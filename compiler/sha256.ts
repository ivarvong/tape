// compiler/sha256.ts
// SHA-256 (FIPS 180-4) of a byte array, as hex. Here so the compiler has no dependencies and stays synchronous.
export function sha256(bytes: ArrayLike<number>): string {
  const K: number[] = [],
    H: number[] = [],
    frac = (x: number): number => ((x - Math.floor(x)) * 4294967296) | 0;
  for (let n = 2; K.length < 64; n++)
    if (![...Array.from({ length: n }).keys()].slice(2).some(d => n % d === 0)) {
      if (H.length < 8) H.push(frac(Math.sqrt(n)));
      K.push(frac(Math.cbrt(n)));
    }
  const len = bytes.length,
    m = new Uint8Array(((len + 72) >> 6) << 6),
    d = new DataView(m.buffer),
    w = new Int32Array(64),
    at = (words: ArrayLike<number>, i: number): number => words[i] ?? 0,
    r = (x: number, n: number): number => (x >>> n) | (x << (32 - n));
  m.set(bytes);
  m[len] = 0x80;
  d.setUint32(m.length - 8, Math.floor(len / 536870912));
  d.setUint32(m.length - 4, len << 3);
  for (let o = 0; o < m.length; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = d.getInt32(o + 4 * i);
    for (let i = 16; i < 64; i++) {
      const s0 = at(w, i - 15),
        s1 = at(w, i - 2);
      w[i] =
        (at(w, i - 16) + (r(s0, 7) ^ r(s0, 18) ^ (s0 >>> 3)) + at(w, i - 7) + (r(s1, 17) ^ r(s1, 19) ^ (s1 >>> 10))) |
        0;
    }
    let [a = 0, b = 0, c = 0, e4 = 0, e = 0, f = 0, g = 0, h = 0] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + at(K, i) + at(w, i)) | 0,
        t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g;
      g = f;
      f = e;
      e = (e4 + t1) | 0;
      e4 = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    [a, b, c, e4, e, f, g, h].forEach((x, i) => {
      H[i] = (at(H, i) + x) | 0;
    });
  }
  return H.map(x => (x >>> 0).toString(16).padStart(8, '0')).join('');
}
