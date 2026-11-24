// fuzz/rng.ts: the one random source of the campaigns. A seed names a case: the same seed gives the same case on
// every machine and every run, so a finding is reported as its seed and can be had again.
export type Rng = {
  /** an integer from 0 up to n, not n */
  int: (n: number) => number;
  /** an integer from lo to hi, both included */
  between: (lo: number, hi: number) => number;
  /** one of the choices */
  one: <T>(xs: readonly T[]) => T;
  /** true about once in n */
  chance: (n: number) => boolean;
  /** a BigInt of up to `bits` random bits, either sign */
  big: (bits: number) => bigint;
};
/** xorshift128+ seeded by splitmix of the seed: fast, and good enough to pick cases. */
export function rng(seed: number): Rng {
  let x = BigInt.asUintN(64, BigInt(seed) * 0x9e3779b97f4a7c15n + 0x2545f4914f6cdd1dn);
  const mix = (): bigint => {
    x = BigInt.asUintN(64, x + 0x9e3779b97f4a7c15n);
    let z = x;
    z = BigInt.asUintN(64, (z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n);
    z = BigInt.asUintN(64, (z ^ (z >> 27n)) * 0x94d049bb133111ebn);
    return z ^ (z >> 31n);
  };
  let a = Number(mix() & 0xffffffffn) >>> 0 || 1,
    b = Number(mix() & 0xffffffffn) >>> 0 || 2,
    c = Number(mix() & 0xffffffffn) >>> 0 || 3,
    d = Number(mix() & 0xffffffffn) >>> 0 || 4;
  // xoshiro128** on 32-bit lanes: no BigInt on the hot path
  const next = (): number => {
    const r = Math.imul(rotl(Math.imul(b, 5), 7), 9) >>> 0;
    const t = b << 9;
    c ^= a;
    d ^= b;
    b ^= c;
    a ^= d;
    c ^= t;
    d = rotl(d, 11);
    return r;
  };
  const int = (n: number): number => (n <= 1 ? 0 : Math.floor((next() / 4294967296) * n));
  const one = <T>(xs: readonly T[]): T => {
    if (xs.length === 0) throw new Error('nothing to choose from');
    const v = xs[int(xs.length)];
    if (v === undefined) throw new Error('nothing to choose from');
    return v;
  };
  const big = (bits: number): bigint => {
    let v = 0n;
    for (let i = 0; i < bits; i += 32) v = (v << 32n) | BigInt(next());
    v &= (1n << BigInt(bits)) - 1n;
    return next() & 1 ? -v : v;
  };
  return {
    int,
    between: (lo, hi) => lo + int(hi - lo + 1),
    one,
    chance: n => int(n) === 0,
    big,
  };
}
const rotl = (v: number, k: number): number => ((v << k) | (v >>> (32 - k))) >>> 0;
