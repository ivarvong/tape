// compiler/common.ts: what every part of the compiler uses: the limits and trap codes of a build, the error a
// compile stops with, and the encodings of the Wasm binary format.
export const I32 = 0x7f,
  I64 = 0x7e,
  F64 = 0x7c;
// DIVISION: by zero. OVERFLOW: an Int result that does not fit in 64 bits. SHIFT: a shift amount outside 0..63.
// FLOAT: a Float operation whose result would be NaN or infinite.
export const TRAP = {
  MEMORY: 1,
  REDUCTIONS: 2,
  BOUNDS: 3,
  DIVISION: 4,
  RELEASED: 5,
  OVERFLOW: 6,
  SHIFT: 7,
  FLOAT: 8,
} as const;
/** Which f64 load and store, i64, or i32 a value of a Wasm type takes in memory (8 bytes each in the arena). */
export const loadOp = (vt: number): number => (vt === F64 ? 0x2b : vt === I64 ? 0x29 : 0x28);
export const storeOp = (vt: number): number => (vt === F64 ? 0x39 : vt === I64 ? 0x37 : 0x36);
/** An f64 constant's instruction. */
export const f64 = (x: number): number[] => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, x, true);
  return [0x44, ...b];
};
/** A Dec literal as written: its digits m with s of them after the point (1230 and 2 are `12.30`). */
export const decText = (m: bigint, s: number): string => {
  const digits = (m < 0n ? -m : m).toString().padStart(s + 1, '0');
  const whole = digits.slice(0, digits.length - s);
  return `${m < 0n ? '-' : ''}${whole}${s > 0 ? `.${digits.slice(digits.length - s)}` : ''}`;
};
// trace: emit an event for every function entered and every arm or step tried and matched (for replay traces).
export const DEFAULTS = {
  pin: {},
  trace: false,
  profile: false,
  check: false,
  reuse: !(typeof process !== 'undefined' && process.env?.TAPE_REUSE === '0'),
  pages: 1024,
  reductionLimit: 50_000_000,
  reductions: true,
  tailCalls: true,
  // small functions written into their callers (compiler/gen/inline.ts)
  inline: true,
  // a recursive function that calls nothing counts its steps in a local (compiler/gen/meter.ts)
  localSteps: true,
  exports: ['handle'],
  rules: true,
};

/** What a compile stops with: a code (C77, P01, …), where, what is wrong, and what to write instead. */
export type Problem = { code: string; file: string; line: number; message: string; hint: string };
export class CompileError extends Error {
  readonly info: Problem;
  /** every problem found, when more than one is reported */
  readonly all: Problem[] | null;
  constructor(info: Problem, all: Problem[] | null = null) {
    super(info.message);
    this.info = info;
    this.all = all;
  }
}
export const fail = (
  at: { file?: string; line?: number } | null | undefined,
  code: string,
  message: string,
  hint = '',
): never => {
  throw new CompileError({ code, file: at?.file ?? '', line: at?.line ?? 0, message, hint });
};

export const uleb = (n: number): number[] => {
  const o: number[] = [];
  do {
    let b = n & 127;
    n >>>= 7;
    if (n) b |= 128;
    o.push(b);
  } while (n);
  return o;
};
export const sleb = (v: number | bigint): number[] => {
  let n = BigInt(v);
  const o: number[] = [];
  for (;;) {
    const b = Number(n & 127n);
    n >>= 7n;
    if ((n === 0n && !(b & 64)) || (n === -1n && b & 64)) {
      o.push(b);
      return o;
    }
    o.push(b | 128);
  }
};
export const utf8 = (s: string): number[] => [...new TextEncoder().encode(s)];
export const stemOf = (file: string): string => file.replace(/^.*\//, '').replace(/\.tape$/, '');
export const vec = (items: (number | number[])[]): number[] => [...uleb(items.length), ...items.flat()];
export const name = (s: string): number[] => {
  const b = utf8(s);
  return [...uleb(b.length), ...b];
};
export const section = (id: number, body: number[]): number[] => [id, ...uleb(body.length), ...body];
