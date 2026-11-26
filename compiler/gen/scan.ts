// compiler/gen/scan.ts: scan(v, at, set) and scan_plain(v, at). One loop. `set` is a compile-time byte set
// (compiler/byteset.ts); scan_plain is that loop for JSON_PLAIN, whose bytes a text literal cannot spell.
//
// 16 bytes at a time when the set is JSON_PLAIN (one signed compare covers the control bytes and those of 128 or
// more) or has at most 16 members (one compare each). Any other set is a 32-byte bit table, one byte at a time.
// The answer is the same either way.
//
// Steps, when the build counts them: one per 16 bytes read, rounded up. A read is every byte from `at` through the
// one it stops on, or from `at` to the end when none is in the set. `at` equal to the length reads nothing. The
// count is added before the result is given, and a count past the limit stops the request (trap 2), as an entry
// into a recursive function does. The amount is computed, so it is not the entry compiler/gen/meter.ts rewrites
// into a local: that rewrite matches only `global.get` of the cost, `i64.const 1`, `i64.add`, `global.set`.
import type { Ctx } from './fn.ts';
import { close, fresh, get, open, set, trapIf } from './fn.ts';
import { unreachable } from '../ast.ts';
import { I32, TRAP, sleb, uleb } from '../common.ts';
import { type ByteSet, JSON_PLAIN, bytesIn, sameSet } from '../byteset.ts';

const V128 = 0x7b;
const BLOCK = [0x02, 0x40],
  LOOP = [0x03, 0x40],
  END = 0x0b;
const simd = (op: number): number[] => [0xfd, ...uleb(op)];
const i32 = (n: number): number[] => [0x41, ...sleb(n)];
const splat = (byte: number): number[] => [...i32(byte), ...simd(0x0f)];

/** How the loop tests the set. `null` is the empty set: the answer is the length, with no loop. The bytes from `at` to the end still count. */
type Kind = { k: 'json' } | { k: 'eq'; members: readonly number[] } | { k: 'bits'; at: number };

function kindOf(c: Ctx, mask: ByteSet): Kind | null {
  if (sameSet(mask, JSON_PLAIN)) return { k: 'json' };
  const members = bytesIn(mask);
  const [first] = members;
  if (first === undefined) return null;
  if (members.length <= 16) return { k: 'eq', members };
  const [at] = c.B.literal(mask);
  return { k: 'bits', at };
}

/** A v128 of the lanes whose byte is in the set. JSON_PLAIN uses a signed compare; a short set, equality. */
function stopsSimd(x: number, kind: Kind): number[] {
  switch (kind.k) {
    case 'json':
      return [
        ...get(x),
        ...splat(32),
        ...simd(0x25),
        ...get(x),
        ...splat(34),
        ...simd(0x23),
        ...simd(0x50),
        ...get(x),
        ...splat(92),
        ...simd(0x23),
        ...simd(0x50),
      ];
    case 'eq': {
      const code: number[] = [];
      kind.members.forEach((m, k) => {
        code.push(...get(x), ...splat(m), ...simd(0x23));
        if (k > 0) code.push(...simd(0x50));
      });
      return code;
    }
    case 'bits':
      return [];
    default:
      return unreachable(kind, 'scan');
  }
}

/** Nonzero when the byte in `b` is in the set. */
function stopsByte(b: number, kind: Kind): number[] {
  switch (kind.k) {
    case 'json':
      return [
        ...get(b),
        ...i32(32),
        0x49,
        ...get(b),
        ...i32(127),
        0x4b,
        0x72,
        ...get(b),
        ...i32(34),
        0x46,
        0x72,
        ...get(b),
        ...i32(92),
        0x46,
        0x72,
      ];
    case 'eq': {
      const code: number[] = [];
      kind.members.forEach((m, k) => {
        code.push(...get(b), ...i32(m), 0x46);
        if (k > 0) code.push(0x72);
      });
      return code;
    }
    case 'bits':
      // bit (b & 7) of the table's byte b >> 3, the layout of hasByte
      return [
        ...i32(kind.at),
        ...get(b),
        ...i32(3),
        0x76,
        0x6a,
        0x2d,
        0,
        0,
        ...i32(1),
        ...get(b),
        ...i32(7),
        0x71,
        0x74,
        0x71,
      ];
    default:
      return unreachable(kind, 'scan');
  }
}

/**
 * The bytes read: from `at` through the stopping byte, or from `at` to `i` when `i` is the length. One step per 16,
 * rounded up (chargeBytes).
 */
function charge(c: Ctx, at32: number, i: number, n: number): void {
  if (!c.B.opts.reductions) return;
  c.code.push(...get(i), ...get(n), 0x49);
  open(c, 0x04, [I32]);
  c.code.push(...get(i), ...get(at32), 0x6b, ...i32(1), 0x6a, 0x05, ...get(i), ...get(at32), 0x6b);
  close(c);
  chargeBytes(c);
}

/**
 * The price of a built-in that reads or writes n bytes (LANGUAGE.md section 10, step version 3): the i32 count of
 * bytes on the stack, one step per 16, rounded up, added to the step count; then a count past the limit stops the
 * request (trap 2), as an entry into a recursive function does. Taken off the stack. The amount is computed, so it
 * is not the entry compiler/gen/meter.ts rewrites into a local.
 */
export function chargeBytes(c: Ctx): void {
  if (!c.B.opts.reductions) {
    c.code.push(0x1a);
    return;
  }
  c.code.push(...i32(15), 0x6a, ...i32(4), 0x76, 0xad);
  added(c);
}

/** The i32 count of bytes on the stack, one step each: parse_float's price when the host reads its text. */
export function chargeEach(c: Ctx): void {
  if (!c.B.opts.reductions) {
    c.code.push(0x1a);
    return;
  }
  c.code.push(0xad);
  added(c);
}

/**
 * chargeBytes of a count known when the program is compiled: ceil(n / 16) steps, nothing for none. The constant comes
 * before the count it is added to, so the sequence is never the `global.get; i64.const 1; i64.add` of an entry that
 * compiler/gen/meter.ts rewrites.
 */
export function chargeKnown(c: Ctx, bytes: number): void {
  chargeSteps(c, Math.ceil(bytes / 16));
}

/** A fixed number of steps, known when the program is compiled (a host call's price), nothing for none; the
 * constant first, as chargeKnown's is. */
export function chargeSteps(c: Ctx, steps: number): void {
  if (!c.B.opts.reductions || steps === 0) return;
  c.code.push(0x42, ...sleb(steps));
  added(c);
}

/** The i64 on the stack added to the step count, then a count past the limit stops the request. */
function added(c: Ctx): void {
  c.code.push(
    0x23,
    ...uleb(c.B.G_COST),
    0x7c,
    0x24,
    ...uleb(c.B.G_COST),
    0x23,
    ...uleb(c.B.G_COST),
    0x42,
    ...sleb(c.B.opts.reductionLimit),
    0x56,
  );
  trapIf(c, TRAP.REDUCTIONS);
}

/** 16 at a time, then the tail. `br 3` from the vector loop leaves both blocks; the tail's `br_if 1` leaves the outer. */
function emitLoops(c: Ctx, p: number, n: number, i: number, kind: Kind): void {
  const b = fresh(c, I32);
  const bytes = [
    ...LOOP,
    ...get(i),
    ...get(n),
    0x4f,
    0x0d,
    1,
    ...get(p),
    ...get(i),
    0x6a,
    0x2d,
    0,
    0,
    ...set(b),
    ...stopsByte(b, kind),
    0x0d,
    1,
    ...get(i),
    ...i32(1),
    0x6a,
    ...set(i),
    0x0c,
    0,
    END,
  ];
  c.code.push(...BLOCK);
  if (kind.k !== 'bits') {
    const x = fresh(c, V128);
    const m = fresh(c, I32);
    const blocks = [
      ...LOOP,
      ...get(i),
      ...i32(16),
      0x6a,
      ...get(n),
      0x4b,
      0x0d,
      1,
      ...get(p),
      ...get(i),
      0x6a,
      ...simd(0x00),
      0,
      0,
      0x21,
      ...uleb(x),
      ...stopsSimd(x, kind),
      ...simd(0x64),
      0x22,
      ...uleb(m),
      0x04,
      0x40,
      ...get(i),
      ...get(m),
      0x68,
      0x6a,
      ...set(i),
      0x0c,
      3,
      END,
      ...get(i),
      ...i32(16),
      0x6a,
      ...set(i),
      0x0c,
      0,
      END,
    ];
    c.code.push(...BLOCK, ...blocks, END);
  }
  c.code.push(...bytes, END);
}

/**
 * The index of the first byte at or after `at` that is in `mask`, as an i64, or the length when there is none.
 * `at` above the length, unsigned (so a negative `at` too), stops the request (trap 3) before any read.
 */
export function emitByteScan(c: Ctx, p: number, n: number, at: number, mask: ByteSet): void {
  const i = fresh(c, I32);
  const at32 = fresh(c, I32);
  c.code.push(...get(at), ...get(n), 0xad, 0x56);
  trapIf(c, TRAP.BOUNDS);
  c.code.push(...get(at), 0xa7, ...set(i), ...get(i), ...set(at32));
  const kind = kindOf(c, mask);
  if (kind === null) c.code.push(...get(n), ...set(i));
  else emitLoops(c, p, n, i, kind);
  charge(c, at32, i, n);
  c.code.push(...get(i), 0xad);
}
