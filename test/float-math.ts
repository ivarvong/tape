// sin, cos, tan, asin, acos, atan2, exp, log, pow and Float's % (fmod): the math library (compiler/math) in three
// builds and the reference interpreter,
// against the true values mpmath computed (testdata/float/golden.jsonl, written by proof/float_oracle.py): every
// result within 1 ulp of the true value (atan2: 1.5), a trap (float not finite) where there is no finite one, and the same bits
// in every build and in the interpreter.
import '../node25.ts';
import { readFileSync } from 'node:fs';
import { compile } from '../compiler.ts';
import type { Options } from '../compiler.ts';
import { interpret, Trap } from '../interp.ts';
import { std } from '../std.ts';
import { bare, call, finish, ok, same } from './harness.ts';

type Golden = { f: string; x: string; y?: string; v: string; m?: string };
const isGolden = (v: unknown): v is Golden =>
  typeof v === 'object' && v !== null && 'f' in v && 'x' in v && 'v' in v && typeof v.f === 'string';
const golden: Golden[] = readFileSync(new URL('../testdata/float/golden.jsonl', import.meta.url), 'utf8')
  .split('\n')
  .filter(l => l !== '')
  .map((l): unknown => JSON.parse(l))
  .filter(isGolden);
const dv = new DataView(new ArrayBuffer(8));
const fromHex = (h: string): number => {
  dv.setBigUint64(0, BigInt(`0x${h}`));
  return dv.getFloat64(0);
};
const TWO = new Set(['atan2', 'pow', 'fmod']);
// fmod is Float's `%`: the compiled builds run their port of musl's (compiler/math/fmod.ts), the interpreter
// JavaScript's `%`, which is specified exactly, so there it is an independent check
const FNS = ['sin', 'cos', 'tan', 'asin', 'acos', 'atan2', 'exp', 'log', 'pow', 'fmod'];
const bodyOf = (f: string): string =>
  f === 'fmod' ? 'a % b' : f === 'atan2' ? 'atan2(y: a, x: b)' : `${f}(x: a, y: b)`;
const text = FNS.map(f =>
  TWO.has(f)
    ? `fn m_${f}(a: Float, b: Float) -> Float {\n  ${bodyOf(f)}\n}\n`
    : `fn m_${f}(x: Float) -> Float {\n  ${f}(x)\n}\n`,
).join('\n');

// ---- the error of a result in ulps of the true value, exactly
type Q = { n: bigint; d: bigint };
function rational(x: number): Q {
  dv.setFloat64(0, x);
  const u = dv.getBigUint64(0),
    e = Number((u >> 52n) & 0x7ffn),
    frac = u & ((1n << 52n) - 1n),
    m = e === 0 ? frac : frac | (1n << 52n),
    p = e === 0 ? -1074 : e - 1075,
    n = u >> 63n ? -m : m;
  return p >= 0 ? { n: n << BigInt(p), d: 1n } : { n, d: 1n << BigInt(-p) };
}
function decimal(s: string): Q {
  const m = /^(-?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/.exec(s);
  if (!m) throw new SyntaxError(`not a decimal: ${s}`);
  const [, sign = '', whole = '', frac = '', exp = '0'] = m;
  const n = BigInt(`${sign}${whole}${frac}`),
    e = Number(exp) - frac.length;
  return e >= 0 ? { n: n * 10n ** BigInt(e), d: 1n } : { n, d: 10n ** BigInt(-e) };
}
const abs = (n: bigint): bigint => (n < 0n ? -n : n);
/** a/b * 2^k as a fraction. */
const times2 = (q: Q, k: number): Q => (k >= 0 ? { n: q.n << BigInt(k), d: q.d } : { n: q.n, d: q.d << BigInt(-k) });
/** |r - v| / ulp(v), where ulp(v) is 2^(e-52) for v in [2^e, 2^(e+1)), and 2^-1074 at least. */
function ulps(r: number, v: Q): number {
  const m = { n: abs(v.n), d: v.d };
  let e = m.n === 0n ? -1074 : m.n.toString(2).length - m.d.toString(2).length;
  const atLeast = (k: number): boolean => {
    const t = times2({ n: 1n, d: 1n }, k);
    return m.n * t.d >= t.n * m.d;
  };
  if (m.n !== 0n && !atLeast(e)) e--;
  const q = rational(r);
  const diff: Q = { n: abs(q.n * v.d - v.n * q.d), d: q.d * v.d };
  const inUlps = times2(diff, -Math.max(e - 52, -1074));
  return Number((inUlps.n * 1_000_000n) / inUlps.d) / 1_000_000;
}

// ---- every golden input, under every build and the interpreter
const BUILDS: Partial<Options>[] = [{}, { reuse: false }, { check: true }];
const runs: string[][] = golden.map(() => []);
const shown = (x: number): string => {
  dv.setFloat64(0, x);
  return dv.getBigUint64(0).toString(16);
};
for (const o of BUILDS) {
  const r = compile([...std, { name: 't.tape', text }], { ...o, exports: FNS.map(f => `m_${f}`) });
  if (r.wasm === null) throw new Error(`does not compile: ${r.errors.map(e => `${e.code} ${e.message}`).join('; ')}`);
  const ex = bare(new WebAssembly.Module(r.wasm));
  golden.forEach((g, k) => {
    call(ex.fns, 'reset');
    try {
      runs[k]?.push(shown(Number(call(ex.fns, `m_${g.f}`, fromHex(g.x), ...(g.y ? [fromHex(g.y)] : [])))));
    } catch {
      runs[k]?.push(`trap ${ex.why()}`);
    }
  });
}
const it = interpret([...std, { name: 't.tape', text }]);
golden.forEach((g, k) => {
  try {
    runs[k]?.push(shown(Number(it.call(`m_${g.f}`, [fromHex(g.x), ...(g.y ? [fromHex(g.y)] : [])]))));
  } catch (e) {
    runs[k]?.push(e instanceof Trap ? `trap ${e.code}` : String(e));
  }
});

// musl gives NaN or an infinity where the language traps
const nonFinite = (h: string): boolean => ((BigInt(`0x${h}`) >> 52n) & 0x7ffn) === 0x7ffn;
const musl = golden.flatMap((g, k) => {
  const got = runs[k]?.[0] ?? '';
  if (g.m === undefined) return [];
  const agree =
    got === 'trap 8' ? nonFinite(g.m) : !got.startsWith('trap') && BigInt(`0x${got}`) === BigInt(`0x${g.m}`);
  return agree ? [] : [`${g.f}(${g.x}): ${got}, musl ${g.m}`];
});
same(`the same bits as musl on ${golden.filter(g => g.m !== undefined).length} inputs`, musl.slice(0, 5), []);
const differ = golden.flatMap((g, k) => (new Set(runs[k]).size === 1 ? [] : [`${g.f}(${g.x}): ${runs[k]?.join(' ')}`]));
same('every build and the interpreter give the same bits', differ.slice(0, 5), []);
// fdlibm's atan2 rounds y/x before its atan: 1.24 ulp at worst in 100,000 inputs (proof/float_oracle.py), as musl's
const BOUND: Readonly<Record<string, number>> = { atan2: 1.5 };
const worst = new Map<string, number>();
const off: string[] = [];
golden.forEach((g, k) => {
  const got = runs[k]?.[0] ?? '';
  if (g.v === 'trap') {
    if (got !== 'trap 8') off.push(`${g.f}(${g.x}): ${got}, wanted trap 8`);
    return;
  }
  if (got.startsWith('trap')) {
    off.push(`${g.f}(${g.x}): ${got}, wanted ${g.v}`);
    return;
  }
  dv.setBigUint64(0, BigInt(`0x${got}`));
  const err = ulps(dv.getFloat64(0), decimal(g.v));
  worst.set(g.f, Math.max(worst.get(g.f) ?? 0, err));
  if (err > (BOUND[g.f] ?? 1)) off.push(`${g.f}(${g.x}): ${err} ulp from ${g.v}`);
});
console.log(
  `  ${golden.length} inputs; the largest error: ${[...worst].map(([f, e]) => `${f} ${e.toFixed(3)} ulp`).join(', ')}`,
);
same(
  'every result within 1 ulp of the true value (atan2 1.5), and a trap where there is no finite one',
  off.slice(0, 5),
  [],
);
ok(
  'the golden file covers each function',
  FNS.every(f => golden.filter(g => g.f === f).length >= 300),
);
finish();
