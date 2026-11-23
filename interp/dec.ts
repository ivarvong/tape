// interp/dec.ts: Dec[s] in the reference interpreter, written from the language's definition and not from the
// compiler's code: a count m of 10^-s as a BigInt, each result computed exactly and then rounded once, by dividing
// with BigInt and looking at the remainder. No 128-bit limbs and no Hacker's Delight here: the compiled module's
// muldiv (compiler/math/dec.ts) is held to this, and both to the reference in test/decs.ts.
import { TRAP } from '../compiler/common.ts';
import { Trap } from './host.ts';

export type Dec = { readonly k: 'dec'; readonly m: bigint; readonly s: number };
const MIN = -(2n ** 63n),
  MAX = 2n ** 63n - 1n;
/** A Dec of count m at scale s, or the stop (integer overflow) when m is beyond 64 bits. */
export const dec = (m: bigint, s: number): Dec => {
  if (m < MIN || m > MAX) throw new Trap(TRAP.OVERFLOW);
  return { k: 'dec', m, s };
};
const pow10 = (k: number): bigint => 10n ** BigInt(k);

/** n / d, rounded as std's Rounding constructor named says. d is not 0. */
export function divide(n: bigint, d: bigint, rounding: string): bigint {
  if (d === 0n) throw new Trap(TRAP.DIVISION);
  const [num, den] = d < 0n ? [-n, -d] : [n, d];
  const q = num / den,
    r = num % den;
  if (r === 0n) return q;
  const negative = num < 0n;
  const twice = 2n * (r < 0n ? -r : r);
  const away =
    rounding === 'HalfEven'
      ? twice > den || (twice === den && q % 2n !== 0n)
      : rounding === 'HalfUp'
        ? twice >= den
        : rounding === 'Down'
          ? false
          : rounding === 'Up'
            ? true
            : rounding === 'Floor'
              ? negative
              : rounding === 'Ceiling'
                ? !negative
                : stop(`no rounding ${rounding}`);
  return away ? (negative ? q - 1n : q + 1n) : q;
}
const stop = (why: string): never => {
  throw new Error(why);
};

/** The count of x at scale t ≥ x's own. */
const at = (x: Dec, t: number): bigint => x.m * pow10(t - x.s);
/** -1, 0 or 1: x against y, exactly, whatever their scales. */
export function order(x: Dec, y: Dec): number {
  const t = Math.max(x.s, y.s),
    a = at(x, t),
    b = at(y, t);
  return a < b ? -1 : a > b ? 1 : 0;
}

export const rescale = (x: Dec, t: number): Dec => dec(at(x, t), t);
export const round = (x: Dec, t: number, rounding: string): Dec => dec(divide(x.m, pow10(x.s - t), rounding), t);
export const toInt = (x: Dec, rounding: string): bigint => dec(divide(x.m, pow10(x.s), rounding), 0).m;
/** The exact product, at scale t: more digits added, or fewer rounded away. */
export function mul(a: Dec, b: Dec, t: number, rounding: string): Dec {
  const m = a.m * b.m,
    s = a.s + b.s;
  return dec(t >= s ? m * pow10(t - s) : divide(m, pow10(s - t), rounding), t);
}
/** a / b at scale t: a·10^-s / (b·10^-u) is a·10^(t+u-s) / b counts of 10^-t. */
export function div(a: Dec, b: Dec, t: number, rounding: string): Dec {
  const k = t + b.s - a.s;
  return dec(k >= 0 ? divide(a.m * pow10(k), b.m, rounding) : divide(a.m, b.m * pow10(-k), rounding), t);
}
/** The Float's exact value (a binary fraction n / 2^p) at scale t, rounded. */
export function ofFloat(x: number, t: number, rounding: string): Dec {
  const v = new DataView(new ArrayBuffer(8));
  v.setFloat64(0, x);
  const u = v.getBigUint64(0),
    field = Number((u >> 52n) & 0x7ffn),
    fraction = u & ((1n << 52n) - 1n),
    m = field === 0 ? fraction : fraction | (1n << 52n),
    p = (field === 0 ? 1 : field) - 1075,
    n = (u >> 63n === 1n ? -m : m) * pow10(t);
  return dec(p >= 0 ? n << BigInt(p) : divide(n, 1n << BigInt(-p), rounding), t);
}
/** The digits, with exactly s after the point: 12.30, -0.05, 0.00. */
export function text(x: Dec): string {
  const digits = (x.m < 0n ? -x.m : x.m).toString().padStart(x.s + 1, '0'),
    whole = digits.slice(0, digits.length - x.s);
  return `${x.m < 0n ? '-' : ''}${whole}${x.s > 0 ? `.${digits.slice(digits.length - x.s)}` : ''}`;
}
/** The Float nearest x: ECMA-262 reads at most 20 significant digits correctly rounded, and a count has 19. */
export const toFloat = (x: Dec): number => Number(text(x));
