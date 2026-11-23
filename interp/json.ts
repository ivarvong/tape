// interp/json.ts: `decode` and `write_json` in the reference interpreter, and the rows of a query as values.
// Written from the rules (LANGUAGE.md), not from the compiler's generated functions (compiler/wire.ts): records,
// records inside records, lists, Option fields and types with several constructors, each reason worded as the
// compiled build words it.
import type { Program, TypeAst, TypeDecl, Variant } from '../compiler/ast.ts';
import { unreachable } from '../compiler/ast.ts';
import { decExpected, refusalOf } from '../compiler/rule.ts';
import { type Adt, type Buf, type Value, adt, isDec } from './value.ts';
import { dec, parse, text as decText } from './dec.ts';

export class Unsupported extends Error {}
/** What a host gives for one cell of a row. */
export type Cell = number | string | null;

const enc = new TextEncoder(),
  strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
type Kind = 't' | 'i' | 'f' | 'b' | 'd';
const KIND: Readonly<Record<Kind, string>> = {
  t: 'text',
  b: 'true or false',
  i: 'an integer',
  f: 'a number',
  d: 'a Dec',
};

/** The type a refined type's values are made of: `Key` (View where …) is View. */
export const baseOf = (prog: Program, t: TypeAst): TypeAst => {
  const refine = prog.types.get(t.name)?.refine;
  return refine ? baseOf(prog, refine.base) : t;
};
const kindOf = (prog: Program, t: TypeAst): Kind => {
  const b = baseOf(prog, t).name;
  if (b === 'View') return 't';
  if (b === 'Int') return 'i';
  if (b === 'Float') return 'f';
  if (b === 'Bool') return 'b';
  if (b === 'Dec') return 'd';
  throw new Unsupported(`${b} in JSON or a row`);
};
/** The declaration of a record type and its first constructor (a row and a method's message have one). */
export const recordOf = (prog: Program, name: string, what: string): { decl: TypeDecl; first: Variant } => {
  const decl = prog.types.get(name),
    first = decl?.variants[0];
  if (!decl || decl.refine || !first) throw new Error(`${what}: ${name} is not a record type`);
  return { decl, first };
};

/** The scale of a Dec type, or of a refinement of one. */
const scaleIn = (prog: Program, t: TypeAst): number => Number(baseOf(prog, t).args[0]?.name ?? 0);
const cell = (prog: Program, t: TypeAst, v: Cell): Value => {
  const k = kindOf(prog, t);
  if (v === null) throw new Error(`NULL in a column read as ${t.name}`);
  // a Dec is stored as its count
  if (k === 'd') {
    if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw new TypeError(`${String(v)} in a column read as Dec`);
    return dec(BigInt(v), scaleIn(prog, t));
  }
  if (k === 'f') {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError(`${String(v)} in a column read as Float`);
    return v;
  }
  return k === 't' ? enc.encode(String(v)) : k === 'b' ? Boolean(v) : BigInt(v);
};
/** One row as a value of the row type: cells in the order of its fields, NULL as None where the field is an Option. */
export const row = (prog: Program, name: string, cells: readonly Cell[]): Adt => {
  const v = recordOf(prog, name, 'row').first;
  return adt(
    v.name,
    Object.fromEntries(
      v.fields.map((fl, i): [string, Value] => {
        const c = cells[i] ?? null,
          inner = fl.type.name === 'Option' ? fl.type.args[0] : undefined;
        if (!inner) return [fl.name, cell(prog, fl.type, c)];
        return [fl.name, c === null ? adt('None') : adt('Some', { value: cell(prog, inner, c) })];
      }),
    ),
  );
};

/** A JSON number as its text, so that it is read exactly (std/json.tape json_int), not as a double. */
class Num {
  readonly source: string;
  constructor(source: string) {
    this.source = source;
  }
}
/** A JSON number as a finite Float (from its text, as the module reads it), or null. */
const finiteOf = (x: unknown): number | null => {
  const v = x instanceof Num ? Number(x.source) : typeof x === 'number' ? x : NaN;
  return Number.isFinite(v) ? v : null;
};
/** A JSON number's value when it is a whole number within ±(2^53 - 1), read exactly from its text; else null. */
function whole(source: string): bigint | null {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(source);
  if (!m) return null;
  const all = (m[2] ?? '') + (m[3] ?? ''),
    kept = all.replace(/0+$/, '');
  if (/^0*$/.test(all)) return 0n;
  const scale = Number(m[4] ?? '0') - (m[3] ?? '').length + (all.length - kept.length),
    core = kept.replace(/^0+/, '');
  if (scale < 0 || core.length + scale > 16) return null;
  const v = BigInt(core) * 10n ** BigInt(scale);
  return v > 9007199254740991n ? null : m[1] === '-' ? -v : v;
}
const wellFormed = (x: string): boolean =>
  !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(x);
const isObject = (v: unknown): v is Readonly<Record<string, unknown>> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Num);
const err = (why: string): Adt => adt('Err', { error: enc.encode(why) });

type Meets = (t: TypeAst, v: Value) => boolean;
/** A value decoded, or why not. */
type Got = { value: Value } | { why: string };
/** Why a value is not one of a scalar shape. */
const notOf = (sh: { kind: Kind; scale: number }): string =>
  `expected ${sh.kind === 'd' ? decExpected(sh.scale) : KIND[sh.kind]}`;
const SURROGATE = 'expected text without lone surrogates';
/** What a type is in JSON: a scalar, a list of something, or a record. */
type Shape = { k: 'scalar'; kind: Kind; scale: number } | { k: 'list'; of: TypeAst } | { k: 'record' };
const shapeOf = (prog: Program, t: TypeAst): Shape => {
  const [of] = t.args;
  if (t.name === 'List' && of) return { k: 'list', of };
  const b = baseOf(prog, t).name;
  return b === 'View' || b === 'Int' || b === 'Float' || b === 'Bool' || b === 'Dec'
    ? { k: 'scalar', kind: kindOf(prog, t), scale: scaleIn(prog, t) }
    : { k: 'record' };
};
// a Dec from a number's text or from text, exactly at its scale
const scalarOf = (k: Kind, x: unknown, scale: number): Value | null =>
  k === 'd'
    ? x instanceof Num || typeof x === 'string'
      ? parse(x instanceof Num ? x.source : x, scale)
      : null
    : k === 't'
      ? typeof x === 'string'
        ? enc.encode(x)
        : null
      : k === 'b'
        ? typeof x === 'boolean'
          ? x
          : null
        : k === 'f'
          ? finiteOf(x)
          : x instanceof Num
            ? whole(x.source)
            : typeof x === 'number' && Number.isSafeInteger(x)
              ? BigInt(x)
              : null;
// a reason from inside `path` with the path before it, as std/json.tape's json_join: `items` and
// `[2].price: missing` are `items[2].price: missing`
const join = (path: string, why: string): string =>
  why === 'missing' || why === 'null' || why.startsWith('expected ') || why.startsWith('not a valid ')
    ? `${path}: ${why}`
    : why.startsWith('[')
      ? `${path}${why}`
      : `${path}.${why}`;

/** A JSON value as type t, below the top: a record from an object, a list from an array, a scalar. */
function valueAs(prog: Program, meets: Meets, t: TypeAst, x: unknown): Got {
  const sh = shapeOf(prog, t);
  if (x === null) return { why: 'null' };
  switch (sh.k) {
    case 'record':
      return recordAs(prog, meets, t.name, x);
    case 'list':
      return Array.isArray(x) ? listAs(prog, meets, sh.of, x) : { why: 'expected an array' };
    case 'scalar': {
      const v = scalarOf(sh.kind, x, sh.scale);
      if (v === null) return { why: notOf(sh) };
      if (typeof x === 'string' && !wellFormed(x)) return { why: SURROGATE };
      return meets(t, v) ? { value: v } : { why: refusalOf(prog, t.name) };
    }
    default:
      return unreachable(sh, 'shape');
  }
}
/** An array's elements, each as type `of`, as a List; the first that is not one is the reason, with its index. */
function listAs(prog: Program, meets: Meets, of: TypeAst, xs: readonly unknown[]): Got {
  const items: Value[] = [];
  for (const [i, x] of xs.entries()) {
    const got = valueAs(prog, meets, of, x);
    if ('why' in got) return { why: join(`[${i}]`, got.why) };
    items.push(got.value);
  }
  return { value: items.reduceRight((tail: Value, head) => adt('Cons', { head, tail }), adt('Nil')) };
}

/**
 * An object as a record type: the constructor its only key names, with an object of its fields as that key's
 * value (as write_json writes a type with several constructors), or else the constructor that has its fields
 * among the keys and names the most of them (the first such). A key no field names is left unread. Each field is
 * checked in order for its kind, then each refined scalar's condition, then each field that is a record or a list,
 * inside it (its reason after the field's name). When no constructor has its fields, the reason is from the one
 * that got furthest.
 */
function recordAs(prog: Program, meets: Meets, name: string, x: unknown): Got {
  if (!isObject(x)) return { why: 'expected an object' };
  const variants = recordOf(prog, name, 'decode').decl.variants,
    keys = Object.keys(x),
    [only = ''] = keys,
    tagged = variants.length > 1 && keys.length === 1 ? variants.find(v => v.name === only) : undefined;
  if (tagged) {
    const inner = x[only];
    if (!isObject(inner)) return { why: `${only}: expected an object` };
    const got = fit(prog, meets, tagged, inner);
    return 'depth' in got ? { why: got.why } : got;
  }
  const has = (fl: Variant['fields'][number]): boolean => Object.hasOwn(x, fl.name);
  const named = (v: Variant): number =>
    v.fields.some(fl => fl.type.name !== 'Option' && !has(fl)) ? -1 : v.fields.filter(has).length;
  let best: Variant | undefined,
    most = -1;
  for (const v of variants) if (named(v) > most) [best, most] = [v, named(v)];
  if (best) {
    const got = fit(prog, meets, best, x);
    return 'depth' in got ? { why: got.why } : got;
  }
  let far = { depth: -1, why: '' };
  for (const v of variants) {
    const got = fit(prog, meets, v, x);
    if ('depth' in got && got.depth > far.depth) far = got;
  }
  return { why: far.why };
}
/** One constructor from an object: its value, why not (a refined condition, something inside), or how far it got. */
function fit(
  prog: Program,
  meets: Meets,
  variant: Variant,
  object: Readonly<Record<string, unknown>>,
): Got | { depth: number; why: string } {
  const f: Record<string, Value> = {},
    later: (() => string | null)[] = [],
    refined: { name: string; type: TypeAst; value: Value }[] = [];
  for (const [depth, fl] of variant.fields.entries()) {
    const inner = fl.type.name === 'Option' ? fl.type.args[0] : undefined,
      type = inner ?? fl.type,
      sh = shapeOf(prog, type),
      x = object[fl.name];
    // an Option field may be absent or null
    if (!Object.hasOwn(object, fl.name) || (inner && x === null)) {
      if (!inner) return { depth, why: `${fl.name}: missing` };
      f[fl.name] = adt('None');
      continue;
    }
    if (x === null) return { depth, why: `${fl.name}: null` };
    const some = (v: Value): Value => (inner ? adt('Some', { value: v }) : v);
    if (sh.k === 'scalar') {
      const value = scalarOf(sh.kind, x, sh.scale);
      if (value === null) return { depth, why: `${fl.name}: ${notOf(sh)}` };
      if (typeof x === 'string' && !wellFormed(x)) return { depth, why: `${fl.name}: ${SURROGATE}` };
      f[fl.name] = some(value);
      refined.push({ name: fl.name, type, value });
      continue;
    }
    if (sh.k === 'list' ? !Array.isArray(x) : !isObject(x))
      return { depth, why: `${fl.name}: expected ${sh.k === 'list' ? 'an array' : 'an object'}` };
    later.push(() => {
      const got = valueAs(prog, meets, type, x);
      if ('why' in got) return join(fl.name, got.why);
      f[fl.name] = some(got.value);
      return null;
    });
  }
  const bad = refined.find(r => !meets(r.type, r.value));
  if (bad) return { why: `${bad.name}: ${refusalOf(prog, bad.type.name)}` };
  for (const step of later) {
    const why = step();
    if (why !== null) return { why };
  }
  return { value: adt(variant.name, f) };
}

/** decode(json:, as: T): Ok with the value, or Err with why the bytes are not one. T is a record type or List[…]. */
export function decode(prog: Program, bytes: Uint8Array, t: TypeAst, meets: Meets): Adt {
  let parsed: unknown;
  let text: string;
  try {
    text = strict.decode(bytes);
    parsed = JSON.parse(text);
  } catch {
    return err(bytes.length > 0 ? 'not JSON' : 'empty');
  }
  // each number as its text, to be read exactly (a reviver too deep to run leaves them as parsed)
  try {
    parsed = JSON.parse(text, (_k, v: unknown, context?: { source?: string }) =>
      typeof v === 'number' ? new Num(context?.source ?? String(v)) : v,
    );
  } catch {
    // RangeError: nested too deep for the reviver
  }
  const [of] = t.args;
  const got: Got =
    t.name === 'List' && of
      ? Array.isArray(parsed)
        ? listAs(prog, meets, of, parsed)
        : { why: 'expected an array' }
      : recordAs(prog, meets, t.name, parsed);
  return 'why' in got ? err(got.why) : adt('Ok', { value: got.value });
}

const isAdt = (v: Value | undefined): v is Adt => typeof v === 'object' && !(v instanceof Uint8Array) && v.k === 'adt';
/**
 * write_json: a value as JSON. A record as an object, its fields in the order they are declared, an Option field
 * that is None left out and one that is Some written as its value; a type with several constructors as
 * {"Constructor": {…}}; a List as an array; Int, Bool and View as themselves. `writeText` writes one text as a
 * JSON string (the program's own `write_json_string`).
 */
export function writeJson(prog: Program, out: Buf, v: Value, writeText: (out: Buf, text: Uint8Array) => void): Buf {
  const text = (t: string): void => {
    for (const b of enc.encode(t)) out.buf.push(b);
  };
  const write = (x: Value | undefined): void => {
    if (typeof x === 'bigint') return text(String(x));
    if (typeof x === 'boolean') return text(x ? 'true' : 'false');
    if (x instanceof Uint8Array) return writeText(out, x);
    // the shortest digits that read back as it, as the host's float_text
    if (typeof x === 'number') return text(String(x));
    // a Dec as text with its scale's digits, exact for any reader
    if (isDec(x)) return text(`"${decText(x)}"`);
    if (!isAdt(x)) throw new Unsupported(`write_json of ${x === undefined ? 'nothing' : `a ${x.k}`}`);
    const made = prog.ctors.get(x.c),
      decl = made?.decl,
      variant = decl?.variants[made?.vi ?? -1];
    if (!decl || !variant || decl.name === 'Option' || decl.name === 'Result')
      throw new Unsupported(`write_json of ${x.c}`);
    if (decl.name === 'List') {
      text('[');
      for (let item: Value | undefined = x, first = true; isAdt(item) && item.c === 'Cons'; first = false) {
        if (!first) text(',');
        write(item.f['head']);
        item = item.f['tail'];
      }
      return text(']');
    }
    const several = decl.variants.length > 1;
    text(several ? `{${JSON.stringify(x.c)}:{` : '{');
    let first = true;
    for (const fl of variant.fields) {
      const field = x.f[fl.name],
        optional = fl.type.name === 'Option' && isAdt(field);
      if (optional && field.c === 'None') continue;
      text(`${first ? '' : ','}${JSON.stringify(fl.name)}:`);
      first = false;
      write(optional ? field.f['value'] : field);
    }
    text(several ? '}}' : '}');
  };
  write(v);
  return out;
}
