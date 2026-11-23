// compiler/math/dec.ts: the exact arithmetic under Dec[s], as functions of the module in the math library's
// builder. A Dec is an Int count m of 10^-s; what a product, a quotient, a change of scale or a conversion makes of
// counts is one routine: round(x·y / (d·e)) with the 128-bit product x·y, divided exactly (Hacker's Delight 2nd ed.
// §9-4, divlu: Knuth's Algorithm D on two 32-bit digits), and rounded once by the six modes of std's Rounding
// (HalfEven 0, HalfUp 1, Down 2, Up 3, Floor 4, Ceiling 5, in the order std/core.tape declares them). The
// interpreter computes the same in BigInt (interp/dec.ts), and test/decs.ts holds both to a reference of its own.
// A result that does not fit in 64 bits stops the run (integer overflow), and so does a divisor of 0 (division by
// zero), here, where the module's trap global is set and nothing else is.
import { TRAP, sleb } from '../common.ts';
import { G_WHY } from '../gen/module.ts';
import {
  F64,
  I32,
  I64,
  add,
  and,
  bits,
  clz,
  div,
  double,
  eq,
  eqz,
  extU,
  geU,
  gtU,
  i,
  l,
  lt,
  ltU,
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
  toFU,
  wrap,
  xor,
  divU,
  remU,
} from './wasm.ts';
import type { Body, Def, E } from './wasm.ts';

const LOW = l(0xffffffffn),
  B32 = l(1n << 32n),
  K32 = l(32n);
const stop = (b: Body, code: number): void => {
  b.code.push(0x41, ...sleb(code), 0x24, G_WHY, 0x00);
};
/** |x| as an unsigned i64: the least Int's is 2^63. */
const magnitude = (x: E): E => select(lt(x, l(0n)), sub(l(0n), x), x);

/** mul128(a, b): the 128 bits of the unsigned product, high then low, from four 32-bit products. */
const MUL128: Def = {
  params: [I64, I64],
  results: [I64, I64],
  body: b => {
    const [x, y] = [b.p(0), b.p(1)];
    const x0 = b.let(and(x, LOW)),
      x1 = b.let(shrU(x, K32)),
      y0 = b.let(and(y, LOW)),
      y1 = b.let(shrU(y, K32));
    const p00 = b.let(mul(x0, y0)),
      p01 = b.let(mul(x0, y1)),
      p10 = b.let(mul(x1, y0));
    const mid = b.let(add(add(shrU(p00, K32), and(p01, LOW)), and(p10, LOW)));
    const hi = add(add(add(mul(x1, y1), shrU(p01, K32)), shrU(p10, K32)), shrU(mid, K32));
    b.ret(hi, or(shl(mid, K32), and(p00, LOW)));
  },
};

/**
 * divlu(u1, u0, v): the quotient and remainder of the unsigned 128-bit u1·2^64 + u0 by v, for u1 < v (so the
 * quotient fits in 64 bits). v is shifted until its top bit is set; each 32-bit digit of the quotient is estimated
 * from the top digits and corrected, at most twice (Knuth's Theorem B).
 */
const DIVLU: Def = {
  params: [I64, I64, I64],
  results: [I64, I64],
  body: b => {
    const [u1, u0, v0] = [b.p(0), b.p(1), b.p(2)];
    const s = b.let(clz(v0));
    const v = b.let(shl(v0, s));
    const vn1 = b.let(shrU(v, K32)),
      vn0 = b.let(and(v, LOW));
    // u0's top s bits move into un32; none when s is 0 (a shift by 64 is a shift by 0 in Wasm)
    const un32 = b.let(or(shl(u1, s), and(shrU(u0, sub(l(64n), s)), shrS(sub(l(0n), s), l(63n)))));
    const un10 = b.let(shl(u0, s));
    const un1 = b.let(shrU(un10, K32)),
      un0 = b.let(and(un10, LOW));
    /** One digit: its estimate from `top` by vn1, then corrected while it is too large. */
    const digit = (top: E, next: E): E => {
      const q = b.let(divU(top, vn1));
      const rhat = b.let(sub(top, mul(q, vn1)));
      b.loop('fix', () => {
        b.if(or(geU(q, B32), gtU(mul(q, vn0), add(shl(rhat, K32), next))), () => {
          b.set(q, sub(q, l(1n)));
          b.set(rhat, add(rhat, vn1));
          b.brIf('fix', ltU(rhat, B32));
        });
      });
      return q;
    };
    const q1 = digit(un32, un1);
    const un21 = b.let(sub(add(shl(un32, K32), un1), mul(q1, v)));
    const q0 = digit(un21, un0);
    b.ret(add(shl(q1, K32), q0), shrU(sub(add(shl(un21, K32), un0), mul(q0, v)), s));
  },
};

/**
 * finish(negative, q, half, inexact, mode): the magnitude q of a quotient truncated toward zero, made q or q + 1 as
 * the mode says, then signed. `half` is how the remainder stands to half the divisor: -1 below, 0 at, 1 above;
 * `inexact`, whether the remainder is not 0. A magnitude beyond the Ints stops the run.
 */
const FINISH: Def = {
  params: [I32, I64, I32, I32, I32],
  results: [I64],
  body: b => {
    const [negative, q, half, inexact, mode] = [b.p(0), b.p(1), b.p(2), b.p(3), b.p(4)];
    const odd = wrap(and(q, l(1n)));
    const byMode = [
      or(eq(half, i(1)), and(eqz(half), odd)), // HalfEven
      ge0(half), // HalfUp: a tie goes away from zero
      i(0), // Down
      inexact, // Up
      and(inexact, negative), // Floor
      and(inexact, eqz(negative)), // Ceiling
    ];
    const up = b.let(byMode.reduceRight((otherwise, choice, k) => select(eq(mode, i(k)), choice, otherwise)));
    const r = b.let(add(q, extU(up)));
    // past 2^63 - 1, or 2^63 for a negative result; or q + 1 wrapped to 0
    b.if(or(gtU(r, add(l(2n ** 63n - 1n), extU(negative))), and(up, eqz(r))), () => {
      stop(b, TRAP.OVERFLOW);
    });
    b.ret(select(negative, sub(l(0n), r), r));
  },
};
function ge0(x: E): E {
  return eqz(lt(x, i(0)));
}

/**
 * muldiv(x, y, d, e, mode): x·y / (d·e), exactly, rounded once as the mode says. x, y and d are signed; e is a
 * positive power of ten. When d·e is 2^64 or more, x·y must be less than it (the one use: a quotient's divisor
 * scaled up, with y = 1): the quotient is then 0 and the remainder below half the divisor.
 */
const MULDIV: Def = {
  params: [I64, I64, I64, I64, I32],
  results: [I64],
  body: b => {
    const [x, y, d, e, mode] = [b.p(0), b.p(1), b.p(2), b.p(3), b.p(4)];
    b.if(eqz(d), () => {
      stop(b, TRAP.DIVISION);
    });
    const negative = b.let(xor(xor(lt(x, l(0n)), lt(y, l(0n))), lt(d, l(0n))));
    const hi = b.local(I64),
      lo = b.local(I64),
      dh = b.local(I64),
      D = b.local(I64),
      q = b.local(I64),
      r = b.local(I64);
    b.setAll([hi, lo], 'dec_mul128', magnitude(x), magnitude(y));
    b.set(D, magnitude(d));
    b.if(ne(e, l(1n)), () => {
      b.setAll([dh, D], 'dec_mul128', D, e);
      b.if(ne(dh, l(0n)), () => {
        b.ret(b.call('dec_finish', I64, negative, l(0n), i(-1), ne(lo, l(0n)), mode));
      });
    });
    b.if(
      eqz(hi),
      () => {
        b.set(q, divU(lo, D));
        b.set(r, remU(lo, D));
      },
      () => {
        b.if(geU(hi, D), () => {
          stop(b, TRAP.OVERFLOW);
        });
        b.setAll([q, r], 'dec_divlu', hi, lo, D);
      },
    );
    const rest = b.let(sub(D, r));
    const half = select(gtU(r, rest), i(1), select(eq(r, rest), i(0), i(-1)));
    b.ret(b.call('dec_finish', I64, negative, q, half, ne(r, l(0n)), mode));
  },
};

/** The 128-bit (hi, lo) shifted right by j, 0 ≤ j ≤ 127: its low 64 bits (the caller tests the high ones). */
const shr128 = (b: Body, hi: E, lo: E, j: E): { hi: E; lo: E } => {
  const big = b.let(geU(j, l(64n)));
  // a shift by 64 - j is by 0 when j is 0, and then nothing of hi moves down
  const carried = select(eqz(j), l(0n), shl(hi, sub(l(64n), j)));
  return {
    hi: select(big, l(0n), shrU(hi, j)),
    lo: select(big, shrU(hi, sub(j, l(64n))), or(shrU(lo, j), carried)),
  };
};
/** Is any of the low j bits of (hi, lo) set, 0 ≤ j ≤ 127? */
const lowBits = (hi: E, lo: E, j: E): E => {
  const mask = (n: E): E => sub(shl(l(1n), n), l(1n));
  return select(
    geU(j, l(64n)),
    or(ne(lo, l(0n)), ne(and(hi, mask(sub(j, l(64n)))), l(0n))),
    ne(and(lo, mask(j)), l(0n)),
  );
};

/**
 * of_float(x, p, mode): the Float's exact value times p (10^t), rounded as the mode says: the count of a Dec[t].
 * x is ±M·2^E, so this is M·p·2^E: shifted left when E ≥ 0, which must fit, and right when E < 0, the bits shifted
 * out deciding the rounding (the first of them is the half; any after it make it more than half).
 */
const OF_FLOAT: Def = {
  params: [F64, I64, I32],
  results: [I64],
  body: b => {
    const [x, p, mode] = [b.p(0), b.p(1), b.p(2)];
    const u = b.let(bits(x));
    const negative = b.let(lt(u, l(0n)));
    const field = b.let(and(shrU(u, l(52n)), l(0x7ffn)));
    const fraction = and(u, l((1n << 52n) - 1n));
    const M = b.let(select(eqz(field), fraction, or(fraction, l(1n << 52n))));
    const E = b.let(sub(select(eqz(field), l(1n), field), l(1075n)));
    const hi = b.local(I64),
      lo = b.local(I64);
    b.setAll([hi, lo], 'dec_mul128', M, p);
    b.if(eqz(lt(E, l(0n))), () => {
      // the count is lo·2^E: it fits only when hi is 0 and lo is at most the largest count >> E
      const most = add(l(2n ** 63n - 1n), extU(negative));
      b.if(or(or(ne(hi, l(0n)), geU(E, l(63n))), gtU(lo, shrU(most, E))), () => {
        stop(b, TRAP.OVERFLOW);
      });
      b.ret(b.call('dec_finish', I64, negative, shl(lo, E), i(-1), i(0), mode));
    });
    const k = b.let(sub(l(0n), E));
    // 2^128 or more: below half of it, as M·p < 2^113
    b.if(geU(k, l(128n)), () => {
      b.ret(b.call('dec_finish', I64, negative, l(0n), i(-1), ne(or(hi, lo), l(0n)), mode));
    });
    const q = shr128(b, hi, lo, k);
    b.if(ne(q.hi, l(0n)), () => {
      stop(b, TRAP.OVERFLOW);
    });
    const ql = b.let(q.lo);
    const g = shr128(b, hi, lo, sub(k, l(1n)));
    const guard = b.let(wrap(and(g.lo, l(1n))));
    const sticky = b.let(lowBits(hi, lo, sub(k, l(1n))));
    const half = select(guard, select(sticky, i(1), i(0)), i(-1));
    b.ret(b.call('dec_finish', I64, negative, ql, half, or(guard, sticky), mode));
  },
};

/**
 * to_float(m, p): the Float nearest m / p (p = 10^s, exact as a double for s ≤ 18), a tie to the even one. Up to
 * 2^53 m is exact as a double, and one division rounds once. Beyond, the quotient is taken to 64 bits and more
 * (floor(|m|·2^64 / p): at least 57 bits, as |m| > 2^53 and p < 2^60) with what is left as a sticky bit in its
 * lowest place, which the conversion of 64 bits to 53 then rounds correctly (two bits or more below the 53).
 */
const TO_FLOAT: Def = {
  params: [I64, I64],
  results: [F64],
  body: b => {
    const [m, p] = [b.p(0), b.p(1)];
    const A = b.let(magnitude(m));
    b.if(or(eq(p, l(1n)), eqz(gtU(A, l(1n << 53n)))), () => {
      b.ret(div(toF(m), toF(p)));
    });
    const q1 = b.let(divU(A, p));
    const q0 = b.local(I64),
      r = b.local(I64);
    b.setAll([q0, r], 'dec_divlu', remU(A, p), l(0n), p);
    const t = b.local(I64),
      sticky = b.let(ne(r, l(0n))),
      n = b.local(I64),
      shift = b.local(I64);
    b.if(
      ne(q1, l(0n)),
      () => {
        b.set(n, clz(q1));
        b.set(t, or(shl(q1, n), select(eqz(n), l(0n), shrU(q0, sub(l(64n), n)))));
        b.set(sticky, or(sticky, ne(shl(q0, n), l(0n))));
        b.set(shift, sub(l(0n), n));
      },
      () => {
        b.set(n, clz(q0));
        b.set(t, shl(q0, n));
        b.set(shift, sub(l(-64n), n));
      },
    );
    const value = b.let(toFU(or(t, extU(sticky))));
    const scaled = mul(value, double(shl(add(l(1023n), shift), l(52n))));
    b.ret(select(lt(m, l(0n)), neg(scaled), scaled));
  },
};

export const DEC: Readonly<Record<string, Def>> = {
  dec_mul128: MUL128,
  dec_divlu: DIVLU,
  dec_finish: FINISH,
  dec_muldiv: MULDIV,
  dec_of_float: OF_FLOAT,
  dec_to_float: TO_FLOAT,
};
