// Dec[s]: an exact number with s digits after the point, an Int count of 10^-s. Every case runs under three builds
// and the reference interpreter, and each answer must be what a reference written here says (BigInt, rounding by
// the floor of the quotient, so neither the compiler's muldiv nor the interpreter's truncating division is reused)
// and, for the golden cases, what Python's decimal says (testdata/dec/golden.jsonl, written by proof/dec_oracle.py).
// Then the rounding table of the definition, literals, conversions, and what the compiler refuses.
//   node test/decs.ts [cases]     cases: random calls besides the golden ones (default 100000)
import '../node25.ts';
import { readFileSync } from 'node:fs';
import { compile } from '../compiler.ts';
import type { Options } from '../compiler.ts';
import { interpret, Trap } from '../interp.ts';
import type { Value } from '../interp/value.ts';
import { adt } from '../interp/value.ts';
import { std } from '../std.ts';
import { bare, call, finish, problems, same } from './harness.ts';

const MIN = -(2n ** 63n),
  MAX = 2n ** 63n - 1n,
  OVERFLOW = 'trap 6',
  DIVISION = 'trap 4';
const MODES = ['HalfEven', 'HalfUp', 'Down', 'Up', 'Floor', 'Ceiling'] as const;
type Mode = (typeof MODES)[number];
const p10 = (k: number): bigint => 10n ** BigInt(k);

// ---- the reference: exact BigInt, rounded from the floor of the quotient
/** n / d rounded as the mode says. */
function rounded(n0: bigint, d0: bigint, mode: Mode): bigint {
  const [n, d] = d0 < 0n ? [-n0, -d0] : [n0, d0];
  const q = n >= 0n ? n / d : -((-n + d - 1n) / d); // the floor
  const f = n - q * d; // 0 <= f < d
  if (f === 0n) return q;
  const c = q + 1n,
    twice = 2n * f;
  switch (mode) {
    case 'Floor':
      return q;
    case 'Ceiling':
      return c;
    case 'Down':
      return n > 0n ? q : c;
    case 'Up':
      return n > 0n ? c : q;
    case 'HalfUp':
      return twice > d ? c : twice < d ? q : n > 0n ? c : q;
    case 'HalfEven':
      return twice > d ? c : twice < d ? q : q % 2n === 0n ? q : c;
    default:
      throw new Error(`no rounding ${String(mode)}`);
  }
}
const count = (v: bigint): string => (v < MIN || v > MAX ? OVERFLOW : String(v));
const view = new DataView(new ArrayBuffer(8));
/** A double as an exact n / d, d a power of two. */
function exactOf(x: number): [bigint, bigint] {
  view.setFloat64(0, x);
  const u = view.getBigUint64(0),
    e = Number((u >> 52n) & 0x7ffn),
    frac = u & ((1n << 52n) - 1n),
    m = e === 0 ? frac : frac | (1n << 52n),
    p = e === 0 ? -1074 : e - 1075,
    n = u >> 63n ? -m : m;
  return p >= 0 ? [n << BigInt(p), 1n] : [n, 1n << BigInt(-p)];
}
/** n/d rounded to the nearest double (a tie to the even one); n/d is well inside the doubles' range here. */
function nearest(n0: bigint, d: bigint): number {
  if (n0 === 0n) return 0;
  const neg = n0 < 0n,
    n = neg ? -n0 : n0;
  let k = 54 - (n.toString(2).length - d.toString(2).length);
  const scaled = (j: number): [bigint, bigint] => (j >= 0 ? [n << BigInt(j), d] : [n, d << BigInt(-j)]);
  let [a, b] = scaled(k);
  while (a / b >= 1n << 53n) [a, b] = scaled(--k);
  while (a / b < 1n << 52n) [a, b] = scaled(++k);
  let q = a / b;
  const r2 = 2n * (a - q * b);
  if (r2 > b || (r2 === b && q % 2n === 1n)) q++;
  const v = Number(q) * 2 ** -k;
  return neg ? -v : v;
}
const hexOf = (x: number): string => {
  view.setFloat64(0, x);
  return view.getBigUint64(0).toString(16).padStart(16, '0');
};
const fromHex = (h: string): number => {
  view.setBigUint64(0, BigInt(`0x${h}`));
  return view.getFloat64(0);
};

// ---- the functions: an operation at given scales, written in Tape
type Kind = 'D' | 'I' | 'F';
type Op = { args: (sc: number[]) => [Kind, number][]; ret: (sc: number[]) => string; body: string; rounds?: true };
const D = (s: number): [Kind, number] => ['D', s],
  I: [Kind, number] = ['I', 0],
  F: [Kind, number] = ['F', 0];
const S = (k: number) => (sc: number[]) => sc[k] ?? 0;
const OPS: Record<string, Op> = {
  add: { args: sc => [D(S(0)(sc)), D(S(0)(sc))], ret: sc => `Dec[${S(0)(sc)}]`, body: 'a + b' },
  sub: { args: sc => [D(S(0)(sc)), D(S(0)(sc))], ret: sc => `Dec[${S(0)(sc)}]`, body: 'a - b' },
  times: { args: sc => [D(S(0)(sc)), I], ret: sc => `Dec[${S(0)(sc)}]`, body: 'a * b' },
  prod: { args: sc => [D(S(0)(sc)), D(S(1)(sc))], ret: sc => `Dec[${S(0)(sc) + S(1)(sc)}]`, body: 'a * b' },
  neg: { args: sc => [D(S(0)(sc))], ret: sc => `Dec[${S(0)(sc)}]`, body: '-a' },
  abs: { args: sc => [D(S(0)(sc))], ret: sc => `Dec[${S(0)(sc)}]`, body: 'abs(a)' },
  lt: { args: sc => [D(S(0)(sc)), D(S(1)(sc))], ret: () => 'Bool', body: 'a < b' },
  eq: { args: sc => [D(S(0)(sc)), D(S(1)(sc))], ret: () => 'Bool', body: 'a == b' },
  ge: { args: sc => [D(S(0)(sc)), D(S(1)(sc))], ret: () => 'Bool', body: 'a >= b' },
  rescale: { args: sc => [D(S(0)(sc))], ret: sc => `Dec[${S(1)(sc)}]`, body: 'rescale(x: a, to: $1)' },
  round: {
    args: sc => [D(S(0)(sc))],
    ret: sc => `Dec[${S(1)(sc)}]`,
    body: 'round(x: a, to: $1, rounding: r)',
    rounds: true,
  },
  to_int: { args: sc => [D(S(0)(sc))], ret: () => 'Int', body: 'to_int(x: a, rounding: r)', rounds: true },
  dec: { args: () => [I], ret: sc => `Dec[${S(0)(sc)}]`, body: 'dec(n: a, scale: $0)' },
  mul: {
    args: sc => [D(S(0)(sc)), D(S(1)(sc))],
    ret: sc => `Dec[${S(2)(sc)}]`,
    body: 'mul(a, by: b, scale: $2, rounding: r)',
    rounds: true,
  },
  mulint: {
    args: sc => [D(S(0)(sc)), I],
    ret: sc => `Dec[${S(1)(sc)}]`,
    body: 'mul(a, by: b, scale: $1, rounding: r)',
    rounds: true,
  },
  div: {
    args: sc => [D(S(0)(sc)), D(S(1)(sc))],
    ret: sc => `Dec[${S(2)(sc)}]`,
    body: 'div(a, by: b, scale: $2, rounding: r)',
    rounds: true,
  },
  divint: {
    args: sc => [D(S(0)(sc)), I],
    ret: sc => `Dec[${S(1)(sc)}]`,
    body: 'div(a, by: b, scale: $1, rounding: r)',
    rounds: true,
  },
  to_dec: {
    args: () => [F],
    ret: sc => `Dec[${S(0)(sc)}]`,
    body: 'to_dec(x: a, scale: $0, rounding: r)',
    rounds: true,
  },
  float: { args: sc => [D(S(0)(sc))], ret: () => 'Float', body: 'float(n: a)' },
};
const opOf = (op: string): Op =>
  OPS[op] ??
  (() => {
    throw new Error(`no op ${op}`);
  })();
const fnName = (op: string, sc: number[]): string => `${op}_${sc.join('_')}`;
function source(op: string, sc: number[]): string {
  const o = opOf(op);
  const kinds = o.args(sc).map(([k, s]) => (k === 'D' ? `Dec[${s}]` : k === 'I' ? 'Int' : 'Float'));
  const params = [...kinds.map((t, i) => `${'ab'[i]}: ${t}`), ...(o.rounds ? ['r: Rounding'] : [])].join(', ');
  const body = o.body.replaceAll(/\$(\d)/g, (_, k: string) => String(sc[Number(k)]));
  return `fn ${fnName(op, sc)}(${params}) -> ${o.ret(sc)} {\n  ${body}\n}\n`;
}

/** What the reference says of one call: a count, true or false, a Float's bits, or a trap. */
function reference(op: string, sc: number[], args: string[], mode: Mode): string {
  const [a = '0', b = '0'] = args;
  const x = op === 'to_dec' ? 0n : BigInt(a),
    y = op === 'to_dec' ? 0n : BigInt(b);
  const [s = 0, u = 0, t = 0] = sc;
  /** x·10^-s compared with y·10^-u */
  const cmp = (): number => {
    const l = x * p10(u),
      r = y * p10(s);
    return l < r ? -1 : l > r ? 1 : 0;
  };
  switch (op) {
    case 'add':
      return count(x + y);
    case 'sub':
      return count(x - y);
    case 'times':
    case 'prod':
      return count(x * y);
    case 'neg':
      return count(-x);
    case 'abs':
      return count(x < 0n ? -x : x);
    case 'lt':
      return String(cmp() < 0);
    case 'eq':
      return String(cmp() === 0);
    case 'ge':
      return String(cmp() >= 0);
    case 'rescale':
      return count(x * p10(u - s));
    case 'round':
      return count(rounded(x, p10(s - u), mode));
    case 'to_int':
      return count(rounded(x, p10(s), mode));
    case 'dec':
      return count(x * p10(s));
    case 'mul':
    case 'mulint': {
      const [bs, ts] = op === 'mul' ? [u, t] : [0, u];
      // x·y at scale s + bs, to ts
      const at = s + bs;
      return count(ts >= at ? x * y * p10(ts - at) : rounded(x * y, p10(at - ts), mode));
    }
    case 'div':
    case 'divint': {
      const [bs, ts] = op === 'div' ? [u, t] : [0, u];
      if (y === 0n) return DIVISION;
      // (x·10^-s / (y·10^-bs))·10^ts = x·10^(ts+bs) / (y·10^s)
      return count(rounded(x * p10(ts + bs), y * p10(s), mode));
    }
    case 'to_dec': {
      const [n, d] = exactOf(fromHex(a));
      return count(rounded(n * p10(s), d, mode));
    }
    case 'float':
      return hexOf(nearest(x, p10(s)));
    default:
      throw new Error(`no op ${op}`);
  }
}

// ---- one program of every function, each call under every build and the interpreter
const BUILDS: Partial<Options>[] = [{}, { reuse: false }, { check: true }];
type Case = { op: string; scales: number[]; args: string[]; rounding?: Mode; want?: string };
const shown = (v: unknown): string =>
  typeof v === 'number'
    ? hexOf(v)
    : typeof v === 'boolean'
      ? String(v)
      : typeof v === 'object' && v !== null && 'm' in v
        ? String(v.m)
        : String(v);
function runAll(cases: readonly Case[]): string[][] {
  const fns = new Map<string, string>();
  for (const c of cases) fns.set(fnName(c.op, c.scales), source(c.op, c.scales));
  const text = [...fns.values()].join('\n');
  const answers: string[][] = cases.map(() => []);
  const kinds = cases.map(c => opOf(c.op).args(c.scales));
  for (const o of BUILDS) {
    const r = compile([...std, { name: 't.tape', text }], { ...o, exports: [...fns.keys()] });
    if (r.wasm === null)
      throw new Error(`does not compile: ${r.errors.map(e => `${e.code} ${e.line} ${e.message}`).join('; ')}`);
    const ex = bare(new WebAssembly.Module(r.wasm));
    const bool = new Set(cases.filter(c => opOf(c.op).ret(c.scales) === 'Bool').map(c => fnName(c.op, c.scales)));
    cases.forEach((c, i) => {
      call(ex.fns, 'reset');
      const args = c.args.map((a, k) => (kinds[i]?.[k]?.[0] === 'F' ? fromHex(a) : BigInt(a)));
      const mode = c.rounding ? [MODES.indexOf(c.rounding)] : [];
      try {
        const v = call(ex.fns, fnName(c.op, c.scales), ...args, ...mode);
        answers[i]?.push(bool.has(fnName(c.op, c.scales)) ? String(v === 1) : shown(v));
      } catch {
        answers[i]?.push(`trap ${ex.why()}`);
      }
    });
  }
  const it = interpret([...std, { name: 't.tape', text }]);
  cases.forEach((c, i) => {
    const args: Value[] = c.args.map((a, k) => {
      const [kind, s] = kinds[i]?.[k] ?? ['I', 0];
      return kind === 'F' ? fromHex(a) : kind === 'D' ? { k: 'dec', m: BigInt(a), s } : BigInt(a);
    });
    try {
      answers[i]?.push(shown(it.call(fnName(c.op, c.scales), [...args, ...(c.rounding ? [adt(c.rounding)] : [])])));
    } catch (e) {
      answers[i]?.push(e instanceof Trap ? `trap ${e.code}` : `trap -1 ${String(e)}`);
    }
  });
  return answers;
}
/** The cases whose answers are not all the one wanted, shown. */
function wrong(cases: readonly Case[], want: (c: Case) => string): string[] {
  return runAll(cases).flatMap((got, i) => {
    const c = cases[i];
    if (!c) return [];
    const w = want(c);
    return got.every(g => g === w)
      ? []
      : [
          `${fnName(c.op, c.scales)}(${c.args.join(', ')}${c.rounding ? `, ${c.rounding}` : ''}): ${got.join(' ')}, want ${w}`,
        ];
  });
}
const refOf = (c: Case): string => reference(c.op, c.scales, c.args, c.rounding ?? 'HalfEven');

// ---- 1. the reference against Python's decimal, then every build and the interpreter against both
const golden: Case[] = readFileSync(new URL('../testdata/dec/golden.jsonl', import.meta.url), 'utf8')
  .split('\n')
  .filter(l => l !== '')
  .map(goldenCase);
/** One line of the golden file, checked to be one. */
function goldenCase(line: string): Case {
  const j: unknown = JSON.parse(line);
  const o = typeof j === 'object' && j !== null ? Object.fromEntries(Object.entries(j)) : {};
  const { op, scales, args, want, rounding } = o;
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
  const mode = MODES.find(m => m === rounding);
  if (typeof op !== 'string' || !Array.isArray(scales)) throw new TypeError(`not a golden case: ${line}`);
  return {
    op,
    scales: scales.map(Number),
    args: strings(args),
    want: String(want),
    ...(mode ? { rounding: mode } : {}),
  };
}
same(
  `the reference agrees with Python's decimal on ${golden.length} golden cases`,
  golden
    .filter(c => refOf(c) !== c.want)
    .map(c => `${fnName(c.op, c.scales)}(${c.args.join(', ')}) ${c.rounding ?? ''}: ${refOf(c)}, decimal ${c.want}`)
    .slice(0, 5),
  [],
);
same('every build and the interpreter give the golden answers', wrong(golden, c => c.want ?? '').slice(0, 5), []);

// ---- 2. the rounding table of the definition (LANGUAGE.md, written by hand from IEEE 754 and Python's ROUND_*)
const table: [string, string[]][] = [
  // x at scale 1, to scale 0: HalfEven HalfUp Down Up Floor Ceiling
  ['-25', ['-2', '-3', '-2', '-3', '-3', '-2']],
  ['-15', ['-2', '-2', '-1', '-2', '-2', '-1']],
  ['-5', ['0', '-1', '0', '-1', '-1', '0']],
  ['-4', ['0', '0', '0', '-1', '-1', '0']],
  ['5', ['0', '1', '0', '1', '0', '1']],
  ['15', ['2', '2', '1', '2', '1', '2']],
  ['25', ['2', '3', '2', '3', '2', '3']],
];
const tableCases = table.flatMap(([x, outs]) =>
  MODES.map((m, k): Case => ({ op: 'round', scales: [1, 0], args: [x], rounding: m, want: outs[k] ?? '' })),
);
const extremes: Case[] =
  // the least and most Dec[2], to scale 1 and 0, every mode (the definition's table)
  MODES.flatMap((m): Case[] => [
    { op: 'round', scales: [2, 1], args: [String(MIN)], rounding: m },
    { op: 'round', scales: [2, 1], args: [String(MAX)], rounding: m },
    { op: 'round', scales: [2, 0], args: [String(MIN)], rounding: m },
    { op: 'div', scales: [2, 2, 2], args: [String(MIN), '-100'], rounding: m },
    { op: 'div', scales: [2, 2, 2], args: ['100', '0'], rounding: m },
    { op: 'divint', scales: [2, 2], args: ['-100', '8'], rounding: m },
  ]);
same(
  'the rounding table: ties at -2.5, -1.5, -0.5, 0.5, 1.5, 2.5 and -0.4 in every mode, as the definition writes them',
  [tableCases.filter(c => refOf(c) !== c.want).length, wrong(tableCases, c => c.want ?? '')],
  [0, []],
);
same(
  'the least and most Dec[2] rounded, the least divided by -1 (overflow), by 0 (division by zero), -1.00 / 8',
  wrong(extremes, refOf),
  [],
);
same(
  'the definition’s values: MIN of Dec[2] to scale 1 Down is -92233720368547758.0, Up -92233720368547758.1; -1.00 / 8 HalfUp is -0.13',
  [
    refOf({ op: 'round', scales: [2, 1], args: [String(MIN)], rounding: 'Down' }),
    refOf({ op: 'round', scales: [2, 1], args: [String(MIN)], rounding: 'Up' }),
    refOf({ op: 'divint', scales: [2, 2], args: ['-100', '8'], rounding: 'HalfUp' }),
    refOf({ op: 'div', scales: [2, 2, 2], args: [String(MIN), '-100'], rounding: 'Down' }),
  ],
  ['-922337203685477580', '-922337203685477581', '-13', OVERFLOW],
);

// ---- 3. random calls: every function of the golden file, edge-biased operands
let seed = 0x9e3779b97f4a7c15n;
const rand = (n: bigint): bigint => {
  seed = BigInt.asUintN(64, seed * 6364136223846793005n + 1442695040888963407n);
  return (seed >> 1n) % n;
};
function pick<T>(xs: readonly T[]): T {
  const x = xs[Number(rand(BigInt(xs.length)))];
  if (x === undefined) throw new Error('nothing to pick');
  return x;
}
function randomCount(s: number): bigint {
  const p = p10(s);
  const kind = rand(10n);
  if (kind < 4n)
    return pick(
      [
        0n,
        1n,
        -1n,
        5n,
        -5n,
        25n,
        -25n,
        MAX,
        MIN,
        MAX - 1n,
        MIN + 1n,
        p,
        -p,
        p / 2n,
        -(p / 2n),
        MAX / p,
        MIN / p,
        MAX / p + 1n,
        2n ** 53n + 1n,
      ].map(v => (v > MAX ? MAX : v)),
    );
  const v = rand(1n << rand(64n));
  const signed = rand(2n) === 0n ? v : -v;
  if (kind < 6n) {
    // a tie, or one away from one, at some scale
    const k = p10(Number(rand(18n)) + 1);
    const t = (signed / k) * k + (signed < 0n ? -k / 2n : k / 2n) + pick([-1n, 0n, 0n, 1n]);
    return t < MIN ? MIN : t > MAX ? MAX : t;
  }
  return signed < MIN ? MIN : signed > MAX ? MAX : signed;
}
const randomInt = (): bigint => pick([0n, 1n, -1n, 2n, 3n, -7n, 10n, 100n, MAX, MIN, rand(2000001n) - 1000000n]);
function randomDouble(): number {
  const kind = rand(3n);
  if (kind === 0n) return pick([0, -0, 0.5, -0.5, 2.5, -2.5, 2.675, 0.015, 1e-5, 5e-324, 9.3e18, -9.3e18, 1e300]);
  if (kind === 1n) return (Number(rand(2000001n)) - 1000000 + 0.5) / 10 ** Number(rand(7n));
  view.setBigUint64(0, rand(1n << 63n) | (rand(2n) << 63n));
  const x = view.getFloat64(0);
  return Number.isFinite(x) ? x : 1.5;
}
const functions = [...new Map(golden.map(c => [fnName(c.op, c.scales), c])).values()];
const n = Number(process.argv[2] ?? 100_000);
const fuzz: Case[] = Array.from({ length: n }, () => {
  const f = pick(functions);
  const kinds = opOf(f.op).args(f.scales);
  const args = kinds.map(([k, s]) =>
    k === 'F' ? hexOf(randomDouble()) : String(k === 'D' && rand(5n) > 0n ? randomCount(s) : randomInt()),
  );
  return { op: f.op, scales: f.scales, args, ...(opOf(f.op).rounds ? { rounding: pick(MODES) } : {}) };
});
same(
  `${n} random calls of ${functions.length} functions: every build and the interpreter give the reference's answers`,
  wrong(fuzz, refOf).slice(0, 5),
  [],
);

// Dec to Float where it is hardest: a count just above or below a midpoint between two Floats, so that the first 64
// bits of the quotient show exactly a half and only the bits past them decide
const midpoints: Case[] = [];
for (const s of [2, 5, 9, 13, 18])
  for (let e = -12; e <= 70; e++)
    for (let j = 0n; j < 40n; j++) {
      const p = p10(s),
        num = (2n * ((1n << 52n) + j * 7919n) + 1n) * (e >= 1 ? 1n << BigInt(e - 1) : 1n),
        den = e >= 1 ? 1n : 1n << BigInt(1 - e);
      for (const m of [(num * p) / den, (num * p) / den + 1n])
        if (m > 1n << 53n && m <= MAX)
          midpoints.push({ op: 'float', scales: [s], args: [String(rand(2n) === 0n ? m : -m)] });
    }
same(
  `Dec to Float at ${midpoints.length} counts beside a midpoint between two Floats: every build and the interpreter round as the reference`,
  wrong(midpoints, refOf).slice(0, 5),
  [],
);

// ---- 4. literals, holes of the type, and Decs in records, variants and closures
const literals = `type Line { Line(price: Dec[2], qty: Int) }

fn total(a: Dec[2]) -> Dec[2] {
  let lines = Line(price: 12.30, qty: 3)
  lines.price * lines.qty + a - 0.05
}

fn negative() -> Dec[3] {
  -1.250 * 2
}

fn least() -> Dec[2] {
  -92233720368547758.08
}

fn closure(a: Dec[1]) -> Dec[1] {
  let add = fn(x: Dec[1]) -> Dec[1] { x + a }
  add(x: 0.5)
}

fn guarded(a: Dec[2]) -> Int {
  match a {
    x if x == 0.00 -> 0
    x if x < 0.0 -> -1
    _ -> 1
  }
}

fn clamp(a: Dec[2]) -> Dec[2] {
  min(a, b: max(a: -1.00, b: 10.00))
}
`;
same(
  'literals, a negative literal and the least Dec[2], a Dec in a record, a closure, a guard; min and max',
  wrongPrograms(),
  [],
);
function wrongPrograms(): string[] {
  const got: string[] = [];
  const cases: [string, Value[], (number | bigint)[], string][] = [
    ['total', [{ k: 'dec', m: 100n, s: 2 }], [100n], '3785'],
    ['negative', [], [], '-2500'],
    ['least', [], [], String(MIN)],
    ['closure', [{ k: 'dec', m: 7n, s: 1 }], [7n], '12'],
    ['guarded', [{ k: 'dec', m: 0n, s: 2 }], [0n], '0'],
    ['guarded', [{ k: 'dec', m: -1n, s: 2 }], [-1n], '-1'],
    ['guarded', [{ k: 'dec', m: 5n, s: 2 }], [5n], '1'],
    ['clamp', [{ k: 'dec', m: 12345n, s: 2 }], [12345n], '1000'],
    ['clamp', [{ k: 'dec', m: -500n, s: 2 }], [-500n], '-500'],
  ];
  const exports = [...new Set(cases.map(c => c[0]))];
  for (const o of BUILDS) {
    const r = compile([...std, { name: 't.tape', text: literals }], { ...o, exports });
    if (r.wasm === null) return r.errors.map(e => `${e.code} ${e.line} ${e.message}`);
    const ex = bare(new WebAssembly.Module(r.wasm));
    for (const [f, , wa, want] of cases) {
      call(ex.fns, 'reset');
      const v = String(call(ex.fns, f, ...wa));
      if (v !== want) got.push(`${f} ${JSON.stringify(o)}: ${v}, want ${want}`);
    }
  }
  const it = interpret([...std, { name: 't.tape', text: literals }]);
  for (const [f, ia, , want] of cases) {
    const v = shown(it.call(f, ia));
    if (v !== want) got.push(`${f} interpreted: ${v}, want ${want}`);
  }
  return got;
}

// ---- 5. what the compiler refuses
const refused = (body: string, params = 'a: Dec[2], b: Dec[3], n: Int, x: Float', ret = 'Dec[2]'): string[] =>
  problems(`fn f(${params}) -> ${ret} {\n  ${body}\n}\n`, { exports: ['f'] }).map(p => p.code);
const hint = (body: string, ret = 'Dec[2]'): string =>
  problems(`fn f(a: Dec[2], b: Dec[3], n: Int, x: Float) -> ${ret} {\n  ${body}\n}\n`, { exports: ['f'] })[0]?.hint ??
  '';
same(
  'refused: two scales in + (C14), an Int or a Float with a Dec (C14), / and % (C19), a product past 18 digits (C14), 1e3 (L06), 19 digits after the point (L06), a literal beyond the counts (P08)',
  [
    refused('a + b'),
    refused('a + 1'),
    refused('a + n'),
    refused('a - x'),
    refused('a / 2'),
    refused('a % b', undefined, 'Dec[2]'),
    refused('a & a'),
    refused('mul(a: 0.000000001, by: 0.0000000001, scale: 2, rounding: Down) + 0.000000001 * 0.0000000001'),
    refused('1e3'),
    refused('0.1234567890123456789'),
    refused('92233720368547758.08'),
  ],
  [['C14'], ['C14'], ['C14'], ['C14'], ['C19'], ['C19'], ['C19'], ['C14'], ['L06'], ['L06'], ['P08']],
);
same(
  'the hints name the one way: rescale up, round down, the literal at its scale, dec(n), to_dec(x), div',
  [
    hint('a + b').includes('round(x: b, to: 2, rounding: HalfEven)'),
    hint('b + a', 'Dec[3]').includes('rescale(x: a, to: 3)'),
    hint('a + 0.5').includes('`0.50`'),
    hint('a + n').includes('scale: 2)') && hint('a + n').includes('dec(n: '),
    hint('a + x').includes('to_dec(x: x, scale: 2'),
    hint('a / 2').includes('div('),
  ],
  [true, true, true, true, true, true],
);
same(
  'refused: Dec without a scale or with 19 (C05); a scale that is not written (C14); round to more digits, rescale to fewer (C14); a Dec literal pattern (C19)',
  [
    refused('a', 'a: Dec'),
    refused('a', 'a: Dec[19]'),
    refused('round(x: a, to: n, rounding: Down)'),
    refused('round(x: a, to: 3, rounding: Down)', undefined, 'Dec[3]'),
    refused('rescale(x: b, to: 2)'),
    refused('match a {\n    0.00 -> a\n    _ -> a\n  }'),
  ],
  [['C05'], ['C05'], ['C14'], ['C14'], ['C14'], ['C19']],
);

finish();
