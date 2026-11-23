// compiler/sha256.ts
// SHA-256 (FIPS 180-4) of a byte array, as hex. Here so the compiler has no dependencies and stays synchronous.
// The round constants and the initial hash: the first 32 bits of the fractional parts of the cube roots of the first
// 64 primes, and of the square roots of the first 8. Computed once: worked out on every call, with a sieve that made
// an array per candidate, they were 13.8% of the hosted compiler's CPU in production (a profile of tape dddd2c92,
// 2026-11-23: the compiler hashes each call signature and the build).
const frac = (x: number): number => ((x - Math.floor(x)) * 4294967296) | 0;
const PRIMES: number[] = [];
for (let n = 2; PRIMES.length < 64; n++) if (PRIMES.every(p => n % p !== 0)) PRIMES.push(n);
const K: readonly number[] = PRIMES.map(p => frac(Math.cbrt(p)));
const H0: readonly number[] = PRIMES.slice(0, 8).map(p => frac(Math.sqrt(p)));

const rot = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

/** SHA-256 a part at a time: update with bytes, clone to go on from here twice, hex for the digest. */
export class Sha256 {
  #h = Int32Array.from(H0);
  #block = new Uint8Array(64);
  #view = new DataView(this.#block.buffer);
  #filled = 0;
  #length = 0;
  static #w = new Int32Array(64);

  update(bytes: ArrayLike<number>): this {
    this.#length += bytes.length;
    for (let i = 0; i < bytes.length;) {
      const n = Math.min(64 - this.#filled, bytes.length - i);
      if (bytes instanceof Uint8Array) this.#block.set(bytes.subarray(i, i + n), this.#filled);
      else for (let k = 0; k < n; k++) this.#block[this.#filled + k] = bytes[i + k] ?? 0;
      this.#filled += n;
      i += n;
      if (this.#filled === 64) {
        this.#compress();
        this.#filled = 0;
      }
    }
    return this;
  }

  clone(): Sha256 {
    const c = new Sha256();
    c.#h.set(this.#h);
    c.#block.set(this.#block);
    c.#filled = this.#filled;
    c.#length = this.#length;
    return c;
  }

  /** The digest, as hex; this hasher is spent after it. */
  hex(): string {
    const len = this.#length;
    this.update([0x80]);
    while (this.#filled !== 56) this.update([0]);
    this.#view.setUint32(56, Math.floor(len / 536870912));
    this.#view.setUint32(60, len << 3);
    this.#compress();
    return [...this.#h].map(x => (x >>> 0).toString(16).padStart(8, '0')).join('');
  }

  #compress(): void {
    const w = Sha256.#w,
      d = this.#view,
      H = this.#h,
      at = (words: ArrayLike<number>, i: number): number => words[i] ?? 0;
    for (let i = 0; i < 16; i++) w[i] = d.getInt32(4 * i);
    for (let i = 16; i < 64; i++) {
      const s0 = at(w, i - 15),
        s1 = at(w, i - 2);
      w[i] =
        (at(w, i - 16) +
          (rot(s0, 7) ^ rot(s0, 18) ^ (s0 >>> 3)) +
          at(w, i - 7) +
          (rot(s1, 17) ^ rot(s1, 19) ^ (s1 >>> 10))) |
        0;
    }
    let [a = 0, b = 0, c = 0, e4 = 0, e = 0, f = 0, g = 0, h = 0] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)) + ((e & f) ^ (~e & g)) + at(K, i) + at(w, i)) | 0,
        t2 = ((rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g;
      g = f;
      f = e;
      e = (e4 + t1) | 0;
      e4 = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    H[0] = (at(H, 0) + a) | 0;
    H[1] = (at(H, 1) + b) | 0;
    H[2] = (at(H, 2) + c) | 0;
    H[3] = (at(H, 3) + e4) | 0;
    H[4] = (at(H, 4) + e) | 0;
    H[5] = (at(H, 5) + f) | 0;
    H[6] = (at(H, 6) + g) | 0;
    H[7] = (at(H, 7) + h) | 0;
  }
}

export const sha256 = (bytes: ArrayLike<number>): string => new Sha256().update(bytes).hex();
