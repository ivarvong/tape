// compiler/gen/checked.ts: Int arithmetic that is exact or stops: + - * and / % with their overflow and division
// tests, shared by Int and by Dec (whose counts are Ints). compiler/gen/expr.ts and compiler/gen/dec.ts use it.
import type { Expr } from '../ast.ts';
import { I32, I64, TRAP, sleb, uleb } from '../common.ts';
import { INT } from '../types.ts';
import type { Type } from '../types.ts';
import { close, fresh, get, need, open, set, trapIf } from './fn.ts';
import type { Ctx } from './fn.ts';
import { rangeOf } from './range.ts';

type Of<K extends Expr['k']> = Extract<Expr, { k: K }>;

export const LEAST = -(2n ** 63n),
  MOST = 2n ** 63n - 1n;
export const I64_EQ = 0x51,
  I64_NE = 0x52,
  I64_LT_S = 0x53,
  I64_GT_S = 0x55,
  I64_GT_U = 0x56,
  I64_ADD = 0x7c,
  I64_SUB = 0x7d,
  I64_MUL = 0x7e,
  I64_DIV_S = 0x7f,
  I64_XOR = 0x85,
  I64_EXTEND32_S = 0xc4,
  I32_OR = 0x72,
  TEE = 0x22;
export const i64 = (v: bigint): number[] => [0x42, ...sleb(v)];
// The i64 locals an overflow or shift test holds its operands in, while it runs: a few for each function, used
// again by every test in it. A test begins once its operands are computed and computes nothing of the program's
// inside, so no two tests use them at once; and a function with fewer locals is cheaper to enter, which a loop
// written as a tail call does at each step.
export const SCRATCH = new WeakMap<readonly number[], number[]>();
export function scratch(c: Ctx, i: number): number {
  const mine = SCRATCH.get(c.locals) ?? [];
  SCRATCH.set(c.locals, mine);
  for (let k = mine.length; k <= i; k++) mine.push(fresh(c, I64));
  return mine[i] ?? fresh(c, I64);
}
/** Does `x op k` fit in an Int for every x from lo to hi? */
export function fitsOver(op: '+' | '-' | '*', k: bigint, [lo, hi]: readonly [bigint, bigint]): boolean {
  const ends = op === '+' ? [lo + k, hi + k] : op === '-' ? [lo - k, hi - k] : [lo * k, hi * k];
  return ends.every(v => v >= LEAST && v <= MOST);
}
/** The literal an operand is, when it is one. */
export const literal = (e: Expr): bigint | null => (e.k === 'int' ? e.v : null);

/**
 * `/` and `%` stop on a zero divisor (division by zero), and on the one quotient that does not fit, the least Int
 * by -1 (integer overflow); `%` stops where `/` does. A literal divisor other than 0 and -1 needs neither test.
 */
export function emitDivide(c: Ctx, e: Of<'bin'>): Type {
  const l = fresh(c, I64);
  const r = fresh(c, I64);
  c.code.push(...set(l));
  need(c, c.emit(e.r, INT, false), INT, e, `the right side of ${e.op}`);
  c.code.push(...set(r));
  const by = literal(e.r);
  if (by === null || by === 0n) {
    c.code.push(...get(r), 0x50);
    trapIf(c, TRAP.DIVISION);
  }
  if (by === null || by === -1n) {
    c.code.push(...get(l), ...i64(LEAST), I64_EQ, ...get(r), ...i64(-1n), I64_EQ, 0x71);
    trapIf(c, TRAP.OVERFLOW);
  }
  c.code.push(...get(l), ...get(r), e.op === '/' ? I64_DIV_S : 0x81);
  return INT;
}

/**
 * `+ - *` with both operands on the stack: the exact result, or a stop (integer overflow) when it does not fit in
 * 64 bits. A sum overflows when both operands' signs differ from the result's; a difference when the operands'
 * signs differ and the result's differs from the first's. A product of two operands that fit in 32 bits fits;
 * otherwise the product modulo 2^64 is divided back (but for -1 times the least Int, which that division cannot
 * test). A literal operand turns each test into comparisons of the other operand with bounds.
 */
export function emitChecked(c: Ctx, e: Of<'bin'>, op: '+' | '-' | '*'): void {
  const left = op === '-' ? null : literal(e.l);
  if (left !== null) return emitByLiteral(c, op, left, true, e.r);
  const a = scratch(c, 0),
    b = scratch(c, 1),
    r = scratch(c, 2);
  // the sign bits that say a sum or a difference overflowed, as the two values whose AND is negative then
  const signs: Record<'+' | '-', [number, number, number, number]> = { '+': [a, r, b, r], '-': [a, b, a, r] };
  const opcode = op === '+' ? I64_ADD : op === '-' ? I64_SUB : I64_MUL;
  c.code.push(...set(b), ...set(a), ...get(a), ...get(b), opcode, TEE, ...uleb(r));
  if (op !== '*') {
    const [p, q, s, t] = signs[op];
    c.code.push(...get(p), ...get(q), I64_XOR, ...get(s), ...get(t), I64_XOR, 0x83, ...i64(0n), I64_LT_S);
    return trapIf(c, TRAP.OVERFLOW);
  }
  const wide = (l: number): number[] => [...get(l), ...get(l), I64_EXTEND32_S, I64_NE];
  c.code.push(...wide(a), ...wide(b), I32_OR);
  open(c, 0x04);
  c.code.push(...get(a), ...i64(-1n), I64_EQ);
  open(c, 0x04, [I32]);
  c.code.push(...get(b), ...i64(LEAST), I64_EQ, 0x05, ...get(a), 0x50);
  open(c, 0x04, [I32]);
  c.code.push(0x41, 0, 0x05, ...get(r), ...get(a), I64_DIV_S, ...get(b), I64_NE);
  close(c);
  close(c);
  trapIf(c, TRAP.OVERFLOW);
  close(c);
}

/**
 * `x + k`, `x - k`, `x * k` for a literal k, with x alone on the stack (`k + x` and `k * x` too, with the literal's
 * copy below x dropped: a literal has no effect, so where it stands in the order of evaluation does not matter).
 * A sum or difference overflowed when it moved from x the other way from k's sign; a product when x is outside
 * the bounds for which it fits.
 */
export function emitByLiteral(c: Ctx, op: '+' | '-' | '*', k: bigint, below: boolean, other: Expr): void {
  const x = scratch(c, 0);
  c.code.push(...set(x), ...(below ? [0x1a] : []));
  if (k === 0n || (op === '*' && k === 1n)) {
    c.code.push(...(op === '*' && k === 0n ? i64(0n) : get(x)));
    return;
  }
  // a variable a condition has bounded (an index, `at + 1`): the result fits whatever it is within the bounds
  const known = rangeOf(c, other);
  if (known && fitsOver(op, k, known)) {
    c.code.push(...get(x), ...i64(k), op === '+' ? I64_ADD : op === '-' ? I64_SUB : I64_MUL);
    return;
  }
  if (op !== '*') {
    const r = scratch(c, 1);
    // x + k with k > 0 (x - k with k < 0) overflowed when it is below x; the other way round, when above it
    const up = (op === '+') === k > 0n;
    const opcode = op === '+' ? I64_ADD : I64_SUB;
    c.code.push(...get(x), ...i64(k), opcode, TEE, ...uleb(r), ...get(r), ...get(x), up ? I64_LT_S : I64_GT_S);
    trapIf(c, TRAP.OVERFLOW);
    return;
  }
  // the least and most x for which x * k fits (BigInt division truncates toward zero)
  const [lo, hi] = k > 0n ? [LEAST / k, MOST / k] : [MOST / k, LEAST / k];
  const tests = [
    ...(lo > LEAST ? [[...get(x), ...i64(lo), I64_LT_S]] : []),
    ...(hi < MOST ? [[...get(x), ...i64(hi), I64_GT_S]] : []),
  ];
  c.code.push(...tests.flat(), ...(tests.length === 2 ? [I32_OR] : []));
  if (tests.length > 0) trapIf(c, TRAP.OVERFLOW);
  c.code.push(...get(x), ...i64(k), I64_MUL);
}
