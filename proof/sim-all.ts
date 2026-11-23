// Every program in the repository that has a handle, under `tape sim` with nothing written for it: alone (its
// Remotes stood in for by their reply types), and the groups that are deployed together, together.
// First run (18 November 2026): a refund, a void, a page or a mail that the Remote refuses was asked again for
// ever in apps/tickets and four of the seven examples/timed. Each now has an arm for the refusal, and rule C87
// asks for one.
//   node proof/sim-all.ts [--seeds 200]        writes proof/results/sim-all.json; exits 1 if the list of
//                                               findings is not the one recorded in EXPECTED below
//   --shard i/n: only the groups whose index is i modulo n, written to proof/results/sim-all.<i>-of-<n>.json;
//   --merge n: the n shards read back, then the record, the summary and the check one run of every group gives
//   (proof/all.ts runs the shards side by side; each group's search is its own)
import '../node25.ts';
import { readFileSync, readdirSync } from 'node:fs';
import { auto, search, shrink } from '../sim.ts';
import type { Auto } from '../sim/model.ts';
import { arg, program, record, root } from './lib.ts';

const seeds = Number(arg('seeds', '200'));
const only = arg('only', '');
const list = (dir: string): string[] =>
  readdirSync(root + dir)
    .filter(f => f.endsWith('.tape'))
    .map(f => `${dir}/${f}`);
const groups = [
  ['apps/tickets/tickets.tape', 'apps/tickets/pay.tape'],
  ['examples/fulfillment.tape', 'examples/inventory.tape', 'examples/payments.tape', 'examples/shipping.tape'],
  ['examples/orders.tape', 'examples/stock.tape'],
  ...[
    'apps/tickets/tickets.tape',
    'apps/queue/queue.tape',
    ...list('examples'),
    ...list('examples/timed'),
    ...list('testdata/compare'),
  ].map(f => [f]),
].filter(g => only === '' || g.some(f => f.includes(only)));

type Row = {
  programs: string;
  result: string;
  code?: string;
  message?: string;
  routes?: number;
  stood_in?: string[];
  invariants?: number;
  runs?: number;
  ms?: number;
  answered?: number;
  never_answered?: string[];
  not_read?: number;
  repeats?: string[];
  choices?: number;
  seed?: number;
  violation?: string | undefined;
  script?: string[];
};
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** The model of a group of programs; a Row when there is none to run (null: no handle, nothing to send to). */
function modelOf(name: string, files: readonly { name: string; text: string }[]): Auto | Row | null {
  try {
    const a = auto(files, { clients: 4, ops: 10 });
    const [no] = a.errors ?? [];
    if (!a.errors) return a;
    if (!no || no.code === 'sim') return null;
    console.log(`build   ${name}: ${no.code} ${no.message.slice(0, 80)}`);
    return { programs: name, result: 'does not build', code: no.code };
  } catch {
    return null;
  }
}

/** One group simulated: what was run, what was answered, and what was wrong. */
async function simulated(name: string, a: Auto): Promise<Row> {
  const began = performance.now();
  const r = await search(a.model, { runs: seeds, steps: 120, faults: 3 });
  const never = a.routes.filter(x => (a.answered.get(x.key)?.ok ?? 0) === 0).map(x => x.key);
  const base = {
    programs: name,
    routes: a.routes.length,
    stood_in: Object.keys(a.stubs),
    invariants: a.invariants.length,
    runs: r.ran,
    ms: Math.round(performance.now() - began),
    answered: a.routes.length - never.length,
    never_answered: never,
    not_read: a.unread.length,
    repeats: r.repeats,
  };
  const [first] = r.failures;
  if (!first) {
    const unread = a.unread.length > 0 ? `, ${a.unread.length} matches not read` : '';
    console.log(
      `ok      ${name}: ${base.answered} of ${a.routes.length} paths answered 2xx, ${a.invariants.length} invariants, ${r.ran} runs${unread}`,
    );
    return { ...base, result: 'ok', choices: r.actions };
  }
  const small = await shrink(a.model, first, { budget: 150 });
  console.log(
    `${small.kind.padEnd(7)} ${name}: run ${r.ran}, ${small.script.length} choices: ${(small.violations[0] ?? '').slice(0, 150)}`,
  );
  return { ...base, result: small.kind, seed: small.seed, violation: small.violations[0], script: small.script };
}

const shardArg = arg('shard', ''),
  merging = Number(arg('merge', '0'));
const [shardIndex = 0, shardOf = 1] = /^\d+\/\d+$/.test(shardArg) ? shardArg.split('/').map(Number) : [0, 1];
const shardName = (i: number, n: number): string => `sim-all.${i}-of-${n}`;
/** A row as a shard wrote it (the fields the summary reads are checked). */
const isRow = (v: unknown): v is Row =>
  typeof v === 'object' &&
  v !== null &&
  'programs' in v &&
  typeof v.programs === 'string' &&
  'result' in v &&
  typeof v.result === 'string';
const out: Row[] = [];
if (merging > 0) {
  const rows: { index: number; row: Row }[] = [];
  for (let i = 0; i < merging; i++) {
    const shard: unknown = JSON.parse(readFileSync(`${root}proof/results/${shardName(i, merging)}.json`, 'utf8'));
    const entries: unknown[] = Array.isArray(shard) ? shard : [];
    for (const e of entries) {
      const index: unknown = typeof e === 'object' && e !== null && 'index' in e ? e.index : undefined,
        row: unknown = typeof e === 'object' && e !== null && 'row' in e ? e.row : undefined;
      if (typeof index !== 'number' || !isRow(row)) throw new TypeError(`shard ${i} of ${merging}: not a row`);
      rows.push({ index, row });
    }
  }
  for (const r of rows.toSorted((a, b) => a.index - b.index)) out.push(r.row);
  console.log(`merged ${merging} shards: ${out.length} rows`);
}
for (const [gi, g] of (merging > 0 ? [] : groups).entries()) {
  if (gi % shardOf !== shardIndex) continue;
  const name = g.join(' + ');
  const a = modelOf(name, g.map(program));
  if (a === null) continue;
  if ('result' in a) {
    out.push(a);
    continue;
  }
  try {
    out.push(await simulated(name, a));
  } catch (e) {
    out.push({ programs: name, result: 'the simulator failed', message: messageOf(e) });
    console.log(`SIMBUG  ${name}: ${messageOf(e).slice(0, 120)}`);
  }
}
if (shardOf > 1) {
  // a row's index is its group's (each group's name is its own); a group with no model has no row
  record(
    shardName(shardIndex, shardOf),
    out.map(row => ({ index: groups.findIndex(g => g.join(' + ') === row.programs), row })),
  );
  console.log(`shard ${shardIndex} of ${shardOf}: ${out.length} rows`);
  process.exit(0);
}
record('sim-all', out);
// the one finding that is meant: trap.tape divides by zero to show a trap
const EXPECTED: Readonly<Record<string, string>> = { 'examples/trap.tape': 'error' };
const surprises = out.filter(o => o.result !== 'ok' && EXPECTED[o.programs] !== o.result);
const absent = Object.keys(EXPECTED).filter(
  k => only === '' && !out.some(o => o.programs === k && o.result === EXPECTED[k]),
);
const by = (k: string): number => out.filter(o => o.result === k).length;
const sum = (of: (o: Row) => number): number => out.reduce((n, o) => n + of(o), 0);
console.log(
  `paths: ${sum(o => o.answered ?? 0)} of ${sum(o => o.routes ?? 0)} answered with a 2xx at least once; ${sum(o => o.not_read ?? 0)} matches on a path not read; ${out.filter(o => (o.invariants ?? 0) > 0).length} of ${out.length} runs had invariants to check`,
);
const reps = out.filter(o => (o.repeats?.length ?? 0) > 0);
console.log(
  `sent again: in ${reps.length} of ${out.length}, some request changed a row when sent a second time: ${reps.map(o => `${(o.programs.split('/').pop() ?? '').replace('.tape', '')} (${o.repeats?.length})`).join(', ')}`,
);
console.log(
  `${out.length} runs of the simulator: ${by('ok')} ok, ${by('error')} with a run that fails, ${by('safety')} safety, ${by('liveness')} liveness, ${by('does not build')} do not build, ${by('the simulator failed')} simulator failures`,
);
if (surprises.length > 0 || absent.length > 0) {
  console.log(
    `NOT AS RECORDED: ${[...surprises.map(o => `${o.programs}: ${o.result}`), ...absent.map(k => `${k}: expected ${EXPECTED[k]}`)].join('; ')}`,
  );
  process.exit(1);
}
