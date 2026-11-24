// programs.ts: the routes of one program: upload, versions, storage, timers, requests, retire, logs, and running a
// request through a version.
import { build, isRefusal } from './build.ts';
import { FAULTY, through } from './faults.ts';
import type { InvokeOptions, Name } from './name.ts';
import { RouterTrace, store } from './spans.ts';
import { APPLY, encodeOutcome } from './records.ts';
import {
  BODY_MAX,
  SOURCE_MAX,
  bodyOf,
  hex,
  messageOf,
  reply,
  signed,
  stopped,
  tapeRequest,
  tooLarge,
  unknownStop,
} from './web.ts';

export type Args = {
  request: Request;
  m: RegExpMatchArray;
  account: string;
  name: string;
  url: URL;
  token: string;
  origin: string;
  ctx: ExecutionContext;
  stub: DurableObjectStub<Name>;
};
type Route = readonly [method: string, pattern: RegExp, run: (a: Args) => Response | Promise<Response>];
type Restarted = {
  live: readonly number[];
  migration: { id?: string; error?: string } | null;
  held: string | null;
};
const iso = (t: unknown): string | null => (typeof t === 'number' ? new Date(t).toISOString() : null);
const otlpOf = (link: string, origin: string): string => link.replace(`${origin}/t/`, `${origin}/otlp/`);

// What an upload or a retirement did to the data: the live versions, the migration run (with a signed trace link),
// and any contract migration still held.
const migrated = async (
  { live, migration, held }: Restarted,
  token: string,
  origin: string,
  account: string,
  name: string,
): Promise<{ live: readonly number[]; held: string | null; migrated: string | { error: string } | null }> => {
  const { id, error } = migration ?? {};
  if (id !== undefined && id !== '')
    return { live, held, migrated: await signed(token, origin, `/${account}/${name}/${live.at(-1)}/${id}`) };
  return { live, held, migrated: error === undefined || error === '' ? null : { error } };
};

// The upload check's run: its trace page and its OTLP/JSON, signed like a request's.
const checked = async (
  check: { version: number; id: string } | null | undefined,
  token: string,
  origin: string,
  account: string,
  name: string,
): Promise<{ checked?: string; checked_otlp?: string }> => {
  if (!check) return {};
  const page = await signed(token, origin, `/${account}/${name}/${check.version}/${check.id}`);
  return { checked: page, checked_otlp: otlpOf(page, origin) };
};
export const traceLinks = async (
  token: string,
  origin: string,
  account: string,
  name: string,
  version: unknown,
  id: unknown,
): Promise<{ trace_url?: string; otlp_url?: string }> => {
  if (typeof id !== 'string' || id === '') return {};
  const trace_url = await signed(token, origin, `/${account}/${name}/${String(version)}/${id}`);
  return { trace_url, otlp_url: otlpOf(trace_url, origin) };
};

// From a run's request (`METHOD TARGET[ public] LF BODY`): its target (path and query), and the buyer it names, if
// any: `/users/<buyer>/…` in the path, `buyer=` in the query or a form body, or `"buyer": "…"` in a JSON body.
export const targetOf = (head: string | null | undefined): string | null => {
  if (head === null || head === undefined || head === '') return null;
  const [line = ''] = (head.split('\n', 1)[0] ?? '').split('\r', 1);
  return line.split(' ')[1] ?? null;
};
const clean = (sent: string): string | null => {
  let v = sent;
  try {
    v = decodeURIComponent(sent.replaceAll('+', ' '));
  } catch {
    // as sent
  }
  return v.length > 0 && v.length <= 64 ? v : null;
};
const unquoted = (text: string): string => {
  try {
    const v: unknown = JSON.parse(`"${text}"`);
    return typeof v === 'string' ? v : text;
  } catch {
    return text;
  }
};
export const buyerOf = (path: string | null | undefined, head: string | null | undefined): string | null => {
  const p = /^(?:\/p\/[^/]+\/[^/]+|\/[^/]+\/[^/]+\/v\/\d+)?\/users\/([^/?]+)/.exec(path ?? '')?.[1];
  if (p !== undefined) return clean(p);
  if (head === null || head === undefined || head === '') return null;
  const nl = head.indexOf('\n'),
    line = nl < 0 ? head : head.slice(0, nl),
    body = nl < 0 ? '' : head.slice(nl + 1);
  const q = (/[?&]buyer=([^&\s]*)/.exec(line) ?? /(?:^|&)buyer=([^&]*)/.exec(body))?.[1];
  if (q !== undefined) return clean(q);
  const j = /"buyer"\s*:\s*"((?:[^"\\]|\\.){1,64})"/.exec(body)?.[1];
  return j === undefined ? null : unquoted(j);
};

// Router faults (faults.ts) the object called carries out itself, and the ones that mean the call never ran
const ROUTER_SUPERVISOR = new Set([
  'reset_callee_before',
  'reset_callee_after',
  'reset_callee_opened',
  'reset_callee_ran',
  'storage_error',
  'storage_reset',
]);
const ROUTER_NOT_SENT: Readonly<Record<string, string>> = {
  overload: 'the call was refused before it was sent (injected overload): the object never saw it',
  reset_callee_before: 'the object was reset before it ran the request (injected): it never ran',
};
const overloaded = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && 'overloaded' in e && e.overloaded === true;

/** published: the public route's call, which runs the latest live version only if the name is published (version is
 * then 0, and the object picks it) */
// An object of the version before invokePublished (during a split deployment) is asked the way it was: publication(),
// then invoke() of its latest version.
async function invokePublished(
  stub: DurableObjectStub<Name>,
  account: string,
  name: string,
  bytes: Uint8Array,
  options: InvokeOptions,
): Promise<Response> {
  try {
    return await stub.invokePublished(account, name, bytes, options);
  } catch (e) {
    if (!messageOf(e).includes('does not implement the method')) throw e;
    const p = await stub.publication();
    if (!p.published || p.latest === null) return reply({ error: 'no such page' }, 404);
    return stub.invoke(account, name, p.latest, bytes, options);
  }
}
const invoked = (
  stub: DurableObjectStub<Name>,
  account: string,
  name: string,
  version: number,
  bytes: Uint8Array,
  options: InvokeOptions,
): Promise<Response> => stub.invoke(account, name, version, bytes, options);
export type Target = { version: number; path: string; via: string | null; published?: boolean };
// One request to one version of a program (the operator's /v/:version/… route, and a published name's public
// route, via: 'public', with its latest version).
export async function run(
  { request, stub, account, name, url, token, ctx }: Omit<Args, 'm' | 'origin'>,
  { version, path, via, published = false }: Target,
): Promise<Response> {
  const open = via !== null && via !== '';
  const mount = open ? `/p/${account}/${name}` : `/${account}/${name}/v/${version}`;
  const bytes = await tapeRequest(request, path, url.search, via, `${url.origin}${mount}`);
  if (bytes === null) return tooLarge("a request's body", BODY_MAX);
  // the Worker's span for this request, and its call to the object (spans.ts); stored there before the reply
  const rt = await new RouterTrace(
    request,
    `${request.method} ${open ? '/p/{account}/{name}' : '/{account}/{name}/v/{version}'}${path}`,
    {
      'tape.account': account,
      'tape.name': name,
      'tape.version': published ? undefined : version,
      ...(open ? { 'tape.via': via } : {}),
    },
  ).started();
  // a jepsen-* account whose plan says router: true takes faults on this hop too (faults.ts); the decision is
  // made before the call span begins, so the call span stays the router's only child
  const fault = FAULTY.test(account)
    ? await ctx.exports.Name.getByName(`${account}/~faults`).fault(`router>${name}.${request.method}#${path}`, 0)
    : null;
  const call = rt.begin(`${name}.invoke`, {
    kind: 'client',
    attributes: {
      'rpc.system': 'cloudflare.durable_object',
      'rpc.service': `${account}/${name}`,
      'rpc.method': 'invoke',
      'tape.fault.kind': fault?.kind,
    },
  });
  const atCallee = fault !== null && ROUTER_SUPERVISOR.has(fault.kind),
    inTransit = fault !== null && !atCallee && fault.kind !== 'trace_store_error';
  let out: Response;
  try {
    if (fault) call.event('tape.fault.injected', { 'tape.fault.kind': fault.kind, 'tape.fault.ms': fault.ms });
    const options: InvokeOptions = { call: { trace: rt.trace, span: call.span }, fault: atCallee ? fault.kind : null };
    const send = (): Promise<Response> =>
      published
        ? invokePublished(stub, account, name, bytes, options)
        : invoked(stub, account, name, version, bytes, options);
    const res = await (inTransit ? through(fault, send, () => Promise.resolve()) : send()),
      body = await res.arrayBuffer();
    call.done({ 'http.response.status_code': res.status, 'tape.call.outcome': 'answered' });
    out = new Response(body, res);
  } catch (e) {
    const outcome = fault ? `fault:${fault.kind}` : 'exception';
    call.done(
      {
        'tape.call.outcome': overloaded(e) ? 'overloaded' : outcome,
        'tape.call.not_sent': fault ? ROUTER_NOT_SENT[fault.kind] : undefined,
      },
      messageOf(e),
    );
    stopped(e);
    out = unknownStop(messageOf(e), `00-${rt.trace}-${rt.span}-01`);
  }
  rt.finish(out.status);
  // The caller's wait on this invocation, the same header kv.ts writes for a shard: the span's own
  // milliseconds, unclamped. A 404 the list of published names answers itself never reaches here.
  out.headers.set(
    'server-timing',
    `tape-invoke;desc="caller-wall-ms-not-cpu";dur=${(call.end ?? call.start) - call.start}`,
  );
  // Every answer names its request, says what the request did, and carries the router's traceparent. A public
  // answer has no signed trace link (that link opens the run): the id and the traceparent are what correlate a
  // failure, and they are not a link.
  const id = out.headers.get('tape-request-id');
  if (id === null || id === '' || id === 'null') out.headers.set('tape-request-id', crypto.randomUUID());
  // A response the object returned is a finished request, including the program's own 500. Unknown is only the
  // stop path, which already set the header (web.ts unknownStop).
  if (out.headers.get('tape-outcome') === null)
    for (const [header, value] of Object.entries(encodeOutcome(APPLY.applied).headers)) out.headers.set(header, value);
  out.headers.set('traceparent', `00-${rt.trace}-${rt.span}-01`);
  const storeIt = (): Promise<string | null> =>
    store(() => ctx.exports.Name.getByName(`${account}/${name}`), call.span, rt);
  // With no signed link in the answer, the router's record is stored after the reply (it was a 37 ms call before
  // it, trace 93a674291ab3e88eda1e14af41a0cddb); a jepsen-* account's still is stored before, as its faults are
  // checked so.
  if (open && fault === null && !FAULTY.test(account)) {
    for (const h of ['tape-next-wake', 'tape-supervisor-span']) out.headers.delete(h);
    ctx.waitUntil(storeIt());
    return out;
  }
  const lost =
    fault?.kind === 'trace_store_error'
      ? "jepsen: the router's record could not be stored (injected)"
      : await storeIt();
  if (open) {
    for (const h of ['tape-next-wake', 'tape-supervisor-span']) out.headers.delete(h);
    return out;
  }
  const link = await signed(token, url.origin, `/${account}/${name}/r/${call.span}`);
  out.headers.set('tape-trace-url', link);
  out.headers.set('tape-otlp-url', otlpOf(link, url.origin));
  out.headers.set('tape-trace-complete', lost === null ? 'true' : 'false');
  out.headers.delete('tape-supervisor-span');
  return out;
}

const upload = async ({ request, stub, account, name, origin, token }: Args): Promise<Response> => {
  if (name.startsWith('tool-'))
    return reply(
      { error: `names beginning tool- belong to tools: upload with POST /tools/${account}/${name.slice(5)}` },
      400,
    );
  if (name.startsWith('kv-'))
    return reply({ error: 'names beginning kv- are KV shards: create a cluster with POST /kv/:account/:cluster' }, 400);
  const sent = await bodyOf(request, SOURCE_MAX);
  if (sent === null) return tooLarge("a program's source", SOURCE_MAX);
  const source = new TextDecoder().decode(sent),
    built = build(source);
  if (isRefusal(built)) return reply(built, built.status);
  const hash = await hex(built.plain),
    row = await stub.upload(account, name, { source, hash, ...built });
  const links = await checked(row.check, token, origin, account, name);
  if ('error' in row) {
    const { check: _check, ...rest } = row;
    return reply({ ...rest, ...links }, row.status);
  }
  const failing = row.live_failing_rules ?? [],
    many = failing.length > 1;
  return reply(
    {
      account,
      name,
      version: row.version,
      hash,
      bytes: built.plain.length,
      created_at: row.created_at,
      url: `${origin}/${account}/${name}/v/${row.version}/`,
      ...links,
      ...(await migrated(row, token, origin, account, name)),
      ...(failing.length > 0
        ? {
            live_failing_rules: failing,
            live_failing_rules_note: `v${failing.map(r => r.version).join(', v')} ${many ? 'are' : 'is'} still live and would be refused by the compiler today, or does not keep to a machine another live version declares (GET /${account}/${name}?rules); ${many ? 'they keep' : 'it keeps'} running as built until retired (DELETE /${account}/${name}/v/:version)`,
          }
        : {}),
      ...(row.machines ? { machines: row.machines } : {}),
    },
    201,
  );
};

// the timers a program has set, its alarm, and its latest woken runs, each with signed trace links
const wakes = async ({ stub, account, name, origin, token }: Args): Promise<Response> => {
  const w = await stub.wakes(account, name);
  return reply({
    account,
    name,
    alarm: iso(w.alarm),
    set: w.set.map(s => ({ key: s.key, due: iso(s.due) })),
    runs: await Promise.all(
      w.runs.map(async r => ({
        key: r.key,
        version: r.version,
        status: r.status,
        error: r.error ?? undefined,
        due: iso(r.due),
        began: iso(r.began),
        late_ms: typeof r.due === 'number' && typeof r.began === 'number' ? r.began - r.due : undefined,
        took_ms: r.took,
        ...(await traceLinks(token, origin, account, name, r.version, r.log_id)),
      })),
    ),
  });
};

/** `since` as sent: an ISO time or milliseconds; an hour ago when it is not given. */
const sinceOf = (raw: string | null): number => {
  if (raw === null) return Date.now() - 3600_000;
  return /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
};
// recent routed requests (operator, public, and tool and KV hops that went through the router), newest first,
// each with what it was, how it ended, the buyer if its request names one, and signed trace links; and the woken
// runs in the same window. ?since= (ISO time or ms, default an hour ago) ?limit= (1..500, default 100)
const requests = async ({ stub, account, name, origin, token, url }: Args): Promise<Response> => {
  const q = url.searchParams,
    since = sinceOf(q.get('since')),
    limit = q.get('limit') === null ? 100 : Number(q.get('limit'));
  if (!Number.isFinite(since)) return reply({ error: 'since is an ISO time or milliseconds since 1970' }, 400);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500)
    return reply({ error: 'limit is a whole number from 1 to 500' }, 400);
  const listed = await stub.requests(account, name, since, limit);
  const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  return reply({
    account,
    name,
    since: iso(since),
    limit,
    requests: await Promise.all(
      listed.requests.map(async r => {
        const a = r.route.attributes,
          link = await signed(token, origin, `/${account}/${name}/r/${r.call_span}`);
        return {
          began: iso(r.route.start),
          took_ms: r.route.end === null ? null : r.route.end - r.route.start,
          method: a['http.request.method'] ?? null,
          path: a['url.path'] ?? null,
          target: targetOf(r.head),
          via: a['tape.via'] ?? 'operator',
          version: a['tape.version'] ?? r.version,
          status: r.route.status,
          buyer: buyerOf(text(a['url.path']), r.head),
          trace: r.route.trace,
          trace_url: link,
          otlp_url: otlpOf(link, origin),
        };
      }),
    ),
    woken: await Promise.all(
      listed.woken.map(async w => ({
        key: w.key,
        version: w.version,
        status: w.status,
        error: w.error ?? undefined,
        due: iso(w.due),
        began: iso(w.began),
        took_ms: w.took,
        ...(await traceLinks(token, origin, account, name, w.version, w.log_id)),
      })),
    ),
  });
};

const retire = async ({ stub, account, name, m, origin, token }: Args): Promise<Response> => {
  if (name.startsWith('kv-'))
    return reply({ error: "a KV shard's program cannot be retired: its cluster depends on it" }, 400);
  const row = await stub.retire(account, name, Number(m[3]));
  if ('error' in row) return reply(row, row.status);
  return reply({
    retired: row.retired,
    ...(await migrated(row, token, origin, account, name)),
    ...(row.machines ? { machines: row.machines } : {}),
  });
};

export const routes: readonly Route[] = [
  ['POST', /^\/([^/]+)\/([^/]+)$/, upload],
  [
    'GET',
    /^\/([^/]+)\/([^/]+)$/,
    async ({ stub, url }) => reply(await stub.versions({ rules: url.searchParams.has('rules') })),
  ],
  [
    'GET',
    /^\/([^/]+)\/([^/]+)\/storage$/,
    async ({ stub, account, name }) => reply(await stub.storageUse(account, name)),
  ],
  ['GET', /^\/([^/]+)\/([^/]+)\/wakes$/, wakes],
  ['GET', /^\/([^/]+)\/([^/]+)\/requests$/, requests],
  ['DELETE', /^\/([^/]+)\/([^/]+)\/v\/(\d+)$/, retire],
  [
    'GET',
    /^\/([^/]+)\/([^/]+)\/(log|trace)\/(\d+)\/([0-9a-f-]{36})$/,
    ({ stub, account, name, m, url }) =>
      stub.log(
        account,
        name,
        Number(m[4]),
        m[5] ?? '',
        m[3] === 'log' ? 'log' : (url.searchParams.get('format') ?? 'text'),
      ),
  ],
  // a routed request's whole trace: the router's spans, the supervisor's, the run's, its calls (OTLP/JSON)
  [
    'GET',
    /^\/([^/]+)\/([^/]+)\/traces\/([0-9a-f]{32})$/,
    ({ stub, account, name, m, url }) =>
      stub.traceLog(account, name, m[3] ?? '', url.searchParams.get('format') === 'json' ? 'json' : 'otlp'),
  ],
  [
    'GET',
    /^\/([^/]+)\/([^/]+)\/r\/([0-9a-f]{16})$/,
    ({ stub, account, name, m, url }) =>
      stub.requestLog(account, name, m[3] ?? '', url.searchParams.get('format') ?? 'otlp', {}),
  ],
  [
    '*',
    /^\/([^/]+)\/([^/]+)\/v\/(\d+)(\/.*)?$/,
    args => run(args, { version: Number(args.m[3]), path: args.m[4] ?? '/', via: null }),
  ],
];
