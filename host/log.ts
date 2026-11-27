// host/log.ts: the effect log. Every call a program makes of its host is written down, so the same request can
// be run again from the log alone and give the same answer.

/** A value read from a row: node:sqlite gives bytes as a Uint8Array, Durable Object SQLite as an ArrayBuffer. */
export type Cell = string | number | bigint | null | Uint8Array | ArrayBuffer;
export type SqlParam = string | number | bigint | null;
/** What the host needs of a database: Durable Object SQLite (ctx.storage.sql), or nodesql.ts over node:sqlite. */
export type Sql = {
  exec: (
    query: string,
    ...params: SqlParam[]
  ) => {
    rowsWritten: number;
    /** SQLite's changes() right after this statement, when the database has it without running another one
     * (node:sqlite's run() does; Durable Object SQLite's cursor does not, and the host then asks `SELECT changes()`) */
    changes?: number;
    raw: () => { toArray: () => Cell[][] };
    toArray: () => Record<string, Cell>[];
  };
};

/** A cell as text: what String() gives it, with bytes as their values. */
export const cellText = (c: Cell | undefined): string => {
  if (typeof c === 'string') return c;
  if (c instanceof ArrayBuffer) return new Uint8Array(c).join(',');
  return c instanceof Uint8Array ? c.join(',') : String(c);
};

/** Bytes in the log: text when they are UTF-8, otherwise the byte values. */
export type Packed = string | { bytes: number[] };
export type Status = 'ok' | 'timeout' | 'unreachable' | 'rejected' | 'skew';
export const STATUS: readonly Status[] = ['ok', 'timeout', 'unreachable', 'rejected', 'skew'];
export type Flags = Record<string, number | boolean>;
/** Where a run is in a trace: its own span, and the span that caused it. */
export type Span = {
  trace: string;
  span: string;
  parent: string | null;
  name: string | null;
  at: number;
  /** when the run began, in µs since 1970, from the fine clock below (absent in logs from before it) */
  at_us?: number;
};

/** The first entry of a run: which build ran, under which flag values, and (for a method) the message it got. */
export type Head = Partial<Span> & {
  build: string;
  flags: Flags;
  method?: string;
  message?: Packed;
  took?: number;
  /** how long the run took in µs, from the fine clock (absent in logs from before it) */
  took_us?: number;
  /** the memory the run used */
  bytes?: number;
  /** the steps the run took, of the 50,000,000 a run may take: the module's `cost` when it ended, or stopped */
  steps?: number;
  /** which step accounting produced `steps`; absent in a log from before the tag. A positive integer the module
   * carried, not the compiler's list: the host does not import the compiler. */
  step_version?: number;
  undone?: true;
  woke?: { key: number; due: number };
};
/** The memory and steps of a run, as its log's first line says them. The step version is written only when the
 * module that ran carried one. */
export const measuredText = (e: Pick<Head, 'bytes' | 'steps' | 'step_version'>): string => {
  const version = e.step_version === undefined ? '' : `, step version ${e.step_version}`;
  return `${e.bytes ?? '?'} bytes of memory, ${e.steps ?? '?'} steps${version}`;
};

/** `undone`: a write that its run's rollback(out) or trap undid (the host marks it; host/run.ts, markUndone) */
export type SqlEffect = { q: number; p: SqlParam[]; r?: number; rows?: Cell[][]; undone?: true };
export type CallEffect = {
  call: string;
  method: string;
  send: Packed;
  within: number;
  once?: string | number;
  status: Status;
  reply: Packed;
  sent: number;
  took: number;
  /** sent and took in µs, from the fine clock (absent in logs from before it) */
  sent_us?: number;
  took_us?: number;
};
/** An HTTP request a program made (std/http.tape fetch): the request as sent, but with every secret value the run
 * read written `[secret <name>]` (url, header values, body), and the reply. `reply` is, for ok, the reply's head as
 * JSON, a line feed and its body, with each secret value the run read held as a mark (host/secrets.ts), so the log
 * holds no secret; a replay puts the values back. For any other status it is why. */
export type FetchEffect = {
  fetch: string;
  method: string;
  headers: { name: string; value: string }[];
  body: Packed;
  within: number;
  key?: string;
  status: Status;
  reply: Packed;
  sent: number;
  took: number;
  sent_us?: number;
  took_us?: number;
};
/** A secret read: its name and the version given (null: none of that name), never its value. */
export type SecretEffect = { secret: string; version: number | null };
export type NowEffect = { now: number };
export type RandomEffect = { random: number };
/** `undone`: a timer its run's rollback(out) or trap undid (its host-store row was rolled back; host/run.ts, markUndone) */
export type WakeEffect = { wake: number; after: number; due: number; undone?: true };
export type Effect = Head | SqlEffect | CallEffect | FetchEffect | SecretEffect | NowEffect | RandomEffect | WakeEffect;

/** One thing a traced run did, in order. `what` at a site: 2 the function was entered, 0 an arm or step was tried, 1 it matched. */
export type TraceEvent =
  | { site: number; what: number }
  | { sql: number; p: SqlParam[]; r?: number | undefined; rows?: Cell[][] | undefined; undone?: true }
  | { call: string; method: string; within: number; status: Status }
  | { fetch: string; method: string; within: number; status: Status }
  | SecretEffect
  | { flags: Flags }
  | NowEffect
  | RandomEffect
  | WakeEffect;

const TAGS = ['build', 'q', 'call', 'fetch', 'secret', 'now', 'random', 'wake'];
/** Is this value, read from a stored log, an entry of an effect log? Told by the field that names its kind. */
export const isEffect = (v: unknown): v is Effect => typeof v === 'object' && v !== null && TAGS.some(tag => tag in v);
export const isHead = (e: Effect): e is Head => 'build' in e;
export const isSql = (e: Effect): e is SqlEffect => 'q' in e;
export const isCall = (e: Effect): e is CallEffect => 'call' in e;
export const isFetch = (e: Effect): e is FetchEffect => 'fetch' in e;
export const isSecret = (e: Effect): e is SecretEffect => 'secret' in e;
export const isNow = (e: Effect): e is NowEffect => 'now' in e;
export const isRandom = (e: Effect): e is RandomEffect => 'random' in e;
export const isWake = (e: Effect): e is WakeEffect => 'wake' in e;

// a leading U+FEFF is kept: it is part of the bytes (host/memory.ts)
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const enc = new TextEncoder();
export const pack = (b: Uint8Array): Packed => {
  try {
    return utf8.decode(b);
  } catch {
    return { bytes: [...b] };
  }
};
export const unpack = (v: Packed): Uint8Array<ArrayBuffer> =>
  typeof v === 'string' ? Uint8Array.from(enc.encode(v)) : Uint8Array.from(v.bytes);

// Distributed tracing. Every request is a span: its effect log starts with { trace, span, parent, name, at } and
// ends up with `took`. Each call passes { trace, parent: this span } to the callee, whose log is the child span.
// Ids have the sizes of W3C traceparent (32 and 16 hex digits). `sink(log)` receives every finished log; spans()
// below joins logs from any number of objects into trees, and traceOf() expands any one span to every function
// and match arm, after the fact, from its log alone.
export const hex = (n: number): string =>
  [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');

export type From = { trace: string; parent: string } | null;
// The fine clock: µs since 1970, for traces only. `at`, `sent` and `took` stay Date.now() milliseconds, as every
// reader of a log expects; the *_us fields beside them say the same to the microsecond, so a span of 0.3 ms is not
// 0. Nothing a program sees or a replay compares reads them: a program's own time is the `now` effect, and
// replay answers from the recorded entries. In Node, performance.now() moves with the CPU; in a Worker it moves
// only across I/O (as Date.now() does there), so a run with no I/O still reads 0 µs.
export const clockUs = (): number => Math.round((performance.timeOrigin + performance.now()) * 1000);

export const begin = (from: From, name: string | null): Span => ({
  trace: from?.trace ?? hex(16),
  span: hex(8),
  parent: from?.parent ?? null,
  name,
  at: Date.now(),
  at_us: clockUs(),
});

export type SpanTree = Head & {
  log: Effect[];
  calls: { to: string; method: string; status: Status; took: number }[];
  children: SpanTree[];
};
/** The logs of any number of objects, joined into trees: each run under the run that called it. */
export function spans(logs: readonly Effect[][]): SpanTree[] {
  const all = logs.flatMap((log): SpanTree[] => {
    const [head] = log;
    if (!head || !isHead(head)) return [];
    const calls = log.filter(isCall).map(e => ({ to: e.call, method: e.method, status: e.status, took: e.took }));
    return [{ ...head, log, calls, children: [] }];
  });
  const by = new Map(all.map(s => [s.span, s]));
  for (const s of all) by.get(s.parent ?? undefined)?.children.push(s);
  for (const s of all) s.children.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  return all.filter(s => !by.has(s.parent ?? undefined));
}
