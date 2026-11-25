// host/call.ts: one call out of a program, made by the host with the call's time budget.
//
// `services` maps each Remote parameter, by name, to async (bytes, { method, fingerprint, key, withinMs, signal })
// => the reply's JSON bytes, or { status: 'ok' | 'rejected' | 'skew', body: bytes }. A service that throws gave no
// reply: the callee may have run and committed (a connection lost after it answered, an object reset before its
// reply went out), so the outcome is unknown and the call is a Timeout, never a Rejected; only the callee says
// Rejected.
import { clockUs, pack } from './log.ts';
import type { CallEffect, FetchEffect, From, Status } from './log.ts';

/** A service may throw this to say "no answer in time" at once, without the clock: tests and the schedule explorer use it. */
export class TimedOut extends Error {}

export type ServiceOptions = {
  method: string;
  fingerprint: string;
  key: string | null;
  withinMs: number;
  signal: AbortSignal;
  trace: From;
};
export type ServiceReply = Uint8Array | ArrayBuffer | { status: string; body?: Uint8Array | ArrayBuffer | null };
export type Service = (bytes: Uint8Array, options: ServiceOptions) => ServiceReply | Promise<ServiceReply>;
// How a call's time budget is kept. The simulator passes timers that never fire: there the simulator decides when a
// reply is late, by its own clock, and a real timer would let the machine's speed into a run.
export type Timers = { set: (f: () => void, ms: number) => unknown; clear: (timer: unknown) => void };
export const REAL_TIMERS: Timers = {
  set: (f, ms) => {
    const timer = setTimeout(f, ms);
    return (): void => {
      clearTimeout(timer);
    };
  },
  clear: cancel => {
    if (typeof cancel === 'function') Reflect.apply(cancel, undefined, []);
  },
};
export const NO_TIMERS: Timers = { set: () => null, clear: () => {} };

/** A call the program asked for whose reply is not in the log: the run stops so the host can make it. */
export class Pending extends Error {
  readonly to: string;
  readonly send: Uint8Array<ArrayBuffer>;
  readonly within: number;
  readonly method: string;
  readonly fingerprint: string;
  readonly once: string | number | undefined;
  constructor(p: {
    to: string;
    send: Uint8Array<ArrayBuffer>;
    within: number;
    method: string;
    fingerprint: string;
    once?: string | number;
  }) {
    super(`a call to ${p.to} is waiting for its reply`);
    this.to = p.to;
    this.send = p.send;
    this.within = p.within;
    this.method = p.method;
    this.fingerprint = p.fingerprint;
    this.once = p.once;
  }
}

/** An HTTP request a program asked for (std/http.tape fetch), as the host sends it. */
export type HttpRequest = {
  method: string;
  url: string;
  headers: [string, string][];
  body: Uint8Array;
  /** sent as Idempotency-Key; every method but GET and HEAD has one */
  key: string | null;
};
/** What became of it: the reply, whatever its status, or why the host would not send it. */
export type HttpAnswer = { status: number; headers: [string, string][]; body: Uint8Array } | { refused: string };
/**
 * Where a host's HTTP requests go: the service's allow-list and Workers' fetch, a stub that answers from a table
 * (tests, the simulator, the command line), or nothing. A client that throws gave no reply: the request may have been
 * received, so the program sees Timeout, as for a call.
 */
export type HttpClient = (
  request: HttpRequest,
  options: { withinMs: number; signal: AbortSignal; trace: From },
) => HttpAnswer | Promise<HttpAnswer>;
/** The limits every host keeps: a request's body, a reply's body, and a reply's headers. */
export const HTTP_LIMITS = { body: 64 * 1024, reply: 1024 * 1024, headers: 32, head: 16384 } as const;

/** One answer of a stub: the status (200), the headers, the body as text. */
export type StubAnswer = {
  status?: number;
  headers?: Readonly<Record<string, string>> | readonly (readonly [string, string])[];
  body?: string;
};
/**
 * An HttpClient that answers from a table and never reaches a network: by "METHOD URL", else by the URL alone;
 * a request the table has no answer for is refused, as a host not on a list is. For the command line, the
 * simulator, the hosted runner and tests.
 */
export function stubHttp(table: Readonly<Record<string, StubAnswer>>): HttpClient {
  const enc8 = new TextEncoder();
  return request => {
    const a = table[`${request.method} ${request.url}`] ?? table[request.url];
    if (!a) return { refused: `host not allowed: no stub answer for ${request.method} ${request.url}` };
    const given: readonly (readonly [unknown, unknown])[] = Array.isArray(a.headers)
      ? a.headers
      : Object.entries(a.headers ?? {});
    const headers = given.map(([n, v]): [string, string] => [String(n), String(v)]);
    return { status: a.status ?? 200, headers, body: enc8.encode(a.body ?? '') };
  };
}

/** A fetch the program asked for whose reply is not in the log: the run stops so the host can make it. */
export class FetchPending extends Error {
  readonly request: HttpRequest;
  /** the entry as it is logged, without its outcome: every secret value the run read written out of it */
  readonly logged: Omit<FetchEffect, 'status' | 'reply' | 'sent' | 'took' | 'sent_us' | 'took_us'>;
  constructor(request: HttpRequest, logged: FetchPending['logged']) {
    super(`a fetch of ${logged.fetch} is waiting for its reply`);
    this.request = request;
    this.logged = logged;
  }
}

export type Caller = {
  services: Readonly<Record<string, Service>>;
  name: string | null;
  timers: Timers;
  http?: HttpClient | null;
};
const enc = new TextEncoder();
const NONE = new Uint8Array(0);
const isStatus = (s: string): s is Status => s === 'ok' || s === 'rejected' || s === 'skew' || s === 'unreachable';
/** The budget ran out before the reply came. */
class Late extends Error {}
const isCut = (err: unknown): boolean => typeof err === 'object' && err !== null && 'cut' in err && Boolean(err.cut);
const messageOf = (err: unknown): string =>
  typeof err === 'object' && err !== null && 'message' in err ? String(err.message) : String(err);

/** What a service's answer is: its bytes are an ok; otherwise the status it gave and its body. */
function answered(reply: unknown): [Status, Uint8Array] {
  if (reply instanceof Uint8Array || reply instanceof ArrayBuffer) return ['ok', new Uint8Array(reply)];
  const status = typeof reply === 'object' && reply !== null && 'status' in reply ? reply.status : undefined;
  if (typeof status !== 'string' || !isStatus(status))
    return ['skew', enc.encode('the service answered with neither bytes nor { status, body }')];
  const body = typeof reply === 'object' && reply !== null && 'body' in reply ? reply.body : undefined;
  return [status, body instanceof Uint8Array || body instanceof ArrayBuffer ? new Uint8Array(body) : NONE];
}

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** Request headers the host writes itself (the framing, the hop, the key), or that a client must not choose. */
const OWN_REQUEST =
  /^(host|content-length|transfer-encoding|connection|keep-alive|upgrade|te|trailer|expect|proxy-.*|idempotency-key|forwarded|x-forwarded-.*|x-real-ip|true-client-ip|cf-.*)$/;
/** Why the host will not send this request, or null: the same refusals on every host, before any client sees it. */
export function refusalOf(r: HttpRequest): string | null {
  if (!TOKEN.test(r.method) || r.method === 'CONNECT' || r.method === 'TRACE')
    return `${r.method.slice(0, 32)} is not a method a program may send`;
  let url: URL;
  try {
    url = new URL(r.url);
  } catch {
    return 'the URL does not parse';
  }
  if (url.protocol !== 'https:') return 'only https URLs are fetched';
  if (url.username !== '' || url.password !== '') return 'a URL with a user or a password is not fetched';
  const bodiless = r.method === 'GET' || r.method === 'HEAD';
  if (!bodiless && r.key === null)
    return `a ${r.method} carries key: Some(…), sent as Idempotency-Key, so a request sent again after a Timeout can be told for a repeat`;
  if (r.key !== null && (r.key.length === 0 || r.key.length > 255 || /[^ -~]/.test(r.key)))
    return 'a key is 1 to 255 printable ASCII characters';
  if (bodiless && r.body.length > 0) return `a ${r.method} has no body`;
  if (r.body.length > HTTP_LIMITS.body) return `a request's body is at most ${HTTP_LIMITS.body} bytes`;
  if (r.headers.length > HTTP_LIMITS.headers) return `a request has at most ${HTTP_LIMITS.headers} headers`;
  let size = 0;
  for (const [name, value] of r.headers) {
    size += name.length + value.length;
    if (!TOKEN.test(name) || name.length > 64) return `invalid header name ${JSON.stringify(name.slice(0, 64))}`;
    if (/[^\t -~]/.test(value) || value.length > 4096) return `invalid header value for ${name}`;
    if (OWN_REQUEST.test(name.toLowerCase())) return `${name.toLowerCase()} is the host's to set`;
  }
  if (size > HTTP_LIMITS.head) return `a request has at most ${HTTP_LIMITS.head} bytes of headers`;
  return null;
}

/** A reply as the module reads it (std/http.tape reply_of): the status, `name:value` lines, an empty line, the body. */
export function replyWire(status: number, headers: readonly [string, string][], body: Uint8Array): Uint8Array {
  const line = (t: string): string => t.replaceAll(/[\r\n]/g, ' ');
  const head = enc.encode(`${status}\n${headers.map(([n, v]) => `${line(n.toLowerCase())}:${line(v)}\n`).join('')}\n`);
  const out = new Uint8Array(head.length + body.length);
  out.set(head);
  out.set(body, head.length);
  return out;
}

/** Makes the request through the host's HTTP client; gives the entry for the log, its reply held by `hold`. */
export async function performFetch(
  c: Caller,
  p: FetchPending,
  trace: From,
  left: number,
  hold: (reply: Uint8Array) => Uint8Array,
): Promise<FetchEffect> {
  const began = Date.now(),
    beganUs = clockUs();
  const entry = (status: Status, reply: Uint8Array): FetchEffect => ({
    ...p.logged,
    status,
    reply: pack(reply),
    sent: began,
    took: Date.now() - began,
    sent_us: beganUs,
    took_us: clockUs() - beganUs,
  });
  const refused = refusalOf(p.request);
  if (refused !== null) return entry('rejected', enc.encode(refused));
  if (!c.http) return entry('unreachable', enc.encode('this host makes no HTTP requests'));
  const budget = Math.min(p.logged.within, left);
  if (budget <= 0) return entry('timeout', NONE);
  const stop = new AbortController();
  let timer: unknown = null;
  const client = c.http;
  try {
    const sent = Promise.resolve().then(() => client(p.request, { withinMs: budget, signal: stop.signal, trace }));
    sent.catch(() => {});
    const tooLate = new Promise<never>((_, no) => {
      timer = c.timers.set(() => {
        no(new Late());
      }, budget);
    });
    const got = await Promise.race([sent, tooLate]);
    if ('refused' in got) return entry('rejected', enc.encode(got.refused));
    if (got.body.length > HTTP_LIMITS.reply)
      return entry('rejected', enc.encode(`a reply's body is at most ${HTTP_LIMITS.reply} bytes`));
    return entry('ok', hold(replyWire(got.status, got.headers, got.body)));
  } catch (err) {
    stop.abort();
    if (isCut(err)) throw err;
    return entry('timeout', NONE);
  } finally {
    c.timers.clear(timer);
  }
}

/** Makes the call; gives the entry for the log. `left`: what remains of the whole request's time. */
export async function perform(c: Caller, p: Pending, trace: From, left: number): Promise<CallEffect> {
  const began = Date.now(),
    beganUs = clockUs();
  // sent: when the call went out, so a trace can place it (the run's own clock only moves across I/O like this)
  const entry = (status: Status, reply: Uint8Array): CallEffect => ({
    call: p.to,
    method: p.method,
    send: pack(p.send),
    within: p.within,
    ...(p.once === undefined ? {} : { once: p.once }),
    status,
    reply: pack(reply),
    sent: began,
    took: Date.now() - began,
    sent_us: beganUs,
    took_us: clockUs() - beganUs,
  });
  const service = c.services[p.to];
  const budget = Math.min(p.within, left);
  if (!service) return entry('unreachable', NONE);
  if (budget <= 0) return entry('timeout', NONE);
  if (p.once !== undefined && c.name === null)
    throw new Error(
      `this program sends commands (call ... once:); pass instantiate a name for this object, so its keys cannot collide with another caller's`,
    );
  const stop = new AbortController();
  const key = p.once === undefined ? null : `${c.name}/${p.method}/${p.once}`;
  const options = { method: p.method, fingerprint: p.fingerprint, key, withinMs: budget, signal: stop.signal, trace };
  let timer: unknown = null;
  try {
    const sent = Promise.resolve().then(() => service(p.send, options));
    sent.catch(() => {}); // after a timeout nobody waits for it; its failure is not an unhandled rejection
    const tooLate = new Promise<never>((_, no) => {
      timer = c.timers.set(() => {
        no(new Late());
      }, budget);
    });
    return entry(...answered(await Promise.race([sent, tooLate])));
  } catch (err) {
    stop.abort();
    // sim.ts only: the caller's object was reset while it waited. The run ends here; what it committed stays.
    if (isCut(err)) throw err;
    // no reply: the budget ran out, or the transport failed; either way the callee may have run
    return entry('timeout', err instanceof Late || err instanceof TimedOut ? NONE : enc.encode(messageOf(err)));
  } finally {
    c.timers.clear(timer);
  }
}
