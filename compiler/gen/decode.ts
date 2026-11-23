// compiler/gen/decode.ts: JSON and rows read into values. JSON is decoded by Tape source written for each type
// (compiler/wire.ts); the rows of a query are read from the block the host wrote.
import type { Call, TypeAst } from '../ast.ts';
import { F64, I32, I64, fail, sleb, uleb, utf8 } from '../common.ts';
import { T, VIEW } from '../types.ts';
import type { Type } from '../types.ts';
import { buildVariant, close, fresh, get, inLocals, need, open, set, store } from './fn.ts';
import type { Ctx, Place } from './fn.ts';
import type { Adt } from './layout.ts';
import { emitPred } from './pattern.ts';

type Why = readonly [number, number] | null;
const i32 = (n: number): number[] => [0x41, ...sleb(n)];
const variantOf = (adt: Adt, name: string): number => adt.variants.findIndex(x => x.name === name);

/** decode(json: bytes, as: T) -> Result[T, View]: the value, or why the bytes are not one. */
export function emitDecode(c: Ctx, e: Call): Type {
  const arg = (n: string) => e.args.find(a => a.label === n);
  const ja =
    arg('json') ??
    fail(e, 'C13', 'decode is missing argument json', 'decode takes (json: the bytes, as: the type to decode into).');
  const ta =
    arg('as') ??
    fail(e, 'C13', 'decode is missing argument as', 'Name the type to decode into, for example `as: NewTodo`.');
  for (const a of e.args)
    if (a !== ja && a !== ta)
      fail(a, 'C11', 'decode takes (json, as)', 'Write `decode(json: body, as: T)` and nothing else.');
  if (ta.value.k !== 'ctor' || ta.value.args.length > 0)
    return fail(
      ta,
      'C14',
      'argument as should be a type name',
      'Name the type itself, `as: NewTodo`, not a value of it.',
    );
  const named: TypeAst = { name: ta.value.name, args: [], line: ta.line, file: ta.file };
  const t = c.B.resolve(named);
  const v = inLocals(c, ja.value, VIEW);
  need(c, v.type, VIEW, ja, 'argument json');
  const out = c.B.slotsOf(t).map(vt => fresh(c, vt));
  const why: [number, number] = [fresh(c, I32), fresh(c, I32)];
  const res = T('Result', t, VIEW);
  const adt = c.B.adtOf(res, e);
  decodeTo(c, t, v.locals, out, ta, why);
  open(c, 0x04, adt.slots);
  buildVariant(c, adt, variantOf(adt, 'Ok'), out);
  c.code.push(0x05);
  buildVariant(c, adt, variantOf(adt, 'Err'), why);
  close(c);
  return res;
}

// json_decode_T(json) -> Result[T, View] (compiler/wire.ts): its Ok fills `out`, its Err is the reason
function decodeNested(c: Ctx, t: Type, view: readonly number[], out: readonly number[], at: Place, why: Why): void {
  const res = c.B.adtOf(T('Result', t, VIEW), at);
  if (res.boxed) return;
  const rl = res.slots.map(vt => fresh(c, vt));
  const okI = variantOf(res, 'Ok');
  const move = (name: string, to: readonly number[]): number[] =>
    (res.variants.find(x => x.name === name)?.fields[0]?.slots ?? []).flatMap((sl, j) => [
      ...get(rl[sl] ?? 0),
      ...set(to[j] ?? 0),
    ]);
  c.code.push(...get(view[0] ?? 0), ...get(view[1] ?? 0), 0x10, ...uleb(c.B.fnIndex(`json_decode_${t.name}`)));
  for (const l of rl.toReversed()) c.code.push(...set(l));
  c.code.push(...get(rl[0] ?? 0), ...i32(okI), 0x46);
  open(c, 0x04, [I32]);
  c.code.push(...move('Ok', out), ...i32(1), 0x05, ...(why ? move('Err', why) : []), ...i32(0));
  close(c);
}

/**
 * Decodes the JSON bytes in `view` as type t into the locals `out`; leaves an i32: 1 when it is a valid t. The
 * decoder is Tape source written for t (compiler/wire.ts); a type it was not written for cannot be JSON (C09).
 */
export function decodeTo(c: Ctx, t: Type, view: readonly number[], out: readonly number[], at: Place, why: Why): void {
  const { B } = c;
  if (!Object.hasOwn(B.SIMJSON.decodes, t.name)) B.SIMJSON.decodes[t.name] = [t, at];
  if (!B.WIRE.decodable.has(t.name)) B.shapeOf(t, at, true);
  if (!B.WIRE.decodable.has(t.name))
    fail(at, 'C30', `decode of ${t.name} needs std/json.tape`, 'Compile the program together with std.');
  decodeNested(c, t, view, out, at, why);
}

export const decodeRow = (c: Ctx, rowT: Type, cur: number, at: Place): number[] =>
  decodeFields(c, c.B.rowOf(rowT, at).variants[0]?.fields ?? [], cur, at, -1, null);

type Read = { readonly name: string; readonly type: Type };

// an 8-byte flag, then the value if present
function decodeOption(c: Ctx, fl: Read, cur: number, at: Place, ok: number, why: Why): number[] {
  const adt = c.B.adtOf(fl.type, at);
  const [inner] = fl.type.args;
  c.code.push(...get(cur), 0x29, 0, 0, 0x50, 0x45, ...get(cur), ...i32(8), 0x6a, ...set(cur));
  open(c, 0x04, adt.slots);
  buildVariant(
    c,
    adt,
    variantOf(adt, 'Some'),
    inner ? decodeFields(c, [{ name: fl.name, type: inner }], cur, at, ok, why) : [],
  );
  c.code.push(0x05);
  buildVariant(c, adt, variantOf(adt, 'None'), []);
  close(c);
  return store(c, fl.type);
}

/** One scalar at the cursor: text is a u32 length and its bytes; an Int, a Float or a Bool is 8 bytes. */
function decodeScalar(c: Ctx, base: string, cur: number): number[] {
  if (base === 'View') {
    const pt = fresh(c, I32);
    const n = fresh(c, I32);
    const length = [...get(cur), 0x28, 0, 0, ...set(n)];
    const bytes = [...get(cur), ...i32(4), 0x6a, ...set(pt)];
    c.code.push(...length, ...bytes, ...get(pt), ...get(n), 0x6a, ...set(cur));
    return [pt, n];
  }
  const l = fresh(c, base === 'Int' ? I64 : base === 'Float' ? F64 : I32);
  c.code.push(...get(cur), base === 'Float' ? 0x2b : 0x29, 0, 0);
  if (base === 'Bool') c.code.push(0x50, 0x45);
  c.code.push(...set(l), ...get(cur), ...i32(8), 0x6a, ...set(cur));
  return [l];
}

/** A refined field whose condition fails clears the `ok` local; the first one to fail is the reason. */
function checkRefined(c: Ctx, fl: Read, mine: number[], ok: number, why: Why): void {
  emitPred(c, fl.type, mine);
  c.code.push(0x45);
  open(c, 0x04);
  if (why) {
    const [wa, wn] = c.B.literal(utf8(`${fl.name}: not a valid ${fl.type.name}`));
    c.code.push(...get(ok));
    open(c, 0x04);
    c.code.push(...i32(wa), ...set(why[0]), ...i32(wn), ...set(why[1]));
    close(c);
  }
  c.code.push(...i32(0), ...set(ok));
  close(c);
}

/** Reads fields at the cursor (advancing it); gives their locals, flat and in order. */
export function decodeFields(c: Ctx, fields: readonly Read[], cur: number, at: Place, ok: number, why: Why): number[] {
  return fields.flatMap(fl => {
    if (fl.type.name === 'Option') return decodeOption(c, fl, cur, at, ok, why);
    const mine = decodeScalar(c, c.B.strip(fl.type).name, cur);
    if (c.B.types.get(fl.type.name)?.refine) checkRefined(c, fl, mine, ok, why);
    return mine;
  });
}
