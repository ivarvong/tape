// compiler/gen/fn.ts: what one function's compilation keeps (its code, its locals, the names in scope), and the
// small emitters every part of the function compiler uses.
import type { Arg, At, Call, Expr, FnDecl, Program } from '../ast.ts';
import { showExpr } from '../../rules/origins.ts';
import { F64, I32, TRAP, f64, fail, loadOp, sleb, storeOp, uleb } from '../common.ts';
import type { Problem } from '../common.ts';
import { shadowedHint, stdName } from '../shadow.ts';
import { BUILTIN_TYPES, key, same, scaleOf } from '../types.ts';
import type { Type } from '../types.ts';
import type { Wire } from '../wire.ts';
import type { Adt, BoxedField, FlatAdt, Shape } from './layout.ts';
import type { CallGraph, Imports, Options, QueryEntry } from './module.ts';
import { G_DEPTH } from './module.ts';

/** What to write where an Int and a Float meet: there is no conversion but the one written. */
export const MIXED =
  'An Int and a Float do not mix: write a Float literal with an f (`2f`, `0.5f`), turn an Int into a Float with `float(n)`, and a Float into an Int with `trunc(x)` (toward zero; `floor(x)` or `ceil(x)` first for the other ways).';

export type Place = { readonly file?: string; readonly line?: number } | null | undefined;
/** A value already in locals. */
export type Stored = { type: Type; locals: number[] };
export type CExpr = Expr;
/** A name in scope. `mode`: whether the function may release the value or is only lent it. */
export type Binding = Stored & { name: string; mode?: 'owned' | 'borrowed'; param?: boolean };
export type Site = { kind: string; fn: string; file: string; line: number };

/** What the build gives the function compiler: the program, its layouts, and the tables functions add to. */
/** A call a program makes of another: the method, whether it carries a key, and the fingerprint both sides must share. */
export type CallDecl = { method: string; keyed: boolean; fingerprint: string };
export type Build = Imports & {
  FLAG_BASE: number;
  G_COST: number;
  G_UNDO: number;
  SIMJSON: { replies: Record<string, unknown>; decodes: Record<string, unknown> };
  WIRE: Wire;
  adtOf: (t: Type, at: Place) => Adt;
  adtOrNull: (t: Type, at: Place) => Adt | null;
  calls: CallDecl[];
  callsOf: CallGraph;
  ctors: Program['ctors'];
  find: (n: string, file: string, at?: Place) => FnDecl | null;
  fingerprint: (method: string, send: Type, reply: Type, at: Place) => string;
  flagRead: Set<string>;
  fnIndex: (n: string) => number;
  /** the function at an index of the module, once named (fnIndex); none for an import or the runtime's */
  fnAt: (index: number) => FnDecl | undefined;
  fns: Map<string, FnDecl>;
  freeList: (size: number) => number;
  isLinear: (t: Type) => boolean;
  literal: (bytes: readonly number[]) => [number, number];
  constData: (bytes: readonly number[]) => number;
  room: (size: number) => number;
  nearest: (n: string, pool: Iterable<string>) => string | null;
  opts: Options;
  orderArgs: (
    what: string,
    names: readonly string[],
    args: readonly Arg[],
    at: Place,
    hidden?: ReadonlySet<string>,
    aside?: string,
  ) => Arg[];
  prog: Program;
  queryId: (q: Omit<QueryEntry, 'run'>) => number;
  reads: (f: FnDecl, i: number) => boolean;
  recursive: Set<string>;
  resolve: (ast: Type, map?: ReadonlyMap<string, Type>) => Type;
  rowKind: (f: { type: Type }) => string | undefined;
  /** the constructors of a fieldless sum (or of the one an Option holds), stored as their texts; null for another type */
  fieldlessIn: (t: Type) => readonly string[] | null;
  rowOf: (t: Type, at: Place) => FlatAdt;
  shapeOf: (t: Type, at: Place, decoding: boolean) => Shape;
  sig: (params: readonly number[], results: readonly number[]) => number;
  sites: Site[];
  slotsOf: (t: Type, at?: Place) => number[];
  sqlFound: Problem[];
  strip: (t: Type) => Type;
  table: string[];
  trap: (code: number) => number[];
  types: Program['types'];
  walk: (e: Expr, out: Set<string>) => void;
  /** function values made so far, for their names */
  counters: { lambdas: number };
};

/** One function being compiled. `emit` writes an expression's code and gives its type. */
export type Ctx = {
  readonly B: Build;
  readonly f: FnDecl;
  readonly code: number[];
  /** the Wasm type of each local after the parameters */
  readonly locals: number[];
  readonly nparams: number;
  depth: number;
  env: Map<string, Binding>;
  /** the Bufs handed over so far */
  consumed: Set<Binding>;
  /** how the names a pattern binds hold their values, where the pattern is being matched */
  binderMode: 'owned' | 'borrowed';
  consuming: boolean;
  emit: (e: CExpr, expected: Type | null, tail: boolean) => Type;
  /** where in `code` the function's weight goes (function.ts holdLevel), once its locals are all known */
  readonly levels?: number[];
  /** the code that holds and gives back the weight, [start, end) in `code`: cut when the function is a loop */
  readonly levelSpans?: [number, number][];
};
/** A call out of the program; one made through an interface carries the type of what it sends. */
export type CallOut = Call & { sendType?: Type };

/** A function that can reach itself: its calls count steps, and hold recursion against the depth budget. */
export const isRecursive = (B: Build, f: FnDecl): boolean =>
  B.recursive.has(f.name) || (f.base !== undefined && B.recursive.has(f.base));
/** The weight's place: an i32.const of 5 bytes, filled by build.ts (levelsOf) when every function is compiled. */
export const WEIGHT_SLOT = [0x80, 0x80, 0x80, 0x80, 0x00];
export const weightAt = (c: Ctx): void => {
  c.code.push(0x41);
  c.levels?.push(c.code.length);
  c.code.push(...WEIGHT_SLOT);
};
/** The weight given back: where the function ends, and before a tail call puts another function in its place. */
export function releaseLevel(c: Ctx): void {
  if (!isRecursive(c.B, c.f)) return;
  const start = c.code.length;
  c.code.push(0x23, ...uleb(G_DEPTH));
  weightAt(c);
  c.code.push(0x6b, 0x24, ...uleb(G_DEPTH));
  c.levelSpans?.push([start, c.code.length]);
}

export const get = (l: number): number[] => [0x20, ...uleb(l)];
export const set = (l: number): number[] => [0x21, ...uleb(l)];

/** A new local of a Wasm type; its index. */
export function fresh(c: Ctx, vt: number): number {
  c.locals.push(vt);
  return c.nparams + c.locals.length - 1;
}

export const blockType = (c: Ctx, results: readonly number[]): number[] => {
  const [only] = results;
  if (only === undefined) return [0x40];
  return results.length === 1 ? [only] : sleb(c.B.sig([], results));
};
/** Opens a block, loop or if that leaves `results` on the stack. */
export function open(c: Ctx, op: number, results: readonly number[] = []): void {
  c.code.push(op, ...blockType(c, results));
  c.depth++;
}
export function close(c: Ctx): void {
  c.code.push(0x0b);
  c.depth--;
}
/** Stops with a reason if the i32 on the stack is not zero. */
export function trapIf(c: Ctx, reason: number): void {
  open(c, 0x04);
  c.code.push(...c.B.trap(reason));
  close(c);
}

/** Takes a value of a type off the stack into fresh locals. */
export function store(c: Ctx, t: Type): number[] {
  const ls = c.B.slotsOf(t).map(vt => fresh(c, vt));
  for (const l of ls.toReversed()) c.code.push(...set(l));
  return ls;
}

/** The std types whose type argument a value only holds, to be read: an `Option[Delay]` is an `Option[Int]`. */
const COVARIANT: ReadonlySet<string> = new Set(['Option', 'List', 'Result']);
/**
 * A value of `got` may stand where `want` is asked: the same type, a refinement of it (a refined type is its base
 * type at run time, and its condition holds of every value it has), or, through the type arguments of a type whose
 * values are immutable and only read, arguments that do (`Option[Delay]` where `Option[Int]` is asked; a `Result`
 * in both its arguments). A function goes the other way in what it takes: `Fn[Int, X]` stands for `Fn[Delay, X]`,
 * since every Delay is an Int, and not the reverse, which would hand a function an Int its condition was not proved
 * of. Any other type (a program's own generic type, `Map`, `Rows`, `Buf`) is the same type or nothing.
 */
export function refines(c: Ctx, got: Type, want: Type): boolean {
  if (same(got, want)) return true;
  const base = c.B.strip(got);
  if (base !== got && refines(c, base, want)) return true;
  if (got.name !== want.name || got.args.length === 0 || got.args.length !== want.args.length) return false;
  const pairs = got.args.map((g, i): [Type, Type | undefined] => [g, want.args[i]]);
  if (COVARIANT.has(got.name)) return pairs.every(([g, w]) => w !== undefined && refines(c, g, w));
  if (got.name === 'Fn' || got.name === 'Fn2') {
    const result = pairs.at(-1);
    return (
      result !== undefined &&
      result[1] !== undefined &&
      refines(c, result[0], result[1]) &&
      pairs.slice(0, -1).every(([g, w]) => w !== undefined && refines(c, w, g))
    );
  }
  return false;
}

/** The type found is the type wanted (or refines it); gives it back. */
export function need(c: Ctx, got: Type, want: Type, at: Place, what: string): Type {
  if (refines(c, got, want)) return got;
  const sh = shadowedHint(got, want);
  return fail(
    at,
    sh ? 'C76' : 'C14',
    `${what} should be ${key(want)} but is ${key(got)}`,
    sh ?? mismatchHint(c, got, want, at),
  );
}

const isExpr = (v: unknown): v is Expr => typeof v === 'object' && v !== null && 'k' in v;
/** The expression a place is, when it is an argument: how a fix can name it. */
const argText = (at: Place): string => {
  const v: unknown = at && 'value' in at ? at.value : null;
  const text = isExpr(v) ? showExpr(v) : '';
  return text === '' || text === '…' ? 'it' : text;
};
/** How to bring a Dec[from] to a Dec[to]: up is exact, down names its rounding. */
export const rescaleHint = (from: number, to: number, what = 'x'): string =>
  to > from
    ? `Make the scales equal: \`rescale(x: ${what}, to: ${to})\` adds digits, exactly.`
    : `Make the scales equal: \`round(x: ${what}, to: ${to}, rounding: HalfEven)\` drops digits, rounding as it says (or bring the other side up to ${from} with \`rescale\`).`;

/** What to write when a value of one type stands where another is wanted, for the mistakes agents make. */
function mismatchHint(c: Ctx, got: Type, want: Type, at: Place): string {
  const e = argText(at),
    inner = got.args[0];
  if (got.name === 'Option' && inner && (same(inner, want) || same(c.B.strip(inner), want)))
    return `${e === 'it' ? 'The value' : `\`${e}\``} may be None. Take the value out first, with a step that says what happens when it is None: \`let Some(value) = ${e === 'it' ? 'e' : e} else -> …\`, then pass \`value\`. Or match it, with an arm for \`Some(value)\` and one for \`None\`.`;
  if (want.name === 'Option' && want.args[0] && (same(want.args[0], got) || same(want.args[0], c.B.strip(got))))
    return `An Option is wanted: \`Some(value: ${e === 'it' ? '…' : e})\`, or \`None\`.`;
  const response = stdName(c.B.prog, 'types', 'Response');
  if (want.name === 'Buf' && got.name === response)
    return 'A Response is an answer, given last, and a Buf is the body being written before it: write into the Buf, then give it its status: `buf() |> append(view: …) |> respond(status: 200)`; or take the Response where the function is called.';
  if (want.name === response && got.name === 'Buf')
    return 'A Buf is not an answer: give it its status last, `… |> respond(status: 200)` (`respond_as(status: 200, content: Html)` for a type), or write `json(status: 200, value: …)` for a value as JSON and `empty(status: 204)` for no body.';
  if (want.name === response && !BUILTIN_TYPES.has(got.name))
    return `A Response is an answer (std/http.tape), and ${key(got)} is not: \`json(status: 200, value: …)\` answers a record as JSON, or write a function from ${key(got)} to Response.`;
  if (want.name === 'Buf' && !BUILTIN_TYPES.has(got.name))
    return `A Buf is bytes being written (\`buf()\`), and ${key(got)} is not: write the value into one first (a function from ${key(got)} to Buf, or \`write_json(out: buf(), value: …)\` for a record).`;
  if ((got.name === 'Float' && want.name === 'Int') || (got.name === 'Int' && want.name === 'Float')) return MIXED;
  const gs = scaleOf(c.B.strip(got)),
    ws = scaleOf(want);
  if (gs !== null && ws !== null) return rescaleHint(gs, ws, e === 'it' ? 'x' : e);
  if (ws !== null && got.name === 'Int')
    return `An Int is not a Dec: write the number with ${ws} digits after the point (\`${(0).toFixed(ws)}\`), or make one with \`dec(n: ${e === 'it' ? 'count' : e}, scale: ${ws})\`.`;
  if (gs !== null && want.name === 'Int')
    return `A Dec is not an Int: \`to_int(x: ${e === 'it' ? 'x' : e}, rounding: Down)\` names how to drop the digits after the point.`;
  if (ws !== null && got.name === 'Float')
    return `A Float is not a Dec: \`to_dec(x: ${e === 'it' ? 'x' : e}, scale: ${ws}, rounding: HalfEven)\` rounds its exact value.`;
  if (gs !== null && want.name === 'Float') return `A Dec is not a Float: \`float(n: ${e === 'it' ? 'x' : e})\`.`;
  if (want.name === 'View' && got.name === 'List')
    return 'A List is not text: `length(list: …)` counts it, and `write_json(value: …)` writes it.';
  return '';
}

/** A place a trace names; -1 in a build that is not traced. */
export const site = (c: Ctx, kind: string, at: At): number =>
  c.B.opts.trace ? c.B.sites.push({ kind, fn: c.f.name, file: at.file, line: at.line }) - 1 : -1;
/** Tells the trace that the place `id` was entered, tried or matched. */
export function ev(c: Ctx, id: number, what: number): void {
  if (c.B.opts.trace) c.code.push(0x41, ...sleb(id), 0x41, what, 0x10, ...uleb(c.B.TRACE_IMPORT));
}

export function declare(c: Ctx, n: string, type: Type, ls: number[], at: Place): Binding {
  if (c.env.has(n))
    fail(at, 'C15', `${n} is already defined`, 'Names are never reused in a function. Pick a new name.');
  const v: Binding = { name: n, type, locals: ls, mode: 'owned' };
  c.env.set(n, v);
  return v;
}

// Which of a type's Wasm values are pointers we can follow: a recursive type is one; a record with one
// constructor passes its fields' pointers through. A type with several constructors that is passed as plain
// values hides its pointers, so they are marked shared when it is built (emitCtor).
export function ptrSlots(c: Ctx, t: Type): number[] {
  const a = BUILTIN_TYPES.has(t.name) ? null : c.B.adtOrNull(c.B.strip(t), null);
  if (!a) return [];
  if (a.boxed) return [0];
  const [only] = a.variants;
  if (a.variants.length !== 1 || !only) return [];
  return only.fields.flatMap(fl => ptrSlots(c, fl.type).flatMap(i => fl.slots[i] ?? []));
}

// In a { check: true } build a released value's mark is set to -1, its memory is never handed out again, and
// every read or mark of it traps: any use of a value after its release is caught on the path that does it.
function checkLive(c: Ctx, ptr: number): void {
  if (!c.B.opts.check) return;
  c.code.push(...get(ptr), 0x28, 2, 4, 0x41, ...sleb(-1), 0x46);
  trapIf(c, TRAP.RELEASED);
}

/** Marks every pointer of a value as shared: something else holds it too, so it is not released or reused. */
export function mark(c: Ctx, t: Type, ls: readonly number[]): void {
  if (!c.B.opts.reuse) return;
  for (const i of ptrSlots(c, t)) {
    const l = ls[i] ?? 0;
    checkLive(c, l);
    c.code.push(...get(l), 0x41, 1, 0x36, 2, 4);
  }
}

/** Gives a value of `size` bytes back, unless it is marked shared: it heads the list of released values of its size. */
export function release(c: Ctx, ptr: number, size: number): void {
  const g = uleb(c.B.freeList(size));
  const unshared = [...get(ptr), 0x28, 2, 4, 0x45, 0x04, 0x40];
  const link = [...get(ptr), 0x23, ...g, 0x36, 2, 0];
  const done = c.B.opts.check ? [...get(ptr), 0x41, ...sleb(-1), 0x36, 2, 4] : [...get(ptr), 0x24, ...g];
  c.code.push(...unshared, ...link, ...done, 0x0b);
}

/** Room for a boxed value of `size` bytes on the stack: a released one of that size if there is one. */
function room(c: Ctx, size: number): number[] {
  const fromArena = [0x41, ...sleb(size), 0x10, ...uleb(c.B.ALLOC)];
  if (!c.B.opts.reuse) return fromArena;
  const g = uleb(c.B.freeList(size));
  const head = [0x23, ...g];
  return [...head, 0x04, 0x7f, ...head, ...head, 0x28, 2, 0, 0x24, ...g, 0x05, ...fromArena, 0x0b];
}

/** Pushes constructor `vi` of a type from its field values already in locals (flat, in field order). */
export function buildVariant(c: Ctx, adt: Adt, vi: number, ls: readonly number[]): void {
  if (adt.boxed) {
    const v = adt.variants[vi];
    if (!v) return;
    const ptr = fresh(c, I32);
    const header = [0x22, ...uleb(ptr), 0x41, ...sleb(vi), 0x36, 2, 0, ...get(ptr), 0x41, 0, 0x36, 2, 4];
    const fields = v.mem.flatMap(({ o, vt }, j) => [...get(ptr), ...get(ls[j] ?? 0), storeOp(vt), 0, ...uleb(o)]);
    c.code.push(...room(c, v.size), ...header, ...fields, ...get(ptr));
    return;
  }
  const flat = adt.variants[vi]?.flat ?? [];
  const zero = (vt: number): number[] => (vt === I32 ? [0x41, 0] : vt === F64 ? f64(0) : [0x42, 0]);
  adt.slots.forEach((vt, s) => {
    const j = flat.indexOf(s);
    if (adt.tagged && s === 0) c.code.push(0x41, ...sleb(vi));
    else c.code.push(...(j >= 0 ? get(ls[j] ?? 0) : zero(vt)));
  });
}

/** The Wasm values of one field of a boxed value, loaded into fresh locals, with no check that it is live. */
export const loadFieldUnchecked = (c: Ctx, ptr: number, fl: BoxedField): number[] =>
  fl.slots.map((o, i) => {
    const vt = fl.vts[i] ?? I32;
    const l = fresh(c, vt);
    c.code.push(...get(ptr), loadOp(vt), 0, ...uleb(o), ...set(l));
    return l;
  });
export function loadField(c: Ctx, ptr: number, fl: BoxedField): number[] {
  checkLive(c, ptr);
  return loadFieldUnchecked(c, ptr, fl);
}

/** An expression's value in locals. A plain variable is used in place. */
export function inLocals(c: Ctx, e: CExpr, expected: Type | null = null): Stored {
  const v = e.k === 'var' ? c.env.get(e.name) : undefined;
  if (v && !c.B.isLinear(v.type)) return { type: v.type, locals: v.locals };
  const type = c.emit(e, expected, false);
  return { type, locals: store(c, type) };
}

/** Runs `fn`, refusing a Buf handed over inside it. */
export function noConsume<T>(c: Ctx, at: Place, what: string, fn: () => T): T {
  const before = c.consumed.size;
  const r = fn();
  if (c.consumed.size !== before)
    fail(
      at,
      'C26',
      `a Buf cannot be handed over inside ${what}`,
      "Bind the result with `let` first, or move it into the arm's expression.",
    );
  return r;
}

/** The index of a function of the math library (compiler/math) in the module; naming it puts it among those to compile. */
export function mathIndex(B: Build, n: string): number {
  const name = `math.${n}`;
  if (!B.fns.has(name)) {
    const at = { line: 0, file: 'math' };
    const zero: Expr = { k: 'float', v: 0, ...at };
    B.fns.set(name, {
      name,
      params: [],
      retAst: { name: 'Float', args: [], ...at },
      body: { k: 'block', lets: [], result: zero, ...at },
      exported: false,
      tparams: [],
      math: n,
      ...at,
    });
  }
  return B.fnIndex(name);
}
