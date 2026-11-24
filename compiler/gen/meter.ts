// compiler/gen/meter.ts: the step count of a recursive function that calls nothing, held in a local while it runs.
// Such a function (a byte scan, a digit loop) counts each entry (compiler/function.ts countEntry: the count global
// plus one, then a stop past the limit) and loops by calling itself as its result, a branch back to its start, so
// it read and wrote the global on every round. Now it reads the global once when it is entered, counts and
// compares in a local, and writes the local back where the count can be seen: before it stops (`unreachable`, so a
// trap leaves the exact count) and before it ends. Nothing else runs while it does, since it calls nothing. A
// function with an instruction that stops the module without an `unreachable` of its own (integer division and
// remainder, the float truncations that trap) or with a `return` is left as it is, and so is any function when an
// instruction is not known. The counts are the same at every point anything can see them (test/inline.ts). A change
// that makes them differ is a new step version (compiler/step-version.ts).
import { uleb } from '../common.ts';
import { Unknown, bodyOf, copyTo, parse, walk } from './inline.ts';
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
  // each instruction's opcode, first immediate, start and end, in arrays of numbers: an object an instruction made
  // the meter most of what reading code allocated after the inliner stopped (2026-11-23)
  const ops: number[] = [],
    args: number[] = [],
    starts: number[] = [],
    ends: number[] = [];
  walk(p.code, x => {
    ops.push(x.op);
    args.push(x.arg);
    starts.push(x.at);
    ends.push(x.end);
  });
  const g = (k: number, op: number): boolean => ops[k] === op && args[k] === cost;
  // the entry count: global.get cost; i64.const 1; i64.add; global.set cost; global.get cost (then the limit)
  const at = ops.findIndex((_, k) => g(k, 0x23) && ops[k + 2] === 0x7c && g(k + 3, 0x24) && g(k + 4, 0x23));
  if (at < 0) return null;
  const touches = ops.filter((op, k) => (op === 0x23 || op === 0x24) && args[k] === cost).length;
  if (touches !== 3 || ops.some(op => ALONE.has(op) || LEAVES.has(op))) return null;
  const n = p.params.length + p.locals.push(0x7e) - 1;
  const flush = [0x20, ...uleb(n), 0x24, ...uleb(cost)];
  const out: number[] = [0x23, ...uleb(cost), 0x21, ...uleb(n)];
  let depth = 0;
  ops.forEach((op, k) => {
    const arg = args[k] ?? -1,
      from = starts[k] ?? 0,
      to = ends[k] ?? 0;
    if (k === at || k === at + 4) out.push(0x20, ...uleb(n));
    else if (k === at + 3) out.push(0x21, ...uleb(n));
    // a stop, a branch that may leave the function, and a table of branches (any of which may)
    else if (op === 0x00 || ((op === 0x0c || op === 0x0d) && arg === depth) || op === 0x0e) {
      out.push(...flush);
      copyTo(out, p.code, from, to);
    } else copyTo(out, p.code, from, to);
    if (op === 0x02 || op === 0x03 || op === 0x04) depth++;
    else if (op === 0x0b) depth--;
  });
  out.push(...flush);
  return bodyOf({ ...p, code: out });
}
