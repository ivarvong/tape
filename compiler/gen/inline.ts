// compiler/gen/inline.ts: small functions written into their callers. It runs on the module's code once every
// function is compiled, so what the compiler checks, refuses and counts is decided before it, and a program that
// does not compile is refused exactly as without it. A call of a function that is small (INLINE_LIMIT bytes of
// instructions), reaches no call of itself and does not touch the step count becomes the function's body: the
// arguments go into locals of the caller, the callee's locals become locals of the caller (shared by every body
// inlined into that caller, since one ends before the next begins, and zeroed first where the body could read one
// before writing it, as a call would find them), and the body runs in a block, so its branches to its own end and
// its `return`s leave the block. The effects, the traps and the step count are the call's: only recursive functions
// count steps, and they are never inlined (test/inline.ts compares builds with and without it). A function no
// export, table slot or remaining call reaches is left as `unreachable`. An instruction this file does not know
// leaves the module as it was.
import { sleb, uleb } from '../common.ts';

/** A function's code as compiled: its locals (runs of count and type), then its instructions, ending with `end`. */
export type Body = readonly number[];
export type Fn = { params: readonly number[]; results: readonly number[]; body: Body };
export type Inlining = {
  /** the module's functions from index `first`: the runtime's, then the program's */
  fns: readonly Fn[];
  first: number;
  /** what the host or the table can call: kept whole */
  roots: ReadonlySet<number>;
  /** functions never inlined */
  kept: ReadonlySet<number>;
  /** a block's type of several results, as a type index */
  blockSig: (results: readonly number[]) => number;
  /** the global the step count is in: a function that reads or writes it is never inlined */
  cost: number;
  /** the most code, in bytes of instructions, a function inlined may have */
  limit: number;
};

export class Unknown extends Error {}

const readU = (b: Body, i: number): [number, number] => {
  let n = 0,
    shift = 0,
    at = i;
  for (;;) {
    const x = b[at++] ?? 0;
    n += (x & 127) * 2 ** shift;
    shift += 7;
    if ((x & 128) === 0) return [n, at];
    if (at > b.length) throw new Unknown('leb past the end');
  }
};
/** readU without its pair: the value goes to `U`, the end is returned (next reads one for most instructions). */
let U = 0;
const readUv = (b: Body, i: number): number => {
  let n = 0,
    shift = 0,
    at = i;
  for (;;) {
    const x = b[at++] ?? 0;
    n += (x & 127) * 2 ** shift;
    shift += 7;
    if ((x & 128) === 0) {
      U = n;
      return at;
    }
    if (at > b.length) throw new Unknown('leb past the end');
  }
};
const skipLeb = (b: Body, i: number): number => {
  let at = i;
  while (((b[at] ?? 0) & 128) !== 0) at++;
  return at + 1;
};
const memarg = (b: Body, i: number): number => {
  const [align, at] = readU(b, i);
  return skipLeb(b, (align & 64) !== 0 ? skipLeb(b, at) : at);
};
const VALTYPES = new Set([0x7f, 0x7e, 0x7d, 0x7c, 0x7b, 0x70, 0x6f]);

type Ins = { op: number; at: number; end: number; arg: number };
/** An instruction to fill: a loop over code reuses one (next's `into`), so reading an instruction allocates nothing. */
const blank = (): Ins => ({ op: 0, at: 0, end: 0, arg: -1 });
/** Copy the bytes of `b` from `from` to `to` onto `out`: in place of out.push(...b.slice(from, to)), which made two
 * arrays an instruction (the inliner's allocation was 6-10% of a compile's; profiles of tape ff30a865, 2026-11-23). */
export const copyTo = (out: number[], b: Body, from: number, to: number): void => {
  for (let k = from; k < to; k++) out.push(b[k] ?? 0);
};
/** One instruction at `i`: its opcode (a prefixed one as 0xfc00 + sub, 0xfd00 + sub), where it ends, and its first
 * immediate when that is a local, a function, a global or a depth; written into `into` when given. */
const fill = (into: Ins, op: number, at: number, end: number, arg = -1): Ins => {
  into.op = op;
  into.at = at;
  into.end = end;
  into.arg = arg;
  return into;
};
function next(b: Body, i: number, into: Ins = blank()): Ins {
  const op = b[i] ?? -1;
  const at = i + 1;
  if (op === 0x02 || op === 0x03 || op === 0x04) {
    const t = b[at] ?? 0;
    return fill(into, op, i, t === 0x40 || VALTYPES.has(t) ? at + 1 : skipLeb(b, at));
  }
  if (op === 0x0c || op === 0x0d || op === 0x10 || op === 0x12 || (op >= 0x20 && op <= 0x26) || op === 0xd2) {
    const end = readUv(b, at);
    return fill(into, op, i, end, U);
  }
  if (op === 0x0e) {
    let [n, p] = readU(b, at);
    for (let k = 0; k <= n; k++) p = skipLeb(b, p);
    return fill(into, op, i, p);
  }
  if (op === 0x11 || op === 0x13) return fill(into, op, i, skipLeb(b, skipLeb(b, at)));
  if (op === 0x1c) {
    const [n, p] = readU(b, at);
    return fill(into, op, i, p + n);
  }
  if (op >= 0x28 && op <= 0x3e) return fill(into, op, i, memarg(b, at));
  if (op === 0x3f || op === 0x40 || op === 0xd0) return fill(into, op, i, at + 1);
  if (op === 0x41 || op === 0x42) return fill(into, op, i, skipLeb(b, at));
  if (op === 0x43) return fill(into, op, i, at + 4);
  if (op === 0x44) return fill(into, op, i, at + 8);
  if (op === 0x00 || op === 0x01 || op === 0x05 || op === 0x0b || op === 0x0f || op === 0x1a || op === 0x1b)
    return fill(into, op, i, at);
  if ((op >= 0x45 && op <= 0xc4) || op === 0xd1) return fill(into, op, i, at);
  if (op === 0xfc) {
    const [sub, p] = readU(b, at);
    const r = (end: number): Ins => fill(into, 0xfc00 + sub, i, end);
    if (sub <= 7) return r(p);
    if (sub === 8) return r(skipLeb(b, p) + 1);
    if (sub === 10) return r(p + 2);
    if (sub === 11) return r(p + 1);
    if (sub === 9 || sub === 13 || (sub >= 15 && sub <= 17)) return r(skipLeb(b, p));
    if (sub === 12 || sub === 14) return r(skipLeb(b, skipLeb(b, p)));
    throw new Unknown(`0xfc ${sub}`);
  }
  if (op === 0xfd) {
    const [sub, p] = readU(b, at);
    const r = (end: number): Ins => fill(into, 0xfd00 + sub, i, end);
    if (sub <= 11 || sub === 92 || sub === 93) return r(memarg(b, p));
    if (sub === 12 || sub === 13) return r(p + 16);
    if (sub >= 21 && sub <= 34) return r(p + 1);
    if (sub >= 84 && sub <= 91) return r(memarg(b, p) + 1);
    if (sub <= 0x113) return r(p);
    throw new Unknown(`0xfd ${sub}`);
  }
  throw new Unknown(`opcode ${op}`);
}

/** A function taken apart: the types of its locals after the parameters, and its instructions without the last end. */
export type Parsed = { params: readonly number[]; results: readonly number[]; locals: number[]; code: number[] };
export function parse(f: Fn): Parsed {
  const b = f.body;
  let [runs, p] = readU(b, 0);
  const locals: number[] = [];
  for (let r = 0; r < runs; r++) {
    const [n, q] = readU(b, p);
    const t = b[q] ?? 0;
    for (let k = 0; k < n; k++) locals.push(t);
    p = q + 1;
  }
  if (b.at(-1) !== 0x0b) throw new Unknown('no end');
  return { params: f.params, results: f.results, locals, code: b.slice(p, -1) };
}
export function bodyOf(p: Parsed): number[] {
  const runs: [number, number][] = [];
  for (const t of p.locals) {
    const last = runs.at(-1);
    if (last?.[1] === t) last[0]++;
    else runs.push([1, t]);
  }
  return [...uleb(runs.length), ...runs.flatMap(([n, t]) => [...uleb(n), t]), ...p.code, 0x0b];
}

/** Every instruction of some code, in order, to `f`: one Ins, filled again for each (what outlives a call is copied
 * out of it), so a pass over code allocates nothing per instruction. */
export function walk(code: readonly number[], f: (ins: Ins) => void): void {
  const ins = blank();
  for (let i = 0; i < code.length; i = ins.end) f(next(code, i, ins));
}

/**
 * The locals a body may read before it has written them on every path there: those it must find zeroed, as a call
 * would. A write counts where it is sure to have run: earlier in the same block, or in a block already ended that
 * nothing branched out of; a write in an `if` counts only inside that arm.
 */
function maybeUnset(p: Parsed): Set<number> {
  type Frame = { set: Set<number>; kind: number; dirty: boolean };
  const frames: Frame[] = [{ set: new Set(p.params.map((_, i) => i)), kind: 0, dirty: false }];
  const unset = new Set<number>();
  const written = (l: number): boolean => frames.some(f => f.set.has(l));
  let stopped = false;
  walk(p.code, ins => {
    const { op, arg } = ins;
    const top = frames.at(-1);
    if (stopped || !top) {
      stopped = true;
      return;
    }
    if (op === 0x20) {
      if (!written(arg)) unset.add(arg);
    } else if (op === 0x21 || op === 0x22) top.set.add(arg);
    else if (op === 0x02 || op === 0x03 || op === 0x04) frames.push({ set: new Set(), kind: op, dirty: false });
    else if (op === 0x05) top.set = new Set();
    else if (op === 0x0b) {
      frames.pop();
      const parent = frames.at(-1);
      if (parent && top.kind !== 0x04 && !top.dirty) for (const l of top.set) parent.set.add(l);
    } else if (op === 0x0c || op === 0x0d || op === 0x0e || op === 0x0f || op === 0x12 || op === 0x13)
      for (const f of frames) f.dirty = true;
  });
  return unset;
}

const zeroOf = (t: number): number[] =>
  t === 0x7e
    ? [0x42, 0]
    : t === 0x7d
      ? [0x43, 0, 0, 0, 0]
      : t === 0x7c
        ? [0x44, 0, 0, 0, 0, 0, 0, 0, 0]
        : t === 0x7b
          ? [0xfd, 12, ...Array.from({ length: 16 }, () => 0)]
          : [0x41, 0];

/** The callee's code written where `call` was, its local `l` being the caller's `local(l)`. */
function spliced(callee: Parsed, local: (l: number) => number, blockType: number[], after: number[]): number[] {
  const nlocal = callee.params.length + callee.locals.length;
  const out: number[] = [];
  for (let k = callee.params.length - 1; k >= 0; k--) out.push(0x21, ...uleb(local(k)));
  const types = [...callee.params, ...callee.locals];
  for (const l of maybeUnset(callee)) out.push(...zeroOf(types[l] ?? 0x7f), 0x21, ...uleb(local(l)));
  out.push(0x02, ...blockType);
  let depth = 0;
  walk(callee.code, ins => {
    const { op, arg } = ins;
    if (op >= 0x20 && op <= 0x22) {
      if (arg >= nlocal) throw new Unknown('local out of range');
      out.push(op, ...uleb(local(arg)));
      return;
    }
    if (op === 0x0f) {
      out.push(0x0c, ...uleb(depth));
      return;
    }
    if (op === 0x12) {
      out.push(0x10, ...uleb(arg), 0x0c, ...uleb(depth));
      return;
    }
    if (op === 0x13) {
      out.push(0x11);
      copyTo(out, callee.code, ins.at + 1, ins.end);
      out.push(0x0c, ...uleb(depth));
      return;
    }
    if (op === 0x02 || op === 0x03 || op === 0x04) depth++;
    else if (op === 0x0b) depth--;
    copyTo(out, callee.code, ins.at, ins.end);
  });
  out.push(0x0b, ...after);
  return out;
}

/** The module's functions with small ones inlined into their callers; the same functions when any is not understood. */
export function inline(m: Inlining): Body[] {
  try {
    return inlined(m);
  } catch (e) {
    if (e instanceof Unknown) return m.fns.map(f => f.body);
    throw e;
  }
}

function inlined(m: Inlining): Body[] {
  const { first } = m;
  const parsed = m.fns.map(parse);
  const at = (index: number): Parsed | undefined => parsed[index - first];
  const callees = parsed.map(p => {
    const out = new Set<number>();
    walk(p.code, ins => {
      if (ins.op === 0x10 || ins.op === 0x12) out.add(ins.arg);
    });
    return out;
  });
  const counts = parsed.map(p => {
    let touches = false;
    walk(p.code, ins => {
      if ((ins.op === 0x23 || ins.op === 0x24) && ins.arg === m.cost) touches = true;
    });
    return touches;
  });
  // a function that reaches a call of itself is never inlined
  const reachesSelf = (i: number): boolean => {
    const seen = new Set<number>();
    const stack = [...(callees[i] ?? [])];
    for (let n = stack.pop(); n !== undefined; n = stack.pop()) {
      if (n === first + i) return true;
      if (seen.has(n)) continue;
      seen.add(n);
      for (const k of callees[n - first] ?? []) stack.push(k);
    }
    return false;
  };
  const candidate = parsed.map((_, i) => !counts[i] && !m.kept.has(first + i) && !reachesSelf(i));
  // callees first, so a function inlined carries what was inlined into it
  const done = new Set<number>();
  const order: number[] = [];
  const visit = (i: number): void => {
    if (done.has(i)) return;
    done.add(i);
    for (const n of callees[i] ?? []) if (n >= first && n - first < parsed.length) visit(n - first);
    order.push(i);
  };
  parsed.forEach((_, i) => {
    visit(i);
  });
  const small = (p: Parsed): boolean => p.code.length <= m.limit;
  for (const i of order) {
    const p = parsed[i];
    if (!p) continue;
    const out: number[] = [];
    const pool = new Map<number, number[]>();
    let changed = false;
    walk(p.code, ins => {
      const target = ins.op === 0x10 || ins.op === 0x12 ? at(ins.arg) : undefined;
      if (!target || !candidate[ins.arg - first] || !small(target) || ins.arg - first === i) {
        copyTo(out, p.code, ins.at, ins.end);
        return;
      }
      // the callee's locals: the k-th of a type is the k-th of that type kept for inlined code, shared by every
      // body inlined here (one ends before the next begins)
      const seen = new Map<number, number>();
      const map = [...target.params, ...target.locals].map(t => {
        const k = seen.get(t) ?? 0;
        seen.set(t, k + 1);
        const kept = pool.get(t) ?? [];
        pool.set(t, kept);
        if (kept.length <= k) kept.push(p.params.length + p.locals.push(t) - 1);
        return kept[k] ?? 0;
      });
      const [only] = target.results;
      const bt = only === undefined ? [0x40] : target.results.length === 1 ? [only] : sleb(m.blockSig(target.results));
      for (const x of spliced(target, l => map[l] ?? 0, bt, ins.op === 0x12 ? [0x0f] : [])) out.push(x);
      changed = true;
    });
    if (changed) p.code = out;
  }
  // what is still reached from the roots; the rest is never called
  const live = new Set<number>();
  const stack = [...m.roots];
  for (let n = stack.pop(); n !== undefined; n = stack.pop()) {
    if (live.has(n) || !at(n)) continue;
    live.add(n);
    walk(at(n)?.code ?? [], ins => {
      if (ins.op === 0x10 || ins.op === 0x12) stack.push(ins.arg);
    });
  }
  return parsed.map((p, i) => (live.has(first + i) ? bodyOf(p) : [0, 0x00, 0x0b]));
}
