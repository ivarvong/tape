// interp/float.ts: Float in the reference interpreter, written from the language's definition and not from the
// compiler's code. A Float is a JS number. JS + - * / are IEEE 754 roundTiesToEven (ECMA-262 §6.1.6.1), as
// Wasm's are; a result that is NaN or infinite stops the run (float not finite), so no Float is ever either.
import { unreachable } from '../compiler/ast.ts';
import { TRAP } from '../compiler/common.ts';
import { Trap } from './host.ts';

/** A Float result, or the stop for one that is not finite. */
export const finite = (x: number): number => {
  if (!Number.isFinite(x)) throw new Trap(TRAP.FLOAT);
  return x;
};
type Op = '+' | '-' | '*' | '/';
export function floatArithmetic(op: Op, l: number, r: number): number {
  switch (op) {
    case '+':
      return finite(l + r);
    case '-':
      return finite(l - r);
    case '*':
      return finite(l * r);
    case '/':
      return finite(l / r);
    default:
      return unreachable(op, 'operator');
  }
}

const TWO_63 = 2 ** 63;
/** trunc(x): the Int toward zero, or the stop (integer overflow) when it is outside the Ints. */
export function truncToInt(x: number): bigint {
  const t = Math.trunc(x);
  if (t < -TWO_63 || t >= TWO_63) throw new Trap(TRAP.OVERFLOW);
  return BigInt(t);
}
