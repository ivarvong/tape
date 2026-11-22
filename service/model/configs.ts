// Every model configuration that is checked: the correct protocol (must have no violation) and each historical bug,
// seeded by a flag (must be found, and by the invariant named). `small` bounds keep the test suite fast; the
// default bounds are the ones a full exploration runs (node service/model/run.ts).
import { explore } from './explore.ts';
import type { Explored } from './explore.ts';
import * as kv from './kv.ts';
import * as calls from './calls.ts';
import * as wipe from './wipe.ts';

const two: calls.Bounds = { runs: ['m1', 'm1'], restarts: 1 },
  three: calls.Bounds = { runs: ['m1', 'm1', 'm2'], restarts: 1 },
  big: calls.Bounds = { runs: ['m1', 'm1', 'm2'], restarts: 2 };
const kvSmall: kv.Bounds = { clients: 2, retries: 1, T: 3, W: 2, S: 1 };
/** One configuration: the model, a name, the bugs seeded, the bounds, the invariant that must be found broken
 * (null: none), the bug it seeds, and whether the small suite runs it. */
type Row<M, F, B> = readonly [
  model: M,
  name: string,
  flags: F,
  bounds: B,
  expect: string | null,
  bug: string | null,
  small: boolean,
];
export type Config =
  Row<'kv', kv.Flags, kv.Bounds> | Row<'calls', calls.Flags, calls.Bounds> | Row<'wipe', wipe.Flags, wipe.Bounds>;
export const CONFIGS: readonly Config[] = [
  // model, name, flags, bounds, expected violation (null: none), bug it seeds, run in the small suite
  ['kv', 'correct', {}, kv.DEFAULTS, null, null, false],
  ['kv', 'correct small', {}, kvSmall, null, null, true],
  [
    'kv',
    'r7',
    { r7: true },
    kv.DEFAULTS,
    'exactly-once',
    'R7: resend after a timeout replays nothing (no once key on the write)',
    true,
  ],
  [
    'kv',
    'h1',
    { h1: true },
    kv.DEFAULTS,
    'versions-grow-by-one',
    'H1: a run on a reset shard commits on the state it read before the reset',
    true,
  ],
  [
    'kv',
    'early',
    { early: true },
    kv.DEFAULTS,
    'exactly-once',
    'prune cutoff at or after now: a write prunes its own record',
    true,
  ],
  [
    'kv',
    'noWindow',
    { noWindow: true },
    kv.DEFAULTS,
    'exactly-once',
    'no 410 for an op id older than the window: a pruned op runs again',
    true,
  ],
  [
    'kv',
    'noSkew',
    { noSkew: true },
    kv.DEFAULTS,
    'exactly-once',
    'prune at now-W instead of now-W-S: a shard clock behind by S re-admits a pruned op',
    true,
  ],
  ['calls', 'correct twins', {}, two, null, null, true],
  ['calls', 'correct + other message', {}, three, null, null, true],
  ['calls', 'correct big', {}, big, null, null, false],
  [
    'calls',
    's2',
    { s2: true },
    two,
    'failed-order-not-charged',
    'S2: a callee whose commit failed answers rejected; the caller compensates a charge that may stand',
    true,
  ],
  [
    'calls',
    'h2',
    { h2: true },
    three,
    'ok-means-it-ran',
    "H2: a key reused for another message replays the first message's reply as ok",
    true,
  ],
  [
    'calls',
    'j4',
    { j4: true },
    two,
    'existing-order-not-404',
    'J4: a lost reply leaves the caller answering 404 for an order that exists',
    true,
  ],
  [
    'calls',
    'm1',
    { m1: true },
    three,
    'failed-order-not-charged',
    'M1: a key reused for another message answers rejected; the caller compensates while the first effect stands',
    true,
  ],
  ['wipe', 'correct', {}, wipe.DEFAULTS, null, null, true],
  [
    'wipe',
    'p2',
    { p2: true },
    wipe.DEFAULTS,
    'failed-means-kept',
    'P2: the stop overtakes the reply; the route reports failure for a deleted name',
    true,
  ],
  [
    'wipe',
    'nosync',
    { nosync: true },
    wipe.DEFAULTS,
    'deleted-means-gone',
    "no sync before the stop: deletes not yet durable are lost (under the model's flush assumption)",
    true,
  ],
  [
    'wipe',
    'p2+nosync',
    { p2: true, nosync: true },
    wipe.DEFAULTS,
    'deleted-means-gone',
    'the first delete pass as deployed',
    true,
  ],
];
/** What a search came to, whatever the model's state is. */
type Searched = Pick<Explored<unknown>, 'states' | 'transitions' | 'depth' | 'truncated'> & {
  found: string | null;
  counterexample: string[] | null;
};
const brief = <S>(r: Explored<S>): Searched => ({
  states: r.states,
  transitions: r.transitions,
  depth: r.depth,
  truncated: r.truncated,
  found: r.violation?.invariant ?? null,
  counterexample: r.violation?.path ?? null,
});
const searchKv = ([, , flags, bounds]: Row<'kv', kv.Flags, kv.Bounds>): Searched =>
  brief(explore({ init: kv.init(bounds), actions: s => kv.actions(s, flags, bounds), invariants: kv.invariants }));
const searchCalls = ([, , flags, bounds]: Row<'calls', calls.Flags, calls.Bounds>): Searched =>
  brief(
    explore({ init: calls.init(bounds), actions: s => calls.actions(s, flags, bounds), invariants: calls.invariants }),
  );
const searchWipe = ([, , flags, bounds]: Row<'wipe', wipe.Flags, wipe.Bounds>): Searched =>
  brief(
    explore({ init: wipe.init(bounds), actions: s => wipe.actions(s, flags, bounds), invariants: wipe.invariants }),
  );
const search = (c: Config): Searched => {
  if (c[0] === 'kv') return searchKv(c);
  return c[0] === 'calls' ? searchCalls(c) : searchWipe(c);
};
export type Checked = Omit<Searched, 'counterexample'> & {
  model: Config[0];
  name: string;
  flags: Config[2];
  bounds: Config[3];
  expect: string | null;
  pass: boolean;
  ms: number;
  counterexample: string[] | null;
};
export function check(c: Config): Checked {
  const [model, name, flags, bounds, expect] = c,
    t0 = Date.now();
  const r = search(c);
  // a truncated search that found nothing proves nothing
  const pass = expect === null ? r.found === null && !r.truncated : r.found === expect;
  return {
    model,
    name,
    flags,
    bounds,
    expect,
    found: r.found,
    pass,
    states: r.states,
    transitions: r.transitions,
    depth: r.depth,
    truncated: r.truncated,
    ms: Date.now() - t0,
    counterexample: r.counterexample,
  };
}
