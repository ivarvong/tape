// interp/json.ts: `decode` and `write_json` in the reference interpreter, and the rows of a query as values.
// Flat records only: a record or a list inside JSON is Unsupported, and counted where the interpreter is compared.
import type { Program, TypeAst, TypeDecl, Variant } from '../compiler/ast.ts';
import { type Adt, type Buf, type Value, adt } from './value.ts';

export class Unsupported extends Error {}
/** What a host gives for one cell of a row. */
export type Cell = number | string | null;

const enc = new TextEncoder(),
  strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
type Kind = 't' | 'i' | 'b';
const KIND: Readonly<Record<Kind, string>> = { t: 'text', b: 'true or false', i: 'a whole number' };

/** The type a refined type's values are made of: `Key` (View where …) is View. */
export const baseOf = (prog: Program, t: TypeAst): TypeAst => {
  const refine = prog.types.get(t.name)?.refine;
  return refine ? baseOf(prog, refine.base) : t;
};
const kindOf = (prog: Program, t: TypeAst): Kind => {
  const b = baseOf(prog, t).name;
  if (b === 'View') return 't';
  if (b === 'Int') return 'i';
  if (b === 'Bool') return 'b';
  throw new Unsupported(`${b} in JSON or a row`);
};
/** The declaration of a record type and its first constructor (a row and a method's message have one). */
export const recordOf = (prog: Program, name: string, what: string): { decl: TypeDecl; first: Variant } => {
  const decl = prog.types.get(name),
    first = decl?.variants[0];
  if (!decl || decl.refine || !first) throw new Error(`${what}: ${name} is not a record type`);
  return { decl, first };
};

const cell = (prog: Program, t: TypeAst, v: Cell): Value => {
  const k = kindOf(prog, t);
  if (v === null) throw new Error(`NULL in a column read as ${t.name}`);
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

const wellFormed = (x: string): boolean =>
  !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(x);
const isObject = (v: unknown): v is Readonly<Record<string, unknown>> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const err = (why: string): Adt => adt('Err', { error: enc.encode(why) });

/**
 * decode(json:, as:): JSON.parse, then the constructor that has its fields among the object's keys and names the
 * most of them (the first such), its values of the right kinds, then each refined field's condition (`meets`). A
 * key no field names is left unread. When no constructor has its fields, the reason is from the one that got
 * furthest.
 */
export function decode(prog: Program, bytes: Uint8Array, name: string, meets: (t: TypeAst, v: Value) => boolean): Adt {
  let parsed: unknown;
  try {
    parsed = JSON.parse(strict.decode(bytes));
  } catch {
    return err(bytes.length > 0 ? 'not JSON' : 'empty');
  }
  if (!isObject(parsed)) return err('not an object');
  const object = parsed;
  let issue = '',
    far = -1;
  const no = (depth: number, why: string): null => {
    if (depth > far) [far, issue] = [depth, why];
    return null;
  };
  const fit = (variant: Variant): Adt | null => {
    const f: Record<string, Value> = {},
      read: { name: string; type: TypeAst; value: Value }[] = [];
    let depth = 0;
    for (const fl of variant.fields) {
      const inner = fl.type.name === 'Option' ? fl.type.args[0] : undefined,
        type = inner ?? fl.type,
        k = kindOf(prog, type),
        x = object[fl.name];
      if (!Object.hasOwn(object, fl.name)) {
        if (!inner) return no(depth, `missing key ${JSON.stringify(fl.name)}`);
        f[fl.name] = adt('None');
        depth++;
        continue;
      }
      const value: Value | null =
        k === 't'
          ? typeof x === 'string'
            ? enc.encode(x)
            : null
          : k === 'b'
            ? typeof x === 'boolean'
              ? x
              : null
            : typeof x === 'number' && Number.isSafeInteger(x)
              ? BigInt(x)
              : null;
      if (value === null) return no(depth, `${fl.name}: expected ${KIND[k]}`);
      if (typeof x === 'string' && !wellFormed(x)) return no(depth, `${fl.name}: text with a lone surrogate`);
      f[fl.name] = inner ? adt('Some', { value }) : value;
      read.push({ name: fl.name, type, value });
      depth++;
    }
    const bad = read.find(r => !meets(r.type, r.value));
    return bad ? err(`${bad.name}: not a valid ${bad.type.name}`) : adt('Ok', { value: adt(variant.name, f) });
  };
  // the constructor that has its fields among the keys and names the most of them; a key none names is unread
  const variants = recordOf(prog, name, 'decode').decl.variants;
  const has = (fl: Variant['fields'][number]): boolean => Object.hasOwn(object, fl.name);
  const named = (v: Variant): number =>
    v.fields.some(fl => fl.type.name !== 'Option' && !has(fl)) ? -1 : v.fields.filter(has).length;
  let best: Variant | undefined,
    most = -1;
  for (const v of variants) if (named(v) > most) [best, most] = [v, named(v)];
  if (best) return fit(best) ?? err(issue);
  for (const v of variants) fit(v);
  return err(issue);
}

/**
 * write_json: a record with one constructor, as an object in the order its fields are declared. `writeText` writes
 * one text as a JSON string (the program's own `write_json_string`).
 */
export function writeJson(prog: Program, out: Buf, v: Adt, writeText: (out: Buf, text: Uint8Array) => void): Buf {
  const d = prog.ctors.get(v.c)?.decl,
    only = d?.variants.length === 1 ? d.variants[0] : undefined;
  if (!only) throw new Unsupported(`write_json of ${v.c}`);
  const text = (t: string): void => {
    for (const b of enc.encode(t)) out.buf.push(b);
  };
  only.fields.forEach((fl, i) => {
    text(`${i ? ',' : '{'}${JSON.stringify(fl.name)}:`);
    const x = v.f[fl.name];
    if (typeof x === 'bigint') text(String(x));
    else if (typeof x === 'boolean') text(x ? 'true' : 'false');
    else if (x instanceof Uint8Array) writeText(out, x);
    else if (typeof x === 'number') throw new Unsupported(`write_json of a Float inside ${v.c}`);
    else throw new Unsupported(`write_json of ${x?.k === 'adt' ? `a ${x.c}` : 'a value'} inside ${v.c}`);
  });
  text(only.fields.length > 0 ? '}' : '{}');
  return out;
}
