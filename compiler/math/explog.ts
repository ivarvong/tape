// compiler/math/explog.ts: exp, log and pow, ported from musl (src/math/exp.c log.c pow.c, with their tables in
// exp_data.c log_data.c pow_data.c, as zig 0.14.1 ships them for wasm32-wasi): the Arm optimized-routines
// versions, on their paths without fma (Wasm has none that is deterministic), with WANT_ROUNDING, no
// TOINT_INTRINSICS and no EXP_USE_TOINT_NARROW. Line for line, but for what a Float cannot be: the branches for
// an infinite or NaN argument are gone, and so are the barriers and forced evaluations that only raise a
// floating-point exception. What overflows gives an infinity, what is invalid NaN, log(0) -infinity, as musl's
// __math_oflow, __math_invalid and __math_divzero do: the caller traps on each (float not finite). What
// underflows gives 0 or -0, as __math_uflow does.
//
// Copyright (c) 2018, Arm Limited.
// SPDX-License-Identifier: MIT
import {
  F64,
  I32,
  I64,
  abs,
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
  gtU,
  hex,
  i,
  l,
  lt,
  ltU,
  loadF,
  loadL,
  mul,
  ne,
  neg,
  or,
  select,
  shl,
  shrS,
  shrU,
  sub,
  toF,
  words64,
  wrap,
} from './wasm.ts';
import type { Body, Def, E } from './wasm.ts';
import { EXP_TAB, LOG_TAB, LOG_TAB2, POW_LOG_TAB } from './tables.ts';

const u64 = (x: number): bigint => {
  const d = new DataView(new ArrayBuffer(8));
  d.setFloat64(0, x);
  return d.getBigUint64(0);
};
/** The entry k of a table of `size` bytes per entry, `offset` into it: an address. */
const entry = (base: E, k: E, size: number): E => add(base, wrap(mul(k, l(BigInt(size)))));

// __math_oflow and __math_uflow: an infinity, or 0, with the sign asked for
const oflow = (sign: E): E => select(sign, f(-Infinity), f(Infinity));
const uflow = (sign: E): E => select(sign, mul(f(-(2 ** -767)), f(2 ** -767)), mul(f(2 ** -767), f(2 ** -767)));

// ---- exp: exp(x) = 2^(k/N) * exp(r), x = ln2/N*k + r, |r| <= ln2/2N, N = 128
const N = 128;
const InvLn2N = hex('0x1.71547652b82fep0') * N,
  NegLn2hiN = hex('-0x1.62e42fefa0000p-8'),
  NegLn2loN = hex('-0x1.cf79abc9e3b3ap-47'),
  Shift = hex('0x1.8p52'),
  C2 = hex('0x1.ffffffffffdbdp-2'),
  C3 = hex('0x1.555555555543cp-3'),
  C4 = hex('0x1.55555cf172b91p-5'),
  C5 = hex('0x1.1111167a4d017p-7');
const top12 = (x: number): number => Number(u64(x) >> 52n);

/** specialcase(tmp, sbits, ki) of exp.c: scale*(1+tmp) where scale's exponent may have overflowed. */
const expSpecial: Def = {
  params: [F64, I64, I64],
  results: [F64],
  body(b) {
    const tmp = b.p(0),
      sbits = b.p(1),
      ki = b.p(2);
    b.if(eqz(and(ki, l(0x80000000n))), () => {
      // k > 0, the exponent of scale might have overflowed by <= 460
      const scale = b.let(double(sub(sbits, l(1009n << 52n))));
      b.ret(mul(f(2 ** 1009), add(scale, mul(scale, tmp))));
    });
    // k < 0, need special care in the subnormal range
    const scale = b.let(double(add(sbits, l(1022n << 52n))));
    const y = b.let(add(scale, mul(scale, tmp)));
    b.if(lt(y, f(1)), () => {
      const lo = b.let(add(sub(scale, y), mul(scale, tmp)));
      const hi = b.let(add(f(1), y));
      b.set(lo, add(add(sub(f(1), hi), y), lo));
      b.set(y, sub(add(hi, lo), f(1)));
      // avoid -0.0 with downward rounding
      b.set(y, select(eq(y, f(0)), f(0), y));
    });
    b.ret(mul(f(2 ** -1022), y));
  },
};

/** The body of exp(x + xtail) with a sign, as exp.c and pow.c's exp_inline write it. */
function expBody(b: Body, x: E, xtail: E | null, signBias: E | null, special: string): void {
  const abstop = b.let(and(wrap(shrU(bits(x), l(52n))), i(0x7ff)));
  b.if(geU(sub(abstop, i(top12(2 ** -54))), i(top12(512) - top12(2 ** -54))), () => {
    b.if(geU(sub(abstop, i(top12(2 ** -54))), i(0x80000000)), () => {
      // avoid spurious underflow for tiny x
      const one = add(f(1), x);
      b.ret(signBias ? select(signBias, neg(one), one) : one);
    });
    b.if(geU(abstop, i(top12(1024))), () => {
      const sign = signBias ?? i(0);
      b.ret(select(wrap(shrU(bits(x), l(63n))), uflow(sign), oflow(sign)));
    });
    // large x is special cased below
    b.set(abstop, i(0));
  });
  const z = b.let(mul(f(InvLn2N), x));
  const kd = b.let(add(z, f(Shift)));
  const ki = b.let(bits(kd));
  b.set(kd, sub(kd, f(Shift)));
  const r = b.let(add(add(x, mul(kd, f(NegLn2hiN))), mul(kd, f(NegLn2loN))));
  if (xtail) b.set(r, add(r, xtail));
  const tab = b.data(words64(EXP_TAB));
  const at = b.let(entry(tab, and(ki, l(BigInt(N - 1))), 16));
  const top = shl(signBias ? add(ki, extU(signBias)) : ki, l(52n - 7n));
  const tail = b.let(double(loadL(at)));
  const sbits = b.let(add(loadL(at, 8), top));
  const r2 = b.let(mul(r, r));
  const tmp = b.let(
    add(add(add(tail, r), mul(r2, add(f(C2), mul(r, f(C3))))), mul(mul(r2, r2), add(f(C4), mul(r, f(C5))))),
  );
  b.if(eqz(abstop), () => {
    b.ret(b.call(special, F64, tmp, sbits, ki));
  });
  const scale = b.let(double(sbits));
  b.ret(add(scale, mul(scale, tmp)));
}

const exp: Def = {
  params: [F64],
  results: [F64],
  body(b) {
    expBody(b, b.p(0), null, null, 'exp_special');
  },
};

// ---- log: log(x) = k*ln2 + log(c) + log1p(z/c - 1), x = 2^k z, z in [OFF, 2*OFF)
const Ln2hi = hex('0x1.62e42fefa3800p-1'),
  Ln2lo = hex('0x1.ef35793c76730p-45');
const A = [
  '-0x1.0000000000001p-1',
  '0x1.555555551305bp-2',
  '-0x1.fffffffeb459p-3',
  '0x1.999b324f10111p-3',
  '-0x1.55575e506c89fp-3',
].map(hex);
const B = [
  '-0x1p-1',
  '0x1.5555555555577p-2',
  '-0x1.ffffffffffdcbp-3',
  '0x1.999999995dd0cp-3',
  '-0x1.55555556745a7p-3',
  '0x1.24924a344de3p-3',
  '-0x1.fffffa4423d65p-4',
  '0x1.c7184282ad6cap-4',
  '-0x1.999eb43b068ffp-4',
  '0x1.78182f7afd085p-4',
  '-0x1.5521375d145cdp-4',
].map(hex);
const at = (xs: readonly number[], k: number): number => xs[k] ?? 0;
const log: Def = {
  params: [F64],
  results: [F64],
  body(b) {
    const x = b.p(0);
    const ix = b.let(bits(x));
    const top = b.let(wrap(shrU(ix, l(48n))));
    const LO = u64(1 - 2 ** -4),
      HI = u64(1 + hex('0x1.09p-4'));
    b.if(ltU(sub(ix, l(LO)), l(HI - LO)), () => {
      // close to 1.0
      b.if(eq(ix, l(u64(1))), () => {
        b.ret(f(0));
      });
      const r = b.let(sub(x, f(1)));
      const r2 = b.let(mul(r, r));
      const r3 = b.let(mul(r, r2));
      const three = (k: number, rest: E): E =>
        add(add(add(f(at(B, k)), mul(r, f(at(B, k + 1)))), mul(r2, f(at(B, k + 2)))), rest);
      const y = b.let(mul(r3, three(1, mul(r3, three(4, mul(r3, three(7, mul(r3, f(at(B, 10))))))))));
      const w = b.let(mul(r, f(2 ** 27)));
      const rhi = b.let(sub(add(r, w), w));
      const rlo = b.let(sub(r, rhi));
      b.set(w, mul(mul(rhi, rhi), f(at(B, 0))));
      const hi = b.let(add(r, w));
      const lo = b.let(add(sub(r, hi), w));
      b.set(lo, add(lo, mul(mul(f(at(B, 0)), rlo), add(rhi, r))));
      b.set(y, add(y, lo));
      b.set(y, add(y, hi));
      b.ret(y);
    });
    b.if(geU(sub(top, i(0x0010)), i(0x7ff0 - 0x0010)), () => {
      // x < 0x1p-1022 (or negative)
      b.if(eqz(shl(ix, l(1n))), () => {
        b.ret(f(-Infinity));
      });
      b.if(ne(and(top, i(0x8000)), i(0)), () => {
        b.ret(f(NaN));
      });
      // subnormal: normalize
      b.set(ix, sub(bits(mul(x, f(2 ** 52))), l(52n << 52n)));
    });
    const tmp = b.let(sub(ix, l(0x3fe6000000000000n)));
    const k = shrS(tmp, l(52n));
    const iz = b.let(sub(ix, and(tmp, l(0xfffn << 52n))));
    const idx = b.let(and(shrU(tmp, l(52n - 7n)), l(BigInt(N - 1))));
    const t = b.let(entry(b.data(words64(LOG_TAB)), idx, 16));
    const t2 = b.let(entry(b.data(words64(LOG_TAB2)), idx, 16));
    const invc = b.let(loadF(t));
    const logc = b.let(loadF(t, 8));
    const z = b.let(double(iz));
    const r = b.let(mul(sub(sub(z, loadF(t2)), loadF(t2, 8)), invc));
    const kd = b.let(toF(k));
    const w = b.let(add(mul(kd, f(Ln2hi)), logc));
    const hi = b.let(add(w, r));
    const lo = b.let(add(add(sub(w, hi), r), mul(kd, f(Ln2lo))));
    const r2 = b.let(mul(r, r));
    const inner = add(add(f(at(A, 1)), mul(r, f(at(A, 2)))), mul(r2, add(f(at(A, 3)), mul(r, f(at(A, 4))))));
    b.ret(add(add(add(lo, mul(r2, f(at(A, 0)))), mul(mul(r, r2), inner)), hi));
  },
};

// ---- pow: exp(y * log(x)), log(x) in two doubles
const POW_OFF = 0x3fe6955500000000n;
const PA = [
  hex('-0x1p-1'),
  hex('0x1.555555555556p-2') * -2,
  hex('-0x1.0000000000006p-2') * -2,
  hex('0x1.999999959554ep-3') * 4,
  hex('-0x1.555555529a47ap-3') * 4,
  hex('0x1.2495b9b4845e9p-3') * -8,
  hex('-0x1.0002b8b263fc3p-3') * -8,
];
const SIGN_BIAS = 0x800 << 7;

/** log_inline(ix) of pow.c: y and its tail, log(x) = y + tail with about 15 bits more. */
const powLog: Def = {
  params: [I64],
  results: [F64, F64],
  body(b) {
    const ix = b.p(0);
    const tmp = b.let(sub(ix, l(POW_OFF)));
    const idx = and(shrU(tmp, l(52n - 7n)), l(BigInt(N - 1)));
    const k = shrS(tmp, l(52n));
    const iz = b.let(sub(ix, and(tmp, l(0xfffn << 52n))));
    const z = b.let(double(iz));
    const kd = b.let(toF(k));
    const t = b.let(entry(b.data(words64(POW_LOG_TAB)), idx, 32));
    const invc = b.let(loadF(t));
    const logc = b.let(loadF(t, 16));
    const logctail = b.let(loadF(t, 24));
    // split z such that rhi, rlo and rhi*rhi are exact and |rlo| <= |r|
    const zhi = b.let(double(and(add(iz, l(1n << 31n)), l(-1n << 32n))));
    const zlo = b.let(sub(z, zhi));
    const rhi = b.let(sub(mul(zhi, invc), f(1)));
    const rlo = b.let(mul(zlo, invc));
    const r = b.let(add(rhi, rlo));
    const t1 = b.let(add(mul(kd, f(Ln2hi)), logc));
    const t2 = b.let(add(t1, r));
    const lo1 = b.let(add(mul(kd, f(Ln2lo)), logctail));
    const lo2 = b.let(add(sub(t1, t2), r));
    const ar = b.let(mul(f(at(PA, 0)), r));
    const ar2 = b.let(mul(r, ar));
    const ar3 = b.let(mul(r, ar2));
    const arhi = b.let(mul(f(at(PA, 0)), rhi));
    const arhi2 = b.let(mul(rhi, arhi));
    const hi = b.let(add(t2, arhi2));
    const lo3 = b.let(mul(rlo, add(ar, arhi)));
    const lo4 = b.let(add(sub(t2, hi), arhi2));
    const pair = (k2: number): E => add(f(at(PA, k2)), mul(r, f(at(PA, k2 + 1))));
    const p = b.let(mul(ar3, add(pair(1), mul(ar2, add(pair(3), mul(ar2, pair(5)))))));
    const lo = b.let(add(add(add(add(lo1, lo2), lo3), lo4), p));
    const y = b.let(add(hi, lo));
    b.ret(y, add(sub(hi, y), lo));
  },
};

/** specialcase(tmp, sbits, ki) of pow.c: as exp's, for a scale that may be negative. */
const powSpecial: Def = {
  params: [F64, I64, I64],
  results: [F64],
  body(b) {
    const tmp = b.p(0),
      sbits = b.p(1),
      ki = b.p(2);
    b.if(eqz(and(ki, l(0x80000000n))), () => {
      const scale = b.let(double(sub(sbits, l(1009n << 52n))));
      b.ret(mul(f(2 ** 1009), add(scale, mul(scale, tmp))));
    });
    b.set(sbits, add(sbits, l(1022n << 52n)));
    // sbits is the signed scale
    const scale = b.let(double(sbits));
    const y = b.let(add(scale, mul(scale, tmp)));
    b.if(lt(abs(y), f(1)), () => {
      const one = b.let(select(lt(y, f(0)), f(-1), f(1)));
      const lo = b.let(add(sub(scale, y), mul(scale, tmp)));
      const hi = b.let(add(one, y));
      b.set(lo, add(add(sub(one, hi), y), lo));
      b.set(y, sub(add(hi, lo), one));
      // fix the sign of 0
      b.set(y, select(eq(y, f(0)), double(and(sbits, l(0x8000000000000000n))), y));
    });
    b.ret(mul(f(2 ** -1022), y));
  },
};

/** exp_inline(x, xtail, sign_bias) of pow.c: sign*exp(x + xtail). */
const powExp: Def = {
  params: [F64, F64, I32],
  results: [F64],
  body(b) {
    expBody(b, b.p(0), b.p(1), b.p(2), 'pow_special');
  },
};

/** checkint(iy) of pow.c: 0 if not an integer, 1 if odd, 2 if even. */
const checkint: Def = {
  params: [I64],
  results: [I32],
  body(b) {
    const iy = b.p(0);
    const e = b.let(and(wrap(shrU(iy, l(52n))), i(0x7ff)));
    b.if(lt(e, i(0x3ff)), () => {
      b.ret(i(0));
    });
    b.if(gtU(e, i(0x3ff + 52)), () => {
      b.ret(i(2));
    });
    const bit = b.let(shl(l(1n), extU(sub(i(0x3ff + 52), e))));
    b.if(ne(and(iy, sub(bit, l(1n))), l(0n)), () => {
      b.ret(i(0));
    });
    b.if(ne(and(iy, bit), l(0n)), () => {
      b.ret(i(1));
    });
    b.ret(i(2));
  },
};

const ONE = u64(1);
const pow: Def = {
  params: [F64, F64],
  results: [F64],
  body(b) {
    const x = b.p(0),
      y = b.p(1);
    const signBias = b.let(i(0));
    const ix = b.let(bits(x));
    const iy = b.let(bits(y));
    const topx = b.let(wrap(shrU(ix, l(52n))));
    const topy = b.let(wrap(shrU(iy, l(52n))));
    const ylarge = (): E => geU(sub(and(topy, i(0x7ff)), i(0x3be)), i(0x43e - 0x3be));
    const zeroinfnan = (v: E): E => geU(sub(shl(v, l(1n)), l(1n)), l(2n * u64(Infinity) - 1n));
    b.if(or(geU(sub(topx, i(1)), i(0x7ff - 1)), ylarge()), () => {
      // y is 0 (an infinite or NaN y cannot be)
      b.if(zeroinfnan(iy), () => {
        b.ret(f(1));
      });
      b.if(zeroinfnan(ix), () => {
        // x is 0 or -0
        const x2 = b.let(mul(x, x));
        b.if(ne(shrU(ix, l(63n)), l(0n)), () => {
          b.if(eq(b.call('pow_checkint', I32, iy), i(1)), () => {
            b.set(x2, neg(x2));
          });
        });
        b.if(ne(shrU(iy, l(63n)), l(0n)), () => {
          b.ret(div(f(1), x2));
        });
        b.ret(x2);
      });
      // here x and y are non-zero finite
      b.if(ne(shrU(ix, l(63n)), l(0n)), () => {
        const yint = b.let(b.call('pow_checkint', I32, iy));
        b.if(eqz(yint), () => {
          b.ret(f(NaN));
        });
        b.if(eq(yint, i(1)), () => {
          b.set(signBias, i(SIGN_BIAS));
        });
        b.set(ix, and(ix, l(0x7fffffffffffffffn)));
        b.set(topx, and(topx, i(0x7ff)));
      });
      b.if(ylarge(), () => {
        // sign_bias is 0 here: y is not odd
        b.if(eq(ix, l(ONE)), () => {
          b.ret(f(1));
        });
        b.if(ltU(and(topy, i(0x7ff)), i(0x3be)), () => {
          // |y| < 2^-65, x^y ~= 1 + y*log(x)
          b.ret(select(gtU(ix, l(ONE)), add(f(1), y), sub(f(1), y)));
        });
        b.ret(select(eq(gtU(ix, l(ONE)), ltU(topy, i(0x800))), oflow(i(0)), uflow(i(0))));
      });
      b.if(eqz(topx), () => {
        // normalize subnormal x so its exponent becomes negative
        b.set(ix, sub(and(bits(mul(x, f(2 ** 52))), l(0x7fffffffffffffffn)), l(52n << 52n)));
      });
    });
    const hi = b.local(F64),
      lo = b.local(F64);
    b.setAll([hi, lo], 'pow_log', ix);
    const yhi = b.let(double(and(iy, l(-1n << 27n))));
    const ylo = b.let(sub(y, yhi));
    const lhi = b.let(double(and(bits(hi), l(-1n << 27n))));
    const llo = b.let(add(sub(hi, lhi), lo));
    const ehi = b.let(mul(yhi, lhi));
    const elo = b.let(add(mul(ylo, lhi), mul(y, llo)));
    b.ret(b.call('pow_exp', F64, ehi, elo, signBias));
  },
};

export const EXPLOG: Readonly<Record<string, Def>> = {
  exp,
  exp_special: expSpecial,
  log,
  pow,
  pow_log: powLog,
  pow_exp: powExp,
  pow_special: powSpecial,
  pow_checkint: checkint,
};
