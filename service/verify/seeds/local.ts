// node service/verify/seeds/local.ts --kv 1-2000 --wf 1-500 [--chunk 15] [--jobs 3] --out <dir>
// Many seeds of the two Jepsen workloads in workerd: the seeds are split into chunks, each
// chunk is one vitest process (its own Miniflare state), --jobs of them at a time. Every seed runs the one config
// (kv.js CONFIG, harness.ts CONFIG). Each chunk's JSON report goes to <out>/<kind>-<a>-<b>.json; the summary
// (seeds passed and failed, faults injected per kind, each failure's anomalies) to <out>/summary.json and stdout.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { flag } from '../../jepsen/cli.ts';
import { at, fields, list, num, text } from '../../jepsen/json.ts';
import { seedsIn } from '../../jepsen/seeds.ts';

// A chunk's workerd keeps every seed's objects: its memory grows about 47 MB a seed (2,049 MB after 40 workflow
// seeds, measured on one run). Chunks of 50, four at a time, filled the 16 GB box (no swap): the last
// seeds of each chunk slowed past the 300 s test timeout and workerd was killed for memory (RUNTIME-SPEC.md
// R-CLIENT-5). The defaults keep each chunk under about 1 GB.
const chunk = Number(flag('chunk') ?? 15),
  jobs = Number(flag('jobs') ?? 3),
  out = flag('out') ?? '/tmp/seeds';
const service = `${import.meta.dirname}/../..`;
mkdirSync(out, { recursive: true });
type Kind = 'kv' | 'wf';
/** One chunk of seeds: a vitest process and the report it writes. */
type Work = { kind: Kind; file: string; envName: string; a: number; b: number; report: string };
const chunksOf = (kind: Kind, seeds: readonly number[], file: string, envName: string): Work[] =>
  Array.from({ length: Math.ceil(seeds.length / chunk) }, (_, k) => seeds.slice(k * chunk, (k + 1) * chunk)).map(
    part => {
      const a = part[0] ?? 0,
        b = part.at(-1) ?? a;
      return { kind, file, envName, a, b, report: `${out}/${kind}-${a}-${b}.json` };
    },
  );
const work = [
  ...chunksOf('kv', seedsIn(flag('kv') ?? ''), 'test/kv-jepsen.test.ts', 'KV_SEEDS'),
  ...chunksOf('wf', seedsIn(flag('wf') ?? ''), 'test/jepsen.test.ts', 'JEPSEN_SEEDS'),
];

const run = (w: Work): Promise<void> =>
  new Promise(done => {
    // a chunk already run is kept (rerun: delete its report)
    if (existsSync(w.report)) {
      done();
      return;
    }
    const began = Date.now();
    const p = spawn('npx', ['vitest', 'run', w.file, '-t', 'seed', '--reporter=json', `--outputFile=${w.report}`], {
      cwd: service,
      env: { ...process.env, [w.envName]: `${w.a}-${w.b}` },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    p.stderr.on('data', (d: unknown) => {
      err = `${err}${String(d)}`.slice(-4000);
    });
    p.on('close', code => {
      if (!existsSync(w.report)) writeFileSync(w.report, JSON.stringify({ crashed: true, code, err }));
      console.error(`${w.kind} ${w.a}-${w.b}: exit ${code}, ${Math.round((Date.now() - began) / 1000)} s`);
      done();
    });
  });
const queue = [...work];
const worker = async (): Promise<void> => {
  for (let w = queue.shift(); w !== undefined; w = queue.shift()) await run(w);
};
await Promise.all(Array.from({ length: jobs }, worker));

type Counts = Record<string, number>;
/** What the seeds of one workload came to. */
type Tally = {
  seeds: number;
  passed: number;
  failed: unknown[];
  not_run: number[];
  faults: Counts;
  client_faults: Counts;
  ops: number;
  info: number;
};
const tally = (): Tally => ({
  seeds: 0,
  passed: 0,
  failed: [],
  not_run: [],
  faults: {},
  client_faults: {},
  ops: 0,
  info: 0,
});
const summary: { kv: Tally; wf: Tally; crashed: unknown[] } = { kv: tally(), wf: tally(), crashed: [] };
const add = (into: Counts, from: unknown): void => {
  for (const [k, v] of Object.entries(fields(from))) into[k] = (into[k] ?? 0) + num(v);
};
/** One seed's test, added to its workload's tally. */
const seed = (s: Tally, kind: Kind, t: unknown): void => {
  const title = text(at(t, 'title')),
    status = at(t, 'status'),
    m = at(t, 'meta', 'jepsen');
  if (!title.startsWith('seed ')) return;
  // a seed vitest did not run (pending) is counted as not run, never as passed
  if (status === 'skipped' || status === 'pending' || status === 'todo') {
    s.not_run.push(Number(/^seed (\d+)/.exec(title)?.[1]));
    return;
  }
  s.seeds++;
  if (status === 'passed') s.passed++;
  else
    s.failed.push({
      seed: at(m, 'seed') ?? title,
      anomalies: at(m, 'anomalies'),
      trace_anomalies: at(m, 'trace_anomalies'),
      anomalous: at(m, 'anomalous'),
      message: list(at(t, 'failureMessages')).map(String).join('\n').slice(0, 1500),
    });
  add(s.faults, kind === 'kv' ? at(m, 'kinds') : at(m, 'stats', 'faults'));
  if (kind === 'kv') add(s.client_faults, at(m, 'client_faults'));
  s.ops += num(at(m, 'stats', 'ops'));
  if (kind === 'kv') s.info += num(at(m, 'stats', 'info'));
};
for (const w of work) {
  const stored: unknown = JSON.parse(readFileSync(w.report, 'utf8'));
  if (at(stored, 'crashed') === true) {
    summary.crashed.push({ ...w, code: at(stored, 'code'), err: at(stored, 'err') });
    continue;
  }
  for (const t of list(at(stored, 'testResults')).flatMap(f => list(at(f, 'assertionResults'))))
    seed(summary[w.kind], w.kind, t);
}
writeFileSync(`${out}/summary.json`, JSON.stringify(summary, null, 1));
/** A workload's tally as the summary line prints it: the workflow has no client faults or unknown outcomes. */
const line = ({ client_faults, info, ...t }: Tally, kind: Kind): Record<string, unknown> => ({
  ...t,
  ...(kind === 'kv' ? { client_faults, info } : {}),
  failed: t.failed.length,
});
console.log(
  JSON.stringify({ kv: line(summary.kv, 'kv'), wf: line(summary.wf, 'wf'), crashed: summary.crashed.length }),
);
const unsound = [summary.kv, summary.wf].some(t => t.failed.length > 0 || t.not_run.length > 0);
if (unsound || summary.crashed.length > 0) process.exitCode = 1;
