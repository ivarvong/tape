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

const out: Row[] = [];
for (const p of plants) out.push(await hunt(p));
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
