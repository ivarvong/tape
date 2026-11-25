// compiler/math/fmod.ts: fmod, Float's `%`, ported from musl (src/math/fmod.c, as zig 0.14.1 ships it): the
// remainder of x / y truncated toward zero, x - n*y for the integer n nearest x/y toward zero, with the sign of x.
// It is exact, so any correct fmod gives these bits (JavaScript's `%` is specified to be the same, ECMA-262
// Number::remainder); this is the integer long division musl does on the significands, line for line, but for
// what a Float cannot be: a NaN or infinite operand. y = 0 gives NaN, which the caller's test turns into the trap.
//
// musl's: Copyright © 2005-2020 Rich Felker, et al. (MIT licence).
import { F64, I64, add, and, bits, div, double, eq, eqz, f, gt, l, leU, mul, or, shl, shrU, sub } from './wasm.ts';
import type { Def, Local } from './wasm.ts';

const ONE_52 = 1n << 52n;
const fmod: Def = {
  params: [F64, F64],
  results: [F64],
  body(b) {
    const x = b.p(0),
      y = b.p(1);
    const uxi = b.let(bits(x)),
      uy = b.let(bits(y));
    const ex = b.let(and(shrU(uxi, l(52n)), l(0x7ffn))),
      ey = b.let(and(shrU(uy, l(52n)), l(0x7ffn)));
    const sx = b.let(shrU(uxi, l(63n)));
    const k = b.local(I64);
    // y = 0: not a number
    b.if(eqz(shl(uy, l(1n))), () => {
      b.ret(div(mul(x, y), mul(x, y)));
    });
    // |x| <= |y|: 0 (with x's sign) or x
    b.if(leU(shl(uxi, l(1n)), shl(uy, l(1n))), () => {
      b.if(eq(shl(uxi, l(1n)), shl(uy, l(1n))), () => {
        b.ret(mul(f(0), x));
      });
      b.ret(x);
    });
    // normalize x and y: a subnormal's leading bit to bit 52, a normal's hidden bit made explicit
    const normal = (u: Local, e: Local): void => {
      b.if(
        eqz(e),
        () => {
          b.set(k, shl(u, l(12n)));
          b.while(eqz(shrU(k, l(63n))), () => {
            b.set(e, sub(e, l(1n)));
            b.set(k, shl(k, l(1n)));
          });
          b.set(u, shl(u, add(sub(l(0n), e), l(1n))));
        },
        () => {
          b.set(u, and(u, l(ONE_52 - 1n)));
          b.set(u, or(u, l(ONE_52)));
        },
      );
    };
    normal(uxi, ex);
    normal(uy, ey);
    // x mod y: one bit of the quotient a turn
    const step = (): void => {
      b.set(k, sub(uxi, uy));
      b.if(eqz(shrU(k, l(63n))), () => {
        b.if(eqz(k), () => {
          b.ret(mul(f(0), x));
        });
        b.set(uxi, k);
      });
    };
    b.while(gt(ex, ey), () => {
      step();
      b.set(uxi, shl(uxi, l(1n)));
      b.set(ex, sub(ex, l(1n)));
    });
    step();
    b.while(eqz(shrU(uxi, l(52n))), () => {
      b.set(uxi, shl(uxi, l(1n)));
      b.set(ex, sub(ex, l(1n)));
    });
    // scale the result
    b.if(
      gt(ex, l(0n)),
      () => {
        b.set(uxi, sub(uxi, l(ONE_52)));
        b.set(uxi, or(uxi, shl(ex, l(52n))));
      },
      () => b.set(uxi, shrU(uxi, add(sub(l(0n), ex), l(1n)))),
    );
    b.ret(double(or(uxi, shl(sx, l(63n)))));
  },
};
export const FMOD: Readonly<Record<string, Def>> = { fmod };
