// compiler/gen/float.ts: Float, an f64 that is never NaN and never infinite. Each operation whose IEEE result
// could be either is followed by a test that stops the run instead (float not finite), so every Float a program
// holds is finite and `==` and `<` are total. The rest is what Wasm defines exactly: + - * / and sqrt correctly
// rounded (roundTiesToEven), and floor, ceil, trunc and nearest exact.
import type { Arg, Call, Expr } from '../ast.ts';
import { F64, I64, TRAP, f64, fail, sleb, uleb } from '../common.ts';
import { BOOL, FLOAT, INT, INTRINSICS } from '../types.ts';
import type { Type } from '../types.ts';
import { fresh, get, need, set, trapIf } from './fn.ts';
import type { Ctx } from './fn.ts';

type Bin = Extract<Expr, { k: 'bin' }>;
const F64_ABS = 0x99,
  F64_LT = 0x63,
  F64_GE = 0x66,
  I32_EQZ = 0x45,
  I32_OR = 0x72,
  TEE = 0x22;
const ARITHMETIC: Readonly<Record<string, number>> = { '+': 0xa0, '-': 0xa1, '*': 0xa2, '/': 0xa3 };
const COMPARE: Readonly<Record<string, number>> = {
  '==': 0x61,
  '!=': 0x62,
  '<': 0x63,
  '>': 0x64,
  '<=': 0x65,
  '>=': 0x66,
};

// One f64 local per function for the tests below: a test begins once its operand is computed and computes nothing
// of the program's inside, so no two use it at once.
const SCRATCH = new WeakMap<readonly number[], number>();
function scratch(c: Ctx): number {
  const had = SCRATCH.get(c.locals);
  if (had !== undefined) return had;
  const l = fresh(c, F64);
  SCRATCH.set(c.locals, l);
  return l;
}

/** The f64 on the stack, or a stop when it is NaN or infinite: NaN fails `<` too. */
export function finite(c: Ctx): void {
  const x = scratch(c);
  c.code.push(TEE, ...uleb(x), F64_ABS, ...f64(Infinity), F64_LT, I32_EQZ);
  trapIf(c, TRAP.FLOAT);
  c.code.push(...get(x));
}

/** `a op b` with a Float on the stack as a: the other side, then the operation. */
export function emitFloatBin(c: Ctx, e: Bin): Type {
  const { op } = e;
  const compare = Object.hasOwn(COMPARE, op) ? COMPARE[op] : undefined;
  const arithmetic = Object.hasOwn(ARITHMETIC, op) ? ARITHMETIC[op] : undefined;
  const opcode = compare ?? arithmetic;
  if (opcode === undefined)
    return fail(
      e,
      'C19',
      `Float values have no ${op}`,
      op === '%'
        ? 'A Float has + - * / and comparisons. For a remainder, `x - y * float(floor(x / y))`.'
        : 'A Float has + - * / and comparisons; bitwise operators and ++ are for Int and text.',
    );
  need(c, c.emit(e.r, FLOAT, false), FLOAT, e, `the right side of ${op}`);
  c.code.push(opcode);
  if (compare !== undefined) return BOOL;
  finite(c);
  return FLOAT;
}

/** The arguments of an intrinsic, in the order of its parameters. */
const argsOf = (c: Ctx, e: Call): Arg[] => c.B.orderArgs(`function ${e.name}`, INTRINSICS.get(e.name) ?? [], e.args, e);
/** One argument on the stack, as the type wanted. */
function emitArg(c: Ctx, a: Arg | undefined, want: Type, what: string): void {
  if (a) need(c, c.emit(a.value, want, false), want, a, `argument ${what}`);
}

// 2^63: the least f64 too large for an Int; -2^63 is the least Int itself
const TWO_63 = 9223372036854775808;
// Float to Float, exact (IEEE 754 roundToIntegral, absolute value); sqrt correctly rounded, NaN below 0
const UNARY: Readonly<Record<string, number>> = { floor: 0x9c, ceil: 0x9b, abs: 0x99, sqrt: 0x9f };

/** min(a, b) and max(a, b) of two Ints or two Floats; abs(x) of an Int, which traps on the least Int. */
function emitOrder(c: Ctx, e: Call): Type {
  const [a, b] = argsOf(c, e);
  const t = a ? c.B.strip(c.emit(a.value, null, false)) : INT;
  if (t.name === 'Float') {
    emitArg(c, b, FLOAT, 'b');
    c.code.push(e.name === 'min' ? 0xa4 : 0xa5);
    return FLOAT;
  }
  need(c, t, INT, a, 'argument a');
  const x = fresh(c, I64),
    y = fresh(c, I64);
  c.code.push(...set(x));
  emitArg(c, b, INT, 'b');
  c.code.push(...set(y), ...get(x), ...get(y), ...get(x), ...get(y), e.name === 'min' ? 0x53 : 0x55, 0x1b);
  return INT;
}

/**
 * The numbers' intrinsics: float(n), the Float nearest n (ties to even, exact up to 2^53); trunc(x), the Int toward
 * zero, a stop (integer overflow) outside the Ints; floor, ceil, abs and sqrt of a Float; abs, min and max of an
 * Int or a Float. Null for any other name.
 */
export function emitFloatIntrinsic(c: Ctx, e: Call): Type | null {
  const n = e.name;
  if (n === 'min' || n === 'max') return emitOrder(c, e);
  const [a] = argsOf(c, e);
  if (n === 'float') {
    emitArg(c, a, INT, 'n');
    c.code.push(0xb9);
    return FLOAT;
  }
  if (n === 'trunc') {
    emitArg(c, a, FLOAT, 'x');
    const r = fresh(c, F64);
    c.code.push(0x9d, TEE, ...uleb(r), ...f64(-TWO_63), F64_LT, ...get(r), ...f64(TWO_63), F64_GE, I32_OR);
    trapIf(c, TRAP.OVERFLOW);
    c.code.push(...get(r), 0xb0);
    return INT;
  }
  const op = Object.hasOwn(UNARY, n) ? UNARY[n] : undefined;
  if (op === undefined) return null;
  // abs takes an Int too; the others a Float
  const t = a ? c.B.strip(c.emit(a.value, n === 'abs' ? null : FLOAT, false)) : FLOAT;
  if (n === 'abs' && t.name === 'Int') {
    const x = fresh(c, I64);
    c.code.push(TEE, ...uleb(x), 0x42, ...sleb(-(2n ** 63n)), 0x51);
    trapIf(c, TRAP.OVERFLOW);
    c.code.push(0x42, 0, ...get(x), 0x7d, ...get(x), ...get(x), 0x42, 0, 0x53, 0x1b);
    return INT;
  }
  need(c, t, FLOAT, a, 'argument x');
  c.code.push(op);
  if (n === 'sqrt') finite(c);
  return FLOAT;
}
