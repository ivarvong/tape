// help.ts: what the tests share. A request to the service with or without the operator's token, a sender for the
// Jepsen workloads, and the readers for JSON that came back.
import { exports } from 'cloudflare:workers';
import { expect } from 'vitest';
import type { Reply, Sender } from '../jepsen/client.ts';
import { messageOf } from '../jepsen/json.ts';

export { at, fields, list, messageOf, num, text } from '../jepsen/json.ts';
export { seedsIn } from '../jepsen/seeds.ts';

export const auth = { authorization: 'Bearer test-token' };
export type Init = Omit<RequestInit, 'headers'> & { headers?: Record<string, string> };

/** A request with no token. */
export const anyone = (path: string, init?: RequestInit): Promise<Response> =>
  exports.default.fetch(`http://tape${path}`, init);
/** A request as the operator. */
export const call = (path: string, init?: Init): Promise<Response> =>
  anyone(path, { ...init, headers: { ...auth, ...init?.headers } });
/** A response's JSON, as a value of no known shape. */
export const json = async (res: Response): Promise<unknown> => {
  const body: unknown = await res.json();
  return body;
};
/** The JSON at a path, as the operator. */
export const got = async (path: string, init?: Init): Promise<unknown> => json(await call(path, init));
/** Text as JSON when it parses, as itself when it does not. */
export const parsed = (text: string): unknown => {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return text;
  }
};
const sent = (body: unknown): string | undefined => {
  if (body === undefined) return undefined;
  return typeof body === 'string' ? body : JSON.stringify(body);
};
/** A sender for a Jepsen workload: the path goes through `route` first. A body that breaks after the status line
 * leaves the client with headers and no answer it can use: status 0. */
export const senderVia =
  (route: (path: string) => string): Sender =>
  async (method, path, body, options): Promise<Reply> => {
    const payload = sent(body);
    const res = await call(route(path), {
      method,
      ...(options?.headers === undefined ? {} : { headers: options.headers }),
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
      ...(payload === undefined ? {} : { body: payload }),
    });
    const headers = Object.fromEntries(res.headers);
    try {
      return { status: res.status, body: parsed(await res.text()), headers };
    } catch (e) {
      return { status: 0, body: { error: `the body broke: ${messageOf(e)}` }, headers };
    }
  };
export const send: Sender = senderVia(path => path);
/** Wait this long. */
export const pause = (ms: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });
/** examples/tickets.tape with its first charge's budget, 50 ms, made 2000 ms (the budget its retries already have).
 * An idle machine answers that call in a few ms; one at load 40 can take longer than 50 (a cold object, a starved
 * core), and the buy then answers 504 for the machine's sake: a test that wanted 201, or the 503 of an unreachable
 * callee, fails, and a seams base run counts a retry's call that the others do not. A test whose subject is that
 * budget makes the timeout itself (within: 1) or injects it (src/faults.ts). */
export const roomy = (tickets: string): string => {
  const first = 'charge(id, section, qty, card, amount, within: 50)';
  if (!tickets.includes(first)) throw new Error(`examples/tickets.tape no longer has ${first}`);
  return tickets.replace(first, 'charge(id, section, qty, card, amount, within: 2000)');
};
/** Matchers for a value of a kind, whatever it is. */
export const anyString: unknown = expect.any(String);
export const anyNumber: unknown = expect.any(Number);
