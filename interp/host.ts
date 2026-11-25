// interp/host.ts: where the reference interpreter's effects go, and how a run stops.
import type { Cell } from './json.ts';

export class Trap extends Error {
  readonly code: number;
  /** what a trap says beyond its number, as the host says it (host/run.ts stopped): a trap 9's function and depth */
  readonly detail: string | null;
  constructor(code: number, detail: string | null = null) {
    super(`trap ${code}`);
    this.code = code;
    this.detail = detail;
  }
}
/** The longest a timer may be set for: 30 days. */
export const MAX_WAKE_MS = 30 * 24 * 3600 * 1000;

export type SqlParam = number | string | null;
export type CallStatus = 'ok' | 'timeout' | 'unreachable' | 'rejected' | 'skew';
export type CallRequest = { to: string; method: string; send: Uint8Array; within: number; once?: string };
/** Each effect is asked of the host when the program reaches it, in order. */
export type Host = {
  flags: Readonly<Record<string, number | bigint | boolean | string>>;
  /** run a statement for its count of rows changed */
  exec(sql: string, params: SqlParam[]): number;
  /** run a statement for its rows */
  rows(sql: string, params: SqlParam[]): Cell[][];
  call(request: CallRequest): { status: CallStatus; reply: Uint8Array };
  /** set a timer; gives the delay it was set for */
  wake(key: number, after: number): number;
  now(): number;
  random(): number;
  /** a secret's value, or null for none (the host logs the version, never the value) */
  secret?(name: string): Uint8Array | null;
};
export type Source = { name: string; text: string };
