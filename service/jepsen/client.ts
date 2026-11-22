// The HTTP client of the production runners (run.ts, seams-run.ts). Two kinds of request, kept apart:
//  - an operation of the workload (it carries the recorder's traceparent): sent once. Whatever happens is the
//    result: a response, a body that broke (status 0), or a thrown error the recorder writes as unknown (info). It
//    is never resent, so every router span of its trace is the client's one attempt (RUNTIME-SPEC.md, R-CLIENT-1).
//  - the runner's own requests (setup, fault plans, the final state, traces: no traceparent): resent on a failure
//    of the connection or the body, up to `tries` times with backoff, since the box's egress has failed TLS
//    mid-run (13:09 ET, 15 November 2026). Each resend is counted in `stats.runner_retries`, and one that still
//    fails throws a RunnerError, which the runner reports as such, never as a service answer.
// The token is sent only in the authorization header and never printed.
import { fields, messageOf, text } from './json.ts';

export class RunnerError extends Error {}
export const stats: {
  runner_retries: number;
  runner_errors: { method: string; path: string; why: string }[];
  clock_jumps: { at: string; wall_ms: number; mono_ms: number }[];
} = { runner_retries: 0, runner_errors: [], clock_jumps: [] };
// The box's wall clock against its monotonic clock, once a second: a jump of more than 2 s between them means the
// process was paused or the machine restored from a snapshot. Both happened in the run of 15 November 2026 11:50 ET
// (RUNTIME-SPEC.md, R-CLIENT-2): a restored client resends what it had already sent, with the same random trace ids.
// A run with a jump is marked so its anomalies are read with that in mind; it is not discarded.
{
  let wall = Date.now(),
    mono = performance.now();
  setInterval(() => {
    const w = Date.now(),
      m = performance.now(),
      skew = w - wall - (m - mono);
    if (Math.abs(skew) > 2000)
      stats.clock_jumps.push({ at: new Date(w).toISOString(), wall_ms: w - wall, mono_ms: Math.round(m - mono) });
    wall = w;
    mono = m;
  }, 1000).unref();
}
const sleep = (ms: number): Promise<void> =>
  new Promise(done => {
    setTimeout(done, ms);
  });

/** What a request came to: status 0 when the body broke; the body as JSON when it is JSON, else as text. */
export type Reply = { status: number; body: unknown; headers: Record<string, string> };
export type SendOptions = { headers?: Record<string, string>; signal?: AbortSignal };
export type Sender = (method: string, path: string, body?: unknown, options?: SendOptions) => Promise<Reply>;
export type SenderConfig = {
  base: string;
  token: string;
  route?: (path: string) => string;
  tries?: number;
  timeout?: number;
};
const parsed = (body: string): unknown => {
  try {
    const v: unknown = JSON.parse(body);
    return v;
  } catch {
    return body;
  }
};
const sent = (body: unknown): { body?: string } => {
  if (body === undefined) return {};
  return { body: typeof body === 'string' ? body : JSON.stringify(body) };
};
/** Why a request that threw failed: its message, and the cause's code when the connection failed. */
const whyOf = (err: unknown): string => {
  const cause = fields(fields(err).cause),
    more = text(cause.code) === '' ? text(cause.message) : text(cause.code);
  return `${messageOf(err)}${more === '' ? '' : `: ${more}`}`;
};

/** One attempt; `broke`: the response began and its body did not arrive. */
type Once = (method: string, path: string, body: unknown, o: SendOptions) => Promise<Reply & { broke: boolean }>;
const attemptWith =
  ({ base, token, route = p => p, timeout = 30000 }: SenderConfig): Once =>
  async (method, path, body, o) => {
    const t = AbortSignal.timeout(timeout);
    const res = await fetch(`${base}${route(path)}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...o.headers },
      ...sent(body),
      signal: o.signal ? AbortSignal.any([o.signal, t]) : t,
    });
    const headers = Object.fromEntries(res.headers);
    try {
      return { status: res.status, body: parsed(await res.text()), headers, broke: false };
    } catch (e) {
      return { status: 0, body: { error: `the body broke: ${messageOf(e)}` }, headers, broke: true };
    }
  };
/** A sender that sends every request once: the KV workload's, whose resends are its clients' own. */
export const sendOnce = (config: SenderConfig): Sender => {
  const once = attemptWith(config);
  return async (method, path, body, options = {}) => {
    const { broke: _broke, ...r } = await once(method, path, body, options);
    return r;
  };
};
export const makeSender = (config: SenderConfig): Sender => {
  const once = attemptWith(config),
    tries = config.tries ?? 6;
  /** One attempt of a runner's own request: its reply, or why it must be sent again. */
  const tried = async (method: string, path: string, body: unknown, o: SendOptions): Promise<Reply | string> => {
    try {
      const { broke, ...r } = await once(method, path, body, o);
      return broke ? text(fields(r.body).error) : r;
    } catch (e) {
      return whyOf(e);
    }
  };
  return async (method, path, body, options = {}) => {
    if (options.headers?.traceparent !== undefined && options.headers.traceparent !== '') {
      const { broke: _broke, ...r } = await once(method, path, body, options);
      return r;
    }
    for (let attempt = 1; ; attempt++) {
      const r = await tried(method, path, body, options);
      if (typeof r !== 'string') return r;
      if (attempt >= tries) {
        stats.runner_errors.push({ method, path, why: r });
        throw new RunnerError(`runner request ${method} ${path} failed ${tries} times: ${r}`);
      }
      stats.runner_retries++;
      process.stderr.write(`runner retry ${attempt} ${method} ${path}: ${r}\n`);
      await sleep(1000 * 2 ** (attempt - 1));
    }
  };
};
