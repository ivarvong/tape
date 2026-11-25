// sim/values.ts: a value of a type, from its JSON Schema: a request's body, or a stood-in Remote's reply.
import type { JsonSchema } from '../compiler/gen/schema.ts';

/** The part of JSON Schema the compiler writes for a program's types. */
export type Schema = JsonSchema;
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
/** What a run has said so far, so that later values can name the same things. */
export type ValueContext = {
  /** values the caller pins, by field name */
  fix?: Readonly<Record<string, number>>;
  /** numbers of a kind, by field name (`seats` for a field `seat`) */
  kinds?: Readonly<Record<string, number[]>>;
  ids: number[];
  keys: string[];
  /** the chance that a text with no minimum length is left empty */
  blank?: number;
  dict: Readonly<Record<string, string[]>>;
  said: Record<string, string[]>;
};
function pickFrom<T extends string | number | Schema>(rand: () => number, xs: readonly T[]): T {
  const x = xs[Math.floor(rand() * xs.length)];
  if (x === undefined) throw new Error('nothing to pick from');
  return x;
}
export function valueOf(schema: Schema | undefined, rand: () => number, ctx: ValueContext, name = ''): Json {
  const pick = <T extends string | number | Schema>(xs: readonly T[]): T => pickFrom(rand, xs);
  if (!schema) return null;
  if (schema.oneOf) return valueOf(pick(schema.oneOf), rand, ctx, name);
  // a sum whose constructors have no fields: the text of one of them
  if (schema.enum && schema.enum.length > 0) return pick(schema.enum);
  if (schema.type === 'object') {
    const o: { [key: string]: Json } = {};
    for (const [k, v] of Object.entries(schema.properties ?? {}))
      if ((schema.required ?? []).includes(k) || rand() < 0.5) o[k] = valueOf(v, rand, ctx, k);
    return o;
  }
  if (schema.type === 'array')
    return Array.from({ length: Math.floor(rand() * 3) }, () => valueOf(schema.items, rand, ctx, name));
  if (schema.type === 'boolean') return rand() < 0.5;
  if (schema.type === 'integer') {
    const fixed = ctx.fix?.[name];
    if (fixed !== undefined) return fixed; // a value the caller pins (a hold long enough not to expire mid-test)
    const lo = schema.minimum ?? -Infinity,
      hi = schema.maximum ?? Infinity,
      fit = (n: number): number => Math.min(hi, Math.max(lo, n));
    const near = [lo, lo + 1, lo + 2, hi].filter(Number.isFinite);
    const kind = ctx.kinds?.[`${name}s`] ?? ctx.kinds?.[name];
    if (kind && kind.length > 0 && rand() < 0.75) return fit(pick(kind));
    return fit(rand() < 0.6 && ctx.ids.length > 0 ? pick(ctx.ids) : pick([...near, 1, 2, 3, 5, 30]));
  }
  // a Float, or a Dec (text with a scale, its pattern): an edge or a small number, within the bounds
  if (schema.type === 'number' || (schema.type === 'string' && schema.pattern !== undefined)) {
    const places = Number(/\{1,(\d+)\}/.exec(schema.pattern ?? '')?.[1] ?? (schema.type === 'number' ? 2 : 0));
    const step = 10 ** -places;
    const lo = schema.minimum ?? (schema.exclusiveMinimum !== undefined ? schema.exclusiveMinimum + step : -1e6),
      hi = schema.maximum ?? (schema.exclusiveMaximum !== undefined ? schema.exclusiveMaximum - step : 1e6);
    const n = Math.min(hi, Math.max(lo, pick([lo, hi, 0, 1, 2.5, 12.34, 30, 99.99, lo + (hi - lo) * rand()])));
    const text = n.toFixed(places);
    return schema.type === 'number' ? Number(text) : text;
  }
  // text: a key is new most of the time and sometimes one sent before; other text is what the programs' rows hold
  const lo = schema.minLength ?? 0,
    hi = schema.maximum ?? schema.maxLength ?? 64,
    shape = (t: string): string => (t.length < lo ? t.padEnd(lo, 'x') : t).slice(0, hi);
  // a stand-in's reply sometimes leaves a text empty, as a real one does (a model with no answer yet)
  if (ctx.blank !== undefined && lo === 0 && rand() < ctx.blank) return '';
  if (/^(key|client|op|once|idempotency)/.test(name)) {
    if (ctx.keys.length > 0 && rand() < 0.3) return pick(ctx.keys);
    const k = shape(`k${ctx.keys.length + 1}`);
    ctx.keys.push(k);
    return k;
  }
  // a field named like a column of the programs' seed rows mostly gets one of those values (a card that exists);
  // otherwise what was said for that field before, so two requests can name the same buyer;
  // and sometimes what was said for another field: the buyer of a hold is the `from` of a transfer
  const held = ctx.dict[name] ?? [],
    own = ctx.said[name] ?? [],
    any = Object.values(ctx.said).flat(),
    roll = rand();
  const t = shape(
    held.length > 0
      ? roll < 0.85
        ? pick(held)
        : pick(['ann', 'bob', 'cy', ...(ctx.dict['*'] ?? []).slice(0, 12)])
      : own.length > 0 && roll < 0.6
        ? pick(own)
        : any.length > 0 && roll < 0.85
          ? pick(any)
          : pick(['ann', 'bob', 'cy', ...(ctx.dict['*'] ?? []).slice(0, 12)]),
  );
  const before = (ctx.said[name] ??= []);
  if (!before.includes(t)) before.push(t);
  return t;
}

// Paths and bodies, read from the syntax tree.
