// compiler/gen/runtime.ts: the three functions every module has, written as Wasm instructions.
import { I32, TRAP, sleb, uleb, vec } from '../common.ts';
import { G_COST, G_HP, G_UNDO, G_WHY, trap } from './module.ts';

type Code = number | readonly number[];
const code = (...parts: Code[]): number[] => parts.flat();
const lg = (local: number): number[] => [0x20, local];
const ls = (local: number): number[] => [0x21, local];
const lt = (local: number): number[] => [0x22, local];
const gget = (global: number): number[] => [0x23, ...uleb(global)];
const gset = (global: number): number[] => [0x24, ...uleb(global)];
const i32 = (n: number): number[] => [0x41, ...sleb(n)];
const call = (fn: number): number[] => [0x10, ...uleb(fn)];
const load = (offset: number): number[] => [0x28, 2, offset];
const store = (offset: number): number[] => [0x36, 2, offset];
const IF = [0x04, 0x40],
  ELSE = 0x05,
  END = 0x0b,
  RETURN = 0x0f,
  DROP = 0x1a,
  I64_ZERO = [0x42, 0],
  EQ = 0x46,
  LT_U = 0x49,
  GT_U = 0x4b,
  LE_U = 0x4d,
  ADD = 0x6a,
  SUB = 0x6b,
  AND = 0x71,
  SHL = 0x74,
  SHR_U = 0x76,
  MEMORY_SIZE = [0x3f, 0],
  MEMORY_GROW = [0x40, 0],
  MEMORY_COPY = [0xfc, 0x0a, 0, 0];
const roundedUp = code(i32(7), ADD, i32(-8), AND);
const memoryBytes = code(MEMORY_SIZE, i32(16), SHL);

/**
 * alloc(size): round up to 8 bytes, move the arena's end forward, grow memory when the end passes it. Nothing is
 * freed; reset() moves the end back to the start for the next request. `profile`: the import a profiled build
 * reports every allocation's size to (the host reads the caller from the Wasm stack), or null.
 * Locals: 1 where the value starts, 2 where it ends.
 */
export function allocBody(profile: number | null): number[] {
  const report = profile === null ? [] : code(lg(0), call(profile));
  const span = code(gget(G_HP), ls(1), lg(1), lg(0), roundedUp, ADD, lt(2));
  const wrapped = code(lg(1), LT_U, IF, trap(TRAP.MEMORY), END);
  const pagesShort = code(lg(2), memoryBytes, SUB, i32(65535), ADD, i32(16), SHR_U);
  const refused = code(MEMORY_GROW, i32(-1), EQ, IF, trap(TRAP.MEMORY), END);
  const grown = code(lg(2), memoryBytes, GT_U, IF, pagesShort, refused, END);
  return code(vec([[2, I32]]), report, span, wrapped, grown, lg(2), gset(G_HP), lg(1), END);
}

/** reset(): the arena's end back to `heap`, the cost, the reason and the undo log cleared, the free lists emptied. */
export function resetBody(heap: number, freeLists: readonly number[]): number[] {
  const cleared = code(I64_ZERO, gset(G_COST), i32(0), gset(G_WHY), i32(0), gset(G_UNDO));
  return code(0, i32(heap), gset(G_HP), cleared, ...freeLists.map(g => code(i32(0), gset(g))), END);
}

/**
 * reserve(h, need): room for `need` more bytes in a Buf, whose header is data, len, cap. A Buf that is the last
 * thing in the arena grows where it is; any other is copied to new room. Locals: 2 len, 3 cap, 4 new cap, 5 data.
 */
export function reserveBody(alloc: number): number[] {
  const header = code(lg(0), load(4), ls(2), lg(0), load(8), ls(3));
  const fits = code(lg(2), lg(1), ADD, lg(3), LE_U, IF, RETURN, END);
  const doubled = code(lg(3), i32(1), SHL, ls(4));
  const atLeast = code(lg(4), lg(2), lg(1), ADD, LT_U, IF, lg(2), lg(1), ADD, ls(4), END);
  const rounded = code(lg(4), roundedUp, ls(4), lg(0), load(0), ls(5));
  const isLast = code(lg(5), lg(3), ADD, gget(G_HP), EQ);
  const inPlace = code(lg(4), lg(3), SUB, call(alloc), DROP);
  const moved = code(lg(0), lg(4), call(alloc), store(0), lg(0), load(0), lg(5), lg(2), MEMORY_COPY);
  const grow = code(isLast, IF, inPlace, ELSE, moved, END);
  return code(vec([[4, I32]]), header, fits, doubled, atLeast, rounded, grow, lg(0), lg(4), store(8), END);
}
