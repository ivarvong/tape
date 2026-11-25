// bench/money.ts: bench/money.tape (Dec[2]) against bench/money-baseline.ts (integer cents in JavaScript): a cart's
// subtotal, tax at a five-decimal rate rounded half to even, and total. First the same answers on generated carts,
// then time per request: the median of 31 batches after warm-up, at three sizes. Local numbers, one machine.
//   node bench/money.ts
import '../node25.ts';
import { instantiate, responseOf } from '../host.ts';
import { built, moduleOf, read } from '../test/harness.ts';
import { handle as js } from './money-baseline.ts';

const dec = new TextDecoder(),
  enc = new TextEncoder();
const r = built([{ name: 'bench/money.tape', text: read('bench/money.tape') }]);
console.log(`money.tape: ${r.wasm.length} bytes`);
const app = instantiate(moduleOf(r), { log: false });

const cart = (lines: number, seed: number): Uint8Array => {
  let s = seed >>> 0 || 1;
  const int = (lo: number, hi: number): number => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return lo + Math.floor((s / 2 ** 32) * (hi - lo + 1));
  };
  const cents = (): string => `${int(0, 9999)}.${String(int(0, 99)).padStart(2, '0')}`;
  return enc.encode(
    JSON.stringify({
      lines: Array.from({ length: lines }, () => ({ price: cents(), qty: int(1, 50) })),
      rate: `0.${String(int(0, 99999)).padStart(5, '0')}`,
    }),
  );
};
const inputs = Array.from({ length: 200 }, (_, i) => cart([1, 3, 10, 40][i % 4] ?? 1, i + 1));
const wrong = inputs.flatMap(b => {
  const t = dec.decode(responseOf(app.handle(b)).body),
    w = dec.decode(js(b));
  return t === w ? [] : [`DIFF ${dec.decode(b).slice(0, 100)}\n tape ${t}\n js   ${w}`];
});
for (const w of wrong.slice(0, 5)) console.log(w);
console.log(`${inputs.length} carts compared, ${wrong.length} differ`);

const SAMPLES = 31;
const sorted = (a: readonly number[]): number[] => a.toSorted((x, y) => x - y);
/** Microseconds per request in each of SAMPLES batches of `each`, after warm-up. */
const time = (f: (b: Uint8Array) => unknown, b: Uint8Array, each: number): number[] => {
  for (let i = 0; i < each * 5; i++) f(b);
  return Array.from({ length: SAMPLES }, () => {
    const t = performance.now();
    for (let i = 0; i < each; i++) f(b);
    return ((performance.now() - t) / each) * 1000;
  });
};
for (const lines of [1, 10, 100]) {
  const b = cart(lines, 7);
  const each = Math.ceil(2000 / lines);
  const tj = sorted(time(js, b, each)),
    tt = sorted(time(x => app.handle(x), b, each));
  const at = (a: number[], q: number): number => a[Math.floor(q * (a.length - 1))] ?? 0;
  console.log(
    `${String(lines).padStart(4)} lines ${String(b.length).padStart(6)} bytes  ${SAMPLES} samples  js median ${at(tj, 0.5).toFixed(2)} µs (p10 ${at(tj, 0.1).toFixed(2)}, p90 ${at(tj, 0.9).toFixed(2)})  tape median ${at(tt, 0.5).toFixed(2)} µs (p10 ${at(tt, 0.1).toFixed(2)}, p90 ${at(tt, 0.9).toFixed(2)})  tape/js ${(at(tt, 0.5) / at(tj, 0.5)).toFixed(2)}`,
  );
}
process.exit(wrong.length > 0 ? 1 : 0);
