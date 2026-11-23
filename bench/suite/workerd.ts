// bench/suite/workerd.ts: csv, words and trace in workerd (local only), Tape against JS, warm and first-request.
// Bundles bench/suite/workerd/worker.ts with esbuild, writes a workerd config beside it with the three programs'
// Wasm, and serves it on a local port. Each number is the time of a fetch from here, minus the median of the same
// fetch doing no work (way=none), since the clock inside workerd does not move while code runs.
//   node bench/suite/workerd.ts --bin <dir with workerd and esbuild>   (e.g. service/node_modules/.bin of a checkout
//                                                                     with the service's dependencies installed)
// warm: 10 requests, then the median of 30. first: a fresh workerd process per sample, and the first request of
// that way there (Tape: instantiating the module, compiled by workerd at startup, and the request), median of 5.
import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { median } from './common.ts';
import { wasmPath } from './wasm.ts';

const argv = process.argv.slice(2);
const bin = argv.includes('--bin')
  ? argv[argv.indexOf('--bin') + 1]
  : new URL('../../service/node_modules/.bin', import.meta.url).pathname;
const dir = mkdtempSync(`${tmpdir()}/tape-workerd-`);
const PROGRAMS = { csv: 'examples/csv.tape', words: 'examples/words.tape', trace: 'apps/trace/trace.tape' };
for (const [n, p] of Object.entries(PROGRAMS)) copyFileSync(wasmPath(p), `${dir}/${n}.wasm`);
execFileSync(
  `${bin}/esbuild`,
  [
    new URL('./workerd/worker.ts', import.meta.url).pathname,
    '--bundle',
    '--format=esm',
    '--platform=neutral',
    '--external:*.wasm',
    '--external:node:*',
    // bench/csv-gen.ts imports node25.ts, which refuses an older Node; workerd's compat layer reports one
    "--define:process.versions.node='25.0.0'",
    `--outfile=${dir}/worker.js`,
  ],
  { stdio: ['ignore', 'ignore', 'inherit'] },
);
const PORT = 8790 + Math.floor(Math.random() * 100);
writeFileSync(
  `${dir}/config.capnp`,
  `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [(name = "main", worker = .w)],
  sockets = [(name = "http", address = "127.0.0.1:${PORT}", http = (), service = "main")],
);
const w :Workerd.Worker = (
  modules = [
    (name = "worker.js", esModule = embed "worker.js"),
    (name = "csv.wasm", wasm = embed "csv.wasm"),
    (name = "words.wasm", wasm = embed "words.wasm"),
    (name = "trace.wasm", wasm = embed "trace.wasm"),
  ],
  compatibilityDate = "2026-11-01",
  compatibilityFlags = ["nodejs_compat"],
);
`,
);

async function start(): Promise<ChildProcess> {
  const p = spawn(`${bin}/workerd`, ['serve', `${dir}/config.capnp`], { stdio: ['ignore', 'ignore', 'inherit'] });
  for (let i = 0; i < 200; i++) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/?w=csv&way=none`);
      return p;
    } catch {
      await sleep(25);
    }
  }
  throw new Error('workerd did not start');
}
const stop = (p: ChildProcess): Promise<void> =>
  new Promise(ok => {
    p.once('exit', () => ok());
    p.kill();
  });
async function time(q: string): Promise<number> {
  const t = performance.now();
  const r = await fetch(`http://127.0.0.1:${PORT}/?${q}`);
  const body = await r.text();
  if (!r.ok) throw new Error(`${q}: ${r.status} ${body}`);
  return performance.now() - t;
}
const version = execFileSync(`${bin}/workerd`, ['--version'], { encoding: 'utf8' }).trim();
console.log(`${version}; times are fetch round trips minus the empty fetch`);
const rows: string[] = [];
for (const w of Object.keys(PROGRAMS)) {
  const p = await start();
  await time(`w=${w}&prepare=1`);
  const res: Record<string, number> = {};
  for (const way of ['none', 'js', 'tape']) {
    for (let k = 0; k < 10; k++) await time(`w=${w}&way=${way}&k=${k}`);
    const ms: number[] = [];
    for (let k = 0; k < 30; k++) ms.push(await time(`w=${w}&way=${way}&k=${k}`));
    res[way] = median(ms);
  }
  await stop(p);
  const first: Record<string, number[]> = { js: [], tape: [] };
  for (let i = 0; i < 5; i++)
    for (const way of ['js', 'tape']) {
      const q = await start();
      await time(`w=${w}&prepare=1`);
      const none = median([
        await time(`w=${w}&way=none`),
        await time(`w=${w}&way=none`),
        await time(`w=${w}&way=none`),
      ]);
      first[way]?.push((await time(`w=${w}&way=${way}`)) - none);
      await stop(q);
    }
  const js = (res['js'] ?? 0) - (res['none'] ?? 0),
    tape = (res['tape'] ?? 0) - (res['none'] ?? 0);
  const fj = median(first['js'] ?? []),
    ft = median(first['tape'] ?? []);
  rows.push(
    `${w.padEnd(6)} warm js ${js.toFixed(2)} ms  tape ${tape.toFixed(2)} ms  tape/js ${(tape / js).toFixed(2)}   first request js ${fj.toFixed(1)} ms  tape ${ft.toFixed(1)} ms  tape/js ${(ft / fj).toFixed(2)}`,
  );
  console.log(rows.at(-1));
}
