// fuzz/json.ts: write_json and decode on random types. Each seed makes a family of types (records of several fields,
// sums of several constructors, Options, Lists, Ints at their edges, big and small, Dec at several scales, Floats,
// text with every kind of character, fields named by reserved words) and a value of the top one, built in the
// program as a constructor expression. The program writes it, decodes what it wrote, writes that again, and decodes
// a second document: the value as a reference written here would send it, with its keys in another order, keys the
// type does not name, white space and \u escapes. A reference written here says what the JSON must hold (read with
// the source of each number, so a large Int is compared exactly); the two writes and the write of the second
// document must be the same bytes; and the interpreter must answer the same bytes as the module.
//   node fuzz/json.ts --seconds 60 [--seed 1] [--shard 0/8] [--only <seed>]
import { unreachable } from '../compiler/ast.ts';
import { compile } from '../compiler.ts';
import { interpret, Trap } from '../interp.ts';
import { std } from '../std.ts';
import { cli, handled, instance, seeds } from './run.ts';
import { rng } from './rng.ts';
import type { Rng } from './rng.ts';
import { decText } from './numbers.ts';

type JT =
  | { k: 'Int' }
  | { k: 'Bool' }
  | { k: 'View' }
  | { k: 'Float' }
  | { k: 'Dec'; s: number }
  | { k: 'Opt'; of: JT }
  | { k: 'List'; of: JT }
  | { k: 'Ref'; name: string };
type Ctor = { name: string; fields: [string, JT][] };
type Decl = { name: string; ctors: Ctor[] };
/** a value, as the reference holds it */
type JV =
  | { k: 'int'; v: bigint }
  | { k: 'bool'; v: boolean }
  | { k: 'text'; v: string }
  | { k: 'float'; v: number }
  | { k: 'dec'; m: bigint; s: number }
  | { k: 'none' }
  | { k: 'some'; v: JV }
  | { k: 'list'; v: JV[] }
  | { k: 'rec'; type: Decl; ctor: Ctor; v: JV[] };

const tname = (t: JT): string =>
  t.k === 'Dec'
    ? `Dec[${t.s}]`
    : t.k === 'Opt'
      ? `Option[${tname(t.of)}]`
      : t.k === 'List'
        ? `List[${tname(t.of)}]`
        : t.k === 'Ref'
          ? t.name
          : t.k;
const FIELD_NAMES = [
  'a',
  'id',
  'name',
  'type',
  'match',
  'fn',
  'value',
  'items',
  'x1',
  'amount',
  'note',
  'when',
  'key',
  'from',
  'to',
  'list',
  'error',
  'ok',
];

function typesOf(r: Rng): Decl[] {
  const decls: Decl[] = [];
  const n = r.between(1, 4);
  for (let i = 0; i < n; i++) {
    const name = `T${i}`;
    const scalar = (): JT =>
      r.one<JT>([
        { k: 'Int' },
        { k: 'Int' },
        { k: 'Bool' },
        { k: 'View' },
        { k: 'View' },
        { k: 'Float' },
        { k: 'Dec', s: r.one([0, 1, 2, 4, 9, 18]) },
      ]);
    // an Option only as a field's own type, for a key that may be absent: not inside a List, not of an Option (C09)
    const field = (depth: number): JT => {
      const c = r.int(10);
      if (c < 5 || depth > 2) return decls.length > 0 && r.chance(4) ? { k: 'Ref', name: r.one(decls).name } : scalar();
      if (c < 7 && depth === 0) return { k: 'Opt', of: field(depth + 1) };
      return { k: 'List', of: field(depth + 1) };
    };
    const ctors: Ctor[] = [];
    const nc = r.chance(3) ? r.between(2, 3) : 1;
    for (let j = 0; j < nc; j++) {
      const used = new Set<string>();
      const fields: [string, JT][] = [];
      // a constructor of a sum may have no fields
      for (let f = 0, nf = r.between(nc > 1 ? 0 : 1, 4); f < nf; f++) {
        let fname = r.one(FIELD_NAMES);
        while (used.has(fname)) fname = `${fname}${f}`;
        used.add(fname);
        fields.push([fname, field(0)]);
      }
      ctors.push({ name: `${name}c${j}`, fields });
    }
    decls.push({ name, ctors });
  }
  return decls;
}
const CHARS = [
  'a',
  'Z',
  ' ',
  '"',
  '\\',
  '/',
  '\n',
  '\t',
  '\r',
  '\b',
  '\f',
  '\u0000',
  '\u0001',
  '\u001F',
  '\u007F',
  'é',
  '€',
  '日',
  '😀',
  ' ',
  ' ',
  '﻿',
  '￿',
  '{',
  '}',
  '[',
  ':',
  ',',
];
function valueOf(r: Rng, t: JT, decls: Decl[], depth: number): JV {
  switch (t.k) {
    case 'Int':
      // within ±(2^53 - 1): an Int field takes no more from JSON (LANGUAGE.md section 9)
      return {
        k: 'int',
        v: r.one([
          0n,
          1n,
          -1n,
          9007199254740991n,
          -9007199254740991n,
          9007199254740990n,
          BigInt(r.between(-1000, 1000)),
          r.big(53) % 9007199254740992n,
          r.big(30),
        ]),
      };
    case 'Bool':
      return { k: 'bool', v: r.chance(2) };
    case 'View':
      return { k: 'text', v: Array.from({ length: r.int(8) }, () => r.one(CHARS)).join('') };
    case 'Float': {
      const x = r.one([
        0,
        -0,
        1,
        -1,
        0.1,
        1e21,
        1e-7,
        5e-324,
        1.7976931348623157e308,
        123.456,
        -2.5e-3,
        Math.PI,
        2 ** 53 + 2,
        r.int(1000) / 8,
      ]);
      return { k: 'float', v: x };
    }
    case 'Dec': {
      const max = 10n ** 18n - 1n;
      let m = r.one([0n, 1n, -1n, max, -max, BigInt(r.between(-100000, 100000)), r.big(59)]);
      if (m > max) m = max;
      if (m < -max) m = -max;
      return { k: 'dec', m, s: t.s };
    }
    case 'Opt':
      return r.chance(3) || depth > 4 ? { k: 'none' } : { k: 'some', v: valueOf(r, t.of, decls, depth + 1) };
    case 'List':
      return {
        k: 'list',
        v: depth > 4 ? [] : Array.from({ length: r.int(3) }, () => valueOf(r, t.of, decls, depth + 1)),
      };
    case 'Ref': {
      const type = decls.find(d => d.name === t.name);
      if (!type) throw new Error(`no type ${t.name}`);
      const ctor = r.one(type.ctors);
      return { k: 'rec', type, ctor, v: ctor.fields.map(([, ft]) => valueOf(r, ft, decls, depth + 1)) };
    }
  }
  return unreachable(t, 'case');
}
// ---- the value as a Tape expression
/** a Tape text expression: literals for what a literal can hold, ctl(c) for the other control bytes, joined by ++ */
const tapeText = (s: string): string => {
  const parts: string[] = [];
  let lit = '';
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (ch === '"') lit += '\\"';
    else if (ch === '\\') lit += '\\\\';
    else if (ch === '\n') lit += '\\n';
    else if (ch === '\t') lit += '\\t';
    else if (ch === '\r') lit += '\\r';
    else if (ch === '\b') lit += '\\b';
    else if (ch === '\f') lit += '\\f';
    else if (c < 32 || c === 127) {
      if (lit) parts.push(`"${lit}"`);
      lit = '';
      parts.push(`ctl(${c})`);
    } else lit += ch;
  }
  if (lit || parts.length === 0) parts.push(`"${lit}"`);
  return parts.join(' ++ ');
};
const floatText = (x: number): string => {
  const s = Object.is(x, -0) ? '-0' : String(x);
  return `${s.replace('e+', 'e')}f`;
};
function expr(v: JV, t: JT): string {
  switch (v.k) {
    case 'int':
      return String(v.v);
    case 'bool':
      return v.v ? 'True' : 'False';
    case 'text':
      return tapeText(v.v);
    case 'float':
      // -0f is the literal 0f negated
      return Object.is(v.v, -0) ? '(-zero())' : floatText(v.v);
    case 'dec':
      return v.s === 0 ? `dec(n: ${v.m}, scale: 0)` : decText(v.m, v.s);
    case 'none':
      return `none_of_${slug(t)}()`;
    case 'some':
      return `Some(value: ${expr(v.v, t.k === 'Opt' ? t.of : t)})`;
    case 'list': {
      const of = t.k === 'List' ? t.of : t;
      return v.v.reduceRight((tail, x) => `Cons(head: ${expr(x, of)}, tail: ${tail})`, `nil_of_${slug(t)}()`);
    }
    case 'rec':
      return v.ctor.fields.length === 0
        ? v.ctor.name
        : `${v.ctor.name}(${v.ctor.fields.map(([f, ft], i) => `${f}: ${expr(v.v[i] ?? { k: 'none' }, ft)}`).join(', ')})`;
  }
  return unreachable(v, 'case');
}
const slug = (t: JT): string => tname(t).replaceAll(/[^A-Za-z0-9]/g, '_');
/** the typed None and Nil each Option and List type needs */
function emptiesOf(decls: Decl[]): string {
  const seen = new Map<string, string>();
  const walk = (t: JT): void => {
    if (t.k === 'Opt') {
      seen.set(`none_of_${slug(t)}`, `fn none_of_${slug(t)}() -> ${tname(t)} {\n  None\n}\n`);
      walk(t.of);
    } else if (t.k === 'List') {
      seen.set(`nil_of_${slug(t)}`, `fn nil_of_${slug(t)}() -> ${tname(t)} {\n  Nil\n}\n`);
      walk(t.of);
    }
  };
  for (const d of decls) for (const c of d.ctors) for (const [, t] of c.fields) walk(t);
  return [...seen.values()].join('\n');
}
// ---- the reference: what the JSON must be, as JS values compared by their source text
type Ref = string; // canonical JSON text, written here
function canonical(v: JV): Ref {
  switch (v.k) {
    case 'int':
      return String(v.v);
    case 'bool':
      return String(v.v);
    case 'text':
      return JSON.stringify(v.v);
    case 'float':
      return String(v.v); // -0 is written 0, as JSON.stringify writes it, and reads back equal
    case 'dec':
      return JSON.stringify(decText(v.m, v.s));
    case 'none':
      return 'null';
    case 'some':
      return canonical(v.v);
    case 'list':
      return `[${v.v.map(canonical).join(',')}]`;
    case 'rec': {
      const body = `{${v.ctor.fields
        .map(([f], i) => [f, v.v[i]] as const)
        .filter(([, x]) => x !== undefined && x.k !== 'none')
        .map(([f, x]) => `${JSON.stringify(f)}:${canonical(x ?? { k: 'none' })}`)
        .join(',')}}`;
      return v.type.ctors.length > 1 ? `{${JSON.stringify(v.ctor.name)}:${body}}` : body;
    }
  }
  return unreachable(v, 'case');
}
/** the same value as a client might send it: keys reordered, keys the type does not name, spaces, escapes */
function sent(r: Rng, v: JV): string {
  const sp = (): string => r.one(['', '', ' ', '\n  ', '\t']);
  switch (v.k) {
    case 'int':
      return r.chance(6) && v.v !== 0n ? `${v.v}e0` : r.chance(8) ? `${v.v}.0` : String(v.v);
    case 'text':
      return `"${Array.from(v.v)
        .map(ch => (ch === '/' && r.chance(2) ? '\\/' : r.chance(3) ? escape(ch) : JSON.stringify(ch).slice(1, -1)))
        .join('')}"`;
    case 'float':
      return r.chance(4) ? (Object.is(v.v, -0) ? '-0.0' : v.v.toExponential()) : canonical(v);
    case 'dec':
      // a Dec is read from a number or from text: either, exact
      return r.chance(2) ? decText(v.m, v.s) : JSON.stringify(decText(v.m, v.s));
    case 'none':
      return 'null';
    case 'some':
      return sent(r, v.v);
    case 'list':
      return `[${sp()}${v.v.map(x => sent(r, x)).join(`,${sp()}`)}${sp()}]`;
    case 'bool':
      return String(v.v);
    case 'rec': {
      let members = v.ctor.fields
        .map(([f], i) => [f, v.v[i]] as const)
        .filter(([, x]) => x !== undefined && !(x.k === 'none' && r.chance(2)))
        .map(([f, x]) => `${JSON.stringify(f)}${sp()}:${sp()}${sent(r, x ?? { k: 'none' })}`);
      if (r.chance(3)) members.push(`"zz_unread":${r.one(['1', '"x"', '[1,{"a":[]}]', 'null', '{"type":2}'])}`);
      if (r.chance(2)) members = members.toReversed();
      const body = `{${sp()}${members.join(`,${sp()}`)}${sp()}}`;
      return v.type.ctors.length > 1 ? `{${JSON.stringify(v.ctor.name)}:${body}}` : body;
    }
  }
  return unreachable(v, 'case');
}
const escape = (ch: string): string =>
  Array.from(ch)
    .flatMap(c => {
      const cp = c.codePointAt(0) ?? 0;
      if (cp < 0x10000) return [cp];
      const u = cp - 0x10000;
      return [0xd800 + (u >> 10), 0xdc00 + (u & 0x3ff)];
    })
    .map(u => `\\u${u.toString(16).padStart(4, '0')}`)
    .join('');

function programOf(decls: Decl[], top: string, value: string): string {
  const types = decls
    .map(
      d =>
        `type ${d.name} {\n${d.ctors.map(c => `  ${c.name}${c.fields.length > 0 ? `(${c.fields.map(([f, t]) => `${f}: ${tname(t)}`).join(', ')})` : ''}`).join('\n')}\n}\n`,
    )
    .join('\n');
  return `${types}
${emptiesOf(decls)}
fn zero() -> Float {
  0f
}

fn ctl(c: Int) -> View {
  freeze(buf: buf() |> push(byte: c))
}

fn handle(raw: View) -> Buf {
  let v = ${value}
  let w = freeze(buf: buf() |> write_json(value: v))
  let again = match decode(json: w, as: ${top}) {
    Ok(value) -> freeze(buf: buf() |> write_json(value))
    Err(error) -> "ERR " ++ error
  }
  let read = match decode(json: raw, as: ${top}) {
    Ok(value) -> freeze(buf: buf() |> write_json(value))
    Err(error) -> "ERR " ++ error
  }
  buf() |> append(view: w) |> push(byte: 10) |> append(view: again) |> push(byte: 10) |> append(view: read)
}
`;
}

export type JsonVerdict = { docs: number; bad: string | null };
const enc = new TextEncoder();
export function jsonCase(seed: number): JsonVerdict {
  const r = rng(seed);
  const decls = typesOf(r),
    top = decls.at(-1) ?? { name: 'T0', ctors: [] };
  const v = valueOf(r, { k: 'Ref', name: top.name }, decls, 0);
  const text = programOf(decls, top.name, expr(v, { k: 'Ref', name: top.name }));
  const sources = [...std, { name: 'j.tape', text }];
  const b = compile(sources);
  if (b.wasm === null)
    return { docs: 0, bad: `refused ${b.errors[0]?.code} line ${b.errors[0]?.line}: ${b.errors[0]?.message}\n${text}` };
  const run = instance(new WebAssembly.Module(b.wasm));
  const it = interpret(sources);
  const want = canonical(v);
  let docs = 0;
  for (let i = 0; i < 16; i++) {
    const doc = sent(r, v);
    const got = handled(run, enc.encode(doc)).out;
    docs++;
    const lines = Buffer.from(got, 'latin1').toString('utf8').split('\n');
    const [w, again, read] = lines;
    if (lines.length !== 3) return { docs, bad: `the program answered ${JSON.stringify(got.slice(0, 300))}\n${text}` };
    if (w !== want) return { docs, bad: `write_json wrote ${w}, the reference ${want}\n${text}` };
    if (again !== w)
      return { docs, bad: `decode of what write_json wrote, written again: ${again}, first ${w}\n${text}` };
    if (read !== w) return { docs, bad: `decode of ${doc}, written: ${read}, wanted ${w}\n${text}` };
    let meant: string;
    try {
      const out = it.call('handle', [enc.encode(doc)]);
      meant = out instanceof Uint8Array ? Buffer.from(out).toString('latin1') : 'not bytes';
    } catch (e) {
      meant = e instanceof Trap ? `trap ${e.code}` : `threw ${e instanceof Error ? e.message : String(e)}`;
    }
    if (meant !== got)
      return {
        docs,
        bad: `the interpreter answered ${JSON.stringify(meant.slice(0, 300))}, the module ${JSON.stringify(got.slice(0, 300))}\n${text}`,
      };
  }
  return { docs, bad: null };
}

if (import.meta.main) {
  const c = cli();
  let docs = 0,
    bad = 0,
    cases = 0;
  const start = Date.now();
  for (const seed of seeds(c)) {
    const v = jsonCase(seed);
    cases++;
    docs += v.docs;
    if (v.bad) {
      bad++;
      console.log(`FINDING json seed=${seed}: ${c.only === null ? v.bad.split('\n')[0] : v.bad}`);
    }
  }
  const s = (Date.now() - start) / 1000;
  console.log(`json: ${cases} types, ${docs} documents, ${bad} findings, ${(docs / s).toFixed(0)} docs/s`);
}
