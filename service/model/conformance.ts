// Trace conformance: the runs that the traces of a KV Jepsen history show, replayed per key in the shard's order
// (each run's start on the shard's clock; one shard runs one request at a time) through the step rules of the
// protocol model (model/kv.ts: the op-id record, the window, the prune), extended with what the model leaves out
// for brevity: compare-and-set (?if=), deletes and reads. Every run must be one the model allows from the state the
// runs before it left: a commit at the next version, of an op id the shard has no record of, inside its window; a
// replay answering its op's commit; a refusal only when the model refuses; a read of the current version.
// A run the trace cannot know (marked unknown) may have committed: a later commit may skip one version per such run.
import { checkOpTrace } from '../jepsen/kv.ts';
import type { Attempt, Cluster, Effect } from '../jepsen/kv.ts';
import { OP_ID } from '../jepsen/retention.ts';
import { windowAnswer, pruneCutoff } from './kv.ts';

/** A key as the runs so far left it: its version, whether it is live, its value, the op ids on record, and how
 * many runs the traces cannot know (each may have committed). */
type KeyState = {
  v: unknown;
  live: unknown;
  value: unknown;
  ops: Map<string, { v: unknown; t: number | null }>;
  unknown: number;
};
/** One run: the attempt, and what its trace shows it did. */
type Seen = { h: Attempt; e: Effect };
type Kind = 'read' | 'commit' | 'replay' | 'rolled_back' | 'refusal';
type Objection = [type: string, extra?: Record<string, unknown>];
type Stepped = { s: KeyState; errs: Objection[]; kind: Kind; timed?: boolean };
type Rules = { window: number; skew: number };
export type Violation = {
  type: string;
  key: string;
  trace: string;
  once: string | undefined;
  f: Attempt['f'];
  effect: Effect;
  [extra: string]: unknown;
};
export type Stats = Record<
  Kind | 'keys' | 'runs' | 'unknown' | 'timed' | 'legacy' | 'tied_groups' | 'tied_reordered',
  number
>;
export type Conformed = { conforms: boolean; violations: Violation[]; stats: Stats };

/** Whether a write's condition (?if=) holds: a put with none always, with 0 only when the key was never written. */
const conditionHolds = (s: KeyState, h: Attempt): boolean => {
  const exp = h.expect;
  if (h.f !== 'put') return s.live === 1 && (exp === undefined || s.v === exp);
  if (exp === undefined) return true;
  return exp === 0 ? s.v === 0 : s.v === exp;
};
/** The time in a timed op id, or null. */
const stampOf = (h: Attempt): number | null => {
  const stamp = h.once === undefined ? undefined : OP_ID.exec(h.once)?.[1];
  return stamp === undefined ? null : Number(stamp);
};
/** A commit: at the next version (or past one version per unknown run), recorded under its op id, then the prune. */
const committed = (s: KeyState, { h, e }: Seen, model: string, stamp: number | null, rules: Rules): Stepped => {
  const errs: Objection[] = [];
  if (model !== 'commit') errs.push([`commit-where-model-${model}s`]);
  const gap = Number(e.version) - (Number(s.v) + 1);
  if (gap < 0 || gap > s.unknown) errs.push(['commit-not-at-next-version', { gap }]);
  else s.unknown -= gap;
  s.v = e.version;
  s.live = e.live;
  s.value = e.value;
  if (h.once !== undefined && h.once !== '') s.ops.set(h.once, { v: e.version, t: stamp });
  if (stamp !== null) {
    const cut = pruneCutoff(e.at ?? Number.NaN, rules.window, rules.skew);
    for (const [op, r] of s.ops) if (r.t !== null && r.t < cut) s.ops.delete(op);
  }
  return { s, errs, kind: 'commit', timed: stamp !== null };
};
// One run, from the state the runs before it left: the new state and what the model objects to (empty: allowed).
function step(s0: KeyState, x: Seen, rules: Rules): Stepped {
  const s = { ...s0, ops: new Map(s0.ops) },
    { h, e } = x;
  if (h.f === 'get') {
    const stale =
      e.kind === 'read' && (e.version !== s.v || e.live !== s.live || (Boolean(s.live) && e.value !== s.value));
    return { s, errs: stale ? [['read-not-current']] : [], kind: 'read' };
  }
  const stamp = stampOf(h),
    timed = stamp !== null;
  const refused = stamp === null ? null : windowAnswer(stamp, e.at ?? Number.NaN, rules.window, rules.skew);
  const known = h.once === undefined || h.once === '' ? undefined : s.ops.get(h.once);
  const allowed = known === undefined ? (conditionHolds(s, h) ? 'commit' : 'no-match') : 'replay';
  const model = refused === null ? allowed : 'refuse';
  if (e.kind === 'committed') return committed(s, x, model, stamp, rules);
  if (e.kind === 'replayed') {
    if (known === undefined || model !== 'replay')
      return { s, errs: [[`replay-where-model-${model}s`]], kind: 'replay', timed };
    const errs: Objection[] = known.v === e.version ? [] : [['replay-not-its-commit', { commit: known.v }]];
    return { s, errs, kind: 'replay', timed };
  }
  if (e.kind === 'none' && e.rolled_back === true) return { s, errs: [], kind: 'rolled_back', timed };
  const errs: Objection[] =
    e.kind === 'none' && e.why === 'the write matched no row' && model !== 'no-match'
      ? [[`no-match-where-model-${model}s`]]
      : [];
  return { s, errs, kind: 'refusal', timed };
}
const permutations = <T>(xs: readonly T[]): T[][] =>
  xs.length <= 1
    ? [[...xs]]
    : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map(p => [x, ...p]));

/** The runs of one order through the model, from a state: where they end, each step, and every objection. */
type Tried = { t: KeyState; steps: Stepped[]; errs: Violation[] };
const tryOrder = (from: KeyState, order: readonly Seen[], key: string, rules: Rules): Tried => {
  const steps: Stepped[] = [],
    errs: Violation[] = [];
  let t = from;
  for (const x of order) {
    const r = step(t, x, rules);
    t = r.s;
    steps.push(r);
    errs.push(
      ...r.errs.map(([type, extra]) => ({
        type,
        key,
        trace: x.h.trace,
        once: x.h.once,
        f: x.h.f,
        effect: x.e,
        ...extra,
      })),
    );
  }
  return { t, steps, errs };
};
/** Runs with the same start, in the first order the model accepts; in the traces' order when it accepts none. */
const tied = (s: KeyState, g: readonly Seen[], key: string, rules: Rules): Tried & { reordered: boolean } => {
  const first = tryOrder(s, g, key, rules);
  if (first.errs.length === 0 || g.length <= 1 || g.length > 6) return { ...first, reordered: false };
  for (const order of permutations(g).slice(1)) {
    const tried = tryOrder(s, order, key, rules);
    if (tried.errs.length === 0) return { ...tried, reordered: true };
  }
  return { ...first, reordered: false };
};
const NO_STATS: Stats = {
  keys: 0,
  runs: 0,
  read: 0,
  commit: 0,
  replay: 0,
  refusal: 0,
  rolled_back: 0,
  unknown: 0,
  timed: 0,
  legacy: 0,
  tied_groups: 0,
  tied_reordered: 0,
};
/** The runs of one key that have a start, grouped by it, earliest first. */
const byStart = (runs: readonly Seen[]): Seen[][] =>
  [
    ...Map.groupBy(
      runs.filter(x => x.e.at !== undefined),
      x => x.e.at ?? 0,
    ),
  ]
    .toSorted((a, b) => a[0] - b[0])
    .map(g => g[1]);
export type Options = Cluster & { shards: number; window?: number; skew?: number };
export function conform(
  history: readonly Attempt[],
  traces: ReadonlyMap<string, unknown> | Readonly<Record<string, unknown>>,
  { account, cluster, shards, window = 3600000, skew = 300000 }: Options,
): Conformed {
  const traceOf = (id: string): unknown => (traces instanceof Map ? traces.get(id) : Reflect.get(traces, id));
  const events: Seen[] = history.map(h => ({
      h,
      e: checkOpTrace(h, traceOf(h.trace) ?? null, { account, cluster, shards }).effect,
    })),
    violations: Violation[] = [],
    stats = { ...NO_STATS },
    rules = { window, skew };
  for (const [key, runs] of Map.groupBy(events, x => x.h.key)) {
    stats.keys++;
    const unknown = runs.filter(x => x.h.f !== 'get' && x.e.kind === 'unknown').length;
    stats.unknown += unknown;
    let s: KeyState = { v: 0, live: 0, value: undefined, ops: new Map(), unknown };
    // runs with the same start (the platform's clock does not move while a request runs, so ties occur) are taken
    // in whichever order the model accepts, if any
    for (const g of byStart(runs)) {
      if (g.length > 1) stats.tied_groups++;
      const chosen = tied(s, g, key, rules);
      if (chosen.reordered) stats.tied_reordered++;
      // no order is allowed: the violations are those of the order the traces give
      violations.push(...chosen.errs);
      s = chosen.t;
      for (const r of chosen.steps) {
        stats.runs++;
        stats[r.kind]++;
        if (r.timed === true) stats.timed++;
        else if (r.timed === false) stats.legacy++;
      }
    }
  }
  return { conforms: violations.length === 0, violations, stats };
}
