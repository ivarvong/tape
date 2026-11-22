// host/call.ts: one call out of a program, made by the host with the call's time budget.
//
// `services` maps each Remote parameter, by name, to async (bytes, { method, fingerprint, key, withinMs, signal })
// => the reply's JSON bytes, or { status: 'ok' | 'rejected' | 'skew', body: bytes }. A service that throws gave no
// reply: the callee may have run and committed (a connection lost after it answered, an object reset before its
// reply went out), so the outcome is unknown and the call is a Timeout, never a Rejected; only the callee says
// Rejected.
import { clockUs, pack } from './log.ts';
import type { CallEffect, From, Status } from './log.ts';

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

export type Caller = { services: Readonly<Record<string, Service>>; name: string | null; timers: Timers };
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
    return ['rejected', enc.encode('the service answered with neither bytes nor { status, body }')];
  const body = typeof reply === 'object' && reply !== null && 'body' in reply ? reply.body : undefined;
  return [status, body instanceof Uint8Array || body instanceof ArrayBuffer ? new Uint8Array(body) : NONE];
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
