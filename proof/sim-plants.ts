// The planted bugs of apps/tickets/plants.ts under `tape sim` with nothing written for it: tickets.tape and
// pay.tape, each plant built with the rules off, the guided search for --runs runs (default 600).
// Which does the simulator find from the programs alone, and how does that compare with the hand-written model
// (apps/tickets/sim.ts, results in apps/tickets/results/sim.json)?   Writes proof/results/sim-plants.json.
import '../node25.ts';
import { plants } from '../apps/tickets/plants.ts';
import type { Plant } from '../apps/tickets/plants.ts';
import { auto, search } from '../sim.ts';
import { arg, read, record } from './lib.ts';

const tickets = read('apps/tickets/tickets.tape');
const pay = read('apps/tickets/pay.tape');
const runs = Number(arg('runs', '600'));

const field = (v: unknown, name: string): unknown =>
  typeof v === 'object' && v !== null ? Object.fromEntries(Object.entries(v))[name] : undefined;
/** What the hand-written model found for each plant (apps/tickets/results/sim.json). */
function handResults(): Map<string, string> {
  const stored: unknown = JSON.parse(read('apps/tickets/results/sim.json'));
  const rows: unknown[] = Array.isArray(stored) ? stored : [];
  return new Map(
    rows.flatMap(r => {
      const sim = field(r, 'sim');
      return typeof sim === 'string' ? [[String(field(r, 'plant')), sim] as const] : [];
    }),
  );
}
const hand = handResults();

type Row = {
  plant: string;
  sim: string;
  /** the codes the rules refuse it with; absent when it was not run */
  rules?: string[];
  run?: number;
  seed?: number;
  violation?: string | undefined;
  script?: string[];
  hand?: string | undefined;
  ms?: number;
};
async function hunt(p: Plant): Promise<Row> {
  if (p.pairs.some(([a]) => !tickets.includes(a))) {
    console.log('??       ', p.name);
    return { plant: p.name, sim: 'its text is not in tickets.tape' };
  }
  const a = auto(
    [
      { name: 'tickets', text: p.pairs.reduce((t, [x, y]) => t.replace(x, y), tickets) },
      { name: 'pay', text: pay },
    ],
    { rules: false, clients: 4, ops: 10 },
  );
  if (a.errors) return { plant: p.name, sim: 'does not build with the rules off' };
  const rules = [...new Set(a.refused.map(e => e.code))];
  const began = performance.now();
  const r = await search(a.model, { runs, steps: 120, faults: 3 });
  const [first] = r.failures;
  const h = hand.get(p.name);
  console.log(
    `${(first?.kind ?? 'MISS').padEnd(9)} ${rules.join(',').padEnd(8)} hand:${String(h).padEnd(9)} ${p.name.slice(0, 64).padEnd(64)} ${first ? `run ${r.ran}` : ''}`,
  );
  const found = first ? { run: r.ran, seed: first.seed, violation: first.violations[0], script: first.script } : {};
  return {
    plant: p.name,
    rules,
    sim: first?.kind ?? 'missed',
    ...found,
    hand: h,
    ms: Math.round(performance.now() - began),
  };
}

// --shard i/n: only the plants whose index is i modulo n, written to proof/results/sim-plants.<i>-of-<n>.json; then
// --merge n reads the n shards back and records and prints what one run of every plant would (proof/all.ts runs
// the shards side by side). Each plant's search is its own, so a shard finds what the whole run finds for it.
const shardArg = arg('shard', ''),
  mergeArg = Number(arg('merge', '0'));
const [index, of] = /^\d+\/\d+$/.test(shardArg) ? shardArg.split('/').map(Number) : [0, 1];
const shardFile = (i: number, n: number): string => `sim-plants.${i}-of-${n}`;
/** A row as a shard wrote it, read back. */
const rowOf = (v: unknown): Row => {
  const str = (name: string): string | undefined => {
      const x = field(v, name);
      return typeof x === 'string' ? x : undefined;
    },
    num = (name: string): number | undefined => {
      const x = field(v, name);
      return typeof x === 'number' ? x : undefined;
    },
    strs = (name: string): string[] | undefined => {
      const x = field(v, name);
      return Array.isArray(x) ? x.map(String) : undefined;
    };
  const row: Row = { plant: str('plant') ?? '', sim: str('sim') ?? '' };
  const rules = strs('rules'),
    run = num('run'),
    seed = num('seed'),
    script = strs('script'),
    ms = num('ms');
  if (rules !== undefined) row.rules = rules;
  if (run !== undefined) row.run = run;
  if (seed !== undefined) row.seed = seed;
  if (script !== undefined) row.script = script;
  if (ms !== undefined) row.ms = ms;
  row.violation = str('violation');
  row.hand = str('hand');
  return row;
};
const out: Row[] = [];
if (mergeArg > 0) {
  const rows = new Map<number, Row>();
  for (let i = 0; i < mergeArg; i++) {
    const shard: unknown = JSON.parse(read(`proof/results/${shardFile(i, mergeArg)}.json`));
    if (!Array.isArray(shard)) throw new TypeError(`shard ${i} of ${mergeArg} is not a list`);
    for (const r of shard) {
      const n = Number(field(r, 'index'));
      rows.set(n, rowOf(field(r, 'row')));
    }
  }
  if (rows.size !== plants.length) throw new Error(`the shards hold ${rows.size} plants, not ${plants.length}`);
  for (let n = 0; n < plants.length; n++) {
    const r = rows.get(n);
    if (r === undefined) throw new Error(`no shard ran plant ${n}`);
    out.push(r);
  }
} else {
  const mine: { index: number; row: Row }[] = [];
  for (const [n, p] of plants.entries()) {
    if (n % (of ?? 1) !== (index ?? 0)) continue;
    const row = await hunt(p);
    out.push(row);
    mine.push({ index: n, row });
  }
  if (of !== 1) {
    record(shardFile(index ?? 0, of ?? 1), mine);
    console.log(`shard ${index} of ${of}: ${mine.length} plants`);
    process.exit(0);
  }
}
record('sim-plants', out);
const ran = out.filter(o => o.rules !== undefined);
const ruled = (o: Row): boolean => (o.rules?.length ?? 0) > 0;
const byHand = (o: Row): boolean => o.hand !== undefined && o.hand !== 'missed';
const found = ran.filter(o => o.sim !== 'missed');
const missed = ran.filter(o => o.sim === 'missed');
console.log(
  `${ran.length} plants run: found ${found.length} from the programs alone (${found.filter(o => !ruled(o)).length} that no rule refuses); the rules refuse ${ran.filter(ruled).length}; neither: ${missed
    .filter(o => !ruled(o))
    .map(o => o.plant.slice(0, 40))
    .join(' | ')}`,
);
console.log(
  `the hand-written model found ${ran.filter(byHand).length}; both ${found.filter(byHand).length}; only the programs-alone run ${found.filter(o => !byHand(o)).length}; only the hand model ${missed.filter(byHand).length}`,
);
