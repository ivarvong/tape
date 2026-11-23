// host/memory.ts: what the host reads from and writes into a module's memory.
//
// ABI: env.sql(query id, params pointer, mode) -> f64. Params are 16 bytes each: an i64 (Int, Bool) or a pointer
// and a length (text). mode 0 returns the rows written. mode 1 returns a pointer to: u32 row count, 4 bytes of
// padding, then every cell in row order: Int and Bool as an i64, text as a u32 length and the UTF-8 bytes. The
// module's `queries` section gives each statement's parameter kinds and row shape; cells are checked against it.
// env.json(pointer, length, shape id) -> f64 decodes JSON with the platform's JSON.parse (decodeJson below).
import type { Cell, Flags, SqlParam } from './log.ts';
import { cellText } from './log.ts';

/** The part of a module's exports the host writes through. */
export type Mem = { readonly memory: WebAssembly.Memory; readonly alloc: (size: number) => number };
/** A statement as the module lists it. `run`: its text with each Int and Bool parameter read as an integer. */
export type Query = { sql: string; params: string; row: string | null; columns: string[] | null; run?: string };
export type FieldShape = { name: string; kind: string; optional: boolean };
export type Shape = { variants: FieldShape[][] };
export type FlagDecl = { name: string; type: string; default: number | boolean; at: number; pinned?: unknown };

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const enc = new TextEncoder();
// The views over a module's memory, made again only when its buffer changes (memory.grow detaches the old one).
// A host call makes one or two of these per statement, so a fresh DataView each time was measurable (1.9% of ledger).
type Views = { buffer: ArrayBuffer; d: DataView; u: Uint8Array };
const seen = new WeakMap<WebAssembly.Memory, Views>();
function views(m: Mem): Views {
  const buffer = m.memory.buffer;
  const had = seen.get(m.memory);
  if (had !== undefined && had.buffer === buffer) return had;
  const made = { buffer, d: new DataView(buffer), u: new Uint8Array(buffer) };
  seen.set(m.memory, made);
  return made;
}
const view = (m: Mem): DataView => views(m).d;
const bytes = (m: Mem): Uint8Array => views(m).u;
/** An i64 at `o`, from a whole number within ±2^53. */
function setInt64(d: DataView, o: number, x: number): void {
  d.setInt32(o, x | 0, true);
  d.setInt32(o + 4, Math.floor(x / 4294967296), true);
}

/** A copy of `len` bytes of the module's memory. */
export const copyOut = (m: Mem, ptr: number, len: number): Uint8Array<ArrayBuffer> =>
  new Uint8Array(m.memory.buffer.slice(ptr, ptr + len));
export const textAt = (m: Mem, ptr: number, len: number): string => utf8.decode(copyOut(m, ptr, len));
/** Bytes copied into new room in the module; where they are. */
export function copyIn(m: Mem, data: Uint8Array): number {
  const at = m.alloc(data.length);
  new Uint8Array(m.memory.buffer, at, data.length).set(data);
  return at;
}
/** Text as a block the module reads: u32 length, then the bytes. */
export function block(m: Mem, text: string): number {
  const b = enc.encode(text);
  const at = m.alloc(4 + b.length);
  view(m).setUint32(at, b.length, true);
  new Uint8Array(m.memory.buffer, at + 4, b.length).set(b);
  return at;
}
/** A call's reply as the module reads it: u32 status, u32 length, bytes. */
export function replyBlock(m: Mem, status: number, reply: Uint8Array): number {
  const at = m.alloc(8 + reply.length);
  const d = view(m);
  d.setUint32(at, status, true);
  d.setUint32(at + 4, reply.length, true);
  new Uint8Array(m.memory.buffer, at + 8, reply.length).set(reply);
  return at;
}
/** The Buf a handler answered with: a pointer to its data and its length. */
export function answerAt(m: Mem, h: number): Uint8Array<ArrayBuffer> {
  const d = view(m);
  return copyOut(m, d.getUint32(h, true), d.getUint32(h + 4, true));
}

// Flags are written into the module's memory, where a read is one load. They change only between requests.
export function writeFlags(m: Mem, decls: readonly FlagDecl[], values: Flags, now: Flags): void {
  const d = view(m);
  for (const [n, v] of Object.entries(values)) {
    const f = decls.find(x => x.name === n);
    if (!f) throw new Error(`no flag ${n}; the program declares: ${decls.map(x => x.name).join(', ') || 'none'}`);
    const fits = f.type === 'Bool' ? typeof v === 'boolean' : Number.isSafeInteger(v);
    if (!fits)
      throw new Error(
        `flag ${n} is ${f.type === 'Bool' ? 'true or false' : 'a whole number'}, not ${JSON.stringify(v)}`,
      );
    setInt64(d, f.at, typeof v === 'boolean' ? (v ? 1 : 0) : v);
    now[n] = v;
  }
}

// ---- SQL

const int = (v: Cell): number => {
  if (typeof v === 'number' && Number.isSafeInteger(v)) return v;
  if (typeof v === 'bigint' && v >= -(2n ** 53n) && v <= 2n ** 53n) return Number(v);
  throw new Error(`sql: ${cellText(v)} is not an integer within ±2^53`);
};

// Text parameters this short that are all ASCII are read byte by byte; anything else (longer, or with a byte of
// 128 or more) goes through the fatal TextDecoder, so what is refused, and how, does not change. A key or a name
// is short and ASCII in nearly every statement, and TextDecoder costs about 0.1 µs a call before it reads a byte.
const SHORT = 64;
function textParam(u: Uint8Array, at: number, n: number): string {
  if (n <= SHORT) {
    let s = '';
    let i = 0;
    for (; i < n; i++) {
      const b = u[at + i] ?? 128;
      if (b > 127) break;
      s += String.fromCodePoint(b);
    }
    if (i === n) return s;
  }
  return utf8.decode(new Uint8Array(u.buffer, at, n));
}

/** The parameters of a statement, read from the block the module wrote. */
export function readParams(m: Mem, q: Query, ptr: number): SqlParam[] {
  const { d, u } = views(m);
  const kinds = q.params;
  const out: SqlParam[] = [];
  for (let k = 0; k < kinds.length; k++) {
    const o = ptr + 16 * k;
    if (kinds[k] === 't') {
      out.push(textParam(u, d.getUint32(o, true), d.getUint32(o + 4, true)));
      continue;
    }
    const x = d.getInt32(o + 4, true) * 4294967296 + d.getUint32(o, true);
    if (!Number.isSafeInteger(x)) throw new RangeError('sql: parameter outside ±2^53');
    out.push(x);
  }
  return out;
}

// a lower-case kind (i, b, t) is a field that cannot be NULL; upper case (I, B, T) is an Option field: an i64
// flag (0 for NULL), then the value when there is one
const isText = (kind: string | undefined): boolean => kind === 't' || kind === 'T';
const isOption = (kind: string | undefined): boolean => kind !== undefined && kind <= 'Z';

const cellSize = (kind: string | undefined, cell: Cell): number =>
  (isText(kind) ? 4 + 3 * cellText(cell).length : 8) + (isOption(kind) ? 8 : 0);

/** The most room the rows can take. */
function rowsSize(q: Query, row: string, rows: readonly Cell[][]): number {
  let size = 8;
  for (const r of rows) {
    if (r.length !== row.length)
      throw new Error(`sql: query returns ${r.length} columns, the row type has ${row.length}: ${q.sql}`);
    size += r.reduce<number>((n, cell, c) => n + cellSize(row[c], cell), 0);
  }
  return size;
}

/** Text at `o` as a u32 length and UTF-8 bytes, in room for 3 bytes a character; how many bytes it took in all. */
function writeText(d: DataView, mem: Uint8Array, o: number, v: string): number {
  const n = v.length;
  let i = 0;
  for (; i < n; i++) {
    const ch = v.codePointAt(i) ?? 128;
    if (ch > 127) break;
    mem[o + 4 + i] = ch;
  }
  const rest = i < n ? enc.encodeInto(v.slice(i), mem.subarray(o + 4 + i, o + 4 + 3 * n)).written : 0;
  d.setUint32(o, i + rest, true);
  return 4 + i + rest;
}

/** One cell at `o`; how many bytes it took. `wrong` says what the cell is instead of what its column should be. */
function writeCell(
  d: DataView,
  mem: Uint8Array,
  o: number,
  v: Cell,
  kind: string | undefined,
  wrong: (should: string, is: string) => Error,
): number {
  const flag = isOption(kind) ? 8 : 0;
  if (flag > 0) setInt64(d, o, v === null ? 0 : 1);
  if (flag > 0 && v === null) return flag;
  if (isText(kind)) {
    if (typeof v !== 'string') throw wrong('text', v === null ? 'NULL' : typeof v);
    return flag + writeText(d, mem, o + flag, v);
  }
  if (v === null || typeof v === 'string') throw wrong('an integer', v === null ? 'NULL' : 'text');
  setInt64(d, o + flag, int(v));
  return flag + 8;
}

/** The rows of a query, written where the module reads them; the pointer. */
export function writeRows(m: Mem, q: Query, rows: readonly Cell[][]): number {
  const row = q.row ?? '';
  const ptr = m.alloc(rowsSize(q, row, rows));
  const { d, u } = views(m);
  d.setUint32(ptr, rows.length, true);
  let c = 0;
  const wrong = (should: string, is: string): Error =>
    new Error(`sql: column ${q.columns?.[c]} should be ${should} but is ${is}: ${q.sql}`);
  let o = ptr + 8;
  for (const r of rows) for (c = 0; c < r.length; c++) o += writeCell(d, u, o, r[c] ?? null, row[c], wrong);
  return ptr;
}

// ---- JSON
// env.json(ptr, len, shape id): JSON.parse, checked against the type's shape. Writes a u32 constructor index,
// 4 bytes of padding, then that constructor's fields in order (an optional field is an i64 flag, then its value
// if present). The bytes may not be JSON of that shape: not an object, an unknown or missing key, a value of the
// wrong kind, text that is not well-formed. Refined types' conditions are checked by the module.

const KIND: Readonly<Record<string, string>> = { t: 'text', b: 'true or false', i: 'a whole number' };
const wellFormed = (s: string): boolean => s.isWellFormed();
const isObject = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
/** Why an object is not one constructor: how many fields in the problem is, and what it is. */
type Miss = { depth: number; why: string };
/** An object that is one constructor: the room it needs, and its nested values as the text handed on. */
type Fit = { size: number; raw: Map<string, string> };

// a nested value is handed over as text for a second decode (std/json.tape): an object as it stands (j); an
// array as its elements, one to a line: objects as they are (a), other values as {"value": …} (v)
function nested(f: FieldShape, x: unknown): string | null | undefined {
  if (f.kind === 'j') return isObject(x) ? JSON.stringify(x) : null;
  if (f.kind !== 'a' && f.kind !== 'v') return undefined;
  if (!Array.isArray(x)) return null;
  return x.map((el: unknown) => `${JSON.stringify(f.kind === 'a' ? el : { value: el })}\n`).join('');
}

const ofKind = (kind: string, x: unknown): boolean =>
  kind === 't' ? typeof x === 'string' : kind === 'b' ? typeof x === 'boolean' : Number.isSafeInteger(x);

/** Whether the object's keys and values are exactly this constructor's fields. */
function fit(shape: readonly FieldShape[], v: Record<string, unknown>): Fit | Miss {
  const raw = new Map<string, string>();
  let size = 8;
  let depth = 0;
  for (const f of shape) {
    const x = v[f.name];
    if (!Object.hasOwn(v, f.name)) {
      if (!f.optional) return { depth, why: `missing key ${JSON.stringify(f.name)}` };
      size += 8;
      depth++;
      continue;
    }
    const text = nested(f, x);
    if (text === null) return { depth, why: `${f.name}: expected ${f.kind === 'j' ? 'an object' : 'an array'}` };
    if (text === undefined && !ofKind(f.kind, x)) return { depth, why: `${f.name}: expected ${KIND[f.kind]}` };
    if (typeof x === 'string' && f.kind === 't' && !wellFormed(x))
      return { depth, why: `${f.name}: text with a lone surrogate` };
    if (text !== undefined) raw.set(f.name, text);
    const length = text?.length ?? (typeof x === 'string' && f.kind === 't' ? x.length : null);
    size += 8 + (length === null ? 8 : 4 + 3 * length);
    depth++;
  }
  const extra = Object.keys(v).find(k => !shape.some(f => f.name === k));
  return extra === undefined ? { size, raw } : { depth, why: `unknown key ${JSON.stringify(extra)}` };
}

/** Constructor `which` with the object's values, written where the module reads it; the pointer. */
function writeObject(
  m: Mem,
  shape: readonly FieldShape[],
  which: number,
  v: Record<string, unknown>,
  { size, raw }: Fit,
): number {
  const out = m.alloc(size);
  const d = view(m);
  const mem = bytes(m);
  d.setUint32(out, which, true);
  d.setUint32(out + 4, 0, true);
  let o = out + 8;
  for (const f of shape) {
    const here = Object.hasOwn(v, f.name);
    const x = raw.get(f.name) ?? v[f.name];
    if (f.optional) {
      setInt64(d, o, here ? 1 : 0);
      o += 8;
      if (!here) continue;
    }
    if (typeof x === 'string' && (f.kind === 't' || raw.has(f.name))) {
      const w = enc.encodeInto(x, mem.subarray(o + 4, o + 4 + 3 * x.length)).written;
      d.setUint32(o, w, true);
      o += 4 + w;
    } else {
      setInt64(d, o, f.kind === 'b' ? (x === true ? 1 : 0) : Number(x));
      o += 8;
    }
  }
  return out;
}

/**
 * JSON decoded as a type: a pointer to the value, as the first constructor whose fields are exactly the object's
 * keys with values of the right kinds; or why not, from the constructor that got furthest.
 */
export function decodeJson(m: Mem, shape: Shape, ptr: number, len: number): { at: number } | { issue: string } {
  let v: unknown;
  try {
    v = JSON.parse(strict.decode(new Uint8Array(m.memory.buffer, ptr, len)));
  } catch {
    return { issue: len > 0 ? 'not JSON' : 'empty' };
  }
  if (!isObject(v)) return { issue: 'not an object' };
  let furthest: Miss = { depth: -1, why: '' };
  for (const [which, fields] of shape.variants.entries()) {
    const found = fit(fields, v);
    if ('size' in found) return { at: writeObject(m, fields, which, v, found) };
    if (found.depth > furthest.depth) furthest = found;
  }
  return { issue: furthest.why };
}
