// compiler/gen/schema.ts: a message or a reply as JSON Schema, for tool manifests and the simulator (not part of
// the module, so no hash changes): records of Int, Bool, View, Option[…] of those for keys that may be absent,
// lists and nested records, and refined types, whose bounds are read from `self >= n`, `self <= n`, `self > n`,
// `self < n` joined by `and`.
import type { Expr } from '../ast.ts';
import { fieldlessOf, storedText } from '../fieldless.ts';
import type { Type } from '../types.ts';
import { scaleOf } from '../types.ts';
import { adtOf, strip } from './layout.ts';
import type { Layouts } from './layout.ts';

export type JsonSchema = {
  type?: string;
  items?: JsonSchema;
  oneOf?: JsonSchema[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: false;
  description?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  /** a Dec[s] as text: digits, then a point and at most s of them */
  pattern?: string;
  /** a fieldless sum: the text of each of its constructors */
  enum?: string[];
};
type Place = object | null | undefined;

const FLIP: Readonly<Record<string, string>> = { '>=': '<=', '<=': '>=', '>': '<', '<': '>' };
const JSON_TYPE: Readonly<Record<string, string>> = {
  Int: 'integer',
  Float: 'number',
  // a Dec is written as text, "12.30", and read from a number or text
  Dec: 'string',
  Bool: 'boolean',
  View: 'string',
};

/** What a side of a comparison measures: '' for self, 'len' for len(self), null for anything else. */
const measured = (x: Expr): '' | 'len' | null => {
  if (x.k === 'var' && x.name === 'self') return '';
  const [only] = x.k === 'call' && x.name === 'len' && x.args.length === 1 ? x.args : [];
  return only?.value.k === 'var' && only.value.name === 'self' ? 'len' : null;
};

/** A literal bound as a number: an Int, a Dec (`0.01`) or a Float (`1.5f`); null for anything else. */
const literal = (x: Expr): number | null =>
  x.k === 'int' ? Number(x.v) : x.k === 'dec' ? Number(x.v) / 10 ** x.s : x.k === 'float' ? x.v : null;

/** `self op n` or `n op self`, as [op with self on the left, n, what is measured]. */
function comparison(e: Extract<Expr, { k: 'bin' }>): [string, number, '' | 'len'] | null {
  const l = measured(e.l);
  const r = measured(e.r);
  const rn = literal(e.r),
    ln = literal(e.l);
  if (l !== null && rn !== null) return [e.op, rn, l];
  if (r !== null && ln !== null) return [FLIP[e.op] ?? e.op, ln, r];
  return null;
}

function bounds(e: Expr, out: JsonSchema): void {
  if (e.k !== 'bin') return;
  if (e.op === 'and') {
    bounds(e.l, out);
    bounds(e.r, out);
    return;
  }
  const found = comparison(e);
  if (!found) return;
  const [op, n, what] = found;
  if (what === 'len') {
    if (op === '>=' || op === '==') out.minLength = n;
    if (op === '<=' || op === '==') out.maxLength = n;
    if (op === '>') out.minLength = n + 1;
    if (op === '<') out.maxLength = n - 1;
    return;
  }
  if (op === '==') [out.minimum, out.maximum] = [n, n];
  if (op === '>=') out.minimum = n;
  if (op === '<=') out.maximum = n;
  if (op === '>') out.exclusiveMinimum = n;
  if (op === '<') out.exclusiveMaximum = n;
}

type Fields = { readonly fields: readonly { name: string; type: Type }[] };

function field(L: Layouts, ft: Type, at: Place): JsonSchema {
  const inner = (ft.name === 'Option' ? ft.args[0] : undefined) ?? ft;
  const d = L.prog.types.get(inner.name);
  const [item] = inner.name === 'List' && inner.args.length === 1 ? inner.args : [];
  if (item) return { type: 'array', items: field(L, item, at) };
  const stripped = strip(L, inner);
  const base = stripped.name;
  if (d && !d.refine && !Object.hasOwn(JSON_TYPE, base)) return jsonSchema(L, inner, at);
  const out: JsonSchema = Object.hasOwn(JSON_TYPE, base) ? { type: JSON_TYPE[base] ?? '' } : {};
  const scale = scaleOf(stripped);
  if (scale !== null) out.pattern = scale === 0 ? '^-?[0-9]+$' : `^-?[0-9]+([.][0-9]{1,${scale}})?$`;
  if (d?.refine) {
    bounds(d.refine.pred, out);
    out.description = `${d.name}, a refined ${base}: its condition is checked when the message is decoded`;
  }
  return out;
}

const object = (L: Layouts, v: Fields, at: Place): JsonSchema => ({
  type: 'object',
  properties: Object.fromEntries(v.fields.map(f => [f.name, field(L, f.type, at)])),
  required: v.fields.filter(f => f.type.name !== 'Option').map(f => f.name),
  additionalProperties: false,
});

// a type with several constructors is one of {"Name": {…}}, as write_json writes it (decode reads that, and an
// object with one constructor's fields)
export function jsonSchema(L: Layouts, t: Type, at: Place): JsonSchema {
  const [item] = t.name === 'List' && t.args.length === 1 ? t.args : [];
  if (item) return field(L, t, at);
  // a sum whose constructors have no fields is the text of one (compiler/fieldless.ts)
  const ctors = t.args.length === 0 ? fieldlessOf(L.prog, t.name) : null;
  if (ctors) return { type: 'string', enum: ctors.map(storedText) };
  const a = adtOf(L, t, at);
  const [only] = a.variants;
  if (a.variants.length === 1 && only) return object(L, only, at);
  return {
    oneOf: a.variants.map(v => ({
      type: 'object',
      properties: { [v.name]: object(L, v, at) },
      required: [v.name],
      additionalProperties: false,
    })),
  };
}
