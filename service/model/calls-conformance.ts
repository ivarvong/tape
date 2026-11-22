// Checks the calls between programs in real traces against the calls model (model/calls.ts): for each once key, at
// most one callee run commits; every answer a caller got that says the callee ran (ok, rejected) is the reply that
// run stored. A non-deduplicated ok/rejected answer whose run is not in the traces is a violation; a deduplicated one
// with no run and no stored reply in the traces is counted as unverifiable (run_not_in_traces), not as a pass. Input: OTLP traces as the service's trace view
// exports them (callee runs are SERVER spans carrying tape.call.key; caller calls are CLIENT spans).
import { spans } from '../jepsen/traces.ts';
import type { Span, Value } from '../jepsen/traces.ts';

/** One callee run that kept its request: its id, the reply it stored, whether it failed. */
type Run = { id: Value; status: Value; failed: boolean; at: number };
/** One call a caller made, and what it was told. */
type Call = { key: Value; status: Value; dedup: boolean; at: number };
export type Violation = { type: string; key: Value; [evidence: string]: unknown };
export type Stats = Record<
  'keys' | 'runs' | 'failed_runs' | 'calls' | 'answered_ran' | 'other' | 'run_not_in_traces',
  number
>;
export type Conformed = { conforms: boolean; violations: Violation[]; stats: Stats };
/** What the traces show, by once key: the runs (one per request id), the stored replies answered again, and the calls. */
type Read = { runs: Map<Value, Map<Value, Run>>; stored: Map<Value, Set<Value>>; calls: Call[] };
const truthy: (v: unknown) => boolean = Boolean;

const note = (read: Read, sp: Span): void => {
  const key = sp.attrs['tape.call.key'],
    dedup = truthy(sp.attrs['tape.call.deduplicated']);
  if (!truthy(key)) return;
  if (sp.kind === 2 && truthy(sp.attrs['tape.request_id']) && !dedup) {
    // one callee run, seen once per trace that includes it: keep one per request id
    const m = read.runs.get(key) ?? new Map<Value, Run>();
    m.set(sp.attrs['tape.request_id'], {
      id: sp.attrs['tape.request_id'],
      status: sp.attrs['tape.call.reply_status'],
      failed: truthy(sp.attrs['tape.run.failed']),
      at: sp.start,
    });
    read.runs.set(key, m);
  } else if (sp.kind === 2 && dedup) {
    // the callee's stored reply, answered again without a run
    const m = read.stored.get(key) ?? new Set<Value>();
    m.add(sp.attrs['tape.call.reply_status']);
    read.stored.set(key, m);
  } else if (sp.kind === 3) read.calls.push({ key, status: sp.attrs['tape.call.status'], dedup, at: sp.start });
};
/** charged-at-most-once: a key's message runs to a commit once, and a stored reply is that run's. */
const keyViolations = (read: Read, stats: Stats): Violation[] => {
  const out: Violation[] = [];
  for (const [key, m] of read.runs) {
    const done = [...m.values()].filter(r => !r.failed),
      [first] = done;
    stats.runs += m.size;
    stats.failed_runs += m.size - done.length;
    if (done.length > 1) out.push({ type: 'key-committed-twice', key, runs: done });
    const st = read.stored.get(key);
    if (st && first && [...st].some(x => x !== first.status))
      out.push({ type: 'stored-reply-not-the-run', key, run: first, stored: [...st] });
  }
  return out;
};
/** ok-means-it-ran / failed-order-not-charged: an answer that says the callee ran names a committed run with that
 * reply. The traces cover the client's operations; a run inside a wake or another workflow step may not be among
 * them, and then the callee's stored reply (a deduplicated server span) is the evidence, if any. */
const callViolation = (read: Read, c: Call, stats: Stats): Violation | null => {
  const done = [...(read.runs.get(c.key)?.values() ?? [])].filter(r => !r.failed);
  if (done.length > 0)
    return done.some(r => r.status === c.status)
      ? null
      : { type: 'answer-not-the-stored-reply', key: c.key, call: c, stored: done.map(r => r.status) };
  const st = read.stored.get(c.key);
  if (st)
    return st.has(c.status) ? null : { type: 'answer-not-the-stored-reply', key: c.key, call: c, stored: [...st] };
  stats.run_not_in_traces++;
  return c.dedup ? null : { type: `${String(c.status)}-without-run`, key: c.key, call: c };
};
export function conformCalls(traces: Readonly<Record<string, unknown>>): Conformed {
  const read: Read = { runs: new Map(), stored: new Map(), calls: [] };
  for (const otlp of Object.values(traces)) for (const sp of spans(otlp)) note(read, sp);
  const stats: Stats = {
    keys: read.runs.size,
    runs: 0,
    failed_runs: 0,
    calls: read.calls.length,
    answered_ran: 0,
    other: 0,
    run_not_in_traces: 0,
  };
  const violations = keyViolations(read, stats);
  for (const c of read.calls) {
    if (c.status !== 'ok' && c.status !== 'rejected') {
      stats.other++;
      continue;
    }
    stats.answered_ran++;
    const violation = callViolation(read, c, stats);
    if (violation) violations.push(violation);
  }
  return { conforms: violations.length === 0, violations, stats };
}
