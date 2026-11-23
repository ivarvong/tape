// compiler/gen/layout.ts: what each type is at run time. A type's values are Wasm values (its slots); a type that
// can contain itself is boxed, and its values are pointers into the arena.
import type { Program, TypeAst, TypeDecl } from '../ast.ts';
import { F64, I32, I64, fail } from '../common.ts';
import { BUILTIN_TYPES, CAPABILITIES, T, key } from '../types.ts';
import type { Type } from '../types.ts';
import type { Wire, WireKind } from '../wire.ts';

/** Where a type was written, when the thing at hand says (a type made by the compiler does not). */
type Place = object | null | undefined;
const where = (at: Place): { file: string; line: number } | null =>
  at && 'line' in at && typeof at.line === 'number'
    ? { line: at.line, file: 'file' in at && typeof at.file === 'string' ? at.file : '' }
    : null;
const refuse = (at: Place, code: string, message: string, hint: string): never => fail(where(at), code, message, hint);
/** A field of an unboxed type: which of the type's slots hold it. */
export type FlatField = { name: string; type: Type; slots: number[] };
export type FlatVariant = { name: string; fields: FlatField[]; flat: number[] };
/** A field of a boxed type: its Wasm types, and the offset of each from the pointer. */
export type BoxedField = { name: string; type: Type; vts: number[]; slots: number[] };
export type BoxedVariant = { name: string; fields: BoxedField[]; size: number; mem: { o: number; vt: number }[] };
/** A type with its arguments given. `tagged`: it has several constructors, so its first slot says which. */
export type FlatAdt = {
  type: Type;
  decl: TypeDecl;
  tagged: boolean;
  boxed?: undefined;
  slots: number[];
  variants: FlatVariant[];
};
export type BoxedAdt = {
  type: Type;
  decl: TypeDecl;
  tagged: boolean;
  boxed: true;
  slots: number[];
  variants: BoxedVariant[];
};
export type Adt = FlatAdt | BoxedAdt;
/** What a JSON value or a column is: i Int, b Bool, t text. */
export type FieldKind = { name: string; kind: string; optional: boolean };
export type Shape = { variants: FieldKind[][] };
/** A message through its nested records and lists, for fingerprints. */
export type Described = { kind?: string | undefined; optional?: boolean; of?: Described | { variants: unknown[] } };

export type Layouts = {
  readonly prog: Program;
  readonly wire: Wire;
  readonly adts: Map<string, Adt>;
  readonly building: Set<string>;
};

/** The names a type mentions, itself included. */
const names = (t: TypeAst | Type, out: Set<string>): Set<string> => {
  out.add(t.name);
  for (const a of t.args) names(a, out);
  return out;
};

/** Marks every type that can contain itself as boxed, and gives the tables its layouts are kept in. */
export function layouts(prog: Program, wire: Wire): Layouts {
  const uses = new Map(
    [...prog.types.values()].map((d): [string, Set<string>] => {
      const used = new Set<string>();
      for (const v of d.variants) for (const f of v.fields) names(f.type, used);
      return [d.name, used];
    }),
  );
  const into = (from: string, target: string, seen = new Set<string>()): boolean =>
    [...(uses.get(from) ?? [])].some(n => n === target || (!seen.has(n) && (seen.add(n), into(n, target, seen))));
  for (const d of prog.types.values()) d.boxed = into(d.name, d.name);
  return { prog, wire, adts: new Map(), building: new Set() };
}

export const subst = (t: Type, map: ReadonlyMap<string, Type>): Type =>
  (t.args.length === 0 ? map.get(t.name) : undefined) ?? { name: t.name, args: t.args.map(a => subst(a, map)) };

/** A type as written, with its parameters given: checked to exist and to be laid out. */
export function resolve(L: Layouts, ast: Type, map: ReadonlyMap<string, Type> = new Map()): Type {
  const t = subst(ast, map);
  slotsOf(L, t, ast);
  return t;
}

const FIXED: Readonly<Record<string, readonly number[]>> = {
  Int: [I64],
  Float: [F64],
  Bool: [I32],
  Buf: [I32],
  Remote: [I32],
  Remotes: [I32],
  // which function, and the values it captured
  Fn: [I32, I32],
  Fn2: [I32, I32],
  View: [I32, I32],
  Sql: [],
  Clock: [],
  Entropy: [],
  Timer: [],
};

/** The Wasm values a value of the type is. */
export function slotsOf(L: Layouts, t: Type, at: Place): number[] {
  if (L.prog.interfaces.has(t.name)) return [I32]; // a capability: which one the host bound
  const fixed = Object.hasOwn(FIXED, t.name) ? FIXED[t.name] : undefined;
  if (fixed) return [...fixed];
  if (t.name === 'Rows') {
    const row = t.args.length === 1 ? t.args[0] : undefined;
    rowOf(
      L,
      row ??
        refuse(
          at,
          'C05',
          'Rows takes one type, for example Rows[Todo]',
          'Name the row type in the brackets: `Rows[Todo]`.',
        ),
      at,
    );
    return [I32, I32];
  }
  return L.prog.types.get(t.name)?.refine ? slotsOf(L, strip(L, t), at) : adtOf(L, t, at).slots;
}

/** A refined type is its base type at run time. */
export function strip(L: Layouts, t: Type): Type {
  const d = L.prog.types.get(t.name);
  return d?.refine ? resolve(L, d.refine.base) : t;
}

export const adtOrNull = (L: Layouts, t: Type, at: Place): Adt | null =>
  BUILTIN_TYPES.has(t.name) || L.prog.types.get(t.name)?.refine ? null : adtOf(L, t, at);

/** The name nearest to n among those of the pool, when one is near enough to be what was meant. */
export function nearest(n: string, pool: Iterable<string>): string | null {
  let best: string | null = null;
  let least = 3;
  for (const c of pool) {
    const d = distance(n, c);
    if (d < least) [least, best] = [d, c];
  }
  return best;
}
function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++)
      next.push(
        Math.min((row[j] ?? 0) + 1, (next[j - 1] ?? 0) + 1, (row[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1)),
      );
    row = next;
  }
  return row[b.length] ?? 0;
}

function declOf(L: Layouts, t: Type, at: Place): TypeDecl {
  const { types } = L.prog;
  const suggestion = (): string => {
    const n = nearest(t.name, [...types.keys(), ...BUILTIN_TYPES]);
    return n ? `Did you mean \`${n}\`?` : '';
  };
  const decl = types.get(t.name) ?? refuse(at, 'C06', `unknown type ${t.name}`, suggestion());
  if (decl.params.length !== t.args.length)
    refuse(
      at,
      'C05',
      `type ${decl.name} takes ${decl.params.length} type argument${decl.params.length === 1 ? '' : 's'}, not ${t.args.length}`,
      decl.params.length > 0
        ? `Write ${decl.name}[${decl.params.join(', ')}] with a type for each.`
        : `${decl.name} takes no type arguments: write ${decl.name} alone.`,
    );
  return decl;
}

function banned(ft: Type, f: { name: string; type: TypeAst }): void {
  if (ft.name !== 'Buf' && !CAPABILITIES.includes(ft.name)) return;
  refuse(
    f.type,
    'C08',
    `field ${f.name} cannot have type ${ft.name}`,
    ft.name === 'Buf'
      ? 'A Buf has one owner at a time, so it is passed and returned, never stored. To write a list as JSON, `write_json(value: list)` (`map` it into a record type first for computed items); for other text, hand the Buf from item to item with `write_each(list, by: fn(out: Buf, item: Line) -> Buf { … })`; fold the list again for a total.'
      : 'A capability is passed as a parameter, so every call that uses it names it.',
  );
}

// memory layout: i32 constructor index, then 8 bytes per Wasm value of each field
function boxed(L: Layouts, t: Type, decl: TypeDecl, map: ReadonlyMap<string, Type>): BoxedAdt {
  const adt: BoxedAdt = { type: t, decl, tagged: decl.variants.length > 1, boxed: true, slots: [I32], variants: [] };
  L.adts.set(key(t), adt);
  adt.variants = decl.variants.map(v => {
    let off = 8;
    const fields = v.fields.map(f => {
      const ft = subst(f.type, map);
      banned(ft, f);
      const vts = slotsOf(L, ft, f.type);
      const slots = vts.map((_, i) => off + 8 * i);
      off += 8 * vts.length;
      return { name: f.name, type: ft, vts, slots };
    });
    const mem = fields.flatMap(f => f.slots.map((o, i) => ({ o, vt: f.vts[i] ?? I32 })));
    return { name: v.name, fields, size: off, mem };
  });
  return adt;
}

/** The slot a field's value takes: the nth slot of its Wasm type, shared across constructors, or a new one. */
function slotFor(slots: number[], vt: number, nth: number, first: number): number {
  let seen = 0;
  for (let s = first; s < slots.length; s++) if (slots[s] === vt && seen++ === nth) return s;
  slots.push(vt);
  return slots.length - 1;
}

function flat(L: Layouts, t: Type, decl: TypeDecl, map: ReadonlyMap<string, Type>): FlatAdt {
  const k = key(t);
  if (L.building.has(k))
    refuse(
      decl,
      'C07',
      `type ${k} contains itself`,
      'A type cannot hold itself directly. Put the recursive field in a constructor beside one that ends it, as List has Cons(head, tail) and Nil.',
    );
  L.building.add(k);
  const tagged = decl.variants.length > 1;
  const slots: number[] = tagged ? [I32] : [];
  const variants = decl.variants.map(v => {
    const used = new Map<number, number>();
    const fields = v.fields.map(f => {
      const ft = subst(f.type, map);
      banned(ft, f);
      const idx = slotsOf(L, ft, f.type).map(vt => {
        const nth = used.get(vt) ?? 0;
        used.set(vt, nth + 1);
        return slotFor(slots, vt, nth, tagged ? 1 : 0);
      });
      return { name: f.name, type: ft, slots: idx };
    });
    return { name: v.name, fields, flat: fields.flatMap(f => f.slots) };
  });
  L.building.delete(k);
  const adt: FlatAdt = { type: t, decl, tagged, slots, variants };
  L.adts.set(k, adt);
  return adt;
}

/** The layout of a declared type with these arguments. */
export function adtOf(L: Layouts, t: Type, at: Place): Adt {
  const had = L.adts.get(key(t));
  if (had) return had;
  const decl = declOf(L, t, at);
  const map = new Map(decl.params.flatMap((p, i): [string, Type][] => (t.args[i] ? [[p, t.args[i]]] : [])));
  return decl.boxed ? boxed(L, t, decl, map) : flat(L, t, decl, map);
}

// A row type: one constructor whose fields are Int, Bool or View, or Option of one of those for a column that
// may be NULL (sql.ts decides which may: the checker refuses Int for a nullable column, and Option for one that
// never is).
const SCALAR: Readonly<Record<string, string>> = { Int: 'i', Float: 'f', Bool: 'b', View: 't' };
const scalar = (name: string | undefined): string | undefined =>
  name !== undefined && Object.hasOwn(SCALAR, name) ? SCALAR[name] : undefined;
export const rowKind = (f: { type: Type }): string | undefined =>
  f.type.name === 'Option' ? scalar(f.type.args[0]?.name)?.toUpperCase() : scalar(f.type.name);

export function rowOf(L: Layouts, t: Type, at: Place): FlatAdt {
  const a = adtOrNull(L, t, at);
  const only = a?.variants.length === 1 ? a.variants[0] : undefined;
  if (!a || a.boxed || !only?.fields.every(f => rowKind(f) !== undefined))
    return refuse(
      at,
      'C09',
      `${key(t)} cannot be a row type`,
      "A row type has one constructor whose fields are Int, Bool or View (or Option[Int], Option[Bool], Option[View] for a column that may be NULL), in the order of the query's columns.",
    );
  return a;
}

// A flat JSON shape, for write_json and for fingerprints: constructors whose fields are Int, Bool, View (or
// refinements of them), or Option of those for keys that may be absent.

/** What a field is in JSON, or null when it cannot be. */
function jsonKind(L: Layouts, ft: Type, decoding: boolean): { kind: string; optional: boolean } | null {
  const one = (x: Type | undefined): string | undefined => (x ? scalar(strip(L, x).name) : undefined);
  const own = one(ft);
  if (own !== undefined) return { kind: own, optional: false };
  const inner = decoding && ft.name === 'Option' ? one(ft.args[0]) : undefined;
  return inner === undefined ? null : { kind: inner, optional: true };
}

export function shapeOf(L: Layouts, t: Type, at: Place, decoding: boolean): Shape {
  const a = adtOrNull(L, t, at);
  const cannot = (): never =>
    refuse(
      at,
      'C09',
      `${key(t)} cannot be ${decoding ? 'decoded from' : 'written as'} JSON`,
      'Its fields must be Int, Float, Bool, View, a record of such fields, a List of them, or Option[…] of one for a key that may be absent (not inside a List).',
    );
  if (!a || a.boxed || (!decoding && a.variants.length !== 1)) return cannot();
  const field = (f: FlatField): FieldKind => ({ name: f.name, ...(jsonKind(L, f.type, decoding) ?? cannot()) });
  return { variants: a.variants.map(v => v.fields.map(field)) };
}

export const isLinear = (t: Type): boolean => t.name === 'Buf';

function describeKind(L: Layouts, k: WireKind, at: Place): Described {
  if (k.k === 's') return { kind: scalar(k.base) };
  if (k.k === 'rec') return { kind: 'o', of: describe(L, T(k.name), at) };
  if (k.k === 'list') return { kind: 'l', of: describeKind(L, k.of, at) };
  return { ...describeKind(L, k.of, at), optional: true };
}

/**
 * What a message is, through its nested records and lists: for fingerprints, so two sides that disagree about a
 * field three levels down are told apart. A flat type's description is its shape.
 */
export function describe(L: Layouts, t: Type, at: Place): { variants: unknown[] } {
  if (!L.wire.nested.has(t.name)) return shapeOf(L, t, at, true);
  const variants = L.prog.types.get(t.name)?.variants ?? [];
  return {
    variants: variants.map(v =>
      v.fields.map(f => {
        const kind = L.wire.kind(f.type, false, new Set());
        return { name: f.name, optional: false, ...(kind ? describeKind(L, kind, at) : {}) };
      }),
    ),
  };
}
