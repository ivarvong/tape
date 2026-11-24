// kv.ts: a sharded key-value store over HTTP, made of Tape programs. A cluster is N shards (1 to 64, fixed when it
// is created, never changed), each a Durable Object running examples/kv.tape: every shard the same version, told
// once which shard it is. This file is the router: it creates clusters, and sends each key to its shard.
//
//   POST   /kv/:account/:cluster            {"shards": N}  201 created; 200 if it exists with N; 409 if with another N
//   GET    /kv/:account/:cluster            the cluster and each shard's counts
//   GET    /kv/:account                     the account's clusters
//   GET    /kv/:account/:cluster/k/:key     200 {key, value, version} | 404 {error, key, version}
//   PUT    /kv/:account/:cluster/k/:key     body: the value; ?if=<version> for compare-and-set (0: only if absent)
//   DELETE /kv/:account/:cluster/k/:key     ?if=<version> as for PUT
//   POST   /kv/:account/:cluster/upgrade    {"confirm": "<cluster>", "dry_run": bool}: every shard to the current program
//
// Routing: shard = FNV-1a 32-bit over the key's bytes as they appear in the path (percent-encoding kept), mod N.
// The same function is in examples/kv.tape, and each shard checks it was sent only its own keys (421 if not). A
// cluster's metadata is one row in the SQLite of the account's ~kv object; a cluster is never deleted or resized,
// so each Worker isolate keeps the shard counts it has read and asks ~kv once per cluster.
//
// Every response from a shard carries kv-shard (i/N), tape-trace-url and tape-otlp-url (the shard's run as a
// trace page and as OTLP/JSON), traceparent (the shard's span; send a traceparent and the shard's span is its
// child) and server-timing (the time spent in the shard call, as the router saw it).
//
// Accounts named jepsen-* can have faults injected between the router and the shards (faults.ts), at sites named
// kv>{cluster}.{METHOD}#{key}: delay, slow_reply, drop, lost, overload, reset_callee_before, reset_callee_after. A
// request whose outcome the router cannot know is 503 {"outcome": "unknown"}; one a shard shed because it was
// overloaded is 503 {"overloaded": true} with retry-after: 1 (the platform does not say whether it ran, so its
// outcome is unknown too).
import kvSource from '../../examples/kv.tape?raw';
import { build, isRefusal } from './build.ts';
import { FAULTY, through } from './faults.ts';
import type { Fault } from './faults.ts';
import type { Cluster, InvokeOptions, Name, Retention, Upload } from './name.ts';
import { RouterTrace, store } from './spans.ts';
import type { Step } from './spans.ts';
import { requestOtlp } from './view.ts';
import { hex, messageOf } from './web.ts';

export const MAX_SHARDS = 64;
export const MAX_KEY = 256;
export const MAX_VALUE = 65536;
export const CLUSTER = /^[a-z0-9][a-z0-9_-]{0,57}$/; // kv-<cluster>-<i> is a name: at most 64
export const KEY = /^[A-Za-z0-9\-._~:%]{1,256}$/;
const enc = new TextEncoder();
const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  Response.json(body, { status, headers });
type Fields = Readonly<Record<string, unknown>>;
const fieldsOf = (v: unknown): Fields => (typeof v === 'object' && v !== null ? { ...v } : {});

// FNV-1a, 32 bits. The doctests in examples/kv.tape pin the same values.
export const fnv1a = (bytes: Uint8Array): number => {
  let h = 0x811c9dc5;
  for (const b of bytes) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return h;
};
export const shardOf = (key: string, shards: number): number => fnv1a(enc.encode(key)) % shards;
export const shardName = (cluster: string, i: number): string => `kv-${cluster}-${i}`;
export const source = kvSource;

const whole = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
// {"shards": N} with N an integer 1..64, or the reason it is not
export const shardsOf = (body: string): { error: string } | ({ shards: number } & Retention) => {
  let v: Fields;
  try {
    v = fieldsOf(JSON.parse(body));
  } catch {
    return { error: 'the body is JSON: {"shards": N}' };
  }
  const { shards } = v;
  if (!whole(shards, 1, MAX_SHARDS))
    return { error: `shards is an integer from 1 to ${MAX_SHARDS}, fixed for the cluster's life` };
  // RUNTIME-SPEC R-RET-2, R-RET-6: the op window, the clock allowance and the trace records kept, per shard
  const window = v.op_window_ms ?? 3600000,
    skew = v.op_skew_ms ?? 300000,
    keep = v.trace_keep ?? 100000;
  if (!whole(window, 1000, 86400000)) return { error: 'op_window_ms is an integer from 1000 to 86400000' };
  if (!whole(skew, 1000, 600000)) return { error: 'op_skew_ms is an integer from 1000 to 600000' };
  if (!whole(keep, 10, 10000000)) return { error: 'trace_keep is an integer from 10 to 10000000' };
  return { shards, window, skew, keep };
};

// the cluster's shard count, read once per isolate: clusters are immutable and never deleted
const known = new Map<string, number>();
export const forget = (): void => {
  known.clear(); // tests
};
// tests: a wrong size
export const remember = (account: string, cluster: string, shards: number): void => {
  known.set(`${account}/${cluster}`, shards);
};

/** Signs the links to one routed request's whole trace. */
export type LinksOf = (
  account: string,
  name: string,
  callSpan: string,
) => Promise<{ trace_url: string; otlp_url: string }>;
type Names = DurableObjectNamespace<Name>;
const nameOf = (ctx: ExecutionContext, account: string, name: string): DurableObjectStub<Name> =>
  ctx.exports.Name.getByName(`${account}/${name}`);

let built: Promise<Upload> | null = null; // the shard program, compiled once per isolate
const compiled = async (): Promise<Upload> => {
  const b = build(kvSource);
  if (isRefusal(b)) throw new Error(`examples/kv.tape does not build: ${JSON.stringify(b)}`);
  return { ...b, source: kvSource, hash: await hex(b.plain) };
};
const program = (): Promise<Upload> => {
  built ??= compiled();
  return built;
};

/** An error with the status its answer should carry. */
class Failed extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
// One shard, made idempotently: v1 is the shard program (uploaded once), then its placement (set once).
const makeShard = async (
  names: Names,
  account: string,
  cluster: string,
  i: number,
  n: number,
  retention: Retention,
): Promise<{ shard: number; shards: number }> => {
  const name = shardName(cluster, i),
    r = await names.getByName(`${account}/${name}`).kvInit(account, name, await program(), i, n, retention);
  if ('error' in r) throw new Failed(`shard ${i}: ${r.error}`, r.status);
  return r;
};

const create = async (
  ctx: ExecutionContext,
  request: Request,
  origin: string,
  account: string,
  cluster: string,
): Promise<Response> => {
  const asked = shardsOf(await request.text());
  if ('error' in asked) return json({ error: asked.error }, 400);
  await nameOf(ctx, account, '~registry').registerName('~kv', 'kv');
  const meta = nameOf(ctx, account, '~kv'),
    claim = await meta.kvClaim(cluster, asked.shards, asked);
  if (!claim) return json({ error: `cluster ${cluster} could not be claimed` }, 500);
  if (claim.shards !== asked.shards)
    return json(
      {
        error: `cluster ${cluster} exists with ${claim.shards} shards; a cluster's size is fixed when it is created`,
        cluster,
        shards: claim.shards,
      },
      409,
    );
  const retention = {
    window: claim.window_ms ?? 3600000,
    skew: claim.skew_ms ?? 300000,
    keep: claim.trace_keep ?? 100000,
  };
  if (
    claim.window_ms !== null &&
    (retention.window !== asked.window || retention.skew !== asked.skew || retention.keep !== asked.keep)
  )
    return json(
      {
        error: `cluster ${cluster} exists with another retention; it is fixed when the cluster is created`,
        cluster,
        op_window_ms: retention.window,
        op_skew_ms: retention.skew,
        trace_keep: retention.keep,
      },
      409,
    );
  if (claim.state === 'creating') {
    // every shard, in parallel; one that fails leaves the cluster 'creating', and POSTing again finishes it
    const results = await Promise.allSettled(
      Array.from({ length: claim.shards }, (_, i) =>
        makeShard(ctx.exports.Name, account, cluster, i, claim.shards, retention),
      ),
    );
    const failed = results.flatMap((r, i) =>
      r.status === 'rejected' ? [{ shard: i, error: messageOf(r.reason) }] : [],
    );
    if (failed.length > 0)
      return json(
        {
          error: `${failed.length} of ${claim.shards} shards could not be created; POST again to finish`,
          cluster,
          shards: claim.shards,
          state: 'creating',
          failed,
        },
        503,
      );
    await meta.kvReady(cluster);
  }
  known.set(`${account}/${cluster}`, claim.shards);
  return json(
    await described(ctx, origin, account, cluster, { ...claim, state: 'ready' }, false),
    claim.created ? 201 : 200,
  );
};

const NOTE_EARLIER = 'made with an earlier examples/kv.tape';
/** One shard's counts, or why it could not be asked. */
const statsOf = async (ctx: ExecutionContext, account: string, name: string): Promise<Fields> => {
  try {
    const r = await nameOf(ctx, account, name).invoke(account, name, 0, enc.encode('GET /stats\n'));
    return { name, ...fieldsOf(await r.json()) };
  } catch (e) {
    return { name, error: messageOf(e) };
  }
};
const described = async (
  ctx: ExecutionContext,
  origin: string,
  account: string,
  cluster: string,
  row: Cluster,
  stats: boolean,
): Promise<Fields> => {
  const b = await program(),
    base = `${origin}/kv/${account}/${cluster}`;
  // the program the cluster runs: shard 0's v1 (a cluster made before examples/kv.tape changed keeps its own)
  // (its latest live version: an upgraded cluster's v1 is retired)
  const versions =
      row.state === 'ready' ? await nameOf(ctx, account, shardName(cluster, 0)).versions({ rules: true }) : [],
    v1 = versions.findLast(v => v.live);
  // a cluster made with an older examples/kv.tape keeps running it; if the compiler would refuse that program today
  // (an unconditional write without an op id, before C54), the cluster says so: a new cluster gets the current one
  const current = (v1?.hash ?? b.hash) === b.hash,
    rules = v1?.rules ?? 'passes';
  const out = {
    account,
    cluster,
    shards: row.shards,
    state: row.state,
    created_at: new Date(row.created_at).toISOString(),
    routing: 'shard = fnv1a32(key bytes as in the path) mod shards',
    program: {
      source: 'examples/kv.tape',
      hash: v1?.hash ?? b.hash,
      version: v1?.version ?? 1,
      current,
      ...(current
        ? {}
        : {
            rules,
            note:
              rules === 'passes'
                ? NOTE_EARLIER
                : `${NOTE_EARLIER}, which the compiler would refuse today; it keeps running as built (it accepts an unconditional PUT without ?op=), and a new cluster gets the current program`,
          }),
    },
    keys: `${base}/k/{key}`,
  };
  if (!stats) return out;
  const shards = await Promise.all(
    Array.from({ length: row.shards }, (_, i) => statsOf(ctx, account, shardName(cluster, i))),
  );
  const live = shards.reduce((a, s) => a + (typeof s.live === 'number' ? s.live : 0), 0);
  return { ...out, shard_stats: shards, live };
};

// the shard count of a ready cluster, or a response that says why there is none; rt: the request's trace
const shardsFor = async (
  ctx: ExecutionContext,
  account: string,
  cluster: string,
  rt: RouterTrace | null,
  fault: Fault | null = null,
): Promise<{ shards: number; refused?: undefined } | { shards?: undefined; refused: Response }> => {
  const k = `${account}/${cluster}`,
    step = rt?.begin('kv.cluster.lookup', { attributes: { 'kv.cluster': cluster } });
  // (jepsen-*) the lookup fails, as an RPC to the cluster's object can: the cache is not consulted
  if (fault?.kind === 'lookup_error') throw new Error('jepsen: the cluster lookup failed (injected)');
  const cached = known.get(k);
  if (cached !== undefined) {
    step?.done({
      'kv.cluster.cache': 'hit',
      'kv.shards': cached,
      'tape.timing': "an in-memory read of this isolate's cache: no I/O, so it reads 0 ms",
    });
    return { shards: cached };
  }
  const row = await nameOf(ctx, account, '~kv').kvCluster(cluster);
  step?.done({ 'kv.cluster.cache': 'miss', 'kv.shards': row?.shards, 'kv.cluster.state': row?.state ?? 'none' });
  if (!row)
    return {
      refused: json(
        { error: `no cluster ${cluster}: create it with POST /kv/${account}/${cluster} {"shards": N}` },
        404,
      ),
    };
  if (row.state !== 'ready')
    return {
      refused: json(
        {
          error: `cluster ${cluster} is still being created; POST /kv/${account}/${cluster} again to finish`,
          state: row.state,
        },
        503,
      ),
    };
  known.set(k, row.shards);
  return { shards: row.shards };
};

// Faults the router can inject for jepsen-* accounts, and where the shard call is sent with each.
const SUPERVISOR = new Set([
  'reset_callee_before',
  'reset_callee_after',
  'reset_callee_opened',
  'reset_callee_ran',
  'storage_error',
  'storage_reset',
]);
const NOT_SENT: Readonly<Record<string, string>> = {
  overload: 'the call was refused before it was sent (injected overload): the shard never saw it',
  reset_callee_before: 'the shard was reset before it ran the request (injected): it never ran',
};
const VALUE_TOO_LARGE = `a value is at most ${MAX_VALUE} bytes`;
const overloaded = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && 'overloaded' in e && e.overloaded === true;

/** One key operation as it is routed: who asked, for what, and its trace. */
type Keyed = {
  ctx: ExecutionContext;
  request: Request;
  url: URL;
  account: string;
  cluster: string;
  key: string;
  rt: RouterTrace;
};

// the fault for this request (jepsen-* accounts), decided first: one kind of it fails the cluster lookup
const faultFor = async ({ ctx, request, account, cluster, key, rt }: Keyed): Promise<Fault | null> => {
  if (!FAULTY.test(account)) return null;
  const d = rt.begin('kv.fault.decide', {
    kind: 'client',
    attributes: {
      'rpc.system': 'cloudflare.durable_object',
      'rpc.service': `${account}/~faults`,
      'rpc.method': 'fault',
    },
  });
  const fault = await nameOf(ctx, account, '~faults').fault(`kv>${cluster}.${request.method}#${key}`, 0);
  d.done({ 'tape.fault.kind': fault?.kind ?? 'none', 'tape.fault.ms': fault?.ms });
  // the router is not a Durable Object: there is no caller object to reset, so those kinds are no fault here
  if (fault?.kind.startsWith('reset_caller') !== true) return fault;
  d.event('tape.fault.ignored', {
    'tape.fault.kind': fault.kind,
    reason: 'the KV router has no caller object to reset',
  });
  return null;
};
// A request refused here never reached a shard, so no shard keeps its record: the response says so. A lookup that
// fails (the cluster's object is unreachable) is a refusal too: before it, nothing was sent anywhere, so nothing
// was applied (an uncaught throw here answered "a shard stopped", outcome unknown, with no trace headers: S1).
const lookedUp = async (k: Keyed, fault: Fault | null): Promise<Awaited<ReturnType<typeof shardsFor>>> => {
  try {
    return await shardsFor(k.ctx, k.account, k.cluster, k.rt, fault);
  } catch (e) {
    return {
      refused: json(
        {
          error: 'the cluster lookup failed before any shard was called: nothing was applied; send the request again',
          outcome: 'not applied',
          reason: messageOf(e),
        },
        503,
        { 'retry-after': '1' },
      ),
    };
  }
};
const unsent = (refused: Response, rt: RouterTrace): Response => {
  rt.finish(refused.status, { 'kv.refused': true });
  refused.headers.set('traceparent', `00-${rt.trace}-${rt.span}-01`);
  refused.headers.set('tape-trace-complete', 'false');
  refused.headers.set('tape-trace-lost', "refused before any shard was called: no shard keeps this request's record");
  return refused;
};
/** Why a shard call that threw is answered as it is: the platform shed it, a fault was injected, or it stopped. */
const refusalOf = (e: unknown, fault: Fault | null, name: string, shard: string): Response => {
  // the platform sheds load from a shard whose queue is too long or too old; not to be retried at once
  if (overloaded(e))
    return json(
      {
        error: `shard ${name} is overloaded (its Durable Object queue is full); send fewer requests at once, or use a cluster with more shards`,
        overloaded: true,
        outcome: 'unknown',
        shard,
      },
      503,
      { 'retry-after': '1' },
    );
  return json(
    {
      error: fault
        ? 'the shard call failed before its reply arrived; it may or may not have been applied'
        : 'a shard stopped before it answered; what it committed before that is kept, so the outcome is unknown',
      outcome: 'unknown',
      shard,
      reason: messageOf(e),
    },
    503,
  );
};
/** The call to the key's shard: its reply, or the refusal that stands for one that never came. */
const callShard = async (
  k: Keyed,
  fault: Fault | null,
  to: { name: string; shard: string; bytes: Uint8Array; call: Step },
): Promise<Response> => {
  const { ctx, account, cluster, rt } = k,
    { name, bytes, call } = to,
    stub = nameOf(ctx, account, name),
    atShard = fault !== null && SUPERVISOR.has(fault.kind);
  const options: InvokeOptions = { call: { trace: rt.trace, span: call.span }, fault: atShard ? fault.kind : null };
  const send = (): Promise<Response> => stub.invoke(account, name, 0, bytes, options);
  try {
    if (fault) call.event('tape.fault.injected', { 'tape.fault.kind': fault.kind, 'tape.fault.ms': fault.ms });
    const res = await (fault && !atShard ? through(fault, send, () => Promise.resolve()) : send());
    // the whole reply, before answering: a shard reset while its reply streams would otherwise break the body
    // after the client had the status line, with nothing in the trace to say so
    const reply = await res.arrayBuffer();
    call.done({ 'http.response.status_code': res.status, 'tape.call.outcome': 'answered' });
    // A shard that refuses a key as not its own means this isolate routed with the wrong shard count, which only a
    // bug can do (clusters never change): the shard's check kept the key off the wrong shard, and the count is
    // read again on the next request.
    if (res.status === 421) {
      known.delete(`${account}/${cluster}`);
      rt.event('kv.cluster.cache.dropped', { reason: 'a shard refused the key as not its own (421)' });
    }
    return new Response(reply, res);
  } catch (e) {
    const outcome = fault ? `fault:${fault.kind}` : 'exception';
    call.done(
      {
        'tape.call.outcome': overloaded(e) ? 'overloaded' : outcome,
        'tape.call.not_sent': fault ? NOT_SENT[fault.kind] : undefined,
      },
      messageOf(e),
    );
    return refusalOf(e, fault, name, to.shard);
  }
};

const keyed = async (
  ctx: ExecutionContext,
  request: Request,
  url: URL,
  links: LinksOf,
  account: string,
  cluster: string,
  key: string,
): Promise<Response> => {
  if (!KEY.test(key))
    return json(
      { error: `a key is 1 to ${MAX_KEY} bytes of A-Z a-z 0-9 - . _ ~ : and %; percent-encode anything else` },
      400,
    );
  if (!['GET', 'PUT', 'DELETE'].includes(request.method))
    return json({ error: 'a key takes GET, PUT and DELETE' }, 405, { allow: 'GET, PUT, DELETE' });
  if (Number(request.headers.get('content-length') ?? 0) > MAX_VALUE) return json({ error: VALUE_TOO_LARGE }, 413);
  // The router's spans start here, once the request is a key operation: a request refused before this point never
  // reached a shard, and its response says why.
  const rt = await new RouterTrace(request, `${request.method} /kv/{account}/{cluster}/k/{key}`, {
    'tape.account': account,
    'kv.cluster': cluster,
    'kv.key': key,
    'url.query': url.search.length > 1 ? url.search.slice(1) : undefined,
  }).started();
  const k: Keyed = { ctx, request, url, account, cluster, key, rt },
    fault = await faultFor(k),
    { shards, refused } = await lookedUp(k, fault);
  if (refused) return unsent(refused, rt);
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.length > MAX_VALUE) return json({ error: VALUE_TOO_LARGE }, 413);
  const hash = fnv1a(enc.encode(key)),
    i = hash % shards,
    name = shardName(cluster, i);
  rt.instant('kv.route', {
    'kv.key': key,
    'kv.hash.fnv1a32': hash,
    'kv.shards': shards,
    'kv.shard': i,
    'kv.shard.name': name,
  });
  const head = enc.encode(`${request.method} /k/${key}${url.search}\n`),
    bytes = new Uint8Array(head.length + body.length);
  bytes.set(head);
  bytes.set(body, head.length);
  const call = rt.begin(`${name}.invoke`, {
    kind: 'client',
    attributes: {
      'rpc.system': 'cloudflare.durable_object',
      'rpc.service': `${account}/${name}`,
      'rpc.method': 'invoke',
      'kv.shard': i,
      'tape.fault.kind': fault?.kind,
    },
  });
  const out = await callShard(k, fault, { name, shard: `${i}/${shards}`, bytes, call });
  out.headers.set('kv-shard', `${i}/${shards}`);
  out.headers.set('server-timing', `shard;desc="${name}";dur=${(call.end ?? call.start) - call.start}`);
  out.headers.set('content-type', 'application/json');
  out.headers.delete('tape-next-wake');
  out.headers.delete('tape-supervisor-span');
  // what the client can rely on: the trace of this request is stored with the shard before this response leaves
  rt.finish(out.status, { 'kv.shard': i, 'kv.shards': shards });
  const lost =
    fault?.kind === 'trace_store_error'
      ? "jepsen: the router's record could not be stored (injected)"
      : await store(() => nameOf(ctx, account, name), call.span, rt);
  const l = await links(account, name, call.span);
  out.headers.set('tape-trace-url', l.trace_url);
  out.headers.set('tape-otlp-url', l.otlp_url);
  out.headers.set('traceparent', `00-${rt.trace}-${rt.span}-01`);
  out.headers.set('tape-trace-complete', lost === null ? 'true' : 'false');
  if (lost !== null) out.headers.set('tape-trace-lost', lost.slice(0, 200));
  return out;
};

// GET /kv/:account/:cluster/traces/:trace[?key=K]: every request of one trace id, from the key's shard or from
// every shard, as OTLP/JSON (?format=json: the stored records)
const traces = async (
  ctx: ExecutionContext,
  url: URL,
  account: string,
  cluster: string,
  trace: string,
): Promise<Response> => {
  const { shards, refused } = await shardsFor(ctx, account, cluster, null);
  if (refused) return refused;
  const key = url.searchParams.get('key'),
    which = key === null ? Array.from({ length: shards }, (_, i) => i) : [shardOf(key, shards)],
    stubs = which.map(i => ({ name: shardName(cluster, i), stub: nameOf(ctx, account, shardName(cluster, i)) }));
  const lists = await Promise.all(stubs.map(({ name, stub }) => stub.traced(account, name, trace)));
  // R-RET-6: the newest time of a record a shard pruned, so a missing trace can be told from a pruned one
  const kept = await Promise.all(stubs.map(({ stub }) => stub.keep())),
    pruned = kept.flatMap(x => (x.pruned_before === null ? [] : [x.pruned_before]));
  const requests = lists.flat(),
    before = pruned.length > 0 ? Math.max(...pruned) : null,
    headers: Record<string, string> = before === null ? {} : { 'tape-pruned-before': String(before) };
  return url.searchParams.get('format') === 'json'
    ? json({ trace, requests, ...(before === null ? {} : { pruned_before: before }) }, 200, headers)
    : json(requestOtlp(requests), 200, headers);
};
// POST /kv/:account/:cluster/upgrade {"confirm": "<cluster>", "dry_run": bool} (RUNTIME-SPEC R-UPG): every shard
// to the current examples/kv.tape. Every shard is checked first (a dry run), and none is changed unless all pass;
// then each shard upgrades on its own (kvUpgrade), in order. A shard already current is skipped, so a run that
// stopped part way is finished by sending it again. Keys and versions are kept: the migrations only add.
const upgrade = async (
  ctx: ExecutionContext,
  request: Request,
  account: string,
  cluster: string,
): Promise<Response> => {
  let body: Fields;
  try {
    const text = await request.text();
    body = fieldsOf(JSON.parse(text === '' ? '{}' : text));
  } catch {
    return json({ error: 'the body is JSON: {"confirm": "<cluster>"}' }, 400);
  }
  if (body.confirm !== cluster) return json({ error: `an upgrade needs {"confirm": "${cluster}"}` }, 400);
  const row = await nameOf(ctx, account, '~kv').kvCluster(cluster);
  if (!row) return json({ error: `no cluster ${cluster}` }, 404);
  if (row.state !== 'ready') return json({ error: `cluster ${cluster} is still being created` }, 409);
  const b = await program(),
    shardIds = Array.from({ length: row.shards }, (_, i) => i),
    about = { account, cluster, to_hash: b.hash };
  const one = async (i: number, dry: boolean): Promise<Fields & { shard: number }> => ({
    shard: i,
    ...(await nameOf(ctx, account, shardName(cluster, i)).kvUpgrade(account, shardName(cluster, i), b, { dry })),
  });
  const checked = await Promise.all(shardIds.map(i => one(i, true))),
    refused = checked.filter(r => 'error' in r);
  if (refused.length > 0 || Boolean(body.dry_run))
    return json(
      {
        ...about,
        dry_run: true,
        shards: checked,
        ...(refused.length > 0
          ? { error: `${refused.length} of ${row.shards} shards cannot be upgraded now; nothing was changed` }
          : {}),
      },
      refused.length > 0 ? 409 : 200,
    );
  const done: Fields[] = [];
  for (const i of shardIds) {
    const r = await one(i, false);
    done.push(r);
    if (typeof r.error === 'string')
      return json(
        {
          ...about,
          shards: done,
          error: `shard ${i}: ${r.error}; shards before it are upgraded, the rest are not; POST again to continue`,
        },
        typeof r.status === 'number' ? r.status : 500,
      );
  }
  return json({ ...about, shards: done });
};

const ROUTE = /^\/kv\/([^/]+)(?:\/([^/]+)(?:\/k\/(.*)|\/traces\/([0-9a-f]{32})|\/(upgrade))?)?$/;
const only = (method: string): Response => json({ error: method }, 405);
/** A cluster's own routes: a key, a trace, the upgrade, create and describe. */
const clustered = async (
  ctx: ExecutionContext,
  request: Request,
  url: URL,
  links: LinksOf,
  [, account = '', cluster = '', key, trace, upgradeRoute]: RegExpMatchArray,
): Promise<Response> => {
  if (key !== undefined) return keyed(ctx, request, url, links, account, cluster, key);
  if (trace !== undefined) return request.method === 'GET' ? traces(ctx, url, account, cluster, trace) : only('GET');
  if (upgradeRoute !== undefined && upgradeRoute !== '')
    return request.method === 'POST' ? upgrade(ctx, request, account, cluster) : only('POST');
  if (request.method === 'POST') return create(ctx, request, url.origin, account, cluster);
  if (request.method !== 'GET') return json({ error: 'a cluster takes POST (create) and GET' }, 405);
  const row = await nameOf(ctx, account, '~kv').kvCluster(cluster);
  return row
    ? json(await described(ctx, url.origin, account, cluster, row, row.state === 'ready'))
    : json({ error: `no cluster ${cluster}` }, 404);
};
// /kv/... (the operator token was checked by the caller)
export const kv = async (ctx: ExecutionContext, request: Request, url: URL, links: LinksOf): Promise<Response> => {
  const m = ROUTE.exec(url.pathname);
  if (!m) return json({ error: 'no such route; see /kv/:account/:cluster and /kv/:account/:cluster/k/:key' }, 404);
  const [, account = '', cluster] = m;
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(account)) return json({ error: 'an account is 1-64 of a-z 0-9 _ -' }, 400);
  if (cluster === undefined) {
    if (request.method !== 'GET') return only('GET');
    const clusters = await nameOf(ctx, account, '~kv').kvClusters();
    return json({ account, clusters: clusters.map(r => ({ ...r, created_at: new Date(r.created_at).toISOString() })) });
  }
  if (!CLUSTER.test(cluster))
    return json({ error: 'a cluster is 1-58 of a-z 0-9 _ -, starting with a letter or digit' }, 400);
  try {
    return await clustered(ctx, request, url, links, m);
  } catch (e) {
    // a shard reset while it ran (a deploy, an eviction): it may have committed, and nobody can say
    return json(
      {
        error: 'a shard stopped before it answered; what it committed before that is kept, so the outcome is unknown',
        outcome: 'unknown',
        reason: messageOf(e),
      },
      e instanceof Failed ? e.status : 503,
    );
  }
};
