// fuzz/numbers.ts: Dec and Float against references written here, from the definition (LANGUAGE.md section 3 and
// docs/std.md), not from the compiler or the interpreter. A Dec is a BigInt count at a scale and every operation is
// exact rational arithmetic rounded once; a Float operation is JavaScript's, which is IEEE 754's; parse_dec reads
// JSON's number syntax exactly; parse_float reads a decimal number. Each seed picks one operation at random scales,
// compiles a program that reads its operands from the request, and runs 200 random operand pairs through it, at
// their edges (zero, ±1, ties, the largest counts, scale 18) most of the time.
//   node fuzz/numbers.ts --seconds 60 [--seed 1] [--shard 0/8] [--only <seed>]
import { unreachable } from '../compiler/ast.ts';
import { compile } from '../compiler.ts';
import { std } from '../std.ts';
import { bodyOf, cli, handled, instance, seeds } from './run.ts';
import type { Run } from './run.ts';
import { rng } from './rng.ts';
import type { Rng } from './rng.ts';

const MAX = (1n << 63n) - 1n,
  MIN = -(1n << 63n);
const ROUNDINGS = ['HalfEven', 'HalfUp', 'Down', 'Up', 'Floor', 'Ceiling'] as const;
type Rounding = (typeof ROUNDINGS)[number];
const p10 = (n: number): bigint => 10n ** BigInt(n);

/** n / d rounded to an integer as the rounding says; d is not 0. */
export function roundDiv(n: bigint, d: bigint, how: Rounding): bigint {
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  // floor and the remainder, 0 <= r < d
  let q = n / d,
    r = n % d;
  if (r < 0n) {
    q -= 1n;
    r += d;
  }
  if (r === 0n) return q;
  const up = (): bigint => q + 1n; // toward plus infinity
  const neg = n < 0n;
  switch (how) {
    case 'Floor':
      return q;
    case 'Ceiling':
      return up();
    case 'Down':
      return neg ? up() : q; // toward zero
    case 'Up':
      return neg ? q : up(); // away from zero
    case 'HalfUp':
    case 'HalfEven': {
      const twice = 2n * r;
      if (twice < d) return q;
      if (twice > d) return up();
      if (how === 'HalfUp') return neg ? q : up();
      return q % 2n === 0n ? q : up();
    }
  }
  return unreachable(how, 'case');
}
const fits = (n: bigint): bigint | 'trap 6' => (n > MAX || n < MIN ? 'trap 6' : n);
/** a count at scale s, as write_dec writes it */
export function decText(m: bigint, s: number): string {
  const neg = m < 0n,
    digits = (neg ? -m : m).toString().padStart(s + 1, '0');
  return `${neg ? '-' : ''}${digits.slice(0, digits.length - s)}${s > 0 ? `.${digits.slice(digits.length - s)}` : ''}`;
}
/** parse_dec's reading: JSON's number syntax, exactly a Dec of scale s whose count fits; null otherwise */
export function parseDec(text: string, s: number): bigint | null {
  const m = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(text);
  if (!m) return null;
  const [, sign = '', whole = '', frac = '', exp = '0'] = m;
  // the value is digits * 10^(e - len(frac)); a long exponent is read as its value, with no limit
  const e = BigInt(exp) - BigInt(frac.length);
  let digits = BigInt(whole + frac);
  // the count at scale s is digits * 10^(e + s)
  const shift = e + BigInt(s);
  if (digits === 0n) return 0n;
  if (shift >= 0n) {
    if (shift > 40n) return null; // too large for any count
    digits *= 10n ** shift;
  } else {
    if (-shift > BigInt(whole.length + frac.length)) return null; // not 0, so some digit is below the scale
    const d = 10n ** -shift;
    if (digits % d !== 0n) return null;
    digits /= d;
  }
  const count = sign === '-' ? -digits : digits;
  return count > MAX || count < MIN ? null : count;
}

type Op = {
  name: string;
  /** the Tape expression, of a, b and rounding */
  expr: string;
  sa: number;
  sb: number | 'Int';
  st: number;
  /** the result as write_dec, write_int or "T"/"F" writes it, or a trap */
  want: (a: bigint, b: bigint, r: Rounding) => string;
  writes: 'dec' | 'int' | 'bool';
};
const asDec = (n: bigint | 'trap 6', s: number): string => (n === 'trap 6' ? n : decText(n, s));
function opOf(r: Rng): Op {
  const S = [0, 1, 2, 2, 3, 4, 6, 8, 9, 12, 17, 18];
  const sa = r.one(S),
    sb = r.one(S);
  switch (r.int(12)) {
    case 0: {
      const st = r.one(S);
      if (Math.abs(sa + sb - st) > 18) return opOf(r);
      return {
        name: 'mul',
        expr: `mul(a, by: b, scale: ${st}, rounding)`,
        sa,
        sb,
        st,
        writes: 'dec',
        // the exact product is a count at sa + sb
        want: (a, b, how) => {
          const n = a * b,
            k = sa + sb - st;
          return asDec(fits(k >= 0 ? roundDiv(n, p10(k), how) : n * p10(-k)), st);
        },
      };
    }
    case 1: {
      const st = r.one(S);
      return {
        name: 'mul by Int',
        expr: `mul(a, by: b, scale: ${st}, rounding)`,
        sa,
        sb: 'Int',
        st,
        writes: 'dec',
        want: (a, b, how) => {
          const k = sa - st;
          return asDec(fits(k >= 0 ? roundDiv(a * b, p10(k), how) : a * b * p10(-k)), st);
        },
      };
    }
    case 2: {
      const st = r.one(S);
      if (Math.abs(st + sb - sa) > 18) return opOf(r);
      return {
        name: 'div',
        expr: `div(a, by: b, scale: ${st}, rounding)`,
        sa,
        sb,
        st,
        writes: 'dec',
        // a/10^sa / (b/10^sb) at st: a * 10^(sb + st) / (b * 10^sa)
        want: (a, b, how) => {
          if (b === 0n) return 'trap 4';
          const k = sb + st - sa;
          return asDec(fits(k >= 0 ? roundDiv(a * p10(k), b, how) : roundDiv(a, b * p10(-k), how)), st);
        },
      };
    }
    case 3: {
      const st = r.one(S);
      return {
        name: 'div by Int',
        expr: `div(a, by: b, scale: ${st}, rounding)`,
        sa,
        sb: 'Int',
        st,
        writes: 'dec',
        want: (a, b, how) => {
          if (b === 0n) return 'trap 4';
          const k = st - sa;
          return asDec(fits(k >= 0 ? roundDiv(a * p10(k), b, how) : roundDiv(a, b * p10(-k), how)), st);
        },
      };
    }
    case 4:
      if (sa + sb > 18) return opOf(r);
      return {
        name: '*',
        expr: 'a * b',
        sa,
        sb,
        st: sa + sb,
        writes: 'dec',
        want: (a, b) => asDec(fits(a * b), sa + sb),
      };
    case 5: {
      const op = r.one(['+', '-']);
      return {
        name: op,
        expr: `a ${op} b`,
        sa,
        sb: sa,
        st: sa,
        writes: 'dec',
        want: (a, b) => asDec(fits(op === '+' ? a + b : a - b), sa),
      };
    }
    case 6: {
      if (sa === 0) return opOf(r);
      const st = r.int(sa);
      return {
        name: 'round',
        expr: `round(x: a, to: ${st}, rounding)`,
        sa,
        sb: 'Int',
        st,
        writes: 'dec',
        want: (a, _b, how) => asDec(fits(roundDiv(a, p10(sa - st), how)), st),
      };
    }
    case 7: {
      if (sa === 18) return opOf(r);
      const st = r.between(sa + 1, 18);
      return {
        name: 'rescale',
        expr: `rescale(x: a, to: ${st})`,
        sa,
        sb: 'Int',
        st,
        writes: 'dec',
        want: a => asDec(fits(a * p10(st - sa)), st),
      };
    }
    case 8:
      return {
        name: 'to_int',
        expr: 'to_int(x: a, rounding)',
        sa,
        sb: 'Int',
        st: 0,
        writes: 'int',
        want: (a, _b, how) => String(fits(roundDiv(a, p10(sa), how))),
      };
    case 9: {
      const op = r.one(['<', '<=', '==', '!=', '>', '>=']);
      return {
        name: `compare ${op}`,
        expr: `a ${op} b`,
        sa,
        sb,
        st: 0,
        writes: 'bool',
        // across scales: by value
        want: (a, b) => {
          const x = a * p10(sb),
            y = b * p10(sa);
          const v = { '<': x < y, '<=': x <= y, '==': x === y, '!=': x !== y, '>': x > y, '>=': x >= y }[op];
          return v ? 'T' : 'F';
        },
      };
    }
    case 10: {
      const f = r.one(['abs', 'min', 'max', 'neg']);
      return {
        name: f,
        expr: f === 'abs' ? 'abs(a)' : f === 'neg' ? '-a' : `${f}(a: a, b: b)`,
        sa,
        sb: sa,
        st: sa,
        writes: 'dec',
        want: (a, b) =>
          asDec(
            fits(f === 'abs' ? (a < 0n ? -a : a) : f === 'neg' ? -a : f === 'min' ? (a < b ? a : b) : a > b ? a : b),
            sa,
          ),
      };
    }
    default:
      return {
        name: 'dec',
        expr: `dec(n: b, scale: ${sa})`,
        sa,
        sb: 'Int',
        st: sa,
        writes: 'dec',
        want: (_a, b) => asDec(fits(b * p10(sa)), sa),
      };
  }
}
const ROUNDING_FN = `fn rounding_of(t: View) -> Rounding {
  match t {
    "HalfEven" -> HalfEven
    "HalfUp" -> HalfUp
    "Down" -> Down
    "Up" -> Up
    "Floor" -> Floor
    _ -> Ceiling
  }
}
`;
function programOf(op: Op): string {
  const b =
    op.sb === 'Int'
      ? `let Some(value: b) = parse_int(text: y) else -> buf() |> append(view: "b?")`
      : `let Some(value: b) = parse_dec(text: y, scale: ${op.sb}) else -> buf() |> append(view: "b?")`;
  const write =
    op.writes === 'dec'
      ? 'write_dec(value: v)'
      : op.writes === 'int'
        ? 'write_int(value: v)'
        : 'append(view: bool_text(v))';
  return `${ROUNDING_FN}
fn bool_text(b: Bool) -> View {
  match b {
    True -> "T"
    False -> "F"
  }
}

fn handle(raw: View) -> Response {
  answer(raw) |> respond(status: 200)
}

fn answer(raw: View) -> Buf {
  let x ++ " " ++ rest = raw else -> buf() |> append(view: "bad")
  let y ++ " " ++ how = rest else -> buf() |> append(view: "bad")
  let Some(value: a) = parse_dec(text: x, scale: ${op.sa}) else -> buf() |> append(view: "a?")
  ${b}
  let rounding = rounding_of(how)
  let v = ${op.expr}
  buf() |> ${write}
}
`;
}
/** a count at an edge most of the time */
function countOf(r: Rng, s: number): bigint {
  switch (r.int(8)) {
    case 0:
      return r.one([0n, 1n, -1n, MAX, MIN, MAX - 1n, MIN + 1n]);
    case 1:
      return r.big(63);
    case 2:
      // a tie, or one away from one, at some digit
      return (r.big(20) * 10n + r.one([5n, 4n, 6n, -5n])) * p10(r.int(Math.min(s, 6) + 1));
    case 3:
      return r.big(r.between(1, 62));
    case 4:
      return BigInt(r.between(-100, 100)) * p10(r.int(19));
    case 5:
      return r.one([3037000499n, 3037000500n, -3037000500n, 10n ** 18n, -(10n ** 18n), 999999999999999999n]);
    default:
      return BigInt(r.between(-100000, 100000));
  }
}
const fit = (n: bigint): bigint => (n > MAX ? MAX : n < MIN ? MIN : n);
/** the text of a count at scale s: as written, or in another JSON form of the same value */
function textOf(r: Rng, m: bigint, s: number): string {
  const t = decText(m, s);
  switch (r.int(6)) {
    case 0: {
      // trailing zeros past the scale
      return s > 0 || r.chance(2) ? `${t}${s > 0 ? '' : '.'}${'0'.repeat(r.between(1, 3))}` : t;
    }
    case 1: {
      // an exponent: the digits with the point moved
      const neg = m < 0n,
        digits = (neg ? -m : m).toString();
      return `${neg ? '-' : ''}${digits}e${-s}`;
    }
    default:
      return t;
  }
}

export type NumVerdict = { cases: number; bad: string | null };
const cache = new Map<string, Run | string>();
function runOf(text: string): Run | string {
  const had = cache.get(text);
  if (had !== undefined) return had;
  const b = compile([...std, { name: 'n.tape', text }]);
  const out =
    b.wasm === null ? `refused ${b.errors[0]?.code} ${b.errors[0]?.message}` : instance(new WebAssembly.Module(b.wasm));
  if (cache.size > 200) cache.clear();
  cache.set(text, out);
  return out;
}
const enc = new TextEncoder();
export function decCase(seed: number, n = 200): NumVerdict {
  const r = rng(seed),
    op = opOf(r);
  const text = programOf(op),
    run = runOf(text);
  if (typeof run === 'string') return { cases: 0, bad: `${op.name}: ${run}` };
  for (let i = 0; i < n; i++) {
    let a = fit(countOf(r, op.sa)),
      b = op.sb === 'Int' ? fit(countOf(r, 0) / p10(r.int(19))) : fit(countOf(r, op.sb));
    // a tie now and then, exactly where the rounding drops digits: half of the last kept digit, at its sign
    const drop =
      op.name === 'round'
        ? op.sa - op.st
        : op.name === 'to_int'
          ? op.sa
          : op.name === 'mul'
            ? op.sa + (typeof op.sb === 'number' ? op.sb : 0) - op.st
            : 0;
    if (drop > 0 && r.chance(3)) {
      a = fit((r.big(r.one([3, 10, 30])) * 10n + r.one([5n, -5n])) * p10(drop - 1));
      if (op.name === 'mul' && typeof op.sb === 'number') b = r.one([1n, -1n]) * p10(op.sb);
    }
    if (op.name === 'div by Int' && r.chance(3)) {
      a = fit(r.big(40) * 2n + 1n);
      b = r.one([2n, -2n]);
    }
    const how = r.one(ROUNDINGS);
    const ta = textOf(r, a, op.sa),
      tb = op.sb === 'Int' ? String(b) : textOf(r, b, op.sb);
    const input = `${ta} ${tb} ${how}`;
    // the texts are read by the reference too: one that is not exactly a Dec of its scale is the program's "a?"
    const want =
        parseDec(ta, op.sa) !== a ? 'a?' : op.sb !== 'Int' && parseDec(tb, op.sb) !== b ? 'b?' : op.want(a, b, how),
      got = bodyOf(handled(run, enc.encode(input)).out);
    if (got !== want)
      return {
        cases: i + 1,
        bad: `${op.name} (a: Dec[${op.sa}], b: ${op.sb === 'Int' ? 'Int' : `Dec[${op.sb}]`}, scale ${op.st}) on "${input}": want ${want}, got ${got}`,
      };
  }
  return { cases: n, bad: null };
}

// ---- parse_dec on any text
const PARSE = (s: number): string => `fn handle(raw: View) -> Response {
  answer(raw) |> respond(status: 200)
}

fn answer(raw: View) -> Buf {
  match parse_dec(text: raw, scale: ${s}) {
    Some(value: d) -> buf() |> write_dec(value: d)
    None -> buf() |> append(view: "none")
  }
}
`;
function numberText(r: Rng): string {
  const digits = (n: number): string => Array.from({ length: n }, () => String(r.int(10))).join('');
  const parts = [
    r.chance(3) ? '-' : r.chance(20) ? '+' : '',
    r.chance(10)
      ? '0' + digits(r.int(3))
      : r.chance(8)
        ? ''
        : String(r.between(1, 9)) + digits(r.int(r.chance(5) ? 40 : 8)),
    r.chance(2) ? `.${digits(r.int(r.chance(5) ? 30 : 6))}${r.chance(3) ? '0'.repeat(r.int(25)) : ''}` : '',
    r.chance(3)
      ? `${r.one(['e', 'E'])}${r.one(['', '+', '-'])}${r.chance(10) ? r.one(['999999999999', '18446744073709551616', '0000000000000000000002', '2147483648']) : String(r.int(40))}`
      : '',
  ];
  let t = parts.join('');
  if (r.chance(15)) t = r.one([' ', '\t', '\n']) + t;
  if (r.chance(15)) t += r.one([' ', 'x', '.', 'e', '\u0000']);
  return t;
}
const timed = (run: Run, t: string): number => {
  const t0 = performance.now();
  handled(run, enc.encode(t));
  return performance.now() - t0;
};
export function parseCase(seed: number, n = 300): NumVerdict {
  const r = rng(seed);
  const s = r.one([0, 1, 2, 3, 6, 9, 18]);
  const run = runOf(PARSE(s));
  if (typeof run === 'string') return { cases: 0, bad: run };
  for (let i = 0; i < n; i++) {
    const t = numberText(r);
    const want = parseDec(t, s);
    const t0 = performance.now();
    const got = bodyOf(handled(run, enc.encode(t)).out);
    const ms = performance.now() - t0;
    const w = want === null ? 'none' : decText(want, s);
    if (got !== w) return { cases: i + 1, bad: `parse_dec(${JSON.stringify(t)}, scale: ${s}): want ${w}, got ${got}` };
    // slow twice running, so a pause of the collector or a loaded machine is not read as a slow parse
    if (ms > 200 && timed(run, t) > 200)
      return { cases: i + 1, bad: `parse_dec(${JSON.stringify(t)}, scale: ${s}) took ${ms.toFixed(0)} ms` };
  }
  return { cases: n, bad: null };
}

// ---- Floats: parse_float, write_float, arithmetic, to_dec, trunc
const FLOATS = `${ROUNDING_FN}
fn f(t: View) -> Float {
  match parse_float(text: t) {
    Some(value) -> value
    None -> -0.125f
  }
}

fn handle(raw: View) -> Response {
  answer(raw) |> respond(status: 200)
}

fn answer(raw: View) -> Buf {
  let op ++ " " ++ rest = raw else -> buf() |> append(view: "bad")
  let x ++ " " ++ y = rest else -> buf() |> append(view: "bad")
  match op {
    "parse" -> match parse_float(text: x) {
      Some(value: v) -> buf() |> write_float(value: v)
      None -> buf() |> append(view: "none")
    }
    "+" -> buf() |> write_float(value: f(x) + f(y))
    "-" -> buf() |> write_float(value: f(x) - f(y))
    "*" -> buf() |> write_float(value: f(x) * f(y))
    "/" -> buf() |> write_float(value: f(x) / f(y))
    "sqrt" -> buf() |> write_float(value: sqrt(f(x)))
    "floor" -> buf() |> write_float(value: floor(f(x)))
    "ceil" -> buf() |> write_float(value: ceil(f(x)))
    "abs" -> buf() |> write_float(value: abs(f(x)))
    "min" -> buf() |> write_float(value: min(a: f(x), b: f(y)))
    "max" -> buf() |> write_float(value: max(a: f(x), b: f(y)))
    "neg" -> buf() |> write_float(value: -f(x))
    "trunc" -> buf() |> write_int(value: trunc(f(x)))
    "float" -> match parse_int(text: x) {
      Some(value: n) -> buf() |> write_float(value: float(n))
      None -> buf() |> append(view: "bad")
    }
    "to_dec2" -> buf() |> write_dec(value: to_dec(f(x), scale: 2, rounding: rounding_of(y)))
    "to_dec9" -> buf() |> write_dec(value: to_dec(f(x), scale: 9, rounding: rounding_of(y)))
    "to_dec0" -> buf() |> write_dec(value: to_dec(f(x), scale: 0, rounding: rounding_of(y)))
    "lt" -> buf() |> append(view: match f(x) < f(y) {
      True -> "T"
      False -> "F"
    })
    "eq" -> buf() |> append(view: match f(x) == f(y) {
      True -> "T"
      False -> "F"
    })
    _ -> buf() |> append(view: "bad")
  }
}
`;
/** parse_float's reading as the definition says: the Float nearest a decimal number; null for none */
export function parseFloatRef(t: string): number | null {
  if (!/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(t)) return null;
  const x = Number(t);
  return Number.isFinite(x) ? x : null;
}
const fin = (x: number): string => (Number.isFinite(x) ? String(x) : 'trap 8');
/** a Float's exact value rounded to scale s */
function toDecRef(x: number, s: number, how: Rounding): string {
  // x = mant * 2^exp exactly
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, x);
  const bits = buf.getBigUint64(0),
    sign = bits >> 63n ? -1n : 1n,
    e = Number((bits >> 52n) & 0x7ffn),
    f = bits & ((1n << 52n) - 1n);
  const mant = e === 0 ? f : f | (1n << 52n),
    exp = (e === 0 ? 1 : e) - 1075;
  // count = x * 10^s = sign * mant * 2^exp * 10^s
  const n = sign * mant * p10(s);
  const c = exp >= 0 ? n * (1n << BigInt(exp)) : roundDiv(n, 1n << BigInt(-exp), how);
  const v = fits(c);
  return v === 'trap 6' ? v : decText(v, s);
}
function floatText(r: Rng): string {
  switch (r.int(7)) {
    case 0:
      return r.one([
        '0',
        '-0',
        '1',
        '-1',
        '0.1',
        '0.5',
        '2.5',
        '-2.5',
        '1e308',
        '1.7976931348623157e308',
        '5e-324',
        '2.2250738585072014e-308',
        '9007199254740993',
        '9223372036854775807',
        '9223372036854775808',
        '-9223372036854776832',
        '1e-7',
        '123456789012345678901234567890',
        '0.30000000000000004',
        '2.675',
        '1.005',
        '0.125',
        '1e21',
        '1e-21',
      ]);
    case 1:
      return String(r.big(64));
    case 2:
      return `${r.between(-1000, 1000)}.${r.int(1000)}`;
    case 3:
      return `${r.between(-9, 9)}.${r.int(100000)}e${r.between(-320, 310)}`;
    case 4: {
      // a random double, as JavaScript writes it
      const b = new DataView(new ArrayBuffer(8));
      b.setUint32(0, r.int(2 ** 32));
      b.setUint32(4, r.int(2 ** 32));
      const x = b.getFloat64(0);
      return Number.isFinite(x) ? String(x) : '1';
    }
    case 5:
      return r.one([
        '',
        ' 1',
        '1 ',
        '0x10',
        '0b11',
        '0o7',
        'Infinity',
        '-Infinity',
        'NaN',
        '1e',
        '.5',
        '5.',
        '+5',
        '1_0',
        '١',
        '1e+',
        '--1',
        '0x',
        '\t2',
      ]);
    default:
      return String(r.between(-100, 100) / r.one([1, 2, 4, 8, 3, 10, 100]));
  }
}
export function floatCase(seed: number, n = 300): NumVerdict {
  const r = rng(seed);
  const run = runOf(FLOATS);
  if (typeof run === 'string') return { cases: 0, bad: run };
  const F = (t: string): number => parseFloatRef(t) ?? -0.125;
  for (let i = 0; i < n; i++) {
    const op = r.one([
      'parse',
      'parse',
      'parse',
      '+',
      '-',
      '*',
      '/',
      'sqrt',
      'floor',
      'ceil',
      'abs',
      'min',
      'max',
      'neg',
      'trunc',
      'float',
      'to_dec2',
      'to_dec9',
      'to_dec0',
      'lt',
      'eq',
    ]);
    const x = op === 'float' ? String(r.big(r.one([10, 53, 54, 63]))) : floatText(r).replaceAll(' ', ''),
      y = op.startsWith('to_dec') ? r.one(ROUNDINGS) : floatText(r).replaceAll(' ', '');
    if (op !== 'parse' && op !== 'float' && x.length === 0) continue;
    const a = F(x),
      b = F(y);
    let want: string;
    switch (op) {
      case 'parse': {
        const v = parseFloatRef(x);
        want = v === null ? 'none' : String(v);
        break;
      }
      case '+':
        want = fin(a + b);
        break;
      case '-':
        want = fin(a - b);
        break;
      case '*':
        want = fin(a * b);
        break;
      case '/':
        want = fin(a / b);
        break;
      case 'sqrt':
        want = fin(Math.sqrt(a));
        break;
      case 'floor':
        want = String(Math.floor(a));
        break;
      case 'ceil':
        want = String(Math.ceil(a));
        break;
      case 'abs':
        want = String(Math.abs(a));
        break;
      case 'min':
        want = String(Math.min(a, b));
        break;
      case 'max':
        want = String(Math.max(a, b));
        break;
      case 'neg':
        want = String(-a);
        break;
      case 'trunc': {
        const t = Math.trunc(a);
        want = t >= 2 ** 63 || t < -(2 ** 63) ? 'trap 6' : BigInt(t).toString();
        break;
      }
      case 'float':
        want = String(Number(BigInt(x)));
        break;
      case 'lt':
        want = a < b ? 'T' : 'F';
        break;
      case 'eq':
        want = a === b ? 'T' : 'F';
        break;
      default: {
        const s = Number(op.slice(6));
        want = toDecRef(a, s, ROUNDINGS.find(w => w === y) ?? 'HalfEven');
      }
    }
    const input = `${op} ${x} ${y}`;
    const got = bodyOf(handled(run, enc.encode(input)).out);
    if (got !== want) return { cases: i + 1, bad: `${input}: want ${want}, got ${got}` };
  }
  return { cases: n, bad: null };
}

if (import.meta.main) {
  const c = cli();
  let cases = 0,
    bad = 0;
  const start = Date.now();
  for (const seed of seeds(c)) {
    for (const [name, f] of [
      ['dec', decCase],
      ['parse_dec', parseCase],
      ['float', floatCase],
    ] as const) {
      const v = f(seed);
      cases += v.cases;
      if (v.bad) {
        bad++;
        console.log(`FINDING numbers ${name} seed=${seed}: ${v.bad}`);
      }
    }
  }
  const s = (Date.now() - start) / 1000;
  console.log(`numbers: ${cases} cases, ${bad} findings, ${(cases / s).toFixed(0)} cases/s`);
}
