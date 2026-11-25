// bench/csv.ts: examples/csv.tape against bench/csv-baseline.ts. First the same answers on generated and edge-case
// inputs, then time per request (median of 15 after warm-up) at three sizes. Local numbers, one machine.
import '../node25.ts';
import { instantiate, responseOf } from '../host.ts';
import { built, moduleOf, read } from '../test/harness.ts';
import { handle as js } from './csv-baseline.ts';
import { gen } from './csv-gen.ts';

const dec = new TextDecoder();
const enc = new TextEncoder();
const t0 = performance.now();
const r = built([{ name: 'examples/csv.tape', text: read('examples/csv.tape') }]);
console.log(
  `csv.tape: ${r.wasm.length} bytes, ${r.functions.length} functions, compiled in ${(performance.now() - t0).toFixed(0)} ms`,
);
const app = instantiate(moduleOf(r), { log: false });

const EDGES = [
  '',
  'ts,user,amount,country',
  'ts,user,amount,country\r\n',
  'nope\n1,u,1,US\n',
  'ts,user,amount,country\n1,u,5,US',
  'ts,user,amount,country\n\n\n1,u,-0,US\n1,u,-,US\n,u,1,US\n1,u,1,USA\n1,u,1,U\n12345678901234567890,u,1,US\n1,u,-999999999999,ZZ\n1,u,5,US\r\n\r\n1,u,7,US\r',
];
const inputs = [
  ...Array.from({ length: 40 }, (_, i) => i + 1).flatMap(seed =>
    [200, 5000, 60000].map(size => gen(size, seed, seed % 2 === 0)),
  ),
  ...EDGES.map(t => enc.encode(t)),
];
/** Where the two answers differ, or null. */
const differs = (b: Uint8Array): string | null => {
  const tape = dec.decode(responseOf(app.handle(b)).body);
  const want = dec.decode(js(b));
  return tape === want
    ? null
    : `DIFF ${JSON.stringify(dec.decode(b).slice(0, 80))}\n tape ${tape.slice(0, 200)}\n js   ${want.slice(0, 200)}`;
};
const wrong = inputs.flatMap(b => differs(b) ?? []);
for (const w of wrong.slice(0, 3)) console.log(w);
console.log(`${inputs.length} inputs compared, ${wrong.length} differ`);

const median = (a: readonly number[]): number => a.toSorted((x, y) => x - y)[a.length >> 1] ?? 0;
const time = (f: (b: Uint8Array) => unknown, b: Uint8Array): number => {
  for (let i = 0; i < 30; i++) f(b);
  return median(
    Array.from({ length: 15 }, () => {
      const t = performance.now();
      f(b);
      return performance.now() - t;
    }),
  );
};
for (const size of [10_000, 100_000, 1_000_000]) {
  const b = gen(size, 7);
  const tj = time(js, b);
  const tt = time(x => app.handle(x), b);
  console.log(
    `${String(size).padStart(8)} bytes  js ${tj.toFixed(3)} ms  tape ${tt.toFixed(3)} ms  tape/js ${(tt / tj).toFixed(2)}`,
  );
}
process.exit(wrong.length > 0 ? 1 : 0);
