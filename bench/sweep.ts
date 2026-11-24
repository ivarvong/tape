// bench/sweep.ts: how Tape scales against JS. For each workload of bench/suite, its request at six sizes (from about
// 10 items or 200 bytes up to near the largest that fits Tape's limits: 64 MB of arena, 50,000,000 steps), under
// three V8 tiers, each cell in a process of its own (bench/sweep-one.ts):
//   opt       V8's defaults: JS up to TurboFan, Wasm Liftoff then TurboFan
//   liftoff   --liftoff-only: Wasm never past Liftoff (JS as default)
//   baseline  --max-opt=1 --liftoff-only: Sparkplug JS and Liftoff Wasm, what a young isolate runs
// time: the JS twin and Tape (log on) take turns request by request after a warm-up; median and p90 of ≥30.
// steps and arena bytes: Tape's own counts for each request (deterministic: the same on every tier).
// mem: peak RSS and V8 heap of a process running one way alone (opt tier, 5 requests).
// cold: the first request of a fresh process at scale 1 (Tape: compile the stored Wasm, instantiate, answer),
//   10 processes a way, the ways alternating. compile: the hosted compile of each program, and its Wasm's size.
//   node bench/sweep.ts [--quick] [--only crud,csv] [--tiers opt,liftoff] [--out file.json]
import '../node25.ts';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, tmpdir, totalmem } from 'node:os';
import { dirname } from 'node:path';
import { NAMES } from './suite/workloads.ts';

const argv = process.argv.slice(2);
const opt = (n: string): string | undefined => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
const quick = argv.includes('--quick');
const only = (opt('--only') ?? NAMES.join(',')).split(',').filter(Boolean);
const TIERS: Record<string, string[]> = {
  opt: [],
  liftoff: ['--liftoff-only'],
  baseline: ['--max-opt=1', '--liftoff-only'],
};
const tiers = (opt('--tiers') ?? Object.keys(TIERS).join(',')).split(',').filter(t => t in TIERS);
/** scale 1 is the suite's benchmark size: crud and ledger 2,000 items, webhook 10,000 events, trace 2,000 spans,
 * csv and words 2 MB. The largest fit: csv ×3 is 37 M steps and words ×1.5 30 M (of 50 M); trace ×2 is 27 MB of
 * arena (of 64; some 5,000-span traces run out). */
const SCALES: Record<string, number[]> = {
  crud: [0.005, 0.025, 0.1, 0.5, 2, 10],
  ledger: [0.005, 0.025, 0.1, 0.5, 2, 10],
  webhook: [0.001, 0.005, 0.02, 0.1, 0.5, 2],
  trace: [0.005, 0.02, 0.1, 0.3, 1, 2],
  csv: [0.0001, 0.001, 0.01, 0.1, 1, 3],
  words: [0.0001, 0.001, 0.01, 0.1, 0.5, 1.5],
};
const ONE = new URL('./sweep-one.ts', import.meta.url).pathname;
const git = (...a: string[]): string => {
  try {
    return execFileSync('git', a, { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};
const dirty = git(
  'status',
  '--porcelain',
  '--',
  'compiler',
  'host',
  'std',
  'host.ts',
  'apps',
  'examples',
  'bench/suite',
);
const commit = `${git('rev-parse', '--short', 'HEAD') || 'unknown'}${dirty ? '+dirty' : ''}`;
const loadEnd: number[] = [];
const meta = {
  commit,
  node: process.versions.node,
  v8: process.versions.v8,
  machine: `${cpus()[0]?.model ?? '?'}, ${cpus().length} cores, ${Math.round(totalmem() / 2 ** 30)} GB, ${process.platform} ${process.arch}`,
  started: new Date().toISOString(),
  loadStart: loadavg(),
  loadEnd,
  tiers: Object.fromEntries(tiers.map(t => [t, TIERS[t]])),
  scales: SCALES,
};
console.log(
  `commit ${commit}; ${meta.machine}; Node ${meta.node}; load ${meta.loadStart.map(x => x.toFixed(2)).join(' ')}`,
);

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;
function child(flags: string[], args: string[]): Record<string, unknown> {
  try {
    const out = execFileSync(process.execPath, ['--no-warnings', ...flags, ONE, ...args], {
      encoding: 'utf8',
      maxBuffer: 1 << 26,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const line: unknown = JSON.parse(out.trim().split('\n').at(-1) ?? 'null');
    return isRecord(line) ? line : { failed: 'sweep-one.ts printed no result' };
  } catch (e) {
    const text = String(isRecord(e) ? (e['stderr'] ?? e) : e);
    return { failed: /trap \d+: [a-z ]+/.exec(text)?.[0] ?? text.slice(0, 200) };
  }
}
const sorted = (a: readonly number[]): number[] => a.toSorted((x, y) => x - y);
const median = (a: readonly number[]): number => sorted(a)[a.length >> 1] ?? NaN;
const q = (a: readonly number[], p: number): number =>
  sorted(a)[Math.min(a.length - 1, Math.floor(p * a.length))] ?? NaN;
const nums = (x: unknown): number[] => (Array.isArray(x) ? x.filter((v): v is number => typeof v === 'number') : []);
const fmt = (x: number): string =>
  x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x >= 1 ? x.toFixed(2) : x.toPrecision(2);

type Cell = {
  workload: string;
  tier: string;
  scale: number;
  requestBytes: number;
  js: { median: number; p90: number; n: number };
  tape: { median: number; p90: number; n: number };
  ratio: number;
  steps: number;
  arenaBytes: number;
  linearBytes: number;
  identical: boolean;
  warm: number;
  load: number;
  failed?: string;
  raw: { js: number[]; tape: number[] };
};
const cells: Cell[] = [];
for (const name of only) {
  for (const scale of SCALES[name] ?? []) {
    for (const tier of tiers) {
      const samples = quick ? 10 : scale <= (SCALES[name]?.[2] ?? 0) ? 60 : 30;
      const r = child(TIERS[tier] ?? [], [name, 'time', String(scale), String(samples)]);
      const js = nums(r['js']),
        tape = nums(r['tape']);
      const cell: Cell = {
        workload: name,
        tier,
        scale,
        requestBytes: Number(r['requestBytes'] ?? 0),
        js: { median: median(js), p90: q(js, 0.9), n: js.length },
        tape: { median: median(tape), p90: q(tape, 0.9), n: tape.length },
        ratio: median(tape) / median(js),
        steps: median(nums(r['steps'])),
        arenaBytes: Math.max(...nums(r['bytes']), 0),
        linearBytes: Number(r['linear'] ?? 0),
        identical: r['identical'] === true,
        warm: Number(r['warm'] ?? 0),
        load: loadavg()[0] ?? 0,
        ...(typeof r['failed'] === 'string' ? { failed: r['failed'] } : {}),
        raw: { js, tape },
      };
      cells.push(cell);
      console.log(
        `${name.padEnd(8)} ×${String(scale).padEnd(6)} ${tier.padEnd(8)} ${String(cell.requestBytes).padStart(8)} B  js ${fmt(cell.js.median).padStart(6)} ms  tape ${fmt(cell.tape.median).padStart(6)} ms  ${cell.ratio.toFixed(2)}×  steps ${cell.steps}  arena ${cell.arenaBytes}${cell.identical ? '' : '  ANSWERS DIFFER'}${cell.failed ? `  ${cell.failed}` : ''}  load ${cell.load.toFixed(1)}`,
      );
    }
  }
}

// ---- memory: one way alone per process, opt tier
const mem: Record<string, unknown>[] = [];
for (const name of only)
  for (const scale of SCALES[name] ?? [])
    for (const way of ['js', 'tape']) {
      const r = child([], [name, 'mem', way, String(scale)]);
      mem.push({ workload: name, scale, way, ...r });
    }
console.log(`memory: ${mem.length} processes`);

// ---- cold start and compile
const cold: Record<string, unknown>[] = [];
const compiles: Record<string, unknown>[] = [];
for (const name of only) {
  for (let i = 0; i < (quick ? 3 : 10); i++)
    for (const way of i % 2 === 0 ? ['js', 'tape'] : ['tape', 'js'])
      cold.push({ workload: name, way, ...child([], [name, 'cold', way]) });
  const c = child([], [name, 'compile']);
  compiles.push({ workload: name, ...c });
  const m = (way: string, k: string): number =>
    median(cold.filter(x => x['workload'] === name && x['way'] === way).map(x => Number(x[k])));
  console.log(
    `${name.padEnd(8)} cold js ${fmt(m('js', 'total'))} ms  tape ${fmt(m('tape', 'total'))} ms (module ${fmt(m('tape', 'compile'))} + instantiate ${fmt(m('tape', 'setup'))} + request ${fmt(m('tape', 'request'))})  compile ${fmt(Number(c['first']))} ms first, ${fmt(Number(c['warm']))} warm, ${Number(c['wasmBytes'])} B`,
  );
}

meta.loadEnd = loadavg();
const file = opt('--out') ?? `${tmpdir()}/tape-sweep/sweep-${commit}-${Date.now()}.json`;
mkdirSync(dirname(file), { recursive: true });
writeFileSync(
  file,
  JSON.stringify({ meta: { ...meta, finished: new Date().toISOString() }, cells, mem, cold, compiles }),
);
console.log(`load ${meta.loadEnd.map(x => x.toFixed(2)).join(' ')}; results: ${file}`);
