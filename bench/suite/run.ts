// bench/suite/run.ts: Tape against JavaScript on six nontrivial workloads, per request, at sizes where one request
// costs 1–100 ms of JS. Each number is measured in a process of its own (one.ts) under the V8 flags of its tier:
//   opt       V8's defaults: JS up to TurboFan, Wasm Liftoff then TurboFan (dynamic tiering)
//   maglev    --max-opt=2: JS never past Maglev (Wasm as default)
//   liftoff   --liftoff-only: Wasm never past Liftoff (JS as default)
//   baseline  --max-opt=1 --liftoff-only: Sparkplug JS and Liftoff Wasm, what a young isolate runs
//   1thread   --single-threaded: no background compilation, so tier-up compiles on the main thread
// warm: the median of 30 requests after 10 (each with fresh keys, so nothing is a repeat), each way on its own
// database, the three ways taking turns request by request in one process (one.ts all).
// cold: the first request of a fresh process (Tape: compiling the stored Wasm, instantiating it, its schema, the
// request; JS: its schema, the request), median of 10 processes, opt tier.
// sweep: crud and csv at three sizes (about 1, 10 and 100 ms of JS), opt tier.
// Ways: js (the twin), tape (log on, as the service runs it), tape-nolog ({ log: false }).
//   node bench/suite/run.ts [--quick] [--only crud,csv] [--no-cold] [--no-sweep] [--json out.json]
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { median, quantile } from './common.ts';
import { wasmPath } from './wasm.ts';
import { NAMES, load } from './workloads.ts';

const argv = process.argv.slice(2);
const flag = (n: string): boolean => argv.includes(n);
const opt = (n: string): string | undefined => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
const quick = flag('--quick');
const only = (argv.includes('--only') ? (opt('--only') ?? '').split(',') : [...NAMES]).filter(Boolean);
const SAMPLES = quick ? 10 : 30;
const COLD = quick ? 3 : 10;
const TIERS: Record<string, string[]> = {
  opt: [],
  maglev: ['--max-opt=2'],
  liftoff: ['--liftoff-only'],
  baseline: ['--max-opt=1', '--liftoff-only'],
  '1thread': ['--single-threaded'],
};
const MODES = ['js', 'tape-log', 'tape-nolog'] as const;
const ONE = new URL('./one.ts', import.meta.url).pathname;

const commit = ((): string => {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--', 'compiler', 'host', 'std', 'host.ts'], {
      encoding: 'utf8',
    }).trim();
    return dirty ? `${sha}+dirty` : sha;
  } catch {
    return 'unknown';
  }
})();
const machine = `${cpus()[0]?.model ?? '?'}, ${cpus().length} cores, Node ${process.versions.node}, V8 ${process.versions.v8}`;
console.log(`commit ${commit}; ${machine}`);

type Warm = { ms: number[]; requestBytes: number; answerBytes: number; failed?: string };
type Cold = { compile: number; setup: number; request: number; total: number };
type All = { ms: Record<string, number[]> | number[]; requestBytes: number; failed?: string };
const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;
const isNumbers = (x: unknown): x is number[] => Array.isArray(x) && x.every(v => typeof v === 'number');
const isWarm = (x: unknown): x is Warm =>
  isRecord(x) && isNumbers(x['ms']) && typeof x['requestBytes'] === 'number' && typeof x['answerBytes'] === 'number';
const isAll = (x: unknown): x is All =>
  isRecord(x) &&
  (isNumbers(x['ms']) || (isRecord(x['ms']) && Object.values(x['ms']).every(isNumbers))) &&
  typeof x['requestBytes'] === 'number';
const isCold = (x: unknown): x is Cold =>
  isRecord(x) && ['compile', 'setup', 'request', 'total'].every(k => typeof x[k] === 'number');
/** one.ts's line, checked to be what was asked for */
function expect<T>(x: unknown, ok: (y: unknown) => y is T, what: string): T {
  if (!ok(x)) throw new Error(`one.ts printed no ${what}: ${JSON.stringify(x)?.slice(0, 200)}`);
  return x;
}
/** One measurement in a process of its own; a run that failed (a Tape trap: out of memory, the step budget) is
 * { ms: [NaN], failed } so the table says so. */
function one(flags: string[], args: string[]): unknown {
  try {
    const out = execFileSync(process.execPath, ['--no-warnings', ...flags, ONE, ...args], {
      encoding: 'utf8',
      maxBuffer: 1 << 26,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const line: unknown = JSON.parse(out.trim().split('\n').at(-1) ?? 'null');
    return line;
  } catch (e) {
    const stderr = isRecord(e) ? e['stderr'] : undefined;
    const text = String(stderr ?? e);
    const failed = /trap \d+: [a-z ]+/.exec(text)?.[0] ?? text.slice(0, 120);
    return {
      ms: [Number.NaN],
      compile: NaN,
      setup: NaN,
      request: NaN,
      total: NaN,
      requestBytes: 0,
      answerBytes: 0,
      failed,
    };
  }
}

/** The three ways in one process, taking turns per request; a Tape trap (out of memory, the step budget) makes
 * the whole process fail, so then each way is measured on its own to keep the JS number. */
function interleaved(flags: string[], name: string, scale: number, samples: number): Record<string, Warm> {
  const all = expect(one(flags, [name, 'all', 'warm', String(scale), String(samples)]), isAll, 'interleaved times');
  const { ms } = all;
  if (!all.failed && !Array.isArray(ms))
    return Object.fromEntries(MODES.map(m => [m, { ms: ms[m] ?? [], requestBytes: all.requestBytes, answerBytes: 0 }]));
  return Object.fromEntries(
    MODES.map(m => [m, expect(one(flags, [name, m, 'warm', String(scale), String(samples)]), isWarm, 'warm times')]),
  );
}

const results: Record<string, unknown> = { commit, machine, at: new Date().toISOString(), samples: SAMPLES };
const fmt = (x: number): string => (x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2));
const pad = (s: string, n: number): string => s.padStart(n);

// ---- warm, per tier
const warm: Record<string, Record<string, Record<string, Warm>>> = {};
for (const name of only) {
  const w = await load(name);
  wasmPath(w.tape);
  warm[name] = {};
  for (const [tier, flags] of Object.entries(TIERS)) {
    const row = interleaved(flags, name, 1, SAMPLES);
    warm[name][tier] = row;
    const js = median(row['js']?.ms ?? []);
    const t = median(row['tape-log']?.ms ?? []);
    const n = median(row['tape-nolog']?.ms ?? []);
    console.log(
      `${name.padEnd(8)} ${tier.padEnd(9)} js ${pad(fmt(js), 6)} ms  tape ${pad(fmt(t), 6)} ms (${(t / js).toFixed(2)}×)  tape-nolog ${pad(fmt(n), 6)} ms (${(n / js).toFixed(2)}×)  [p90 js ${fmt(quantile(row['js']?.ms ?? [], 0.9))} tape ${fmt(quantile(row['tape-log']?.ms ?? [], 0.9))}]`,
    );
  }
}
results['warm'] = warm;

// ---- cold
const cold: Record<string, Record<string, Cold[]>> = {};
if (!flag('--no-cold')) {
  for (const name of only) {
    cold[name] = {};
    for (const mode of MODES) {
      const runs: Cold[] = [];
      for (let i = 0; i < COLD; i++) runs.push(expect(one([], [name, mode, 'cold', '1']), isCold, 'cold times'));
      cold[name][mode] = runs;
    }
    const m = (mode: string, k: keyof Cold): number => median((cold[name]?.[mode] ?? []).map(r => r[k]));
    console.log(
      `${name.padEnd(8)} cold      js ${pad(fmt(m('js', 'total')), 6)} ms  tape ${pad(fmt(m('tape-log', 'total')), 6)} ms (${(m('tape-log', 'total') / m('js', 'total')).toFixed(2)}×; compile ${fmt(m('tape-log', 'compile'))} + instantiate ${fmt(m('tape-log', 'setup'))} + request ${fmt(m('tape-log', 'request'))})  tape-nolog ${fmt(m('tape-nolog', 'total'))} ms`,
    );
  }
  results['cold'] = cold;
}

// ---- size sweep
// trace ×5 is 10,000 spans: Tape runs out of its 64 MB there (it fits up to about 5,000); csv ×4 (8 MB) and more
// exceed its 50,000,000-step budget, so the csv sweep stops at ×3
const SWEEP: Record<string, number[]> = { crud: [0.1, 1, 10], csv: [0.05, 0.5, 3], trace: [0.25, 1, 2.5, 5] };
const sweep: Record<string, Record<string, Record<string, Warm>>> = {};
if (!flag('--no-sweep')) {
  for (const [name, scales] of Object.entries(SWEEP)) {
    if (!only.includes(name)) continue;
    sweep[name] = {};
    for (const scale of scales) {
      const row = interleaved([], name, scale, quick ? 5 : 15);
      sweep[name][String(scale)] = row;
      const js = median(row['js']?.ms ?? []);
      const t = median(row['tape-log']?.ms ?? []);
      const n = median(row['tape-nolog']?.ms ?? []);
      console.log(
        `${name.padEnd(8)} sweep ×${String(scale).padEnd(5)} ${pad(String(row['js']?.requestBytes), 9)} B  js ${pad(fmt(js), 6)} ms  tape ${pad(fmt(t), 6)} ms (${(t / js).toFixed(2)}×)  tape-nolog ${pad(fmt(n), 6)} ms (${(n / js).toFixed(2)}×)${row['tape-log']?.failed ? `  tape: ${row['tape-log'].failed}` : ''}`,
      );
    }
  }
  results['sweep'] = sweep;
}

// ---- the table
console.log(`\ntape/js per request (median; tape = log on, as shipped; in brackets log off). commit ${commit}`);
const tiers = Object.keys(TIERS);
console.log(`${'workload'.padEnd(9)}${pad('js ms', 8)}${tiers.map(t => pad(t, 14)).join('')}${pad('cold', 14)}`);
for (const name of only) {
  const cell = (row: Record<string, Warm> | undefined): string => {
    const js = median(row?.['js']?.ms ?? []);
    return pad(
      `${(median(row?.['tape-log']?.ms ?? []) / js).toFixed(2)} (${(median(row?.['tape-nolog']?.ms ?? []) / js).toFixed(2)})`,
      14,
    );
  };
  const c = cold[name];
  const coldCell = c
    ? pad(
        `${(median((c['tape-log'] ?? []).map(r => r.total)) / median((c['js'] ?? []).map(r => r.total))).toFixed(2)} (${(median((c['tape-nolog'] ?? []).map(r => r.total)) / median((c['js'] ?? []).map(r => r.total))).toFixed(2)})`,
        14,
      )
    : pad('-', 14);
  console.log(
    `${name.padEnd(9)}${pad(fmt(median(warm[name]?.['opt']?.['js']?.ms ?? [])), 8)}${tiers.map(t => cell(warm[name]?.[t])).join('')}${coldCell}`,
  );
}
const file = opt('--json') ?? `${tmpdir()}/tape-bench-suite/results-${commit}-${Date.now()}.json`;
writeFileSync(file, JSON.stringify(results));
console.log(`\nraw samples: ${file}`);
