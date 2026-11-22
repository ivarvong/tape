// bench/cart.ts: examples/cart.tape against bench/cart-baseline.ts: a JSON body decoded, checked and answered.
// First the same answers on generated carts and on bodies that are not carts, then time per request (median of 15
// after warm-up) at three sizes. Local numbers, one machine.
import '../node25.ts';
import { instantiate } from '../host.ts';
import { built, moduleOf, read } from '../test/harness.ts';
import { handle as js } from './cart-baseline.ts';

const dec = new TextDecoder();
const enc = new TextEncoder();
const r = built([{ name: 'examples/cart.tape', text: read('examples/cart.tape') }]);
console.log(`cart.tape: ${r.wasm.length} bytes, ${r.functions.length} functions`);
const app = instantiate(moduleOf(r), { log: false });

/** A cart of `lines` lines, the same for the same seed. */
const cart = (lines: number, seed: number): Uint8Array => {
  let s = seed >>> 0 || 1;
  const int = (lo: number, hi: number): number => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return lo + Math.floor((s / 2 ** 32) * (hi - lo + 1));
  };
  const coupon = [undefined, null, 'TEN', 'FIVE', 'NOPE'][int(0, 4)];
  return enc.encode(
    JSON.stringify({
      customer: `customer-${int(1, 99999)}`,
      lines: Array.from({ length: lines }, () => ({
        sku: `sku-${int(1, 9999)}-${'é"\\/'.slice(0, int(0, 4))}`,
        qty: int(1, 1000),
        cents: int(0, 250000),
      })),
      ...(coupon === undefined ? {} : { coupon }),
    }),
  );
};
const NOT_CARTS = [
  '',
  'null',
  '[]',
  '{}',
  '{"customer":"a"}',
  '{"customer":"a","lines":{}}',
  '{"customer":1,"lines":[]}',
  '{"customer":"a","lines":[]}',
  '{"customer":"a","lines":[],"coupon":7}',
  '{"customer":"a","lines":[],"coupon":null}',
  '{"customer":"a","lines":[],"extra":true}',
  '{"customer":"a","lines":[1]}',
  '{"customer":"a","lines":[{"sku":"","qty":1,"cents":1}]}',
  `{"customer":"a","lines":[{"sku":"${'x'.repeat(33)}","qty":1,"cents":1}]}`,
  `{"customer":"a","lines":[{"sku":"${'é'.repeat(17)}","qty":1,"cents":1}]}`,
  '{"customer":"a","lines":[{"sku":"s","qty":0,"cents":1}]}',
  '{"customer":"a","lines":[{"sku":"s","qty":1001,"cents":1}]}',
  '{"customer":"a","lines":[{"sku":"s","qty":1.5,"cents":1}]}',
  '{"customer":"a","lines":[{"sku":"s","qty":"1","cents":1}]}',
  '{"customer":"a","lines":[{"sku":"s","qty":1,"cents":-1}]}',
  '{"customer":"a","lines":[{"sku":"s","qty":1,"cents":100000001}]}',
  '{"customer":"a","lines":[{"sku":"s","qty":1}]}',
  '{"customer":"a","lines":[{"sku":"s","qty":1,"cents":1,"note":"x"}]}',
  '{"customer":"a","lines":[{"sku":"s","qty":1e2,"cents":1}]}',
  '{"customer":"a","lines":[{"sku":"s","qty":2,"cents":2500}],"coupon":"FIVE"}',
  '{"customer":"a","lines":[{"sku":"s","qty":2,"cents":2499}],"coupon":"FIVE"}',
  '{"customer":"a","lines":[{"sku":"s","qty":1,"cents":1}]',
];
const inputs = [
  ...Array.from({ length: 60 }, (_, i) => i + 1).flatMap(seed => [0, 1, 7, 40].map(lines => cart(lines, seed))),
  ...NOT_CARTS.map(t => enc.encode(t)),
];
/** Where the two answers differ, or null. */
const differs = (b: Uint8Array): string | null => {
  const tape = dec.decode(app.handle(b));
  const want = dec.decode(js(b));
  return tape === want
    ? null
    : `DIFF ${JSON.stringify(dec.decode(b).slice(0, 110))}\n tape ${tape.slice(0, 160)}\n js   ${want.slice(0, 160)}`;
};
const wrong = inputs.flatMap(b => differs(b) ?? []);
for (const w of wrong.slice(0, 8)) console.log(w);
console.log(`${inputs.length} inputs compared, ${wrong.length} differ`);

const median = (a: readonly number[]): number => a.toSorted((x, y) => x - y)[a.length >> 1] ?? 0;
/** Microseconds per request: the median of 15 batches of `each`, after warm-up. */
const time = (f: (b: Uint8Array) => unknown, b: Uint8Array, each: number): number => {
  for (let i = 0; i < each * 3; i++) f(b);
  return median(
    Array.from({ length: 15 }, () => {
      const t = performance.now();
      for (let i = 0; i < each; i++) f(b);
      return ((performance.now() - t) / each) * 1000;
    }),
  );
};
for (const lines of [1, 10, 100]) {
  const b = cart(lines, 7);
  const each = Math.ceil(2000 / lines);
  const tj = time(js, b, each);
  const tt = time(x => app.handle(x), b, each);
  console.log(
    `${String(lines).padStart(4)} lines ${String(b.length).padStart(6)} bytes  js ${tj.toFixed(1)} µs  tape ${tt.toFixed(1)} µs  tape/js ${(tt / tj).toFixed(2)}`,
  );
}
process.exit(wrong.length > 0 ? 1 : 0);
