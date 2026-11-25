// interp/float.ts: Float in the reference interpreter, written from the language's definition and not from the
// compiler's code. A Float is a JS number. JS + - * / are IEEE 754 roundTiesToEven (ECMA-262 §6.1.6.1), as
// Wasm's are; a result that is NaN or infinite stops the run (float not finite), so no Float is ever either. JS `%`
// is the exact remainder with the sign of the left side (ECMA-262 Number::remainder), which is C's fmod: the
// compiled module's `%` is its own port of musl's fmod (compiler/math/fmod.ts), so this one is independent of it.
import { unreachable } from '../compiler/ast.ts';
import { TRAP } from '../compiler/common.ts';
import { Trap } from './host.ts';
import { standalone } from '../compiler/math/library.ts';

/** A Float result, or the stop for one that is not finite. */
export const finite = (x: number): number => {
  if (!Number.isFinite(x)) throw new Trap(TRAP.FLOAT);
  return x;
};
type Op = '+' | '-' | '*' | '/' | '%';
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
    case '%':
      return finite(l % r);
    default:
      return unreachable(op, 'operator');
  }
}

/** The public functions of the math library, from the module of its own (compiler/math/library.ts standalone). */
export type Math64 = Record<string, (...xs: number[]) => number>;
let made: Math64 | null = null;
export function math64(): Math64 {
  if (made) return made;
  const out: Math64 = {};
  // compiled from bytes where that is allowed (Node, browsers); a Worker refuses it, and so has no math here
  const mod: unknown = Reflect.construct(WebAssembly.Module, [standalone()]);
  if (!(mod instanceof WebAssembly.Module)) throw new TypeError('the math library did not compile');
  for (const [n, f] of Object.entries(new WebAssembly.Instance(mod).exports))
    if (typeof f === 'function') out[n] = (...xs: number[]) => Number(f(...xs));
  made = out;
  return out;
}
export function mathFn(name: string): (...xs: number[]) => number {
  return math64()[name] ?? stop(`no math function ${name}`);
}
const stop = (why: string): never => {
  throw new Error(why);
};

const TWO_63 = 2 ** 63;
/** trunc(x): the Int toward zero, or the stop (integer overflow) when it is outside the Ints. */
export function truncToInt(x: number): bigint {
  const t = Math.trunc(x);
  if (t < -TWO_63 || t >= TWO_63) throw new Trap(TRAP.OVERFLOW);
  return BigInt(t);
}
