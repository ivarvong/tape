// compiler/math/decimal.ts: parse_float's fast path, in the module. For text of the form `-?(0|[1-9]digits)(.digits)?`
// (JSON's number syntax with no exponent) whose digits, the point left out, are an integer m <= 2^53, with at most
// 22 digits after the point: m and 10^k are both exact doubles, so m / 10^k is one IEEE division, correctly rounded
// (roundTiesToEven), and that is ECMA-262's StringToNumber of the text (Clinger, "How to Read Floating Point Numbers
// Accurately", PLDI 1990, §3). The sign is put on afterwards, so -0 and -0.0 are -0. Anything else (an exponent, a
// `+`, white space, more digits, the empty text) gives NaN, which this never gives otherwise, and the caller asks
// the host's float_of (compiler/gen/intrinsic.ts parseFloat), which reads JSON's number syntax and nothing else.
// test/float-of.ts holds both to that syntax read by Number.
import {
  doubles,
  F64,
  I32,
  I64,
  add,
  and,
  div,
  eq,
  eqz,
  extU,
  f,
  gtU,
  i,
  l,
  loadB,
  loadF,
  ltU,
  mul,
  ne,
  neg,
  or,
  select,
  shl,
  sub,
  toFU,
} from './wasm.ts';
import type { Def } from './wasm.ts';

/** The largest m, and the largest k, for which m / 10^k is exact before the division. */
export const MAX_MANTISSA = 2n ** 53n;
export const MAX_PLACES = 22;
/** 10^0 … 10^22, each exact: read from its decimal text, which is correctly rounded (Math.pow need not be). */
export const POWERS: readonly number[] = Array.from({ length: MAX_PLACES + 1 }, (_, k) => Number(`1e${k}`));

const parseDecimal: Def = {
  params: [I32, I32],
  results: [F64],
  body: b => {
    const end = b.let(add(b.p(0), b.p(1)));
    const at = b.let(b.p(0));
    // a leading minus: 1, and `at` past it
    const minus = b.local(I32);
    b.set(minus, and(ltU(at, end), eq(loadB(at), i(45))));
    b.set(at, add(at, minus));
    const m = b.local(I64, l(0n));
    const digits = b.local(I32, i(0));
    const places = b.local(I32, i(0));
    const point = b.local(I32, i(0));
    const c = b.local(I32);
    b.block('slow', () => {
      b.while(ltU(at, end), () => {
        b.set(c, sub(loadB(at), i(48)));
        b.if(
          ltU(c, i(10)),
          () => {
            // m only grows, so once it is past 2^53 the text is not for this path (and m*10 never overflows)
            b.set(m, add(mul(m, l(10n)), extU(c)));
            b.brIf('slow', gtU(m, l(MAX_MANTISSA)));
            b.set(digits, add(digits, i(1)));
            b.set(places, add(places, point));
          },
          () => {
            // the one point ('.' is 46, so c is -2); anything else is for the host
            b.brIf('slow', or(ne(c, i(-2)), point));
            b.set(point, i(1));
          },
        );
        b.set(at, add(at, i(1)));
      });
      // JSON's number syntax, which the host also holds the rest to: a digit before the point, one after a point,
      // and no leading zero ("05", ".5" and "5." are for the host, which answers NaN)
      const before = b.let(sub(digits, places));
      b.brIf('slow', or(eqz(before), and(point, eqz(places))));
      b.brIf('slow', and(gtU(before, i(1)), eq(loadB(add(b.p(0), minus)), i(48))));
      b.brIf('slow', gtU(places, i(MAX_PLACES)));
      const x = b.let(div(toFU(m), loadF(add(b.data(doubles(POWERS)), shl(places, i(3))))));
      b.ret(select(minus, neg(x), x));
    });
    b.ret(f(NaN));
  },
};

export const DECIMAL: Readonly<Record<string, Def>> = { parse_decimal: parseDecimal };
