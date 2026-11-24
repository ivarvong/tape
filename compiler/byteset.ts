// compiler/byteset.ts: a set of bytes as 32 bytes, bit b of byte b >> 3. scan and scan_plain share it
// (compiler/gen/scan.ts, the interpreter): the same bit means the same member in both.
/** 32 bytes. Bit `b & 7` of byte `b >> 3` is set when byte `b` is a member. */
export type ByteSet = readonly number[];

/** The set of these bytes. A byte outside 0..255 is not a member. The same byte twice is one member. */
export function byteSet(bytes: Iterable<number>): ByteSet {
  const m = Array.from({ length: 32 }, () => 0);
  for (const b of bytes) {
    if (b < 0 || b > 255) continue;
    const i = b >> 3;
    m[i] = (m[i] ?? 0) | (1 << (b & 7));
  }
  return m;
}

/** Whether byte `b` is in the set. A `b` outside 0..255 is not. */
export function hasByte(set: ByteSet, b: number): boolean {
  if (b < 0 || b > 255) return false;
  return ((set[b >> 3] ?? 0) & (1 << (b & 7))) !== 0;
}

/** The members, in order from 0. */
export function bytesIn(set: ByteSet): number[] {
  const out: number[] = [];
  for (let b = 0; b < 256; b++) if (hasByte(set, b)) out.push(b);
  return out;
}

export function sameSet(a: ByteSet, b: ByteSet): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

// below 32, 128 or more, a quote (34) or a backslash (92): where a JSON string's plain run ends
const jsonBytes = (): number[] => {
  const xs: number[] = [];
  for (let b = 0; b < 32; b++) xs.push(b);
  for (let b = 128; b < 256; b++) xs.push(b);
  xs.push(34, 92);
  return xs;
};

/** The bytes `scan_plain` stops on. One instance of the set `scan` takes. */
export const JSON_PLAIN: ByteSet = byteSet(jsonBytes());
