// bench/suite/rand.ts: the suite's seeded random source and text codecs, with no Node imports (the workerd worker
// uses them too).
export const enc = new TextEncoder();
export const dec = new TextDecoder();

/** A seeded source of whole numbers in [lo, hi]. */
export function rng(seed: number): (lo: number, hi: number) => number {
  let s = seed >>> 0 || 1;
  return (lo, hi) => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    s ^= s >>> 16;
    return lo + Math.floor(((s >>> 0) / 2 ** 32) * (hi - lo + 1));
  };
}
