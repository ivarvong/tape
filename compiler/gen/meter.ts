// compiler/gen/meter.ts: the step count of a recursive function that calls nothing, held in a local while it runs.
// Such a function (a byte scan, a digit loop) counts each entry (compiler/function.ts countEntry: the count global
// plus one, then a stop past the limit) and loops by calling itself as its result, a branch back to its start, so
// it read and wrote the global on every round. Now it reads the global once when it is entered, counts and
// compares in a local, and writes the local back where the count can be seen: before it stops (`unreachable`, so a
// trap leaves the exact count) and before it ends. Nothing else runs while it does, since it calls nothing. A
// function with an instruction that stops the module without an `unreachable` of its own (integer division and
// remainder, the float truncations that trap) or with a `return` is left as it is, and so is any function when an
// instruction is not known. The counts are the same at every point anything can see them (test/inline.ts).
import { uleb } from '../common.ts';
import { Unknown, bodyOf, each, parse } from './inline.ts';
import type { Body, Fn } from './inline.ts';

/** i32/i64 div and rem, and the float truncations that trap: they stop the module with no `unreachable` first. */
const ALONE = new Set([0x6d, 0x6e, 0x6f, 0x70, 0x7f, 0x80, 0x81, 0x82, 0xa8, 0xa9, 0xaa, 0xab, 0xae, 0xaf, 0xb0, 0xb1]);
/** what ends the function or leaves it for another: calls, tail calls, `return` */
const LEAVES = new Set([0x0f, 0x10, 0x11, 0x12, 0x13]);

/** The bodies, with each function that counts its entries and calls nothing counting in a local. */
export function meter(fns: readonly Fn[], cost: number): Body[] {
  try {
    return fns.map(f => metered(f, cost) ?? f.body);
  } catch (e) {
    if (e instanceof Unknown) return fns.map(f => f.body);
    throw e;
  }
}

function metered(f: Fn, cost: number): number[] | null {
  const p = parse(f);
  const ins = [...each(p.code)];
  const g = (k: number, op: number): boolean => ins[k]?.op === op && ins[k]?.arg === cost;
  // the entry count: global.get cost; i64.const 1; i64.add; global.set cost; global.get cost (then the limit)
  const at = ins.findIndex((_, k) => g(k, 0x23) && ins[k + 2]?.op === 0x7c && g(k + 3, 0x24) && g(k + 4, 0x23));
  if (at < 0) return null;
  const touches = ins.filter(x => (x.op === 0x23 || x.op === 0x24) && x.arg === cost).length;
  if (touches !== 3 || ins.some(x => ALONE.has(x.op) || LEAVES.has(x.op))) return null;
  const n = p.params.length + p.locals.push(0x7e) - 1;
  const flush = [0x20, ...uleb(n), 0x24, ...uleb(cost)];
  const out: number[] = [0x23, ...uleb(cost), 0x21, ...uleb(n)];
  let depth = 0;
  ins.forEach((x, k) => {
    const bytes = p.code.slice(x.at, x.end);
    if (k === at || k === at + 4) out.push(0x20, ...uleb(n));
    else if (k === at + 3) out.push(0x21, ...uleb(n));
    // a stop, a branch that may leave the function, and a table of branches (any of which may)
    else if (x.op === 0x00 || ((x.op === 0x0c || x.op === 0x0d) && x.arg === depth) || x.op === 0x0e)
      out.push(...flush, ...bytes);
    else out.push(...bytes);
    if (x.op === 0x02 || x.op === 0x03 || x.op === 0x04) depth++;
    else if (x.op === 0x0b) depth--;
  });
  out.push(...flush);
  return bodyOf({ ...p, code: out });
}
