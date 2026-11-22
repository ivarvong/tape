// Int: 64-bit signed, and arithmetic that does not fit is a trap, not a wrap. Each case runs under three builds and
// the reference interpreter, and the answer must be what exact arithmetic (BigInt, here) says: the value when it
// fits in 64 bits, the trap otherwise. Then negative literals, the precedence of unary minus, the wrapping
// intrinsics, and thousands of random expressions over the same oracle.
//   node test/ints.ts [cases]     cases: how many random expressions (default 4000)
import '../node25.ts';
import { compile } from '../compiler.ts';
import type { Options } from '../compiler.ts';
import { interpret } from '../interp.ts';
import { Trap } from '../interp.ts';
import { std } from '../std.ts';
import { bare, call, finish, same } from './harness.ts';

const MIN = -(2n ** 63n),
  MAX = 2n ** 63n - 1n;
/** what a run gives: a number, or the code of the trap it stopped with */
type Got = bigint | `trap ${number}`;
const DIVISION = 'trap 4',
  OVERFLOW = 'trap 6',
  SHIFT = 'trap 7';

// ---- the oracle: exact arithmetic, and the trap a result outside 64 bits (or a zero divisor, or a shift amount
// outside 0..63) stops with. `a % b` traps when `a / b` would: MIN % -1 is the one case where the remainder fits.
class Stop {
  readonly why: string;
  constructor(why: string) {
    this.why = why;
  }
}
const fits = (x: bigint): bigint => {
  if (x < MIN || x > MAX) throw new Stop(OVERFLOW);
  return x;
};
const asBits = (x: bigint): bigint => BigInt.asIntN(64, x);
type Op = '+' | '-' | '*' | '/' | '%' | '&' | '|' | '^' | '<<' | '>>';
function exact(op: Op, a: bigint, b: bigint): bigint {
  switch (op) {
    case '+':
      return fits(a + b);
    case '-':
      return fits(a - b);
    case '*':
      return fits(a * b);
    case '/':
    case '%':
      if (b === 0n) throw new Stop(DIVISION);
      fits(a / b); // BigInt division truncates toward zero, as Int's does
      return op === '/' ? a / b : a % b;
    case '&':
      return a & b;
    case '|':
      return a | b;
    case '^':
      return a ^ b;
    case '<<':
    case '>>':
      if (b < 0n || b > 63n) throw new Stop(SHIFT);
      // the bits shifted out of a left shift are gone; a right shift copies the sign bit in
      return op === '<<' ? asBits(a << b) : a >> b;
  }
}

// ---- one program, many functions, each run under every build and the interpreter
const BUILDS: Partial<Options>[] = [{}, { reuse: false }, { check: true }];
type Case = { fn: string; args: bigint[] };
/** Each case's answer from each build and from the interpreter: one list per case. */
function runAll(text: string, cases: readonly Case[]): Got[][] {
  const fns = [...new Set(cases.map(c => c.fn))];
  const answers: Got[][] = cases.map(() => []);
  for (const o of BUILDS) {
    const r = compile([...std, { name: 't.tape', text }], { ...o, exports: fns });
    if (r.wasm === null) throw new Error(`does not compile: ${r.errors.map(e => `${e.code} ${e.line} ${e.message}`)}`);
    const ex = bare(new WebAssembly.Module(r.wasm));
    cases.forEach((c, i) => {
      call(ex.fns, 'reset');
      try {
        answers[i]?.push(BigInt.asIntN(64, BigInt(String(call(ex.fns, c.fn, ...c.args)))));
      } catch {
        answers[i]?.push(`trap ${ex.why()}`);
      }
    });
  }
  const it = interpret([...std, { name: 't.tape', text }]);
  cases.forEach((c, i) => {
    try {
      const v = it.call(c.fn, c.args);
      answers[i]?.push(typeof v === 'bigint' ? v : `trap -1`);
    } catch (e) {
      answers[i]?.push(e instanceof Trap ? `trap ${e.code}` : `trap -1`);
    }
  });
  return answers;
}
const show = (g: Got): string => (typeof g === 'bigint' ? String(g) : g);
/** the cases that do not all give `want`, as text */
function wrong(text: string, cases: readonly Case[], want: readonly Got[]): string[] {
  return runAll(text, cases).flatMap((got, i) =>
    got.every(g => g === want[i])
      ? []
      : [
          `${cases[i]?.fn}(${cases[i]?.args.join(', ')}): builds and interpreter ${got.map(show).join(' ')}, exact ${show(want[i] ?? 0n)}`,
        ],
  );
}
const oracle = (f: () => bigint): Got => {
  try {
    return f();
  } catch (e) {
    if (e instanceof Stop) return e.why as Got;
    throw e;
  }
};

// ---- 1. each operator at the edges
const OPS: Op[] = ['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>'];
const NAME: Record<Op, string> = {
  '+': 'add',
  '-': 'sub',
  '*': 'mul',
  '/': 'div',
  '%': 'rem',
  '&': 'band',
  '|': 'bor',
  '^': 'bxor',
  '<<': 'shl',
  '>>': 'shr',
};
const EDGES = [
  MIN,
  MIN + 1n,
  -(2n ** 32n),
  -(2n ** 31n) - 1n,
  -(2n ** 31n),
  -3n,
  -1n,
  0n,
  1n,
  2n,
  3n,
  10n,
  63n,
  64n,
  2n ** 31n - 1n,
  2n ** 31n,
  2n ** 32n,
  3037000499n,
  3037000500n,
  MAX - 1n,
  MAX,
];
const binaries = OPS.map(op => `fn ${NAME[op]}(a: Int, b: Int) -> Int {\n  a ${op} b\n}\n`).join('\n');
const negate = 'fn neg(a: Int) -> Int {\n  -a\n}\n';
const edgeCases: Case[] = [
  ...OPS.flatMap(op => EDGES.flatMap(a => EDGES.map(b => ({ fn: NAME[op], args: [a, b] })))),
  ...EDGES.map(a => ({ fn: 'neg', args: [a] })),
];
const edgeWant = edgeCases.map(c => {
  const [a = 0n, b = 0n] = c.args;
  const op = OPS.find(o => NAME[o] === c.fn);
  return oracle(() => (op ? exact(op, a, b) : fits(-a)));
});
same(
  `every operator on ${EDGES.length}×${EDGES.length} edge values, and -a`,
  wrong(`${binaries}\n${negate}`, edgeCases, edgeWant),
  [],
);

// ---- 2. the cases the report found, and the traps that say which
const fact = `fn fact(n: Int) -> Int {
  match {
    n <= 1 -> 1
    else -> n * fact(n - 1)
  }
}
`;
let f = 1n;
const factorials = Array.from({ length: 26 }, (_, i) => {
  const n = BigInt(i);
  f *= n === 0n ? 1n : n;
  return { n, want: f > MAX ? OVERFLOW : f };
});
same(
  '0! to 25!: exact up to 20!, a trap from 21! on',
  wrong(
    fact,
    factorials.map(x => ({ fn: 'fact', args: [x.n] })),
    factorials.map(x => x.want as Got),
  ),
  [],
);
same('21! is a trap with its own code, not 1/0s', [oracle(() => fits(f)), DIVISION], [OVERFLOW, 'trap 4']);

// ---- 3. literals: negative ones, the least Int, and unary minus binding tighter than * and /
const literals = `fn least() -> Int {
  -9223372036854775808
}

fn most() -> Int {
  9223372036854775807
}

fn neg_seven() -> Int {
  -7
}

fn minus_minus() -> Int {
  3 - -7
}

fn tighter(x: Int) -> Int {
  -x * 3 + -2 * -x / 2
}

fn neg_sum(a: Int, b: Int) -> Int {
  -(a + b)
}

fn least_negated() -> Int {
  -(-9223372036854775808)
}

fn sign(n: Int) -> Int {
  match n {
    -1 -> 100
    -9223372036854775808 -> 200
    0 -> 0
    _ -> 7
  }
}

fn one(n: Int) -> Int {
  let -1 = n else -> 0
  1
}
`;
const litCases: [Case, Got][] = [
  [{ fn: 'least', args: [] }, MIN],
  [{ fn: 'most', args: [] }, MAX],
  [{ fn: 'neg_seven', args: [] }, -7n],
  [{ fn: 'minus_minus', args: [] }, 10n],
  [{ fn: 'tighter', args: [5n] }, -5n * 3n + (-2n * -5n) / 2n],
  [{ fn: 'neg_sum', args: [2n, 3n] }, -5n],
  [{ fn: 'neg_sum', args: [MAX, 1n] }, OVERFLOW],
  [{ fn: 'neg_sum', args: [MIN + 1n, -1n] }, OVERFLOW],
  [{ fn: 'least_negated', args: [] }, OVERFLOW],
  [{ fn: 'sign', args: [-1n] }, 100n],
  [{ fn: 'sign', args: [MIN] }, 200n],
  [{ fn: 'sign', args: [1n] }, 7n],
  [{ fn: 'one', args: [-1n] }, 1n],
  [{ fn: 'one', args: [1n] }, 0n],
];
same(
  'negative literals, the least Int, unary minus on any expression, in patterns',
  wrong(
    literals,
    litCases.map(([c]) => c),
    litCases.map(([, w]) => w),
  ),
  [],
);
const refused = (text: string): string => {
  const [e] = compile([...std, { name: 't.tape', text }], { exports: ['f'] }).errors;
  return e ? `${e.code} ${e.message}` : 'compiled';
};
same(
  'a literal too large for an Int is refused, not wrapped',
  [
    refused('fn f() -> Int {\n  9223372036854775808\n}\n'),
    refused('fn f() -> Int {\n  -9223372036854775809\n}\n'),
    refused('fn f(n: Int) -> Int {\n  match n {\n    99999999999999999999 -> 1\n    _ -> 0\n  }\n}\n'),
  ],
  [
    'P08 9223372036854775808 does not fit in an Int',
    'P08 -9223372036854775809 does not fit in an Int',
    'P08 99999999999999999999 does not fit in an Int',
  ],
);

// ---- 4. where wrapping is wanted (a hash, a checksum), it is asked for by name
const wrapping = ['add', 'sub', 'mul']
  .map(w => `fn w${w}(a: Int, b: Int) -> Int {\n  wrapping_${w}(a, b)\n}\n`)
  .join('\n');
const W: Record<string, (a: bigint, b: bigint) => bigint> = {
  wadd: (a, b) => asBits(a + b),
  wsub: (a, b) => asBits(a - b),
  wmul: (a, b) => asBits(a * b),
};
const wCases: Case[] = Object.keys(W).flatMap(fn => EDGES.flatMap(a => EDGES.map(b => ({ fn, args: [a, b] }))));
same(
  'wrapping_add, wrapping_sub, wrapping_mul: the low 64 bits of the exact result',
  wrong(
    wrapping,
    wCases,
    wCases.map(c => W[c.fn]?.(c.args[0] ?? 0n, c.args[1] ?? 0n) ?? 0n),
  ),
  [],
);
// FNV-1a, 64 bits, as the reference vectors give it (http://www.isthe.com/chongo/tech/comp/fnv/): needs the wrap
const fnv = `fn fnv(v: View) -> Int {
  fnv_from(v, at: 0, h: -3750763034362895579)
}

fn fnv_from(v: View, at: Int, h: Int) -> Int {
  match {
    at >= len(v) -> h
    else -> fnv_from(v, at: at + 1, h: wrapping_mul(a: h ^ v[at], b: 1099511628211))
  }
}

fn of_a() -> Int {
  fnv(v: "a")
}

fn of_foobar() -> Int {
  fnv(v: "foobar")
}
`;
same(
  'a 64-bit FNV-1a with wrapping_mul matches the published vectors',
  wrong(
    fnv,
    [
      { fn: 'of_a', args: [] },
      { fn: 'of_foobar', args: [] },
    ],
    [asBits(0xaf63dc4c8601ec8cn), asBits(0x85944171f73967e8n)],
  ),
  [],
);

// ---- 5. a condition that bounds a variable lets `x + k` go untested (compiler/gen/range.ts); these are the ways
// it could wrongly do so, each with a value for which only the test stops the overflow
const bounded = `fn find(v: View, byte: Int, at: Int) -> Int {
  match {
    at >= len(v) or v[at] == byte -> at
    else -> find(v, byte, at: at + 1)
  }
}

fn and_false(x: Int, v: View) -> Int {
  match {
    x < 0 and x >= len(v) -> 0
    else -> x + 1
  }
}

fn or_true(x: Int, v: View) -> Int {
  match {
    x < len(v) or x > 5 -> x + 9223372032559808511
    else -> 0
  }
}

fn below_only(x: Int, v: View) -> Int {
  match {
    x >= len(v) -> 0
    else -> x - 1
  }
}

fn negated(x: Int, v: View) -> Int {
  match {
    not (x < len(v)) -> x + 1
    else -> x + 9223372032559808511
  }
}

fn not_the_length(x: Int, v: View) -> Int {
  let len = fn(w: View) -> Int { 9223372036854775807 }
  match {
    x < len(v) -> x + 9223372032559808511
    else -> 0
  }
}

fn find_in(at: Int) -> Int {
  find(v: "a,b,,c", byte: 44, at)
}

fn and_false_of(x: Int) -> Int {
  and_false(x, v: "abc")
}

fn or_true_of(x: Int) -> Int {
  or_true(x, v: "abc")
}

fn below_only_of(x: Int) -> Int {
  below_only(x, v: "abc")
}

fn negated_of(x: Int) -> Int {
  negated(x, v: "abc")
}

fn not_the_length_of(x: Int) -> Int {
  not_the_length(x, v: "abc")
}
`;
const boundedCases: [Case, Got][] = [
  [{ fn: 'find_in', args: [0n] }, 1n],
  [{ fn: 'find_in', args: [2n] }, 3n],
  [{ fn: 'find_in', args: [5n] }, 6n],
  [{ fn: 'and_false_of', args: [MAX] }, OVERFLOW],
  [{ fn: 'and_false_of', args: [5n] }, 6n],
  [{ fn: 'or_true_of', args: [2n ** 40n] }, OVERFLOW],
  [{ fn: 'or_true_of', args: [1n] }, 1n + 9223372032559808511n],
  [{ fn: 'below_only_of', args: [MIN] }, OVERFLOW],
  [{ fn: 'below_only_of', args: [2n] }, 1n],
  [{ fn: 'negated_of', args: [MAX] }, OVERFLOW],
  [{ fn: 'negated_of', args: [2n] }, 2n + 9223372032559808511n],
  [{ fn: 'not_the_length_of', args: [2n ** 40n] }, OVERFLOW],
  [{ fn: 'not_the_length_of', args: [2n] }, 2n + 9223372032559808511n],
];
same(
  'a bound a condition proves is used only where it holds: and, or, not, a local function named len (a name is never bound twice: C15)',
  wrong(
    bounded,
    boundedCases.map(([c]) => c),
    boundedCases.map(([, w]) => w),
  ),
  [],
);

// ---- 6. random expressions: compiled, interpreted and exact must agree, trap for trap
const cases = Number(process.argv[2] ?? 4000);
let seed = 0x9e3779b97f4a7c15n;
const rand = (n: number): number => {
  seed = BigInt.asUintN(64, seed * 6364136223846793005n + 1442695040888963407n);
  return Number((seed >> 33n) % BigInt(n));
};
const pick = <T>(xs: readonly T[]): T => xs[rand(xs.length)] ?? (xs[0] as T);
const INTERESTING = [...EDGES, 5n, 7n, 100n, 1000003n, 4294967296n, -4294967297n];
const randomInt = (): bigint =>
  rand(3) === 0
    ? BigInt.asIntN(64, BigInt(rand(2 ** 30)) * BigInt(rand(2 ** 30)) * BigInt(rand(2 ** 4) + 1))
    : pick(INTERESTING);
type E =
  { k: 'lit'; v: bigint } | { k: 'var'; n: 'x' | 'y' | 'z' } | { k: 'neg'; e: E } | { k: 'bin'; op: Op; l: E; r: E };
const SMALL_SHIFT = [0n, 1n, 7n, 31n, 62n, 63n];
function gen(depth: number): E {
  if (depth === 0 || rand(4) === 0)
    return rand(2) === 0 ? { k: 'var', n: pick(['x', 'y', 'z'] as const) } : { k: 'lit', v: randomInt() };
  if (rand(8) === 0) return { k: 'neg', e: gen(depth - 1) };
  const op = pick(OPS);
  // a shift amount is mostly in range, so the shift itself is tested and not only its trap
  const r =
    (op === '<<' || op === '>>') && rand(4) !== 0 ? { k: 'lit' as const, v: pick(SMALL_SHIFT) } : gen(depth - 1);
  return { k: 'bin', op, l: gen(depth - 1), r };
}
const src = (e: E): string => {
  switch (e.k) {
    case 'lit':
      return String(e.v);
    case 'var':
      return e.n;
    case 'neg':
      return `-(${src(e.e)})`;
    case 'bin':
      return `(${src(e.l)} ${e.op} ${src(e.r)})`;
  }
};
const value = (e: E, env: Record<'x' | 'y' | 'z', bigint>): bigint => {
  switch (e.k) {
    case 'lit':
      return e.v;
    case 'var':
      return env[e.n];
    case 'neg':
      return fits(-value(e.e, env));
    case 'bin': {
      // left before right, as the program evaluates them: the first trap reached is the one seen
      const l = value(e.l, env);
      return exact(e.op, l, value(e.r, env));
    }
  }
};
const PER = 250,
  INPUTS = 4;
let total = 0,
  traps = 0;
const tally = new Map<string, number>();
const failures: string[] = [];
for (let done = 0; done < cases; done += PER) {
  const exprs = Array.from({ length: Math.min(PER, cases - done) }, () => gen(1 + rand(4)));
  const text = exprs.map((e, i) => `fn e${i}(x: Int, y: Int, z: Int) -> Int {\n  ${src(e)}\n}\n`).join('\n');
  const cs: Case[] = [],
    want: Got[] = [];
  exprs.forEach((e, i) => {
    for (let k = 0; k < INPUTS; k++) {
      const env = { x: randomInt(), y: randomInt(), z: randomInt() };
      cs.push({ fn: `e${i}`, args: [env.x, env.y, env.z] });
      const w = oracle(() => value(e, env));
      want.push(w);
      tally.set(typeof w === 'bigint' ? 'value' : w, (tally.get(typeof w === 'bigint' ? 'value' : w) ?? 0) + 1);
    }
  });
  total += cs.length;
  traps += want.filter(w => typeof w !== 'bigint').length;
  failures.push(
    ...wrong(text, cs, want).map(x => `${x}\n    ${src(exprs[Number(/^e(\d+)/.exec(x)?.[1])] ?? { k: 'lit', v: 0n })}`),
  );
}
console.log(
  `  random: ${cases} expressions, ${total} runs, each under 3 builds and the interpreter: ${[...tally].map(([k, n]) => `${n} ${k}`).join(', ')}`,
);
same(
  `random expressions: ${total} runs, ${traps} of them traps, each as exact arithmetic says`,
  failures.slice(0, 5),
  [],
);

finish();
