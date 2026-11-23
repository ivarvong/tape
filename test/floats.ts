// Float: an f64 that is never NaN and never infinite. Each case runs under three builds and the reference
// interpreter, and the answer must be what exact arithmetic says: the operands as exact rationals (BigInt), the
// result rounded once to the nearest f64 (ties to even), and a trap (float not finite) when that is beyond the
// largest f64, or when there is no number (0/0). Then the literals, the conversions to and from Int, text, and
// what the compiler refuses.
//   node test/floats.ts [cases]     cases: how many random operand pairs per operator (default 3000)
import '../node25.ts';
import { compile } from '../compiler.ts';
import type { Options } from '../compiler.ts';
import { interpret, Trap } from '../interp.ts';
import { std } from '../std.ts';
import { unreachable } from '../compiler/ast.ts';
import { bare, call, codes, finish, problems, same } from './harness.ts';

type Got = number | bigint | string;
const FLOAT = 'trap 8',
  OVERFLOW = 'trap 6';

// ---- the oracle: exact rationals, rounded once
type Exact = { n: bigint; d: bigint }; // n / d, d > 0 a power of two
const bits = new DataView(new ArrayBuffer(8));
function exact(x: number): Exact {
  bits.setFloat64(0, x);
  const u = bits.getBigUint64(0),
    e = Number((u >> 52n) & 0x7ffn),
    frac = u & ((1n << 52n) - 1n),
    m = e === 0 ? frac : frac | (1n << 52n),
    p = e === 0 ? -1074 : e - 1075,
    n = u >> 63n ? -m : m;
  return p >= 0 ? { n: n << BigInt(p), d: 1n } : { n, d: 1n << BigInt(-p) };
}
/** n/d rounded to the nearest f64, ties to even; ±Infinity beyond the largest; the sign of a zero is the caller's. */
function nearest(n0: bigint, d: bigint): number {
  if (n0 === 0n) return 0;
  const neg = n0 < 0n,
    n = neg ? -n0 : n0;
  // k: the power of two that puts n/d·2^k in [2^52, 2^53), but no more than 1074 (the subnormals' fixed ulp)
  let k = 52 - (n.toString(2).length - d.toString(2).length);
  const scaled = (j: number): [bigint, bigint] => (j >= 0 ? [n << BigInt(j), d] : [n, d << BigInt(-j)]);
  let [a, b] = scaled(k);
  if (a / b >= 1n << 53n) [a, b] = scaled(--k);
  else if (a / b < 1n << 52n) [a, b] = scaled(++k);
  if (k > 1074) [a, b] = scaled((k = 1074));
  let q = a / b;
  const r2 = 2n * (a - q * b);
  if (r2 > b || (r2 === b && q % 2n === 1n)) q++;
  const v = Number(q) * 2 ** -k;
  return neg ? -v : v;
}
const add = (x: Exact, y: Exact): Exact => ({ n: x.n * y.d + y.n * x.d, d: x.d * y.d });
const isNegZero = (x: number): boolean => x === 0 && 1 / x < 0;
const signed = (x: number): boolean => x < 0 || isNegZero(x);
type Op = '+' | '-' | '*' | '/';
function exactly(op: Op, x: number, y: number): Got {
  const a = exact(x),
    b = exact(y);
  let r: number;
  switch (op) {
    case '+':
    case '-': {
      const s = add(a, op === '+' ? b : { n: -b.n, d: b.d });
      // an exact zero is +0, but -0 + -0 (and -0 - +0) is -0
      r = s.n === 0n ? (isNegZero(x) && isNegZero(op === '+' ? y : -y) ? -0 : 0) : nearest(s.n, s.d);
      break;
    }
    case '*':
      r = a.n === 0n || b.n === 0n ? (signed(x) !== signed(y) ? -0 : 0) : nearest(a.n * b.n, a.d * b.d);
      break;
    case '/':
      if (b.n === 0n) return FLOAT;
      r =
        a.n === 0n
          ? signed(x) !== signed(y)
            ? -0
            : 0
          : nearest(a.n * b.d * (b.n < 0n ? -1n : 1n), a.d * (b.n < 0n ? -b.n : b.n));
      break;
    default:
      return unreachable(op, 'operator');
  }
  return Number.isFinite(r) ? r : FLOAT;
}

// ---- one program, many functions, each run under every build and the interpreter
const BUILDS: Partial<Options>[] = [{}, { reuse: false }, { check: true }];
type Case = { fn: string; args: (number | bigint)[] };
const asGot = (v: unknown): Got => (typeof v === 'number' || typeof v === 'bigint' ? v : `value ${String(v)}`);
function runAll(text: string, cases: readonly Case[]): Got[][] {
  const fns = [...new Set(cases.map(c => c.fn))];
  const answers: Got[][] = cases.map(() => []);
  for (const o of BUILDS) {
    const r = compile([...std, { name: 't.tape', text }], { ...o, exports: fns });
    if (r.wasm === null)
      throw new Error(`does not compile: ${r.errors.map(e => `${e.code} ${e.line} ${e.message}`).join('; ')}`);
    const ex = bare(new WebAssembly.Module(r.wasm));
    cases.forEach((c, i) => {
      call(ex.fns, 'reset');
      try {
        answers[i]?.push(asGot(call(ex.fns, c.fn, ...c.args)));
      } catch {
        answers[i]?.push(`trap ${ex.why()}`);
      }
    });
  }
  const it = interpret([...std, { name: 't.tape', text }]);
  cases.forEach((c, i) => {
    try {
      const v = it.call(c.fn, [...c.args]);
      answers[i]?.push(typeof v === 'boolean' ? (v ? 1 : 0) : asGot(v));
    } catch (e) {
      answers[i]?.push(e instanceof Trap ? `trap ${e.code}` : `trap -1 ${String(e)}`);
    }
  });
  return answers;
}
// Object.is: a -0 must be a -0 in every build
const show = (g: Got | undefined): string => (isNegZero(Number(g)) && typeof g === 'number' ? '-0' : String(g));
function wrong(text: string, cases: readonly Case[], want: readonly Got[]): string[] {
  return runAll(text, cases).flatMap((got, i) =>
    got.every(g => Object.is(g, want[i]))
      ? []
      : [
          `${cases[i]?.fn}(${cases[i]?.args.map(a => show(a)).join(', ')}): ${got.map(show).join(' ')}, exact ${show(want[i])}`,
        ],
  );
}

// ---- 1. the oracle against what is known
same(
  'the oracle: 0.1 + 0.2, 1/3, 2^-1074 / 2, the largest times 2, 1 - 2^-53, a tie to even',
  [
    exactly('+', 0.1, 0.2),
    exactly('/', 1, 3),
    exactly('/', 2 ** -1074, 2),
    exactly('*', Number.MAX_VALUE, 2),
    exactly('-', 1, 2 ** -54),
    exactly('+', 1, 2 ** -53),
  ],
  [0.30000000000000004, 0.3333333333333333, 0, FLOAT, 1, 1],
);

// ---- 2. every operator on edge values, and random ones
const OPS: Op[] = ['+', '-', '*', '/'];
const NAME: Record<Op, string> = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div' };
const EDGES = [
  0,
  -0,
  2 ** -1074,
  -(2 ** -1074),
  2 ** -1022,
  2 ** -1022 - 2 ** -1074,
  1e-300,
  0.1,
  0.5,
  1,
  -1,
  1 + 2 ** -52,
  1.5,
  2,
  3,
  10,
  1e15,
  2 ** 53,
  2 ** 53 + 2,
  1e300,
  -1e300,
  Number.MAX_VALUE,
  -Number.MAX_VALUE,
];
let seed = 0x2545f4914f6cdd1dn;
const rand = (n: number): number => {
  seed = BigInt.asUintN(64, seed * 6364136223846793005n + 1442695040888963407n);
  return Number((seed >> 33n) % BigInt(n));
};
/** A double: any bit pattern that is finite, one of modest size, or one near another (to cancel). */
function randomFloat(near: number | null): number {
  const kind = rand(4);
  if (near !== null && kind === 0) return near * (1 + (rand(2000) - 1000) * 2 ** -40);
  if (kind === 1) return (rand(2_000_001) - 1_000_000) / (1 + rand(1000));
  for (;;) {
    bits.setUint32(0, rand(2 ** 32));
    bits.setUint32(4, rand(2 ** 32));
    const x = bits.getFloat64(0);
    if (Number.isFinite(x)) return x;
  }
}
const binaries = OPS.map(op => `fn ${NAME[op]}(a: Float, b: Float) -> Float {\n  a ${op} b\n}\n`).join('\n');
const cmp = `fn lt(a: Float, b: Float) -> Bool {\n  a < b\n}\n\nfn eq(a: Float, b: Float) -> Bool {\n  a == b\n}\n\nfn neg(a: Float) -> Float {\n  -a\n}\n`;
const cases = Number(process.argv[2] ?? 3000);
const pairs: [number, number][] = [
  ...EDGES.flatMap(a => EDGES.map((b): [number, number] => [a, b])),
  ...Array.from({ length: cases }, (): [number, number] => {
    const a = randomFloat(null);
    return [a, randomFloat(a)];
  }),
];
const opCases: Case[] = [
  ...OPS.flatMap(op => pairs.map(([a, b]) => ({ fn: NAME[op], args: [a, b] }))),
  ...pairs.map(([a, b]) => ({ fn: 'lt', args: [a, b] })),
  ...pairs.map(([a, b]) => ({ fn: 'eq', args: [a, b] })),
  ...EDGES.map(a => ({ fn: 'neg', args: [a] })),
];
const opWant: Got[] = [
  ...OPS.flatMap(op => pairs.map(([a, b]) => exactly(op, a, b))),
  ...pairs.map(([a, b]) => {
    const x = exact(a),
      y = exact(b);
    return x.n * y.d < y.n * x.d ? 1 : 0;
  }),
  ...pairs.map(([a, b]) => {
    const x = exact(a),
      y = exact(b);
    return x.n * y.d === y.n * x.d ? 1 : 0;
  }),
  ...EDGES.map(a => (isNegZero(a) ? 0 : a === 0 ? -0 : -a)),
];
const opWrong = wrong(`${binaries}\n${cmp}`, opCases, opWant);
same(
  `+ - * / < == on ${EDGES.length}×${EDGES.length} edge pairs and ${cases} random ones, and -a: ${opCases.length} runs, ${opWant.filter(w => w === FLOAT).length} of them traps`,
  opWrong.slice(0, 5),
  [],
);

// ---- 3. literals, and a Float in a record, a variant, a closure and a let
const literals = `type P { P(x: Float, y: Float) }

type Shape {
  Circle(r: Float)
  Square(side: Float, n: Int)
}

fn lits() -> Float {
  1.5f + 2f * 1e-3f - 6.02E23f / 1e23f + 0.1f
}

fn negative() -> Float {
  -1.5f * -2f
}

fn tiny() -> Float {
  4.9406564584124654e-324f
}

fn record(a: Float) -> Float {
  let p = P(x: a, y: a * 2f)
  p.y - p.x
}

fn area(s: Shape) -> Float {
  match s {
    Circle(r) -> 3.141592653589793f * r * r
    Square(side, n) -> side * side * float(n)
  }
}

fn areas(a: Float) -> Float {
  area(Circle(r: a)) + area(Square(side: a, n: 3))
}

fn scaled(k: Float) -> Fn[Float, Float] {
  fn(x: Float) -> Float { x * k }
}

fn closure(a: Float) -> Float {
  let f = scaled(k: 2.5f)
  f(a)
}

fn guarded(a: Float) -> Int {
  match a {
    x if x == 0f -> 0
    x if x < 0f -> -1
    _ -> 1
  }
}
`;
const litCases: [Case, Got][] = [
  [{ fn: 'lits', args: [] }, 1.5 + 2 * 1e-3 - 6.02e23 / 1e23 + 0.1],
  [{ fn: 'negative', args: [] }, 3],
  [{ fn: 'tiny', args: [] }, 2 ** -1074],
  [{ fn: 'record', args: [0.1] }, 0.1],
  [{ fn: 'areas', args: [2] }, Math.PI * 2 * 2 + 12],
  [{ fn: 'closure', args: [4] }, 10],
  [{ fn: 'guarded', args: [-0] }, 0n],
  [{ fn: 'guarded', args: [-(2 ** -1074)] }, -1n],
  [{ fn: 'guarded', args: [7] }, 1n],
];
same(
  'literals, negative literals, the least subnormal, and a Float in a record, a variant, a closure and a guard',
  wrong(
    literals,
    litCases.map(x => x[0]),
    litCases.map(x => x[1]),
  ),
  [],
);

// ---- 4. conversions and the numbers' intrinsics: float(n) rounds once; trunc gives an Int or stops; floor, ceil,
// abs and sqrt of a Float; abs, min and max of an Int or a Float
const MIN = -(2n ** 63n),
  MAX = 2n ** 63n - 1n;
const unaries = ['floor', 'ceil', 'abs', 'sqrt'];
const convert = [
  `fn to_float(n: Int) -> Float {\n  float(n)\n}\n`,
  `fn to_trunc(x: Float) -> Int {\n  trunc(x)\n}\n`,
  ...unaries.map(g => `fn f_${g}(x: Float) -> Float {\n  ${g}(x)\n}\n`),
  `fn f_min(a: Float, b: Float) -> Float {\n  min(a, b)\n}\n`,
  `fn f_max(a: Float, b: Float) -> Float {\n  max(a, b)\n}\n`,
  `fn i_min(a: Int, b: Int) -> Int {\n  min(a, b)\n}\n`,
  `fn i_max(a: Int, b: Int) -> Int {\n  max(a, b)\n}\n`,
  `fn i_abs(x: Int) -> Int {\n  abs(x)\n}\n`,
].join('\n');
const INTS = [
  0n,
  1n,
  -1n,
  2n ** 53n,
  2n ** 53n + 1n,
  2n ** 53n + 3n,
  -(2n ** 53n) - 1n,
  2n ** 62n + 1n,
  MAX,
  MIN,
  MIN + 1n,
];
/** x's exact value rounded toward -∞, +∞ or zero, as an integer. */
function integral(how: 'floor' | 'ceil' | 'trunc', x: number): bigint {
  const { n, d } = exact(x);
  const fl = n >= 0n ? n / d : -((-n + d - 1n) / d);
  return how === 'floor' ? fl : how === 'ceil' ? (fl * d === n ? fl : fl + 1n) : n / d;
}
/** The double next to a positive r, by its bits: one up or one down. */
function step(r: number, by: bigint): number {
  bits.setFloat64(0, r);
  bits.setBigUint64(0, bits.getBigUint64(0) + by);
  return bits.getFloat64(0);
}
/** The nearest f64 to sqrt(x), checked exactly: r is it when the midpoints to its neighbours bracket sqrt(x). */
function root(x: number): Got {
  if (x === 0) return x;
  if (x < 0) return FLOAT;
  const { n, d } = exact(x);
  const r = Math.sqrt(x);
  const mid = (o: number): Exact => add(exact(r), exact(o));
  const [lo, hi] = [mid(step(r, -1n)), mid(step(r, 1n))];
  // (m/2)^2 vs n/d, for m = lo and hi (each is twice the midpoint)
  const below = (m: Exact): boolean => m.n * m.n * d < 4n * n * m.d * m.d;
  return below(lo) && !below(hi) ? r : `not correctly rounded: Math.sqrt(${x}) = ${r}`;
}
const zeroOf = (v: bigint, x: number): number => (v === 0n ? (signed(x) ? -0 : 0) : Number(v));
const less = (a: number, b: number): boolean => {
  const x = exact(a),
    y = exact(b);
  return x.n * y.d < y.n * x.d;
};
const fmin = (a: number, b: number): number =>
  a === 0 && b === 0 ? (signed(a) || signed(b) ? -0 : 0) : less(b, a) ? b : a;
const fmax = (a: number, b: number): number =>
  a === 0 && b === 0 ? (signed(a) && signed(b) ? -0 : 0) : less(a, b) ? b : a;
const FLOATS = [
  0,
  -0,
  0.5,
  -0.5,
  1.5,
  2.5,
  -2.5,
  0.49999999999999994,
  2 ** 52 + 1,
  2 ** 52 - 0.5,
  -(2 ** 52) + 0.5,
  2 ** -1074,
  1e-300,
  -1e-300,
  123.456,
  -123.456,
  2,
  4,
  2 ** 63,
  -(2 ** 63),
  2 ** 63 - 1024,
  -(2 ** 63) - 2048,
  1e300,
  -1e300,
  Number.MAX_VALUE,
  ...Array.from({ length: 300 }, () => randomFloat(null) / 2 ** rand(1100)),
];
const unaryWant = (g: string, x: number): Got =>
  g === 'floor' || g === 'ceil' ? zeroOf(integral(g, x), x) : g === 'abs' ? (signed(x) ? -x : x) : root(x);
const fpairs = FLOATS.map((x, k): [number, number] => [x, FLOATS[(k * 7 + 3) % FLOATS.length] ?? 0]);
const ipairs = INTS.flatMap(a => INTS.map((b): [bigint, bigint] => [a, b]));
const convCases: Case[] = [
  ...INTS.map(n => ({ fn: 'to_float', args: [n] })),
  ...FLOATS.map(x => ({ fn: 'to_trunc', args: [x] })),
  ...unaries.flatMap(g => FLOATS.map(x => ({ fn: `f_${g}`, args: [x] }))),
  ...fpairs.flatMap(([a, b]) => [
    { fn: 'f_min', args: [a, b] },
    { fn: 'f_max', args: [a, b] },
  ]),
  ...ipairs.flatMap(([a, b]) => [
    { fn: 'i_min', args: [a, b] },
    { fn: 'i_max', args: [a, b] },
  ]),
  ...INTS.map(n => ({ fn: 'i_abs', args: [n] })),
];
const convWant: Got[] = [
  ...INTS.map(n => nearest(n, 1n)),
  ...FLOATS.map(x => {
    const v = integral('trunc', x);
    return v < MIN || v > MAX ? OVERFLOW : v;
  }),
  ...unaries.flatMap(g => FLOATS.map(x => unaryWant(g, x))),
  ...fpairs.flatMap(([a, b]) => [fmin(a, b), fmax(a, b)]),
  ...ipairs.flatMap(([a, b]) => [a < b ? a : b, a > b ? a : b]),
  ...INTS.map(n => (n === MIN ? OVERFLOW : n < 0n ? -n : n)),
];
same(
  `float(n) on ${INTS.length} Ints, trunc and floor, ceil, abs, sqrt on ${FLOATS.length} Floats, min and max of Floats and Ints, abs of Ints: ${convCases.length} runs`,
  wrong(convert, convCases, convWant).slice(0, 5),
  [],
);
same(
  'the oracle: trunc outside the Ints stops, ceil(-0.5) is -0, sqrt(2) is correctly rounded, sqrt(-1) stops',
  [
    OVERFLOW === (integral('trunc', 2 ** 63) > MAX ? OVERFLOW : 0),
    Object.is(unaryWant('ceil', -0.5), -0),
    root(2),
    root(-1),
  ],
  [true, true, Math.SQRT2, FLOAT],
);

// ---- 5. text: a Float in a hole is the shortest digits that read back as it
const text = `fn show(x: Float) -> View {\n  "x=\\(x);"\n}\n`;
const shown = [0, -0, 0.1, 0.1 + 0.2, 1e21, 1e-7, 123456789.125, 2 ** -1074, Number.MAX_VALUE, -5, 100];
const viewOf = (ex: ReturnType<typeof bare>, x: number): string => {
  call(ex.fns, 'reset');
  const r = call(ex.fns, 'show', x);
  const [at, n] = Array.isArray(r) ? r.map(Number) : [0, 0];
  return new TextDecoder().decode(new Uint8Array(ex.memory.buffer, at, n));
};
const tb = compile([...std, { name: 't.tape', text }], { exports: ['show'] });
const tex = bare(new WebAssembly.Module(tb.wasm ?? new Uint8Array()));
const tit = interpret([...std, { name: 't.tape', text }]);
same(
  'a hole gives the shortest digits (String of the number) in the compiled build and in the interpreter',
  shown.map(x => {
    const v = tit.call('show', [x]);
    return [viewOf(tex, x), new TextDecoder().decode(v instanceof Uint8Array ? v : new Uint8Array())];
  }),
  shown.map(x => [`x=${String(x)};`, `x=${String(x)};`]),
);

// ---- 6. random expressions: each operation rounded once, as the oracle rounds it, and trap for trap
type E =
  { k: 'lit'; v: number } | { k: 'var'; n: 'x' | 'y' | 'z' } | { k: 'neg'; e: E } | { k: 'bin'; op: Op; l: E; r: E };
const LITS = [0, 0.5, 1, 3, 0.1, 1e-300, 1e300, 1.7976931348623157e308, 2 ** -1074, 6.02e23];
function gen(depth: number): E {
  if (depth === 0 || rand(4) === 0)
    return rand(2) === 0
      ? { k: 'var', n: (['x', 'y', 'z'] as const)[rand(3)] ?? 'x' }
      : { k: 'lit', v: LITS[rand(LITS.length)] ?? 1 };
  if (rand(8) === 0) return { k: 'neg', e: gen(depth - 1) };
  return { k: 'bin', op: OPS[rand(4)] ?? '+', l: gen(depth - 1), r: gen(depth - 1) };
}
// a literal as Tape writes it: the shortest digits, an f, and an exponent only in Tape's form
const lit = (v: number): string => `${String(v).replace('e+', 'e')}f`;
const src = (e: E): string =>
  e.k === 'lit'
    ? lit(e.v)
    : e.k === 'var'
      ? e.n
      : e.k === 'neg'
        ? `-(${src(e.e)})`
        : `(${src(e.l)} ${e.op} ${src(e.r)})`;
function value(e: E, env: Record<'x' | 'y' | 'z', number>): Got {
  if (e.k === 'lit') return e.v;
  if (e.k === 'var') return env[e.n];
  if (e.k === 'neg') {
    const v = value(e.e, env);
    return typeof v === 'number' ? -v : v;
  }
  const l = value(e.l, env);
  if (typeof l !== 'number') return l;
  const r = value(e.r, env);
  return typeof r === 'number' ? exactly(e.op, l, r) : r;
}
const EXPRS = Number(process.argv[3] ?? 600);
const exprs = Array.from({ length: EXPRS }, () => gen(1 + rand(4)));
const exprText = exprs.map((e, i) => `fn e${i}(x: Float, y: Float, z: Float) -> Float {\n  ${src(e)}\n}\n`).join('\n');
const exprCases: Case[] = [],
  exprWant: Got[] = [];
exprs.forEach((e, i) => {
  for (let k = 0; k < 4; k++) {
    const env = { x: randomFloat(null), y: randomFloat(null), z: (rand(2001) - 1000) / 8 };
    exprCases.push({ fn: `e${i}`, args: [env.x, env.y, env.z] });
    exprWant.push(value(e, env));
  }
});
same(
  `random expressions: ${exprCases.length} runs, ${exprWant.filter(w => w === FLOAT).length} of them traps, each operation rounded once`,
  wrong(exprText, exprCases, exprWant).slice(0, 5),
  [],
);

// ---- 7. what the compiler refuses
const refused = (program: string): string[] => problems(program, { exports: ['f'] }).map(p => p.code);
const fnOf = (body: string, params = 'x: Float, n: Int'): string => `fn f(${params}) -> Float {\n  ${body}\n}\n`;
same(
  'refused: 1.5 and 1e3 without f, more than 20 digits, beyond the largest; an Int with a Float; %, bitwise, ++',
  [
    refused(fnOf('1.5')),
    refused(fnOf('1e3')),
    refused(fnOf('1.2345678901234567890123f')),
    refused(fnOf('1e400f')),
    refused(fnOf('x + 1')),
    refused(fnOf('x * n')),
    refused(fnOf('x % 2f')),
    refused(fnOf('round(x)')),
    refused(`fn f(x: Float) -> Float {\n  x & x\n}\n`),
  ],
  [['L06'], ['L06'], ['L06'], ['L06'], ['C14'], ['C14'], ['C19'], ['C22'], ['C19']],
);
const mixed = problems(fnOf('x + 1'), { exports: ['f'] })[0]?.hint ?? '';
same(
  'the hint names the conversions',
  ['`2f`', 'float(n)', 'trunc(x)'].every(w => mixed.includes(w)),
  true,
);
same(
  'refused: a Float literal pattern (C19), an Int where a Float is wanted (C14)',
  [
    codes(`fn f(x: Float) -> Int {\n  match x {\n    0.5f -> 1\n    _ -> 0\n  }\n}\n`, { exports: ['f'] }).map(
      c => c.split(':')[0],
    ),
    codes(`fn f(n: Int) -> Float {\n  n\n}\n`, { exports: ['f'] }).map(c => c.split(':')[0]),
  ],
  [['C19'], ['C14']],
);

finish();
