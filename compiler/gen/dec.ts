// compiler/gen/dec.ts: Dec[s], an exact number with s digits after the point, held as an Int count m of 10^-s (12.30
// is 1230 in a Dec[2]). The scale is in the type, so it costs nothing at run time: + and - are an Int's, of two
// Decs of one scale; * adds the scales (an Int is a count, of scale 0); comparisons are exact across scales. Every
// operation that would lose a digit names its rounding and goes through compiler/math/dec.ts's muldiv, which
// divides the 128-bit product exactly and rounds once. Overflow stops the run, as it does for an Int.
import type { Arg, Call, Expr } from '../ast.ts';
import { I64, TRAP, fail, sleb, uleb } from '../common.ts';
import { BOOL, FLOAT, INT, T, decType, key, scaleOf } from '../types.ts';
import type { Type } from '../types.ts';
import { fresh, get, mathIndex, need, rescaleHint, set, trapIf } from './fn.ts';
import type { Ctx } from './fn.ts';
import { LEAST, MOST, emitByLiteral, emitChecked } from './checked.ts';
import { showExpr } from '../../rules/origins.ts';

type Bin = Extract<Expr, { k: 'bin' }>;
const MAX_SCALE = 18;
const i64 = (v: bigint): number[] => [0x42, ...sleb(v)];
const ten = (k: number): bigint => 10n ** BigInt(k);
const SIGNED: Readonly<Record<string, number>> = {
  '==': 0x51,
  '!=': 0x52,
  '<': 0x53,
  '>': 0x55,
  '<=': 0x57,
  '>=': 0x59,
};

/** The literal an operand is and the scale it is written at: `3` is 3 at 0, `1.50` is 150 at 2. */
const literalOf = (e: Expr): { v: bigint; s: number } | null =>
  e.k === 'int' ? { v: e.v, s: 0 } : e.k === 'dec' ? { v: e.v, s: e.s } : null;

/** `a op b` with a Dec[s] on the stack as a. */
export function emitDecBin(c: Ctx, e: Bin, lt: Type): Type {
  const { op } = e;
  const s = scaleOf(lt) ?? 0;
  if (op === '+' || op === '-') {
    const k = literalOf(e.r);
    if (k && k.s === s && e.r.k === 'dec') {
      emitByLiteral(c, op, k.v, false, e.l);
      return lt;
    }
    const rt = c.B.strip(c.emit(e.r, lt, false));
    const rs = scaleOf(rt);
    if (rs !== null && rs !== s)
      fail(
        e,
        'C14',
        `${key(lt)} ${op} ${key(rt)}: the scales differ`,
        e.r.k === 'dec' && rs < s
          ? `Write the literal at the scale of the other side: \`${decWritten(e.r.v * ten(s - rs), s)}\`.`
          : rescaleHint(rs, s, showExpr(e.r)),
      );
    need(c, rt, lt, e, `the right side of ${op}`);
    emitChecked(c, e, op);
    return lt;
  }
  if (op === '*') {
    const k = literalOf(e.r);
    if (k) {
      emitByLiteral(c, op, k.v, false, e.l);
      return product(e, s, k.s);
    }
    const rt = c.B.strip(c.emit(e.r, null, false));
    const rs = rt.name === 'Int' ? 0 : scaleOf(rt);
    if (rs === null) need(c, rt, lt, e, 'the right side of *');
    emitChecked(c, e, op);
    return product(e, s, rs ?? 0);
  }
  if (Object.hasOwn(SIGNED, op)) {
    const rt = c.B.strip(c.emit(e.r, null, false));
    const rs = scaleOf(rt);
    if (rs === null) need(c, rt, lt, e, `the right side of ${op}`);
    compare(c, op, s, rs ?? s);
    return BOOL;
  }
  return fail(
    e,
    'C19',
    `Dec values have no ${op}`,
    op === '/' || op === '%'
      ? 'A quotient of Decs names its scale and its rounding: `div(a: x, by: y, scale: 2, rounding: HalfEven)`. To split a total into parts that add up, divide with rounding Down and give the remainder out.'
      : 'A Dec has + - *, the comparisons, and the functions of its own (round, rescale, mul, div).',
  );
}

/** A Dec[a] * Dec[b] is a Dec[a + b], within 18 digits. */
function product(e: Bin, a: number, b: number): Type {
  if (a + b > MAX_SCALE)
    fail(
      e,
      'C14',
      `Dec[${a}] * Dec[${b}] would have ${a + b} digits after the point, and a Dec has at most 18`,
      'Say the scale of the product and how to round it: `mul(a: x, by: y, scale: 9, rounding: HalfEven)`.',
    );
  return decType(a + b);
}

const decWritten = (m: bigint, s: number): string => {
  const digits = (m < 0n ? -m : m).toString().padStart(s + 1, '0');
  return `${m < 0n ? '-' : ''}${digits.slice(0, digits.length - s)}${s > 0 ? `.${digits.slice(-s)}` : ''}`;
};

/**
 * `x op y` with x at scale a and y at scale b on the stack. At one scale it is the counts'. Otherwise the one at
 * the smaller scale is brought to the other's, and when that does not fit in 64 bits it is beyond every count at
 * the larger scale, so its sign decides.
 */
function compare(c: Ctx, op: string, a: number, b: number): void {
  const opcode = SIGNED[op] ?? 0x51;
  if (a === b) {
    c.code.push(opcode);
    return;
  }
  const x = fresh(c, I64),
    y = fresh(c, I64);
  c.code.push(...set(y), ...set(x));
  const [small, other, k] = a < b ? [x, y, b - a] : [y, x, a - b];
  const bound = MOST / ten(k);
  // the side brought up is the left one when a < b: beyond the bound it is the greater (or the lesser below -bound)
  const left = a < b;
  const greater = left ? ['>', '>=', '!='].includes(op) : ['<', '<=', '!='].includes(op);
  const lesser = left ? ['<', '<=', '!='].includes(op) : ['>', '>=', '!='].includes(op);
  const scaled = [...get(small), ...i64(ten(k)), 0x7e];
  const compared = [...(left ? [...scaled, ...get(other)] : [...get(other), ...scaled]), opcode];
  // lesser beyond -bound, else greater beyond bound, else the comparison
  const beyond = [...get(small), ...i64(bound), 0x55, 0x1b, ...get(small), ...i64(-bound), 0x53, 0x1b];
  c.code.push(0x41, lesser ? 1 : 0, 0x41, greater ? 1 : 0, ...compared, ...beyond);
}

/** The count on the stack times 10^k, or a stop (integer overflow) when that does not fit. */
function scaleUp(c: Ctx, k: number, at: Expr): void {
  if (k > 0) emitByLiteral(c, '*', ten(k), false, at);
}

// ---- the functions of Dec

/** A scale written in the call: a number from 0 to 18. */
function scaleArg(a: Arg | undefined, what: string): number {
  const v = a?.value;
  if (v?.k !== 'int' || v.v < 0n || v.v > BigInt(MAX_SCALE))
    return fail(
      a ?? v ?? { line: 0, file: '' },
      'C14',
      `${what} should be a scale, a number from 0 to 18 written in the call`,
      `The scale is part of the type, so it is written as a number: \`${what}: 2\` for cents.`,
    );
  return Number(v.v);
}
/** A Dec argument on the stack: its scale. */
function decArg(c: Ctx, a: Arg | undefined, what: string, orInt = false): number {
  if (!a) return 0;
  const t = c.B.strip(c.emit(a.value, null, false));
  const s = orInt && t.name === 'Int' ? 0 : scaleOf(t);
  if (s === null)
    fail(
      a,
      'C14',
      `argument ${what} should be a Dec but is ${key(t)}`,
      t.name === 'Int'
        ? 'An Int is not a Dec: `dec(n: count, scale: 2)` makes one (exact).'
        : t.name === 'Float'
          ? 'A Float is not a Dec: `to_dec(x: f, scale: 2, rounding: HalfEven)` makes one from its exact value.'
          : 'A Dec is written with a point, `12.30`, or made from an Int with `dec(n: count, scale: 2)`.',
    );
  return s ?? 0;
}
/** The rounding argument on the stack: std's Rounding, its constructor's index. */
function roundingArg(c: Ctx, a: Arg | undefined): void {
  if (!a) return;
  const want = T('Rounding');
  if (!c.B.types.has('Rounding'))
    fail(
      a,
      'C30',
      'the program has no type Rounding',
      'Rounding is std/core.tape: compile it together with your file.',
    );
  need(c, c.emit(a.value, want, false), want, a, 'argument rounding');
}
/** muldiv(x, y, d, e, mode) with x, y, d and the mode on the stack in the order the helper takes them. */
const muldiv = (c: Ctx): void => {
  c.code.push(0x10, ...uleb(mathIndex(c.B, 'dec_muldiv')));
};

const NAMES = new Set(['rescale', 'round', 'mul', 'div', 'dec', 'to_int', 'to_dec']);

/** rescale, round, mul, div, dec, to_int, to_dec; null for any other name. */
export function emitDecIntrinsic(c: Ctx, e: Call, args: () => Arg[]): Type | null {
  if (!NAMES.has(e.name)) return null;
  const a = args();
  switch (e.name) {
    case 'rescale': {
      const s = decArg(c, a[0], 'x');
      const t = scaleArg(a[1], 'to');
      if (t < s)
        fail(
          e,
          'C14',
          `rescale(to: ${t}) of a Dec[${s}] would drop digits`,
          `rescale only adds digits, exactly. To fewer, name the rounding: \`round(x, to: ${t}, rounding: HalfEven)\`.`,
        );
      scaleUp(c, t - s, a[0]?.value ?? e);
      return decType(t);
    }
    case 'round': {
      const s = decArg(c, a[0], 'x');
      const t = scaleArg(a[1], 'to');
      if (t >= s)
        fail(
          e,
          'C14',
          `round(to: ${t}) of a Dec[${s}] has nothing to round`,
          `round goes to fewer digits. To as many or more, \`rescale(x, to: ${t})\` is exact.`,
        );
      c.code.push(...i64(1n), ...i64(ten(s - t)), ...i64(1n));
      roundingArg(c, a[2]);
      muldiv(c);
      return decType(t);
    }
    case 'to_int': {
      const s = decArg(c, a[0], 'x');
      c.code.push(...i64(1n), ...i64(ten(s)), ...i64(1n));
      roundingArg(c, a[1]);
      muldiv(c);
      return INT;
    }
    case 'dec': {
      const n = a[0];
      if (n) need(c, c.emit(n.value, INT, false), INT, n, 'argument n');
      const t = scaleArg(a[1], 'scale');
      scaleUp(c, t, n?.value ?? e);
      return decType(t);
    }
    case 'mul': {
      const s = decArg(c, a[0], 'a'),
        u = decArg(c, a[1], 'by', true),
        t = scaleArg(a[2], 'scale'),
        j = s + u - t;
      if (j > MAX_SCALE)
        fail(
          e,
          'C14',
          `a product of a Dec[${s}] and a Dec[${u}] rounded to ${t} digits drops ${j}, and at most 18 go at once`,
          'Round an operand to fewer digits first.',
        );
      c.code.push(...i64(ten(Math.max(j, 0))), ...i64(1n));
      roundingArg(c, a[3]);
      muldiv(c);
      if (j < 0) scaleUp(c, -j, e);
      return decType(t);
    }
    case 'div': {
      // a·10^-s / (b·10^-u) at scale t is a·10^(t+u-s) / b
      const s = decArg(c, a[0], 'a'),
        u = decArg(c, a[1], 'by', true),
        t = scaleArg(a[2], 'scale'),
        k = t + u - s,
        by = fresh(c, I64);
      if (k > MAX_SCALE || k < -MAX_SCALE)
        fail(
          e,
          'C14',
          `a quotient of a Dec[${s}] by a Dec[${u}] at ${t} digits moves the point ${Math.abs(k)} places, and at most 18 at once`,
          'Round an operand first, or ask for a scale nearer the operands’.',
        );
      // a·10^k / b, or a / (b·10^-k)
      c.code.push(...set(by), ...i64(ten(Math.max(k, 0))), ...get(by), ...i64(ten(Math.max(-k, 0))));
      roundingArg(c, a[3]);
      muldiv(c);
      return decType(t);
    }
    case 'to_dec': {
      const x = a[0];
      if (x) need(c, c.emit(x.value, FLOAT, false), FLOAT, x, 'argument x');
      const t = scaleArg(a[1], 'scale');
      c.code.push(...i64(ten(t)));
      roundingArg(c, a[2]);
      c.code.push(0x10, ...uleb(mathIndex(c.B, 'dec_of_float')));
      return decType(t);
    }
    default:
      return null;
  }
}

/** float(d): the Float nearest a Dec, with its count on the stack. */
export function decToFloat(c: Ctx, s: number): Type {
  c.code.push(...i64(ten(s)), 0x10, ...uleb(mathIndex(c.B, 'dec_to_float')));
  return FLOAT;
}

/** abs, min and max of Decs: an Int's, of one scale. */
export function decOrder(c: Ctx, name: string, t: Type, other?: Arg): Type {
  if (name === 'abs') {
    const x = fresh(c, I64);
    c.code.push(0x22, ...uleb(x), ...i64(LEAST), 0x51);
    trapIf(c, TRAP.OVERFLOW);
    c.code.push(...i64(0n), ...get(x), 0x7d, ...get(x), ...get(x), ...i64(0n), 0x53, 0x1b);
    return t;
  }
  const x = fresh(c, I64),
    y = fresh(c, I64);
  c.code.push(...set(x));
  if (other) {
    const rt = c.B.strip(c.emit(other.value, t, false));
    const rs = scaleOf(rt);
    if (rs !== null && rs !== scaleOf(t))
      fail(
        other,
        'C14',
        `${name} of a ${key(t)} and a ${key(rt)}: the scales differ`,
        rescaleHint(rs, scaleOf(t) ?? 0),
      );
    need(c, rt, t, other, 'argument b');
  }
  c.code.push(...set(y), ...get(x), ...get(y), ...get(x), ...get(y), name === 'min' ? 0x53 : 0x55, 0x1b);
  return t;
}
