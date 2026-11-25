// kv.ts: a Jepsen-style test of the sharded KV service (src/kv.ts, examples/kv.tape): is each key linearizable
// while faults are injected between the router and the shards? No runtime imports: vitest (in workerd) and
// jepsen/kv-run.ts (Node, against production) drive it, each with its own `send`.
//
//   1. setup: create a cluster of `shards` in a fresh jepsen-* account; set the fault plan for the account.
//   2. load:  `clients` concurrent clients, `ops` operations each, on a few hot keys, chosen by a seeded generator:
//             reads, unconditional writes, compare-and-set writes (?if= the version the client last saw, or 0)
//             and deletes. Every value written is unique. Each operation is recorded with its invocation and
//             completion as points in one global order (a counter, so the order is exact even where the clock is
//             frozen): ok, fail (a 409: the key was at another version; nothing was written), or info (no answer:
//             the write may or may not have happened).
//   3. heal:  faults off; read every key (retrying until it answers).
//   4. check: per key, see check() below.
//
//   5. traces: fetch every operation's trace by its id and check it (checkTraces below, and traces.ts).
//
// send(method, path, body, { headers, signal }) -> { status, body, headers } (body parsed as JSON when it is;
// headers a plain object), or throws. Paths are absolute: "/kv/<account>/<cluster>/k/<key>", "/_faults/<account>".
//
// Faults between the client and the Worker, drawn per operation by the client's seeded generator (clientFaults):
//   drop_request    the request is never sent: known not applied (fail), and there must be no trace
//   drop_response   sent and answered, and the answer thrown away: unknown to the client (info); the trace must
//                   exist and show what the service answered (kept as sent_status, for the trace check only)
//   abort           sent, then the connection is aborted after 0-40 ms: unknown (info); the Worker may be
//                   cancelled, so the router's part of the trace may be missing, and then must say so
// A shard's storage failing at commit (the storage_error fault) answers 503 {"applied": false} (500 before
// RUNTIME-SPEC R-ANS-2 chose 503 for a transient failure): known not applied.
import type { Reply, Sender } from './client.ts';
import { at, fields, list, messageOf, text } from './json.ts';
import type { Fields } from './json.ts';
import { clientSpan, spans as spansOf, tree, nesting, missingEvents } from './traces.ts';
import type { Anomaly, Span, SpanEvent, Tree } from './traces.ts';

export const rng = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
const sleep = (ms: number): Promise<void> =>
  new Promise(done => {
    setTimeout(done, ms);
  });

// The faults a KV run uses unless given others: about 30% of shard calls. (The router is stateless, so the faults
// that reset a caller have no meaning here.)
export const PLAN: Readonly<Record<string, number>> = {
  delay: 0.06,
  slow_reply: 0.05,
  drop: 0.04,
  lost: 0.04,
  overload: 0.04,
  reset_callee_before: 0.03,
  reset_callee_opened: 0.02,
  reset_callee_ran: 0.03,
  reset_callee_after: 0.04,
  storage_error: 0.03,
  trace_store_error: 0.02,
  lookup_error: 0.02,
};
export type ClientFaults = { drop_request?: number; drop_response?: number; abort?: number };
export const CLIENT_FAULTS: ClientFaults = { drop_request: 0.02, drop_response: 0.03, abort: 0.03 };
export type ClientFault = 'drop_request' | 'drop_response' | 'abort';

export type Cluster = { account: string; cluster: string };
export type Setup = Cluster & {
  shards: number;
  seed: number;
  plan?: Readonly<Record<string, number>> | null;
  tail?: readonly number[];
};
export async function setup(
  send: Sender,
  { account, cluster, shards, seed, plan = PLAN, tail = [20, 300] }: Setup,
): Promise<unknown> {
  const made = await send('POST', `/kv/${account}/${cluster}`, { shards });
  if (made.status !== 201 && made.status !== 200)
    throw new Error(`create ${cluster}: ${made.status} ${JSON.stringify(made.body)}`);
  const set = await send('PUT', `/_faults/${account}`, plan ? { seed, p: plan, tail } : null);
  if (set.status !== 200) throw new Error(`faults: ${set.status} ${JSON.stringify(set.body)}`);
  return made.body;
}

/** What a client asks of a key. */
export type Op = { f: 'get' | 'put' | 'del'; value?: string; expect?: number | undefined };
/** One attempt of one operation, as the client recorded it: start and end are points of the shared clock. */
export type Attempt = {
  client: number;
  key: string;
  f: 'get' | 'put' | 'del';
  value?: string;
  expect?: number | undefined;
  start: number;
  end?: number;
  trace: string;
  span: string;
  client_fault?: ClientFault;
  /** the op id every attempt of one write carries, and which attempt this is */
  once?: string;
  attempt?: number;
  status?: number;
  type?: 'ok' | 'fail' | 'info';
  version?: number | undefined;
  read?: unknown;
  live?: boolean;
  trace_complete?: string | null;
  trace_lost?: string | null;
  error?: string;
  /** what the service sent, when the client threw the answer away */
  sent_status?: number | null;
  applied?: false;
  not_sent?: true;
  /** a logical operation's attempts (logical()) */
  attempts?: Attempt[];
  /** the case of a scripted run this attempt belongs to (seams.ts) */
  case?: number;
};
export type History = Attempt[];

// retries: a write whose outcome is unknown (info) is sent again, up to this many times, with the same op id
// (?op=, examples/kv.tape): the shard applies it once and answers a repeat with the first reply. Each attempt
// is its own history entry (own trace), with once = the op id and attempt = 0, 1, ...; logical() merges them.
// retries may be a function of the client: (client) => n. The one config every seed runs is RETRIES: the
// odd-numbered clients resend an unknown write twice, the even ones never, in every seed.
export const RETRIES = (client: number): number => (client % 2 === 1 ? 2 : 0);
// The one config every seed runs with, locally (test/kv-jepsen.test.ts) and against the deployed service
// (kv-run.ts): only the seed changes, and the shard count follows from it.
export const CONFIG = {
  clients: 6,
  ops: 40,
  keys: 6,
  shards: (seed: number): number => 1 + (seed % 4),
  retries: RETRIES,
  plan: PLAN,
  clientFaults: CLIENT_FAULTS,
  tail: [20, 300],
};
/** The fault a draw picks, if any. */
const clientFault = (faults: ClientFaults | null, fu: number): ClientFault | null => {
  if (!faults) return null;
  const request = faults.drop_request ?? 0,
    response = request + (faults.drop_response ?? 0);
  if (fu < request) return 'drop_request';
  if (fu < response) return 'drop_response';
  return fu < response + (faults.abort ?? 0) ? 'abort' : null;
};
const opFor = (u: number, r: () => number, value: string, seen: number): Op => {
  if (u < 0.35) return { f: 'get' };
  if (u < 0.6) return { f: 'put', value };
  if (u < 0.9) return { f: 'put', value, expect: seen };
  return { f: 'del', expect: r() < 0.5 ? seen : undefined };
};
export type Load = Cluster & {
  seed: number;
  clients?: number;
  ops?: number;
  keys?: number;
  clientFaults?: ClientFaults | null;
  retries?: number | ((client: number) => number);
};
export async function load(
  send: Sender,
  { account, cluster, seed, clients = 8, ops = 40, keys = 6, clientFaults = CLIENT_FAULTS, retries = RETRIES }: Load,
): Promise<{ history: History; keys: string[] }> {
  const history: History = [],
    names = Array.from({ length: keys }, (_, i) => `j${seed}-${i}`),
    retriesOf = typeof retries === 'function' ? retries : (): number => retries;
  const attemptOne = attempter(send, { account, cluster, history, clock: { n: 0 } });
  const one = async (client: number, r: () => number, n: number, seen: Map<string, number>): Promise<void> => {
    const key = names[Math.floor(r() * names.length)] ?? '',
      u = r(),
      path = `/kv/${account}/${cluster}/k/${key}`,
      op = opFor(u, r, `c${client}.${n}`, seen.get(key) ?? 0);
    const fu = r(),
      cut = Math.floor(r() * 40),
      fault = clientFault(clientFaults, fu);
    // every write carries an op id: an unconditional PUT without one is refused (428, examples/kv.tape), and with
    // one a resend (--retries) is the same write
    const once = op.f === 'get' ? undefined : `${Date.now()}_c${client}-${n}`; // R-RET-1: <t>_<id>, t when first sent
    for (let attempt = 0; ; attempt++) {
      const h = await attemptOne(client, key, path, op, once, attempt, attempt === 0 ? fault : null, cut, seen);
      if (h.type !== 'info' || attempt >= retriesOf(client) || once === undefined) return;
    }
  };
  await Promise.all(
    Array.from({ length: clients }, async (_, client) => {
      const r = rng(seed * 1000 + client),
        seen = new Map<string, number>();
      for (let n = 0; n < ops; n++) await one(client, r, n, seen);
    }),
  );
  return { history, keys: names };
}

const METHOD = { get: 'GET', put: 'PUT', del: 'DELETE' } as const;
const shown = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));
/** Why a request that threw failed, with the cause when the connection failed. */
const thrown = (e: unknown): string => {
  const { cause } = fields(e),
    c = fields(cause),
    more = text(c.code) === '' ? text(c.message) : text(c.code);
  if (cause === undefined || cause === null) return messageOf(e);
  return `${messageOf(e)}: ${more === '' ? shown(cause) : more}`;
};
const numberAt = (v: unknown, field: string): number | undefined => {
  const x = at(v, field);
  return typeof x === 'number' ? x : undefined;
};
/** What an answer means for the attempt: ok, a known failure (and what it claims), or unknown. */
const outcomeOf = (f: Op['f'], res: Pick<Reply, 'status' | 'body'>): Partial<Attempt> => {
  const b = fields(res.body),
    version = numberAt(b, 'version'),
    rolledBack = b.applied === false || (b.outcome === 'not_applied' && (res.status === 500 || b.transient === true)),
    unsent = res.status === 503 && b.outcome === 'not_applied' && b.transient !== true;
  if (f === 'get') {
    if (res.status === 200) return { type: 'ok', live: true, version, read: b.value };
    if (res.status === 404 && version !== undefined) return { type: 'ok', live: false, version };
    // a read that did not answer changed nothing
    return { type: 'fail', ...(unsent ? { not_sent: true } : {}) };
  }
  if (res.status === 200 || res.status === 201) return { type: 'ok', version };
  // the version it found
  if (res.status === 409 || (f === 'del' && res.status === 404)) return { type: 'fail', version };
  // rolled back: a claim the checks hold it to
  if ((res.status === 500 || res.status === 503) && rolledBack) return { type: 'fail', applied: false };
  // refused before any shard was called (the cluster lookup failed): a claim the checks hold it to as well
  return unsent ? { type: 'fail', not_sent: true } : { type: 'info' };
};
export type AttemptOne = (
  client: number,
  key: string,
  path: string,
  op: Op,
  once: string | undefined,
  attempt: number,
  fault: ClientFault | null,
  cut: number,
  seen: Map<string, number>,
) => Promise<Attempt>;
// One attempt of one operation, recorded in history: { client, key, f, value, expect, start, end (points of the
// shared clock), trace, span, once, attempt, client_fault, status, type, version, read, live, ... }. seams.ts uses it.
export const attempter =
  (
    send: Sender,
    { account: _account, cluster: _cluster, history, clock }: Cluster & { history: History; clock: { n: number } },
  ): AttemptOne =>
  async (client, key, path, op, once, attempt, fault, cut, seen) => {
    const cs = clientSpan();
    const h: Attempt = {
      client,
      key,
      ...op,
      start: clock.n++,
      trace: cs.trace,
      span: cs.span,
      ...(fault ? { client_fault: fault } : {}),
      ...(once === undefined ? {} : { once, attempt }),
    };
    history.push(h);
    const parts = [once === undefined ? '' : `op=${once}`, op.expect === undefined ? '' : `if=${op.expect}`].filter(
        x => x !== '',
      ),
      q = parts.length > 0 ? `?${parts.join('&')}` : '';
    if (fault === 'drop_request') return Object.assign(h, { end: clock.n++, status: 0, type: 'fail' as const });
    const ac = fault === 'abort' ? new AbortController() : null,
      timer = ac
        ? setTimeout(() => {
            ac.abort();
          }, cut)
        : null;
    let res: Pick<Reply, 'status' | 'body'> & { headers?: Record<string, string> };
    try {
      res = await send(METHOD[op.f], `${path}${q}`, op.value, {
        headers: { traceparent: cs.traceparent },
        ...(ac ? { signal: ac.signal } : {}),
      });
    } catch (e) {
      res = { status: 0, body: { error: thrown(e) } };
    }
    if (timer) clearTimeout(timer);
    // a problem's detail (the service's errors, and the shard's, are application/problem+json); `error` is the
    // client's own note of a connection that failed
    const failure = fields(res.body).detail ?? fields(res.body).error,
      said = failure === undefined || failure === null || failure === '' ? null : shown(failure);
    h.end = clock.n++;
    h.trace_complete = res.headers?.['tape-trace-complete'] ?? null;
    if (h.trace_complete === 'false') h.trace_lost = res.headers?.['tape-trace-lost'] ?? null;
    if (res.status >= 500 && said !== null) h.error = said.slice(0, 200);
    if (fault === 'abort' || fault === 'drop_response') {
      // the client does not know what happened; what the service sent (if anything arrived) is kept for the trace check
      h.sent_status = res.status === 0 ? null : res.status;
      // and a connection that failed before any response (K2: such a request may never have reached the Worker)
      if (res.status === 0 && said !== null) h.error = said;
      return Object.assign(h, { status: 0, type: op.f === 'get' ? ('fail' as const) : ('info' as const) });
    }
    h.status = res.status;
    // a connection that failed, or a body that broke: what the client was told, kept for the trace check
    if (res.status === 0) h.error = said ?? 'no response';
    Object.assign(h, outcomeOf(op.f, res));
    if (typeof h.version === 'number') seen.set(key, h.version);
    return h;
  };

// The history as the client's logical operations: the attempts of one op id are one operation, from the first
// attempt's start to the last one's end; it is ok (with that version) if any attempt was, else unknown if any was,
// else failed. The linearizability check runs on this; the trace check runs on every attempt.
/** What the attempts of one op id came to between them. */
type Merged = {
  type: Attempt['type'] | undefined;
  status: number | undefined;
  version: number | undefined;
  start: number;
  end: number | undefined;
};
const merged = (attempts: readonly Attempt[]): Merged | null => {
  const [first] = attempts,
    last = attempts.at(-1),
    ok = attempts.find(a => a.type === 'ok');
  if (!first || !last) return null;
  const span = { start: first.start, end: last.end };
  if (ok) return { type: 'ok', status: ok.status, version: ok.version, ...span };
  // an attempt that failed after an unknown one: the unknown one may still have applied it (the failure only says
  // this attempt did not), so the operation stays unknown unless an attempt was ok
  if (attempts.some(a => a.type === 'info')) return { type: 'info', status: last.status, version: undefined, ...span };
  return { type: last.type, status: last.status, version: last.version, ...span };
};
export function logical(history: History): History {
  const out: History = [],
    groups = new Map<string, Attempt & { attempts: Attempt[] }>();
  for (const h of history) {
    if (h.once === undefined || h.once === '') {
      out.push(h);
      continue;
    }
    const id = `${h.client}/${h.once}`,
      g = groups.get(id) ?? { ...h, attempts: [] };
    if (!groups.has(id)) {
      groups.set(id, g);
      out.push(g);
    }
    g.attempts.push(h);
  }
  for (const g of groups.values()) Object.assign(g, merged(g.attempts));
  return out;
}

export type KeyState = { live: boolean; version: number; value?: unknown };
export type Final = Record<string, KeyState>;
export async function heal(
  send: Sender,
  { account, cluster, keys }: Cluster & { keys: readonly string[] },
): Promise<Final> {
  await send('PUT', `/_faults/${account}`, null);
  const final: Final = {};
  const read = async (key: string): Promise<KeyState> => {
    for (let attempt = 0; ; attempt++) {
      let res: Pick<Reply, 'status' | 'body'>;
      try {
        res = await send('GET', `/kv/${account}/${cluster}/k/${key}`);
      } catch {
        res = { status: 0, body: null };
      }
      const version = numberAt(res.body, 'version') ?? 0;
      if (res.status === 200) return { live: true, version, value: at(res.body, 'value') };
      if (res.status === 404) return { live: false, version };
      if (attempt > 20) throw new Error(`final read of ${key}: ${res.status}`);
      await sleep(200);
    }
  };
  for (const key of keys) final[key] = await read(key);
  return final;
}

// Every committed write to a key (deletes too) takes the next version, 1, 2, 3, ..., and every value written is
// unique, so a history is linearizable per key iff all of this holds (anomalies otherwise):
//   - acked writes have distinct versions; a CAS acked with ?if=v has version v+1
//   - real time: an acked op that ended before another op started has a version no greater (strictly smaller
//     when the later op is a write); equivalently, an op with a version <= a read's version started before
//     that read ended; a 409's version counts as a read of the version (without its value)
//   - a read of version v returns what the write of v wrote: its value (or not-found, for a delete), and that
//     write did not start after the read ended; a version no acked write has must be a write whose answer was
//     lost (info): a read value no write wrote at all is an anomaly
//   - nothing acked is lost: the final version is at least every version observed, and it is dense: at most
//     the number of writes that may have happened (acked + info)
export type Stats = Record<string, unknown>;
export type Checked = { valid: boolean; anomalies: Anomaly[]; anomaly_count: number; stats: Stats };
const endOf = (h: Attempt): number => h.end ?? Infinity;
const versionOf = (h: Attempt): number => h.version ?? Number.NaN;
/** One key's writes: the acked ones by version, checked as they are filed. */
const ackedByVersion = (
  key: string,
  ops: readonly Attempt[],
  acked: readonly Attempt[],
  anomalies: Anomaly[],
): Map<unknown, Attempt> => {
  const byVersion = new Map<unknown, Attempt>();
  for (const w of acked) {
    if (byVersion.has(w.version))
      anomalies.push({ type: 'duplicate-version', key, version: w.version, ops: [byVersion.get(w.version), w] });
    byVersion.set(w.version, w);
    if (w.expect !== undefined && w.version !== w.expect + 1) anomalies.push({ type: 'cas-wrong-version', key, op: w });
  }
  for (const h of ops.filter(x => x.status === 409))
    if (h.version === h.expect) anomalies.push({ type: 'refused-at-expected-version', key, op: h });
  for (const h of ops.filter(x => x.f === 'del' && x.status === 404))
    if (byVersion.get(h.version)?.f === 'put')
      anomalies.push({ type: 'delete-missed-live-key', key, op: h, write: byVersion.get(h.version) });
  return byVersion;
};
/** One key's reads against its writes; returns the writes whose answer was lost, placed by the value a read saw. */
const readsOf = (
  key: string,
  ops: readonly Attempt[],
  writes: readonly Attempt[],
  byVersion: ReadonlyMap<unknown, Attempt>,
  anomalies: Anomaly[],
): Map<Attempt, number> => {
  const placed = new Map<Attempt, number>(),
    byValue = new Map(writes.flatMap(w => (w.value === undefined ? [] : [[w.value, w] as const]))),
    lostDelete = writes.some(w => w.type === 'info' && w.f === 'del');
  for (const r of ops.filter(h => h.f === 'get' && h.type === 'ok')) {
    const w = byVersion.get(r.version),
      src = typeof r.read === 'string' ? byValue.get(r.read) : undefined;
    if (r.version === 0) {
      if (r.live === true) anomalies.push({ type: 'live-at-version-0', key, op: r });
    } else if (w) {
      if (r.live !== (w.f === 'put') || (r.live && r.read !== w.value))
        anomalies.push({ type: 'read-wrong-value', key, read: r, write: w });
    } else if (r.live !== true) {
      if (!lostDelete) anomalies.push({ type: 'unexplained-delete', key, read: r });
    } else if (!src) anomalies.push({ type: 'read-unwritten-value', key, read: r });
    else {
      const at1 = placed.get(src);
      if (src.type !== 'info') anomalies.push({ type: 'read-value-of-other-version', key, read: r, write: src });
      else if (at1 !== undefined && at1 !== r.version)
        anomalies.push({ type: 'value-at-two-versions', key, read: r, write: src });
      else placed.set(src, versionOf(r));
      if (src.start > endOf(r)) anomalies.push({ type: 'read-from-future', key, read: r, write: src });
    }
  }
  return placed;
};
// real time, over everything with a known version
const realTime = (key: string, known: readonly Attempt[], anomalies: Anomaly[]): void => {
  for (const a of known)
    for (const b of known) {
      if (a === b || endOf(a) >= b.start) continue; // a ended before b started
      const bWrites = b.f !== 'get' && b.type !== 'fail'; // an acked write, or a lost one placed by a read
      if (bWrites ? !(versionOf(a) < versionOf(b)) : !(versionOf(a) <= versionOf(b)))
        anomalies.push({ type: 'real-time', key, before: a, after: b });
    }
};
const oneKey = (key: string, ops: readonly Attempt[], f: KeyState | undefined, anomalies: Anomaly[]): void => {
  const writes = ops.filter(h => h.f !== 'get'),
    acked = writes.filter(h => h.type === 'ok'),
    maybe = acked.length + writes.filter(h => h.type === 'info').length;
  const observed = ops.filter(
    h => typeof h.version === 'number' && (h.type === 'ok' || h.status === 409 || h.status === 404),
  );
  const byVersion = ackedByVersion(key, ops, acked, anomalies),
    placed = readsOf(key, ops, writes, byVersion, anomalies);
  const known = [...observed, ...[...placed].map(([w, version]): Attempt => ({ ...w, version, end: Infinity }))];
  realTime(key, known, anomalies);
  const top = Math.max(0, ...known.map(versionOf));
  if (!f) {
    anomalies.push({ type: 'no-final-read', key });
    return;
  }
  if (f.version < top) anomalies.push({ type: 'lost-write', key, final: f, observed: top });
  if (f.version > maybe) anomalies.push({ type: 'versions-not-dense', key, final: f.version, writes: maybe });
  const last = byVersion.get(f.version);
  if (last && (f.live !== (last.f === 'put') || (f.live && f.value !== last.value)))
    anomalies.push({ type: 'final-wrong-value', key, final: f, write: last });
};
export function check(history: History, final: Final): Checked {
  const anomalies: Anomaly[] = [],
    count = (which: (h: Attempt) => boolean): number => history.filter(which).length;
  const stats = {
    ops: history.length,
    ok: count(h => h.type === 'ok'),
    fail: count(h => h.type === 'fail'),
    info: count(h => h.type === 'info'),
    reads: count(h => h.f === 'get' && h.type === 'ok'),
    writes_acked: count(h => h.f !== 'get' && h.type === 'ok'),
    cas_acked: count(h => h.expect !== undefined && h.type === 'ok'),
    cas_refused: count(h => h.expect !== undefined && h.status === 409),
  };
  for (const [key, ops] of Map.groupBy(history, h => h.key)) oneKey(key, ops, final[key], anomalies);
  return { valid: anomalies.length === 0, anomalies: anomalies.slice(0, 50), anomaly_count: anomalies.length, stats };
}

// ---- traces
const fetched = async (send: Sender, path: string): Promise<unknown> => {
  for (let attempt = 0; ; attempt++) {
    let res: Pick<Reply, 'status' | 'body'>;
    try {
      res = await send('GET', path);
    } catch (e) {
      res = { status: 0, body: messageOf(e) };
    }
    if (res.status === 200) return res.body;
    if (attempt >= 5) return { error: `${res.status} ${JSON.stringify(res.body).slice(0, 200)}` };
    await sleep(200 * (attempt + 1));
  }
};
// Every operation's trace, by its trace id, from its key's shard: Map trace id -> OTLP/JSON (null: not found).
export async function collectTraces(
  send: Sender,
  { account, cluster, history, parallel = 8 }: Cluster & { history: History; parallel?: number },
): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>(),
    queue = history.filter(h => h.trace !== '');
  const worker = async (): Promise<void> => {
    for (let h = queue.shift(); h; h = queue.shift())
      out.set(h.trace, await fetched(send, `/kv/${account}/${cluster}/traces/${h.trace}?key=${h.key}`));
  };
  await Promise.all(Array.from({ length: parallel }, worker));
  return out;
}

export const fnv1a = (key: string): number => {
  let x = 0x811c9dc5;
  for (const b of new TextEncoder().encode(key)) x = Math.imul(x ^ b, 0x01000193) >>> 0;
  return x;
};

/** What a trace says an operation did. */
export type Effect = {
  kind: 'committed' | 'read' | 'none' | 'unknown' | 'absent' | 'replayed';
  version?: unknown;
  value?: unknown;
  live?: unknown;
  key?: unknown;
  why?: unknown;
  rolled_back?: true;
  /** the run's start (ms, the shard's clock) */
  at?: number;
};
export type OpChecked = {
  anomalies: Anomaly[];
  effect: Effect;
  spans?: number;
  markers?: unknown[];
  skew?: number;
  offsets?: number[];
  refused?: true;
  told?: true;
  network?: boolean;
};
export type TraceOptions = Cluster & { shards: number; tolerance?: number };
type Flag = (type: string, extra?: Fields) => void;
const statusOf = (s: Span): unknown => s.attrs['http.response.status_code'];
const marks = (s: Span, what: string): boolean => missingEvents(s).some(e => e.attrs['tape.missing'] === what);
const sqlOf = (e: SpanEvent): string => text(e.attrs['db.query.text']);
const rowsOf = (e: SpanEvent): unknown[][] => {
  const returned: unknown = JSON.parse(text(e.attrs['tape.sql.rows']) === '' ? '[]' : text(e.attrs['tape.sql.rows']));
  return list(returned).map(list);
};

function effectOfRun(h: Attempt, run: Span): Effect {
  const q = run.events.filter(e => e.name === 'db.query');
  if (run.attrs['tape.run.rolled_back'] === true || run.status === 2) return { kind: 'none', rolled_back: true };
  if (h.f === 'get') {
    const sel = q.find(e => sqlOf(e).startsWith('SELECT key, value, version, live FROM kv'));
    if (!sel) return { kind: 'unknown', why: 'no read statement' };
    const [row] = rowsOf(sel);
    return row
      ? { kind: 'read', version: row[2], value: row[3] === 1 ? row[1] : undefined, live: row[3] }
      : { kind: 'read', version: 0, live: 0 };
  }
  // the op id lookup: key_ops (migration 3, by op and key) or ops (migration 2, clusters made before it)
  const replay = q.find(e => /^SELECT key, status, version FROM (key_ops|ops) WHERE op = /.test(sqlOf(e))),
    [replayed] = replay ? rowsOf(replay) : [];
  if (replayed) return { kind: 'replayed', version: replayed[2], key: replayed[0] };
  const w = q.find(e => /^(INSERT INTO kv|UPDATE kv)/.test(sqlOf(e)));
  if (!w) return { kind: 'none', why: 'no write statement (refused before it)' };
  const [row] = rowsOf(w);
  return row
    ? { kind: 'committed', version: row[2], value: row[1], live: row[3] }
    : { kind: 'none', why: 'the write matched no row' };
}
// What the run's SQL says: the write statement's RETURNING row (committed unless the run was rolled back), or
// the read's row. With the run's start (ms, the shard's clock): one shard runs one request at a time, so these
// order its runs (model/conformance.ts replays them through the protocol model in that order)
const effectOf = (h: Attempt, run: Span): Effect => ({ ...effectOfRun(h, run), at: run.start });

/** An operation with no trace at all: whether that is allowed, and what it then says. */
const untraced = (h: Attempt, anomalies: Anomaly[], bad: Flag): OpChecked => {
  // An aborted request, or one whose connection failed (the client's fetch threw: status 0 with the error kept),
  // may never have reached the Worker, or reached it and was cancelled before it called a shard; either way no
  // shard ran it (a shard that had would have its own record, and the trace would show it). Its absence is
  // allowed and counted; what it may not have done is still checked (versions and final state). Anything else
  // the client sent must have a trace.
  // (a body that broke is not one: the Worker had begun its reply, and stores its record before it replies)
  // A request the router refused before it called any shard (and said so: not applied, its trace incomplete) has
  // no shard to keep its record; it is held to not having been applied (a fail), which the history checks.
  if (h.not_sent === true && h.trace_complete === 'false')
    return { anomalies, effect: { kind: 'none' }, spans: 0, refused: true };
  // A response that said its trace is incomplete (the router's record was not stored) and no shard record either:
  // the shard never opened a record of the call (a shard's record and its commit are one transaction, R2), so
  // the absence is allowed and counted; it excuses no committed version (a hole is still an anomaly).
  if (h.trace_complete === 'false')
    return {
      anomalies,
      effect: { kind: 'absent', why: 'no trace; the response said its trace is incomplete' },
      spans: 0,
      told: true,
    };
  const unfaulted =
      h.client_fault === undefined || (h.client_fault === 'drop_response' && (h.sent_status ?? null) === null),
    network =
      h.status === 0 && unfaulted && h.error !== undefined && h.error !== '' && !h.error.startsWith('the body broke');
  if (h.client_fault !== 'abort' && !network) bad('trace-missing', { status: h.status, error: h.error });
  return {
    anomalies,
    effect: {
      kind: h.client_fault === 'abort' || network ? 'absent' : 'unknown',
      why: network ? `no trace; the connection failed: ${h.error}` : 'no trace',
    },
    spans: 0,
    network,
  };
};
/** The span of the call to the shard: under the router's span (checked), or standing in for a lost router record. */
const invokeOf = (h: Attempt, t: Tree, root: Span, o: TraceOptions, bad: Flag): Span | null => {
  const shard = fnv1a(h.key) % o.shards;
  if (root.attrs['tape.missing'] === 'router') {
    if (missingEvents(root).length === 0) bad('missing-without-marker', { span: root.name });
    // allowed only when the client cut the request short, or was told
    if (h.client_fault !== 'abort' && h.trace_complete !== 'false')
      bad('router-record-missing', {
        status: h.status,
        trace_complete: h.trace_complete,
        reason: missingEvents(root)[0]?.attrs['tape.missing.reason'],
      });
    return root;
  }
  if (
    root.name !== `${METHOD[h.f]} /kv/{account}/{cluster}/k/{key}` ||
    root.kind !== 2 ||
    root.service !== 'tape-router'
  )
    bad('wrong-root', { name: root.name, kind: root.kind, service: root.service });
  if (root.attrs['kv.key'] !== h.key) bad('router-wrong-key', { got: root.attrs['kv.key'] });
  const seen = h.status === undefined || h.status === 0 ? (h.sent_status ?? 0) : h.status;
  if (seen !== 0 && statusOf(root) !== seen) bad('status-mismatch', { router: statusOf(root), client: seen });
  const kids = t.kids(root),
    named = (n: string): Span[] => kids.filter(k => k.name === n);
  const lookup = named('kv.cluster.lookup'),
    [route] = named('kv.route'),
    invokes = kids.filter(k => k.name.endsWith('.invoke')),
    [invoke] = invokes;
  if (lookup.length !== 1 || lookup[0]?.kind !== 1) bad('lookup-span', { n: lookup.length });
  if (named('kv.route').length !== 1 || route?.kind !== 1) bad('route-span', { n: named('kv.route').length });
  else if (route.attrs['kv.shard'] !== shard || route.attrs['kv.shards'] !== o.shards)
    bad('route-wrong-shard', { got: route.attrs['kv.shard'], want: shard });
  if (invokes.length !== 1 || !invoke) {
    bad('shard-call-span', { n: invokes.length });
    return null;
  }
  if (invoke.kind !== 3 || invoke.name !== `kv-${o.cluster}-${shard}.invoke`)
    bad('shard-call-wrong', { name: invoke.name, kind: invoke.kind });
  const unexpected = kids.filter(
    k => !['kv.cluster.lookup', 'kv.route', 'kv.fault.decide'].includes(k.name) && k !== invoke,
  );
  if (unexpected.length > 0) bad('unexpected-router-child', { spans: unexpected.map(k => k.name) });
  return invoke;
};
/** A supervisor's run, checked against the supervisor, the router and the request; and what it did. */
const supervised = (
  h: Attempt,
  t: Tree,
  root: Span,
  sup: Span,
  outcome: unknown,
  o: TraceOptions,
  bad: Flag,
): Effect => {
  const shardName = `kv-${o.cluster}-${fnv1a(h.key) % o.shards}`;
  if (sup.kind !== 2 || sup.service !== `${o.account}/${shardName} supervisor`)
    bad('supervisor-wrong', { service: sup.service, kind: sup.kind });
  if (outcome === 'fault:overload') bad('ran-after-not-sent', { outcome });
  const open = marks(sup, 'supervisor.end');
  if (open && outcome === 'answered') bad('open-supervisor-of-answered-call');
  const runs = t.kids(sup),
    [run] = runs;
  if (!run) {
    if (!marks(sup, 'run')) bad('run-missing-without-marker');
    // no log: its last writes did not commit (the log commits with them)
    return { kind: 'none', why: sup.attrs['error.message'] ?? 'no run recorded' };
  }
  if (runs.length > 1) bad('duplicate-run', { n: runs.length });
  if (
    run.kind !== 2 ||
    run.service !== `${o.account}/${shardName}` ||
    !run.name.startsWith(`${METHOD[h.f]} /k/${h.key}`)
  )
    bad('run-wrong', { name: run.name, service: run.service });
  // (a supervisor that stopped before the end of the call recorded no status: there is nothing to compare)
  if (!open && statusOf(run) !== statusOf(sup))
    bad('run-status-not-supervisor-status', { run: statusOf(run), supervisor: statusOf(sup) });
  if (outcome === 'answered' && statusOf(root) !== undefined && statusOf(root) !== statusOf(run))
    bad('router-status-not-run-status', { router: statusOf(root), run: statusOf(run) });
  if (!open && !text(run.attrs['tape.duration.source']).startsWith('measured')) bad('run-duration-unmeasured');
  const queries = run.events.filter(e => e.name === 'db.query').length;
  if (run.attrs['tape.sql.statements'] !== queries)
    bad('sql-count-mismatch', { attr: run.attrs['tape.sql.statements'], events: queries });
  return effectOf(h, run);
};
/** What the call to the shard led to, from what hangs under its span. */
const effectUnder = (h: Attempt, t: Tree, root: Span, invoke: Span, o: TraceOptions, bad: Flag): Effect => {
  const under = t.kids(invoke),
    sups = under.filter(k => text(k.service).endsWith(' supervisor')),
    // a run whose supervisor record was lost (the object reset in flight) hangs under the call span, marked
    orphans = under.filter(k => k.attrs['tape.supervisor.missing'] === true),
    [sup] = sups,
    [orphan] = orphans,
    outcome = invoke.attrs['tape.call.outcome'];
  if (under.length !== sups.length + orphans.length)
    bad('unexpected-call-child', {
      spans: under.filter(k => !sups.includes(k) && !orphans.includes(k)).map(k => k.name),
    });
  if (orphan) {
    if (sups.length > 0 || orphans.length > 1)
      bad('duplicate-execution', { supervisors: sups.length, orphans: orphans.length });
    if (!orphans.every(x => missingEvents(x).length > 0)) bad('orphan-run-without-marker');
    if (outcome === 'answered') bad('orphan-run-of-answered-call');
    return effectOf(h, orphan);
  }
  if (!sup) {
    if (missingEvents(invoke).length === 0) bad('supervisor-missing-without-marker', { outcome });
    // the call failed: never sent (an injected overload or reset before), or the object was reset while it was in
    // flight and kept no record; a run's log commits with its writes, and none was found, so nothing committed
    if (outcome === 'answered') bad('supervisor-missing', { outcome });
    return { kind: 'none' };
  }
  if (sups.length > 1) bad('duplicate-execution', { n: sups.length });
  return supervised(h, t, root, sup, outcome, o, bad);
};
// what the client saw, against what the trace says
const agrees = (h: Attempt, effect: Effect, bad: Flag): void => {
  if (h.f === 'get') {
    const same =
      effect.kind === 'read' &&
      effect.version === h.version &&
      effect.live === (h.live === true ? 1 : 0) &&
      (h.live !== true || effect.value === h.read);
    if (h.type === 'ok' && !same)
      bad('trace-read-mismatch', { client: { version: h.version, read: h.read, live: h.live }, trace: effect });
    return;
  }
  const keyed = h.once !== undefined && h.once !== '',
    replayOk = effect.kind === 'replayed' && keyed && effect.version === h.version && effect.key === h.key,
    wrote = h.f === 'put' ? effect.live === 1 && effect.value === h.value : effect.live === 0,
    committed = effect.kind === 'committed' && effect.version === h.version && wrote;
  if (h.type === 'ok' && !replayOk && !committed)
    bad('trace-effect-mismatch', { client: { version: h.version, value: h.value }, trace: effect });
  if (effect.kind === 'replayed' && !keyed) bad('replay-without-op-id', { trace: effect });
  if (h.type === 'fail' && effect.kind === 'committed')
    bad('failed-op-committed-in-trace', { trace: effect, status: h.status });
};

// One operation's trace, checked on its own: its shape, and what it says happened (effect):
//   { kind: 'committed', version, value, live } a write that committed; { kind: 'read', version, value, live };
//   { kind: 'none' } nothing was written; { kind: 'unknown', why } the trace says it cannot know (explicitly).
export function checkOpTrace(h: Attempt, otlp: unknown, o: TraceOptions): OpChecked {
  const anomalies: Anomaly[] = [],
    bad: Flag = (type, extra = {}) => {
      anomalies.push({ type, key: h.key, f: h.f, trace: h.trace, client_fault: h.client_fault, ...extra });
    };
  const failed = fields(otlp).error;
  if (failed !== undefined && failed !== null && failed !== '') {
    bad('trace-unreadable', { error: failed });
    return { anomalies, effect: { kind: 'unknown', why: 'unreadable' } };
  }
  const all = spansOf(otlp);
  if (h.client_fault === 'drop_request') {
    if (all.length > 0) bad('trace-for-unsent-request', { spans: all.length });
    return { anomalies, effect: { kind: 'none' }, spans: all.length };
  }
  if (all.length === 0) return untraced(h, anomalies, bad);
  const t = tree(all, { trace: h.trace, client: h.span });
  for (const a of t.anomalies) bad(a.type, a);
  const markers = all.flatMap(s => missingEvents(s).map(e => e.attrs['tape.missing'])),
    shape = { anomalies, spans: all.length, markers },
    unknown: Effect = { kind: 'unknown', why: 'no run' };
  if (!t.root) return { ...shape, effect: unknown };
  // the router: present, or explicitly missing (allowed only when the client cut the request short, or was told)
  const invoke = invokeOf(h, t, t.root, o, bad);
  if (!invoke) return { ...shape, effect: unknown };
  const effect = effectUnder(h, t, t.root, invoke, o, bad);
  agrees(h, effect, bad);
  const n = nesting(all, t.by, o.tolerance ?? 50);
  for (const a of n.anomalies) bad(a.type, a);
  return { ...shape, effect, skew: n.worst, offsets: n.offsets };
}

type TraceStats = {
  ops: number;
  traced: number;
  spans: number;
  absent_allowed: number;
  markers: Record<string, number>;
  info_committed: number;
  info_not_committed: number;
  info_unknown: number;
  worst_skew_ms: number;
  clock_offset_ms: [number, number] | null;
  absent_told?: number;
  refused_untraced?: number;
  absent_network?: number;
  replayed?: number;
};
/** One operation's check, counted. */
const counted = (stats: TraceStats, h: Attempt, r: OpChecked): void => {
  if ((r.spans ?? 0) > 0) stats.traced++;
  stats.spans += r.spans ?? 0;
  if (r.effect.kind === 'absent') stats.absent_allowed++;
  if (r.told === true) stats.absent_told = (stats.absent_told ?? 0) + 1;
  if (r.refused === true) stats.refused_untraced = (stats.refused_untraced ?? 0) + 1;
  if (r.network === true) stats.absent_network = (stats.absent_network ?? 0) + 1;
  for (const m of r.markers ?? []) stats.markers[String(m)] = (stats.markers[String(m)] ?? 0) + 1;
  stats.worst_skew_ms = Math.max(stats.worst_skew_ms, r.skew ?? 0);
  for (const off of r.offsets ?? []) {
    const [lo, hi] = stats.clock_offset_ms ?? [off, off];
    stats.clock_offset_ms = [Math.min(lo, off), Math.max(hi, off)];
  }
  if (h.type !== 'info' || h.f === 'get') return;
  if (r.effect.kind === 'committed') stats.info_committed++;
  else if (r.effect.kind === 'none') stats.info_not_committed++;
  else stats.info_unknown++;
};
type Effects = ReadonlyMap<Attempt, Effect>;
const NONE: Effect = { kind: 'unknown' };
// exactly once: the attempts of one op id commit at most once between them, and a replay answers that commit
const exactlyOnce = (history: History, effects: Effects, stats: TraceStats, anomalies: Anomaly[]): void => {
  const keyed = history.filter(h => h.once !== undefined && h.once !== '');
  for (const [id, attempts] of Map.groupBy(keyed, h => `${h.client}/${h.once}`)) {
    const of = attempts.map(a => effects.get(a) ?? NONE),
      commits = of.filter(e => e.kind === 'committed'),
      replays = of.filter(e => e.kind === 'replayed'),
      [first] = commits;
    if (commits.length > 1)
      anomalies.push({ type: 'op-applied-twice', once: id, versions: commits.map(e => e.version) });
    for (const replay of replays)
      if (!first || replay.version !== first.version)
        anomalies.push({ type: 'replay-without-its-commit', once: id, replay, commits });
    stats.replayed = (stats.replayed ?? 0) + replays.length;
  }
};
/** One key's traces against its final state: the writes the traces say committed are versions 1..final, one each. */
const keyTraces = (
  key: string,
  ops: readonly Attempt[],
  f: KeyState | undefined,
  effects: Effects,
  anomalies: Anomaly[],
): void => {
  // only a trace that says it cannot know (a run that stopped, marked) excuses a hole: a missing trace never does
  const committed = new Map<unknown, { h: Attempt; e: Effect }>(),
    unknown = ops.filter(h => {
      const e = effects.get(h) ?? NONE;
      return h.f !== 'get' && e.kind === 'unknown' && e.why !== 'no trace' && e.why !== 'unreadable';
    }).length;
  for (const h of ops) {
    const e = effects.get(h) ?? NONE,
      was = committed.get(e.version);
    if (e.kind !== 'committed') continue;
    if (was) anomalies.push({ type: 'trace-duplicate-version', key, version: e.version, ops: [was.h.trace, h.trace] });
    committed.set(e.version, { h, e });
  }
  if (!f) return;
  let holes = 0;
  for (let v = 1; v <= f.version; v++) if (!committed.has(v)) holes++;
  if (holes > unknown)
    anomalies.push({
      type: 'committed-write-without-trace',
      key,
      final: f.version,
      traced: committed.size,
      holes,
      unknown,
    });
  for (const v of committed.keys())
    if (typeof v === 'number' && v > f.version)
      anomalies.push({ type: 'trace-version-beyond-final', key, version: v, final: f.version });
  const last = committed.get(f.version);
  if (f.version > 0 && last && (f.live !== (last.e.live === 1) || (f.live && f.value !== last.e.value)))
    anomalies.push({ type: 'trace-final-mismatch', key, final: f, trace: last.e });
  for (const h of ops.filter(x => x.f === 'get' && x.type === 'ok' && (x.version ?? 0) > 0)) {
    const w = committed.get(h.version),
      live = h.live === true;
    if (w && (live !== (w.e.live === 1) || (live && h.read !== w.e.value)))
      anomalies.push({
        type: 'read-not-from-traced-write',
        key,
        read: { version: h.version, value: h.read },
        write: w.e,
      });
    if (!w && holes <= unknown && unknown === 0)
      anomalies.push({ type: 'read-of-untraced-version', key, version: h.version });
  }
};

// Every operation's trace, then the writes the traces say committed, per key, against the final state: they must
// be exactly versions 1..final, one each, the final value the last one's, and every read's value its version's.
// A committed write whose reply was lost must still be there: a hole in the versions is a write without a trace.
export function checkTraces(
  history: History,
  final: Final,
  traces: ReadonlyMap<string, unknown>,
  opts: TraceOptions,
): Checked {
  const anomalies: Anomaly[] = [],
    stats: TraceStats = {
      ops: history.length,
      traced: 0,
      spans: 0,
      absent_allowed: 0,
      markers: {},
      info_committed: 0,
      info_not_committed: 0,
      info_unknown: 0,
      worst_skew_ms: 0,
      clock_offset_ms: null,
    };
  const effects = new Map<Attempt, Effect>();
  for (const h of history) {
    const r = checkOpTrace(h, traces.get(h.trace) ?? null, opts);
    anomalies.push(...r.anomalies);
    effects.set(h, r.effect);
    counted(stats, h, r);
  }
  exactlyOnce(history, effects, stats, anomalies);
  for (const [key, ops] of Map.groupBy(history, h => h.key)) keyTraces(key, ops, final[key], effects, anomalies);
  return { valid: anomalies.length === 0, anomalies: anomalies.slice(0, 50), anomaly_count: anomalies.length, stats };
}

// ---- a history and a final state as they were stored (JSON)
const FS = new Set(['get', 'put', 'del']);
const isF = (v: unknown): v is Attempt['f'] => typeof v === 'string' && FS.has(v);
const isType = (v: unknown): v is NonNullable<Attempt['type']> => v === 'ok' || v === 'fail' || v === 'info';
const isClientFault = (v: unknown): v is ClientFault => v === 'drop_request' || v === 'drop_response' || v === 'abort';
const numberOr = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const textOr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
/** One attempt as a stored history has it. */
export const attemptOf = (v: unknown): Attempt => {
  const h = fields(v),
    end = numberOr(h.end),
    status = numberOr(h.status),
    once = textOr(h.once),
    attempt = numberOr(h.attempt),
    value = textOr(h.value),
    error = textOr(h.error),
    sent = h.sent_status;
  return {
    client: numberOr(h.client) ?? 0,
    key: text(h.key),
    f: isF(h.f) ? h.f : 'get',
    start: numberOr(h.start) ?? 0,
    trace: text(h.trace),
    span: text(h.span),
    ...(value === undefined ? {} : { value }),
    ...('expect' in h ? { expect: numberOr(h.expect) } : {}),
    ...(end === undefined ? {} : { end }),
    ...(isClientFault(h.client_fault) ? { client_fault: h.client_fault } : {}),
    ...(once === undefined ? {} : { once }),
    ...(attempt === undefined ? {} : { attempt }),
    ...(status === undefined ? {} : { status }),
    ...(isType(h.type) ? { type: h.type } : {}),
    ...('version' in h ? { version: numberOr(h.version) } : {}),
    ...('read' in h ? { read: h.read } : {}),
    ...(typeof h.live === 'boolean' ? { live: h.live } : {}),
    ...(typeof h.trace_complete === 'string' || h.trace_complete === null ? { trace_complete: h.trace_complete } : {}),
    ...(typeof h.trace_lost === 'string' || h.trace_lost === null ? { trace_lost: h.trace_lost } : {}),
    ...(error === undefined ? {} : { error }),
    ...(typeof sent === 'number' || sent === null ? { sent_status: sent } : {}),
    ...(h.applied === false ? { applied: false } : {}),
    ...(h.not_sent === true ? { not_sent: true } : {}),
  };
};
export const historyOf = (v: unknown): History => list(v).map(attemptOf);
/** A final state as it was stored. */
export const finalOf = (v: unknown): Final =>
  Object.fromEntries(
    Object.entries(fields(v)).map(([key, state]): [string, KeyState] => {
      const st = fields(state);
      return [
        key,
        { live: st.live === true, version: numberOr(st.version) ?? 0, ...('value' in st ? { value: st.value } : {}) },
      ];
    }),
  );
