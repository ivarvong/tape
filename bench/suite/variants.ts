// bench/suite/variants.ts: what a build option the compiler already has costs, per workload: the same program built
// with the defaults and with { reductions: false } (no step metering: one global add and compare on every function
// entry), timed in one process, alternating builds per request so drift hits both alike.
//   node bench/suite/variants.ts [workload …] [--samples 30]
import { compile } from '../../compiler.ts';
import type { Options } from '../../compiler.ts';
import { std } from '../../std.ts';
import { makeWay, median, prime, programFiles, sourcesOf } from './common.ts';
import { NAMES, load } from './workloads.ts';

const argv = process.argv.slice(2);
const SAMPLES = Number(argv.includes('--samples') ? argv[argv.indexOf('--samples') + 1] : '30');
const names = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--samples');
const VARIANTS: [string, Partial<Options>][] = [
  ['default', {}],
  ['no reductions', { reductions: false }],
];
for (const name of names.length > 0 ? names : NAMES) {
  const w = await load(name);
  const realNow = Date.now;
  const pinned = w.now;
  if (pinned !== undefined) Date.now = () => pinned;
  const ways = VARIANTS.map(([label, o]) => {
    const r = compile([...std, ...programFiles(sourcesOf(w))], o);
    if (!r.wasm) throw new Error(`${w.name} (${label}) does not compile`);
    const module = new WebAssembly.Module(r.wasm);
    return { label, module, run: makeWay(w, 'tape-nolog', module), ms: Array.of<number>() };
  });
  for (let k = 0; k < 10 + SAMPLES; k++) {
    const req = w.request(k, 1);
    for (const v of ways) {
      const run = w.fresh === true ? makeWay(w, 'tape-nolog', v.module) : v.run;
      if (w.fresh === true || k === 0) await prime(w, run, k);
      const t = performance.now();
      await run(req);
      if (k >= 10) v.ms.push(performance.now() - t);
    }
  }
  const base = median(ways[0]?.ms ?? []);
  console.log(
    `${name.padEnd(8)} ${ways.map(v => `${v.label} ${median(v.ms).toFixed(2)} ms (${((median(v.ms) / base - 1) * 100).toFixed(1)}%)`).join('  ')}`,
  );
  Date.now = realNow;
}
