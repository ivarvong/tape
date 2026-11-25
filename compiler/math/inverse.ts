// compiler/math/inverse.ts: atan2, and the atan it is made of, asin and acos, ported from musl (src/math/atan.c
// atan2.c asin.c acos.c, as zig 0.14.1 ships them). Line for line, but for what a Float cannot be: the NaN and infinity branches are gone, and so
// is FORCE_EVAL. atan(x) is atan2(x, 1f), bit for bit (atan2 calls atan for x = 1).
//
// From FreeBSD's msun, from fdlibm:
// ====================================================
// Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
//
// Developed at SunSoft, a Sun Microsystems, Inc. business.
// Permission to use, copy, modify, and distribute this
// software is freely granted, provided that this notice
// is preserved.
// ====================================================
import {
  F64,
  abs,
  add,
  and,
  bits,
  div,
  double,
  eq,
  eqz,
  f,
  geU,
  hi,
  i,
  l,
  leU,
  lo,
  ltU,
  mul,
  neg,
  or,
  poly,
  shrU,
  sqrt,
  sub,
} from './wasm.ts';
import type { Def, E } from './wasm.ts';

// ---- atan(x)
const atanhi = [4.63647609000806093515e-1, 7.85398163397448278999e-1, 9.82793723247329054082e-1, 1.570796326794896558];
const atanlo = [
  2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17,
];
const aT = [
  3.33333333333329318027e-1, -1.99999999998764832476e-1, 1.42857142725034663711e-1, -1.1111110405462355788e-1,
  9.09088713343650656196e-2, -7.69187620504482999495e-2, 6.66107313738753120669e-2, -5.83357013379057348645e-2,
  4.97687799461593236017e-2, -3.6531572744216915527e-2, 1.62858201153657823623e-2,
];
const even = [0, 2, 4, 6, 8, 10].map(k => aT[k] ?? 0),
  odd = [1, 3, 5, 7, 9].map(k => aT[k] ?? 0);
const atan: Def = {
  params: [F64],
  results: [F64],
  body(b) {
    const x = b.p(0);
    const sign = b.let(shrU(hi(x), i(31)));
    const ix = b.let(and(hi(x), i(0x7fffffff)));
    const signed = (z: E): void => {
      b.if(sign, () => {
        b.ret(neg(z));
      });
      b.ret(z);
    };
    // |x| >= 2^66: pi/2 (0x1p-120f is below its last bit)
    b.if(geU(ix, i(0x44100000)), () => signed(add(f(atanhi[3] ?? 0), f(2 ** -120))));
    const id = b.local(F64);
    const reduce = (k: number, e: E): void => {
      b.set(id, f(k));
      b.set(x, e);
    };
    b.if(
      ltU(ix, i(0x3fdc0000)),
      () => {
        // |x| < 0.4375; below 2^-27, x itself
        b.if(ltU(ix, i(0x3e400000)), () => {
          b.ret(x);
        });
        b.set(id, f(-1));
      },
      () => {
        b.set(x, abs(x));
        b.if(
          ltU(ix, i(0x3ff30000)),
          () =>
            b.if(
              ltU(ix, i(0x3fe60000)),
              () => reduce(0, div(sub(mul(f(2), x), f(1)), add(f(2), x))),
              () => reduce(1, div(sub(x, f(1)), add(x, f(1)))),
            ),
          () =>
            b.if(
              ltU(ix, i(0x40038000)),
              () => reduce(2, div(sub(x, f(1.5)), add(f(1), mul(f(1.5), x)))),
              () => reduce(3, div(f(-1), x)),
            ),
        );
      },
    );
    const z = b.let(mul(x, x));
    const w = b.let(mul(z, z));
    const s1 = b.let(mul(z, poly(w, even)));
    const s2 = b.let(mul(w, poly(w, odd)));
    b.if(eq(id, f(-1)), () => {
      b.ret(sub(x, mul(x, add(s1, s2))));
    });
    // atanhi[id] - (x*(s1+s2) - atanlo[id] - x), id 0 to 3
    for (let k = 0; k < 4; k++)
      b.if(eq(id, f(k)), () => signed(sub(f(atanhi[k] ?? 0), sub(sub(mul(x, add(s1, s2)), f(atanlo[k] ?? 0)), x))));
    b.ret(f(0));
  },
};

// ---- atan2(y, x)
// pi is the double nearest pi, 0x400921FB54442D18, which Math.PI is
const pi = Math.PI,
  pi_lo = 1.2246467991473532e-16;
const atan2: Def = {
  params: [F64, F64],
  results: [F64],
  body(b) {
    const y = b.p(0),
      x = b.p(1);
    const ix = b.let(hi(x)),
      lx = b.let(lo(x)),
      iy = b.let(hi(y)),
      ly = b.let(lo(y));
    // x = 1.0
    b.if(eqz(or(sub(ix, i(0x3ff00000)), lx)), () => {
      b.ret(b.call('atan', F64, y));
    });
    // 2*sign(x) + sign(y)
    const m = b.let(or(and(shrU(iy, i(31)), i(1)), and(shrU(ix, i(30)), i(2))));
    b.set(ix, and(ix, i(0x7fffffff)));
    b.set(iy, and(iy, i(0x7fffffff)));
    const byM = (zs: readonly [E, E, E, E]): void => {
      zs.forEach((z, k) => {
        if (k < 3)
          b.if(eq(m, i(k)), () => {
            b.ret(z);
          });
        else b.ret(z);
      });
    };
    // y = 0: atan(+-0, +anything) = +-0, atan(+-0, -anything) = +-pi
    b.if(eqz(or(iy, ly)), () => byM([y, y, f(pi), f(-pi)]));
    // x = 0
    b.if(eqz(or(ix, lx)), () => {
      b.if(and(m, i(1)), () => {
        b.ret(f(-pi / 2));
      });
      b.ret(f(pi / 2));
    });
    // |y/x| > 2^64
    b.if(ltU(add(ix, i(64 << 20)), iy), () => {
      b.if(and(m, i(1)), () => {
        b.ret(f(-pi / 2));
      });
      b.ret(f(pi / 2));
    });
    // z = atan(|y/x|) without spurious underflow; |y/x| < 2^-64 with x < 0 is 0
    const z = b.local(F64);
    b.if(
      and(and(m, i(2)), ltU(add(iy, i(64 << 20)), ix)),
      () => b.set(z, f(0)),
      () => b.set(z, b.call('atan', F64, abs(div(y, x)))),
    );
    byM([z, neg(z), sub(f(pi), sub(z, f(pi_lo))), sub(sub(z, f(pi_lo)), f(pi))]);
  },
};

// ---- asin(x), acos(x): R(z) is their rational approximation of (asin(x) - x) / x^3, z = x^2
const pio2_hi = 1.570796326794896558,
  pio2_lo = 6.12323399573676603587e-17;
const pS = [
  1.66666666666666657415e-1, -3.25565818622400915405e-1, 2.01212532134862925881e-1, -4.00555345006794114027e-2,
  7.91534994289814532176e-4, 3.4793310759602116757e-5,
];
const qS = [1, -2.40339491173441421878, 2.02094576023350569471, -6.8828397160545329303e-1, 7.70381505559019352791e-2];
const asinR: Def = {
  params: [F64],
  results: [F64],
  body(b) {
    const z = b.p(0);
    b.ret(div(mul(z, poly(z, pS)), poly(z, qS)));
  },
};
/** x with its low 32 bits cleared (SET_LOW_WORD(x, 0)). */
const highOnly = (x: E): E => double(and(bits(x), l(-(1n << 32n))));
/** NaN, as musl writes it for |x| > 1: 0/(x-x). The caller's test turns it into the trap. */
const nan = (x: E): E => div(f(0), sub(x, x));
const asin: Def = {
  params: [F64],
  results: [F64],
  body(b) {
    const x = b.p(0);
    const hx = b.let(hi(x));
    const ix = b.let(and(hx, i(0x7fffffff)));
    // |x| >= 1: +-pi/2 at +-1, else not a number
    b.if(geU(ix, i(0x3ff00000)), () => {
      b.if(eqz(or(sub(ix, i(0x3ff00000)), lo(x))), () => {
        b.ret(add(mul(x, f(pio2_hi)), f(2 ** -120)));
      });
      b.ret(nan(x));
    });
    // |x| < 0.5; x itself for 2^-1022 <= |x| < 2^-26
    b.if(ltU(ix, i(0x3fe00000)), () => {
      b.if(and(ltU(ix, i(0x3e500000)), geU(ix, i(0x00100000))), () => {
        b.ret(x);
      });
      b.ret(add(x, mul(x, b.call('asin_r', F64, mul(x, x)))));
    });
    // 1 > |x| >= 0.5
    const z = b.let(mul(sub(f(1), abs(x)), f(0.5)));
    const s = b.let(sqrt(z));
    const r = b.let(b.call('asin_r', F64, z));
    b.if(
      geU(ix, i(0x3fef3333)),
      // |x| > 0.975
      () => b.set(x, sub(f(pio2_hi), sub(mul(f(2), add(s, mul(s, r))), f(pio2_lo)))),
      () => {
        // f + c = sqrt(z)
        const hs = b.let(highOnly(s));
        const c = b.let(div(sub(z, mul(hs, hs)), add(s, hs)));
        b.set(
          x,
          sub(
            mul(f(0.5), f(pio2_hi)),
            sub(sub(mul(mul(f(2), s), r), sub(f(pio2_lo), mul(f(2), c))), sub(mul(f(0.5), f(pio2_hi)), mul(f(2), hs))),
          ),
        );
      },
    );
    b.if(shrU(hx, i(31)), () => {
      b.ret(neg(x));
    });
    b.ret(x);
  },
};
const acos: Def = {
  params: [F64],
  results: [F64],
  body(b) {
    const x = b.p(0);
    const hx = b.let(hi(x));
    const ix = b.let(and(hx, i(0x7fffffff)));
    // |x| >= 1: 0 at 1, pi at -1, else not a number
    b.if(geU(ix, i(0x3ff00000)), () => {
      b.if(eqz(or(sub(ix, i(0x3ff00000)), lo(x))), () => {
        b.if(shrU(hx, i(31)), () => {
          b.ret(add(mul(f(2), f(pio2_hi)), f(2 ** -120)));
        });
        b.ret(f(0));
      });
      b.ret(nan(x));
    });
    // |x| < 0.5; pi/2 below 2^-57
    b.if(ltU(ix, i(0x3fe00000)), () => {
      b.if(leU(ix, i(0x3c600000)), () => {
        b.ret(add(f(pio2_hi), f(2 ** -120)));
      });
      b.ret(sub(f(pio2_hi), sub(x, sub(f(pio2_lo), mul(x, b.call('asin_r', F64, mul(x, x)))))));
    });
    // x < -0.5
    b.if(shrU(hx, i(31)), () => {
      const z = b.let(mul(add(f(1), x), f(0.5)));
      const s = b.let(sqrt(z));
      const w = b.let(sub(mul(b.call('asin_r', F64, z), s), f(pio2_lo)));
      b.ret(mul(f(2), sub(f(pio2_hi), add(s, w))));
    });
    // x > 0.5
    const z = b.let(mul(sub(f(1), x), f(0.5)));
    const s = b.let(sqrt(z));
    const df = b.let(highOnly(s));
    const c = b.let(div(sub(z, mul(df, df)), add(s, df)));
    const w = b.let(add(mul(b.call('asin_r', F64, z), s), c));
    b.ret(mul(f(2), add(df, w)));
  },
};

export const INVERSE: Readonly<Record<string, Def>> = { atan, atan2, asin_r: asinR, asin, acos };
