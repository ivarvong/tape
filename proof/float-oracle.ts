// proof/float-oracle.ts: inputs for the math library's oracle, and what the library gives for each, as JSON lines
// for proof/float_oracle.py (mpmath), which says how far each result is from the true value. By hand, not in the
// gate: the gate reads the golden file the oracle wrote (test/float-math.ts).
//   node proof/float-oracle.ts [n] [musl.wasm]     n inputs per function (default 100000), edge cases first
// With musl.wasm, each line also has musl's own result (m), which the golden file keeps, so the gate holds the port
// to musl bit for bit. That module is musl's libm as zig 0.14.1 builds it, exporting m_sin, m_cos, … :
//   double m_sin(double x) { return sin(x); }  …  zig cc -target wasm32-wasi -O2 -mexec-model=reactor m.c -o musl.wasm
import '../node25.ts';
import { readFileSync } from 'node:fs';
import { math64 } from '../interp/float.ts';

const n = Number(process.argv[2] ?? 100_000);
const lib = math64();
const muslFile = process.argv[3];
const musl: Record<string, (...xs: number[]) => number> = {};
if (muslFile)
  for (const [k, f] of Object.entries(new WebAssembly.Instance(new WebAssembly.Module(readFileSync(muslFile))).exports))
    if (typeof f === 'function') musl[k] = (...xs: number[]) => Number(f(...xs));
const muslOf = (fn: string, xs: number[]): number | null => musl[`m_${fn}`]?.(...xs) ?? null;
const dv = new DataView(new ArrayBuffer(8));
const hexOf = (x: number): string => {
  dv.setFloat64(0, x);
  return dv.getBigUint64(0).toString(16).padStart(16, '0');
};
let seed = 0x853c49e6748fea9bn;
const unit = (): number => {
  seed = BigInt.asUintN(64, seed * 6364136223846793005n + 1442695040888963407n);
  return Number(seed >> 11n) / 2 ** 53;
};
const sign = (): number => (unit() < 0.5 ? -1 : 1);
/** |x| spread evenly over the exponents from 2^lo to 2^hi. */
const spread = (lo: number, hi: number): number => (1 + unit()) * 2 ** Math.floor(lo + unit() * (hi - lo));
const uniform = (a: number, b: number): number => a + unit() * (b - a);
/** Near a multiple of pi/2, where the reduction cancels: k*pi/2 a few ulps either way. */
const nearPio2 = (): number => {
  const x = Math.round(unit() * 2 ** (1 + unit() * 40)) * (Math.PI / 2);
  if (x === 0) return 0;
  dv.setFloat64(0, x);
  dv.setBigUint64(0, dv.getBigUint64(0) + BigInt(Math.floor(uniform(-8, 8))));
  return dv.getFloat64(0) * sign();
};
const EDGE = [
  0, -0, 5e-324, -5e-324, 2.2250738585072014e-308, 1e-300, 1, -1, 0.5, 2, 10, 1e300, 1.7976931348623157e308,
];
const INPUTS: Record<string, () => number[]> = {
  sin: () => [
    [uniform(-10, 10), spread(-30, 1023) * sign(), nearPio2(), uniform(-1e6, 1e6)][Math.floor(unit() * 4)] ?? 0,
  ],
  exp: () => [[uniform(-746, 710), uniform(-1, 1), spread(-60, 0) * sign()][Math.floor(unit() * 3)] ?? 0],
  log: () => [[spread(-1074, 1024), 1 + spread(-50, -4) * sign(), uniform(0, 100)][Math.floor(unit() * 3)] ?? 1],
  atan2: () => [spread(-60, 60) * sign(), spread(-60, 60) * sign()],
  pow: () => {
    const k = Math.floor(unit() * 4);
    if (k === 0) return [spread(-20, 20), uniform(-50, 50)];
    if (k === 1) return [1 + spread(-40, -10) * sign(), spread(10, 40) * sign()];
    if (k === 2) return [-spread(-10, 10), Math.round(uniform(-60, 60))];
    return [spread(-1074, 1024), uniform(-2, 2)];
  },
};
INPUTS['cos'] = INPUTS['sin'] ?? (() => [0]);
for (const [fn, make] of Object.entries(INPUTS)) {
  const f = lib[fn];
  if (!f) throw new Error(`the library has no ${fn}`);
  const two = fn === 'atan2' || fn === 'pow';
  const edges = two ? EDGE.flatMap(a => EDGE.map(b => [a, b])) : EDGE.map(a => [a]);
  for (let k = 0; k < n; k++) {
    const [x = 0, y = 0] = k < edges.length ? (edges[k] ?? []) : make();
    const r = two ? f(x, y) : f(x);
    const m = muslOf(fn, two ? [x, y] : [x]);
    const line = {
      f: fn,
      x: hexOf(x),
      ...(two ? { y: hexOf(y) } : {}),
      r: hexOf(r),
      ...(m === null ? {} : { m: hexOf(m) }),
    };
    console.log(JSON.stringify(line));
  }
}
