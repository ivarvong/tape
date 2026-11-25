// compiler/math/trig.ts: sin, cos and tan, ported from musl (src/math/sin.c cos.c tan.c __sin.c __cos.c __tan.c
// __rem_pio2.c __rem_pio2_large.c, as zig 0.14.1 ships them for wasm32-wasi, which drops the directed-rounding
// fix-up of __rem_pio2: Wasm rounds to nearest). Line for line, but for what a Float cannot be: the NaN and
// infinity branches are gone, and so is FORCE_EVAL, which only raises a floating-point exception.
//
// From FreeBSD's msun, from fdlibm:
// ====================================================
// Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
//
// Developed at SunPro, a Sun Microsystems, Inc. business.
// Permission to use, copy, modify, and distribute this
// software is freely granted, provided that this notice
// is preserved.
// ====================================================
// Optimized by Bruce D. Evans (__sin, __cos, __rem_pio2).
// __tan: Copyright 2004 Sun Microsystems, Inc. All Rights Reserved. Permission to use, copy, modify, and
// distribute this software is freely granted, provided that this notice is preserved.
import {
  F64,
  I32,
  add,
  and,
  bits,
  div,
  double,
  eq,
  eqz,
  extU,
  f,
  geU,
  floor,
  ge,
  gt,
  hi,
  i,
  ints32,
  doubles,
  l,
  le,
  leU,
  loadF,
  loadI,
  lt,
  ltU,
  mul,
  ne,
  neg,
  or,
  poly,
  shl,
  shrS,
  shrU,
  sub,
  toF,
  toI32,
  wrap,
} from './wasm.ts';
import type { Body, Def, E, Local } from './wasm.ts';

// ---- __sin(x, y, iy): sin(x + y) for |x + y| <= pi/4; iy says whether y is 0
const S1 = -1.66666666666666324348e-1,
  S = [8.33333333332248946124e-3, -1.98412698298579493134e-4, 2.75573137070700676789e-6],
  S56 = [-2.50507602534068634195e-8, 1.58969099521155010221e-10];
const kSin: Def = {
  params: [F64, F64, I32],
  results: [F64],
  body(b) {
    const x = b.p(0),
      y = b.p(1),
      iy = b.p(2);
    const z = b.let(mul(x, x));
    const w = b.let(mul(z, z));
    const r = b.let(add(poly(z, S), mul(mul(z, w), poly(z, S56))));
    const v = b.let(mul(z, x));
    b.if(eqz(iy), () => {
      b.ret(add(x, mul(v, add(f(S1), mul(z, r)))));
    });
    b.ret(sub(x, sub(sub(mul(z, sub(mul(f(0.5), y), mul(v, r))), y), mul(v, f(S1)))));
  },
};

// ---- __cos(x, y): cos(x + y) for |x + y| <= pi/4
const C13 = [4.16666666666666019037e-2, -1.38888888888741095749e-3, 2.48015872894767294178e-5],
  C46 = [-2.75573143513906633035e-7, 2.0875723212981748279e-9, -1.13596475577881948265e-11];
const kCos: Def = {
  params: [F64, F64],
  results: [F64],
  body(b) {
    const x = b.p(0),
      y = b.p(1);
    const z = b.let(mul(x, x));
    const w = b.let(mul(z, z));
    const r = b.let(add(mul(z, poly(z, C13)), mul(mul(w, w), poly(z, C46))));
    const hz = b.let(mul(f(0.5), z));
    b.set(w, sub(f(1), hz));
    b.ret(add(w, add(sub(sub(f(1), w), hz), sub(mul(z, r), mul(x, y)))));
  },
};

// ---- __tan(x, y, odd): tan(x + y) (odd 0) or -1/tan(x + y) (odd 1) for |x + y| <= pi/4 (or a little more)
const T = [
  3.33333333333334091986e-1, 1.33333333333201242699e-1, 5.39682539762260521377e-2, 2.18694882948595424599e-2,
  8.86323982359930005737e-3, 3.59207910759131235356e-3, 1.45620945432529025516e-3, 5.88041240820264096874e-4,
  2.46463134818469906812e-4, 7.817944429395570923e-5, 7.14072491382608190305e-5, -1.85586374855275456654e-5,
  2.59073051863633712884e-5,
];
const Tat = (ks: readonly number[]): number[] => ks.map(k => T[k] ?? 0);
const pio4 = 7.85398163397448278999e-1,
  pio4lo = 3.06161699786838301793e-17;
/** x with its low 32 bits cleared (SET_LOW_WORD(x, 0)). */
const highOnly = (x: E): E => double(and(bits(x), l(-(1n << 32n))));
const kTan: Def = {
  params: [F64, F64, I32],
  results: [F64],
  body(b) {
    const x = b.p(0),
      y = b.p(1),
      odd = b.p(2);
    const hx = b.let(hi(x));
    // |x| >= 0.6744: tan(pi/4 - y), from (1 - tan y) / (1 + tan y)
    const big = b.let(geU(and(hx, i(0x7fffffff)), i(0x3fe59428)));
    const sign = b.let(shrU(hx, i(31)));
    b.if(big, () => {
      b.if(sign, () => {
        b.set(x, neg(x));
        b.set(y, neg(y));
      });
      b.set(x, add(sub(f(pio4), x), sub(f(pio4lo), y)));
      b.set(y, f(0));
    });
    const z = b.let(mul(x, x));
    const w = b.let(mul(z, z));
    const r = b.let(poly(w, Tat([1, 3, 5, 7, 9, 11])));
    const v = b.let(mul(z, poly(w, Tat([2, 4, 6, 8, 10, 12]))));
    const s = b.let(mul(z, x));
    b.set(r, add(add(y, mul(z, add(mul(s, add(r, v)), y))), mul(s, f(T[0] ?? 0))));
    b.set(w, add(x, r));
    b.if(big, () => {
      b.set(s, toF(sub(i(1), mul(i(2), odd))));
      b.set(v, sub(s, mul(f(2), add(x, sub(r, div(mul(w, w), add(w, s)))))));
      b.if(sign, () => {
        b.ret(neg(v));
      });
      b.ret(v);
    });
    b.if(eqz(odd), () => {
      b.ret(w);
    });
    // -1/(x+r) has up to 2 ulp error, so compute it accurately
    const w0 = b.let(highOnly(w));
    b.set(v, sub(r, sub(w0, x)));
    const a = b.let(div(f(-1), w));
    const a0 = b.let(highOnly(a));
    b.ret(add(a0, mul(a, add(add(f(1), mul(a0, w0)), mul(a0, v)))));
  },
};

// ---- __rem_pio2(x) -> (n, y0, y1): x - n*pi/2 = y0 + y1, |y0 + y1| <= pi/4 (or a little more)
const toint = 1.5 / 2 ** -52,
  invpio2 = 6.36619772367581382433e-1,
  pio2_1 = 1.57079632673412561417,
  pio2_1t = 6.07710050650619224932e-11,
  pio2_2 = 6.0771005063039659766e-11,
  pio2_2t = 2.02226624879595063154e-21,
  pio2_3 = 2.0222662487111664558e-21,
  pio2_3t = 8.47842766036889956997e-32;
const remPio2: Def = {
  params: [F64],
  results: [I32, F64, F64],
  body(b) {
    const x = b.p(0);
    const sign = b.let(wrap(shrU(bits(x), l(63n))));
    const ix = b.let(and(hi(x), i(0x7fffffff)));
    const z = b.local(F64);
    const y0 = b.local(F64);
    const y1 = b.local(F64);
    // |x| near k*pi/2 for k = 1..4, without cancellation: one subtraction of k*pi/2 in two parts
    const near = (k: number): void => {
      b.if(
        eqz(sign),
        () => {
          b.set(z, sub(x, f(k * pio2_1)));
          b.set(y0, sub(z, f(k * pio2_1t)));
          b.set(y1, sub(sub(z, y0), f(k * pio2_1t)));
          b.ret(i(k), y0, y1);
        },
        () => {
          b.set(z, add(x, f(k * pio2_1)));
          b.set(y0, add(z, f(k * pio2_1t)));
          b.set(y1, add(sub(z, y0), f(k * pio2_1t)));
          b.ret(i(-k), y0, y1);
        },
      );
    };
    b.block('medium', () => {
      b.if(leU(ix, i(0x400f6a7a)), () => {
        // |x| ~= pi/2 or 2pi/2: cancellation, so the medium case
        b.brIf('medium', eq(and(ix, i(0xfffff)), i(0x921fb)));
        b.if(
          leU(ix, i(0x4002d97c)),
          () => near(1),
          () => near(2),
        );
      });
      b.if(leU(ix, i(0x401c463b)), () => {
        b.if(
          leU(ix, i(0x4015fdbc)),
          () => {
            b.brIf('medium', eq(ix, i(0x4012d97c)));
            near(3);
          },
          () => {
            b.brIf('medium', eq(ix, i(0x401921fb)));
            near(4);
          },
        );
      });
      b.brIf('medium', ltU(ix, i(0x413921fb)));
      // large: |x| in 24-bit pieces, scaled so the first has exponent 23
      const t = b.let(double(or(and(bits(x), l((1n << 52n) - 1n)), l(BigInt(0x3ff + 23) << 52n))));
      const tx0 = b.let(toF(toI32(t)));
      b.set(t, mul(sub(t, tx0), f(2 ** 24)));
      const tx1 = b.let(toF(toI32(t)));
      b.set(t, mul(sub(t, tx1), f(2 ** 24)));
      // skip zero terms, the first term is not zero
      const nx = b.let(i(3));
      b.if(eq(t, f(0)), () => {
        b.set(nx, i(2));
        b.if(eq(tx1, f(0)), () => {
          b.set(nx, i(1));
        });
      });
      const n = b.local(I32);
      b.setAll([n, y0, y1], 'rem_pio2_large', tx0, tx1, t, sub(shrU(ix, i(20)), i(0x3ff + 23)), nx);
      b.if(sign, () => {
        b.ret(sub(i(0), n), neg(y0), neg(y1));
      });
      b.ret(n, y0, y1);
    });
    // medium: |x| ~< 2^20*(pi/2); rint(x/(pi/2)), then up to three subtractions of n*pi/2 in parts
    const fn = b.let(sub(add(mul(x, f(invpio2)), f(toint)), f(toint)));
    const n = b.let(toI32(fn));
    const r = b.let(sub(x, mul(fn, f(pio2_1))));
    const w = b.let(mul(fn, f(pio2_1t)));
    b.set(y0, sub(r, w));
    const exponent = (v: E): E => and(wrap(shrU(bits(v), l(52n))), i(0x7ff));
    const ex = b.let(shrU(ix, i(20)));
    const tt = b.local(F64);
    const again = (p: number, pt: number): void => {
      b.set(tt, r);
      b.set(w, mul(fn, f(p)));
      b.set(r, sub(tt, w));
      b.set(w, sub(mul(fn, f(pt)), sub(sub(tt, r), w)));
      b.set(y0, sub(r, w));
    };
    b.if(gt(sub(ex, exponent(y0)), i(16)), () => {
      again(pio2_2, pio2_2t);
      b.if(gt(sub(ex, exponent(y0)), i(49)), () => {
        again(pio2_3, pio2_3t);
      });
    });
    b.set(y1, sub(sub(r, y0), w));
    b.ret(n, y0, y1);
  },
};

// ---- __rem_pio2_large(x0, x1, x2, e0, nx) -> (n & 7, y0, y1), for prec 1 (double): the pieces of |x| times the
// bits of 2/pi that matter, in 24-bit integers held as doubles
const IPIO2 = [
  0xa2f983, 0x6e4e44, 0x1529fc, 0x2757d1, 0xf534dd, 0xc0db62, 0x95993c, 0x439041, 0xfe5163, 0xabdebb, 0xc561b7,
  0x246e3a, 0x424dd2, 0xe00649, 0x2eea09, 0xd1921c, 0xfe1deb, 0x1cb129, 0xa73ee8, 0x8235f5, 0x2ebb44, 0x84e99c,
  0x7026b4, 0x5f7e41, 0x3991d6, 0x398353, 0x39f49c, 0x845f8b, 0xbdf928, 0x3b1ff8, 0x97ffde, 0x05980f, 0xef2f11,
  0x8b5a0a, 0x6d1f6d, 0x367ecf, 0x27cb09, 0xb74f46, 0x3f669e, 0x5fea2d, 0x7527ba, 0xc7ebe5, 0xf17b3d, 0x0739f7,
  0x8a5292, 0xea6bfb, 0x5fb11f, 0x8d5d08, 0x560330, 0x46fc7b, 0x6babf0, 0xcfbc20, 0x9af436, 0x1da9e3, 0x91615e,
  0xe61b08, 0x659985, 0x5f14a0, 0x68408d, 0xffd880, 0x4d7327, 0x310606, 0x1556ca, 0x73a8c9, 0x60e27b, 0xc08c6b,
];
const PIO2 = [
  1.57079625129699707031, 7.54978941586159635335e-8, 5.39030252995776476554e-15, 3.28200341580791294123e-22,
  1.27065575308067607349e-29, 1.22933308981111328932e-36, 2.73370053816464559624e-44, 2.16741683877804819444e-51,
];
/** 2^n for -1022 <= n <= 1023 (scalbn's multiplier). */
const pow2 = (n: E): E => double(shl(extU(add(n, i(0x3ff))), l(52n)));
const remPio2Large: Def = {
  params: [F64, F64, F64, I32, I32],
  results: [I32, F64, F64],
  body(b) {
    const x0 = b.p(0),
      x1 = b.p(1),
      x2 = b.p(2),
      e0 = b.p(3),
      nx = b.p(4);
    // the arrays: x[3], f[20], q[20], fq[20] (doubles) and iq[20] (int32)
    const room = b.link.scratch(8 * 3 + 8 * 60 + 4 * 20);
    const X = room,
      F = room + 24,
      Q = F + 160,
      FQ = Q + 160,
      IQ = FQ + 160;
    const ipio2 = b.data(ints32(IPIO2));
    const pio2 = b.data(doubles(PIO2));
    const d = (base: number | E, k: E): E => add(typeof base === 'number' ? i(base) : base, shl(k, i(3)));
    const w4 = (base: number | E, k: E): E => add(typeof base === 'number' ? i(base) : base, shl(k, i(2)));
    const get = (base: number, k: E): E => loadF(d(base, k));
    const put = (base: number, k: E, v: E): void => b.store(d(base, k), v);
    const iqAt = (k: E): E => loadI(w4(IQ, k));
    const iqSet = (k: E, v: E): void => b.store(w4(IQ, k), v);
    b.store(i(X), x0);
    b.store(i(X), x1, 8);
    b.store(i(X), x2, 16);
    const jk = 4,
      jp = 4;
    const jx = b.let(sub(nx, i(1)));
    const jv = b.let(div(sub(e0, i(3)), i(24)));
    b.if(lt(jv, i(0)), () => {
      b.set(jv, i(0));
    });
    const q0 = b.let(sub(e0, mul(i(24), add(jv, i(1)))));
    // f[0] to f[jx+jk], where f[jx+jk] = ipio2[jv+jk]
    const k1 = b.local(I32),
      j = b.let(sub(jv, jx)),
      m = b.let(add(jx, i(jk)));
    b.set(k1, i(0));
    b.while(le(k1, m), () => {
      b.if(
        lt(j, i(0)),
        () => put(F, k1, f(0)),
        () => put(F, k1, toF(loadI(w4(ipio2, j)))),
      );
      b.set(k1, add(k1, i(1)));
      b.set(j, add(j, i(1)));
    });
    // q[k] = sum of x[j]*f[jx+k-j] for j from 0 to jx
    const fw = b.local(F64);
    const qAt = (k: E): void => {
      b.set(fw, f(0));
      b.set(j, i(0));
      b.while(le(j, jx), () => {
        b.set(fw, add(fw, mul(get(X, j), get(F, sub(add(jx, k), j)))));
        b.set(j, add(j, i(1)));
      });
      put(Q, k, fw);
    };
    b.set(k1, i(0));
    b.while(le(k1, i(jk)), () => {
      qAt(k1);
      b.set(k1, add(k1, i(1)));
    });
    const jz = b.let(i(jk));
    const z = b.local(F64),
      n = b.local(I32),
      ih = b.local(I32),
      carry = b.local(I32),
      k = b.local(I32);
    b.loop('recompute', () => {
      // distill q[] into iq[] reversingly
      b.set(k1, i(0));
      b.set(j, jz);
      b.set(z, get(Q, jz));
      b.while(gt(j, i(0)), () => {
        b.set(fw, toF(toI32(mul(f(2 ** -24), z))));
        iqSet(k1, toI32(sub(z, mul(f(2 ** 24), fw))));
        b.set(z, add(get(Q, sub(j, i(1))), fw));
        b.set(k1, add(k1, i(1)));
        b.set(j, sub(j, i(1)));
      });
      // n: z's integer part, mod 8
      b.set(z, mul(z, pow2(q0)));
      b.set(z, sub(z, mul(f(8), floor(mul(z, f(0.125))))));
      b.set(n, toI32(z));
      b.set(z, sub(z, toF(n)));
      b.set(ih, i(0));
      const last = sub(jz, i(1));
      b.if(
        gt(q0, i(0)),
        () => {
          // iq[jz-1] holds bits of n too
          b.set(k1, shrS(iqAt(last), sub(i(24), q0)));
          b.set(n, add(n, k1));
          iqSet(last, sub(iqAt(last), shl(k1, sub(i(24), q0))));
          b.set(ih, shrS(iqAt(last), sub(i(23), q0)));
        },
        () => {
          b.if(
            eqz(q0),
            () => b.set(ih, shrS(iqAt(last), i(23))),
            () =>
              b.if(ge(z, f(0.5)), () => {
                b.set(ih, i(2));
              }),
          );
        },
      );
      b.if(gt(ih, i(0)), () => {
        // the fraction is above 0.5: 1 - it
        b.set(n, add(n, i(1)));
        b.set(carry, i(0));
        b.set(k1, i(0));
        b.while(lt(k1, jz), () => {
          b.set(j, iqAt(k1));
          b.if(
            eqz(carry),
            () =>
              b.if(ne(j, i(0)), () => {
                b.set(carry, i(1));
                iqSet(k1, sub(i(0x1000000), j));
              }),
            () => iqSet(k1, sub(i(0xffffff), j)),
          );
          b.set(k1, add(k1, i(1)));
        });
        b.if(eq(q0, i(1)), () => iqSet(last, and(iqAt(last), i(0x7fffff))));
        b.if(eq(q0, i(2)), () => iqSet(last, and(iqAt(last), i(0x3fffff))));
        b.if(eq(ih, i(2)), () => {
          b.set(z, sub(f(1), z));
          b.if(ne(carry, i(0)), () => {
            b.set(z, sub(z, pow2(q0)));
          });
        });
      });
      // a fraction of 0: more terms are needed when every bit after jk is 0 too
      b.if(eq(z, f(0)), () => {
        b.set(j, i(0));
        b.set(k1, sub(jz, i(1)));
        b.while(ge(k1, i(jk)), () => {
          b.set(j, or(j, iqAt(k1)));
          b.set(k1, sub(k1, i(1)));
        });
        b.if(eqz(j), () => {
          b.set(k, i(1));
          b.while(eqz(iqAt(sub(i(jk), k))), () => {
            b.set(k, add(k, i(1)));
          });
          // add q[jz+1] to q[jz+k]
          b.set(k1, add(jz, i(1)));
          b.while(le(k1, add(jz, k)), () => {
            put(F, add(jx, k1), toF(loadI(w4(ipio2, add(jv, k1)))));
            qAt(k1);
            b.set(k1, add(k1, i(1)));
          });
          b.set(jz, add(jz, k));
          b.br('recompute');
        });
      });
    });
    // chop off zero terms, or break z into 24-bit pieces
    b.if(
      eq(z, f(0)),
      () => {
        b.set(jz, sub(jz, i(1)));
        b.set(q0, sub(q0, i(24)));
        b.while(eqz(iqAt(jz)), () => {
          b.set(jz, sub(jz, i(1)));
          b.set(q0, sub(q0, i(24)));
        });
      },
      () => {
        b.set(z, mul(z, pow2(sub(i(0), q0))));
        b.if(
          ge(z, f(2 ** 24)),
          () => {
            b.set(fw, toF(toI32(mul(f(2 ** -24), z))));
            iqSet(jz, toI32(sub(z, mul(f(2 ** 24), fw))));
            b.set(jz, add(jz, i(1)));
            b.set(q0, add(q0, i(24)));
            iqSet(jz, toI32(fw));
          },
          () => iqSet(jz, toI32(z)),
        );
      },
    );
    // the 24-bit pieces as doubles
    b.set(fw, pow2(q0));
    b.set(k1, jz);
    b.while(ge(k1, i(0)), () => {
      put(Q, k1, mul(fw, toF(iqAt(k1))));
      b.set(fw, mul(fw, f(2 ** -24)));
      b.set(k1, sub(k1, i(1)));
    });
    // fq[jz-i] = PIo2[0..jp] * q[i..jz]
    b.set(k1, jz);
    b.while(ge(k1, i(0)), () => {
      b.set(fw, f(0));
      b.set(k, i(0));
      b.while(and(le(k, i(jp)), le(k, sub(jz, k1))), () => {
        b.set(fw, add(fw, mul(loadF(d(pio2, k)), get(Q, add(k1, k)))));
        b.set(k, add(k, i(1)));
      });
      put(FQ, sub(jz, k1), fw);
      b.set(k1, sub(k1, i(1)));
    });
    // fq[] compressed into y0 + y1
    b.set(fw, f(0));
    b.set(k1, jz);
    b.while(ge(k1, i(0)), () => {
      b.set(fw, add(fw, get(FQ, k1)));
      b.set(k1, sub(k1, i(1)));
    });
    const y0 = b.let(fw);
    b.set(fw, sub(get(FQ, i(0)), fw));
    b.set(k1, i(1));
    b.while(le(k1, jz), () => {
      b.set(fw, add(fw, get(FQ, k1)));
      b.set(k1, add(k1, i(1)));
    });
    b.if(eqz(ih), () => {
      b.ret(and(n, i(7)), y0, fw);
    });
    b.ret(and(n, i(7)), neg(y0), neg(fw));
  },
};

// ---- sin, cos, tan
/** The reduction of x to y0 + y1 in [-pi/4, pi/4], and the quadrant n. */
function reduced(b: Body, x: E): [Local, Local, Local] {
  const n = b.local(I32),
    y0 = b.local(F64),
    y1 = b.local(F64);
  b.setAll([n, y0, y1], 'rem_pio2', x);
  return [n, y0, y1];
}
const small = (x: E): E => leU(and(hi(x), i(0x7fffffff)), i(0x3fe921fb));
const tiny = (x: E, below: number): E => ltU(and(hi(x), i(0x7fffffff)), i(below));
const sin: Def = {
  params: [F64],
  results: [F64],
  body(b) {
    const x = b.p(0);
    b.if(small(x), () => {
      b.if(tiny(x, 0x3e500000), () => {
        b.ret(x);
      });
      b.ret(b.call('k_sin', F64, x, f(0), i(0)));
    });
    const [n, y0, y1] = reduced(b, x);
    const q = b.let(and(n, i(3)));
    b.if(eqz(q), () => b.ret(b.call('k_sin', F64, y0, y1, i(1))));
    b.if(eq(q, i(1)), () => b.ret(b.call('k_cos', F64, y0, y1)));
    b.if(eq(q, i(2)), () => b.ret(neg(b.call('k_sin', F64, y0, y1, i(1)))));
    b.ret(neg(b.call('k_cos', F64, y0, y1)));
  },
};
const cos: Def = {
  params: [F64],
  results: [F64],
  body(b) {
    const x = b.p(0);
    b.if(small(x), () => {
      b.if(tiny(x, 0x3e46a09e), () => {
        b.ret(f(1));
      });
      b.ret(b.call('k_cos', F64, x, f(0)));
    });
    const [n, y0, y1] = reduced(b, x);
    const q = b.let(and(n, i(3)));
    b.if(eqz(q), () => b.ret(b.call('k_cos', F64, y0, y1)));
    b.if(eq(q, i(1)), () => b.ret(neg(b.call('k_sin', F64, y0, y1, i(1)))));
    b.if(eq(q, i(2)), () => b.ret(neg(b.call('k_cos', F64, y0, y1))));
    b.ret(b.call('k_sin', F64, y0, y1, i(1)));
  },
};
const tan: Def = {
  params: [F64],
  results: [F64],
  body(b) {
    const x = b.p(0);
    b.if(small(x), () => {
      // |x| < 2^-27: x itself
      b.if(tiny(x, 0x3e400000), () => {
        b.ret(x);
      });
      b.ret(b.call('k_tan', F64, x, f(0), i(0)));
    });
    const [n, y0, y1] = reduced(b, x);
    b.ret(b.call('k_tan', F64, y0, y1, and(n, i(1))));
  },
};
export const TRIG: Readonly<Record<string, Def>> = {
  k_sin: kSin,
  k_cos: kCos,
  k_tan: kTan,
  tan,
  rem_pio2: remPio2,
  rem_pio2_large: remPio2Large,
  sin,
  cos,
};
