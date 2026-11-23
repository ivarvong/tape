// decode against a reference written here: 10,000 generated documents, each decoded by the module
// (testdata/json-fuzz.tape: flat records, refinements, nested records, lists of records, of numbers and of lists,
// Option fields of every kind, several constructors, none) and by the reference, answers compared byte for byte.
// The reference is the decode the host did before the module decoded JSON itself: JSON.parse of the bytes as
// strict UTF-8, then the constructor that has all its fields among the keys and names the most of them (other keys are left unread), its values of their kinds,
// then its refinements in field order, then its records and lists, each reason with its path; except that a number
// is read exactly from its text (JSON.parse's reviver gives the text), so 1e-400 is not a whole number. The
// documents are mostly of the right shape with one thing changed: a key missing, added, repeated or of another
// kind, null, a number in every JSON form (1e3, 2.0, -0, 9007199254740992, 1e400, 1.5), escapes, astral
// characters, lone surrogates, bytes that are not UTF-8, a BOM, whitespace, cut short, trailing bytes, nested 3,000
// deep, not an object, empty. The flat types are run under the interpreter too, which decodes on its own.
import '../node25.ts';
import { readFileSync } from 'node:fs';
import { compile } from '../compiler.ts';
import { instantiate } from '../host.ts';
import { interpret } from '../interp.ts';
import { std } from '../std.ts';
import { finish, ok, same } from './harness.ts';

type Kind =
  | { k: 'int'; min?: number; max?: number; refined?: string }
  | { k: 'text'; min?: number; max?: number; refined?: string }
  | { k: 'bool' }
  | { k: 'float' }
  | { k: 'rec'; name: string }
  | { k: 'list'; of: Kind }
  | { k: 'opt'; of: Kind };
type Field = [name: string, kind: Kind];
type Ctor = { name: string; fields: Field[] };
const NAME: Kind = { k: 'text', min: 1, max: 8, refined: 'Name' };
const SMALL: Kind = { k: 'int', min: -100, max: 100, refined: 'Small' };
const INT: Kind = { k: 'int' };
const TEXT: Kind = { k: 'text' };
const TYPES: Record<string, Ctor[]> = {
  Point: [
    {
      name: 'Point',
      fields: [
        ['x', INT],
        ['y', INT],
      ],
    },
  ],
  Tag: [
    {
      name: 'Tag',
      fields: [
        ['name', NAME],
        ['on', { k: 'bool' }],
      ],
    },
  ],
  Flat: [
    {
      name: 'Flat',
      fields: [
        ['id', INT],
        ['label', TEXT],
        ['ok', { k: 'bool' }],
        ['size', SMALL],
        ['x', { k: 'float' }],
      ],
    },
  ],
  Box: [
    {
      name: 'Box',
      fields: [
        ['at', { k: 'rec', name: 'Point' }],
        ['tags', { k: 'list', of: { k: 'rec', name: 'Tag' } }],
        ['nums', { k: 'list', of: INT }],
      ],
    },
  ],
  Grid: [
    {
      name: 'Grid',
      fields: [
        ['rows', { k: 'list', of: { k: 'list', of: SMALL } }],
        ['names', { k: 'list', of: NAME }],
      ],
    },
  ],
  Deep: [
    {
      name: 'Deep',
      fields: [
        ['box', { k: 'rec', name: 'Box' }],
        ['grid', { k: 'rec', name: 'Grid' }],
        ['note', TEXT],
      ],
    },
  ],
  Maybe: [
    {
      name: 'Maybe',
      fields: [
        ['a', { k: 'opt', of: INT }],
        ['b', { k: 'opt', of: NAME }],
        ['c', { k: 'opt', of: { k: 'rec', name: 'Point' } }],
        ['d', { k: 'opt', of: { k: 'list', of: { k: 'rec', name: 'Tag' } } }],
        ['e', TEXT],
      ],
    },
  ],
  Shape: [
    { name: 'Circle', fields: [['r', SMALL]] },
    {
      name: 'Rect',
      fields: [
        ['w', INT],
        ['h', INT],
      ],
    },
    {
      name: 'Label',
      fields: [
        ['text', NAME],
        ['at', { k: 'rec', name: 'Point' }],
      ],
    },
    {
      name: 'Square',
      fields: [
        ['w', INT],
        ['r', SMALL],
      ],
    },
  ],
  Empty: [{ name: 'Empty', fields: [] }],
};
const TOP = ['Flat', 'Box', 'Grid', 'Deep', 'Maybe', 'Shape', 'Empty'];
const FLAT = new Set(['Flat', 'Empty']);

// ---- the reference
class Num {
  readonly source: string;
  constructor(source: string) {
    this.source = source;
  }
}
const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const enc = new TextEncoder();
const isObject = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === 'object' && !Array.isArray(x) && !(x instanceof Num);
/** A JSON number's value when it is a whole number within ±(2^53 - 1), read exactly; else null. */
function whole(source: string): number | null {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(source);
  if (!m) return null;
  const digits = (m[2] ?? '') + (m[3] ?? '');
  const trimmed = digits.replace(/0+$/, '');
  if (/^0*$/.test(digits)) return 0;
  const scale = Number(m[4] ?? '0') - (m[3] ?? '').length + (digits.length - trimmed.length);
  if (scale < 0) return null;
  const core = trimmed.replace(/^0+/, '');
  if (core.length + scale > 16) return null;
  const v = BigInt(core) * 10n ** BigInt(scale);
  if (v > 9007199254740991n) return null;
  return m[1] === '-' ? -Number(v) : Number(v);
}
type Fit = { ok: true } | { ok: false; depth: number; why: string };
const kindName = (k: Kind): string =>
  k.k === 'text'
    ? 'text'
    : k.k === 'bool'
      ? 'true or false'
      : k.k === 'int'
        ? 'an integer'
        : k.k === 'float'
          ? 'a number'
          : k.k === 'rec'
            ? 'an object'
            : k.k === 'list'
              ? 'an array'
              : kindName(k.of);
function check(x: unknown, there: boolean, kind: Kind, name: string, depth: number): Fit {
  const k = kind.k === 'opt' ? kind.of : kind;
  // an Option may be absent or null; anything else absent is missing, and null is null
  if (!there || x === null)
    return kind.k === 'opt' ? { ok: true } : { ok: false, depth, why: `${name}: ${there ? 'null' : 'missing'}` };
  const right =
    k.k === 'text'
      ? typeof x === 'string'
      : k.k === 'bool'
        ? typeof x === 'boolean'
        : k.k === 'int'
          ? x instanceof Num && whole(x.source) !== null
          : k.k === 'float'
            ? x instanceof Num && Number.isFinite(Number(x.source))
            : k.k === 'rec'
              ? isObject(x)
              : Array.isArray(x);
  if (!right) return { ok: false, depth, why: `${name}: expected ${kindName(k)}` };
  if (typeof x === 'string' && !x.isWellFormed())
    return { ok: false, depth, why: `${name}: expected text without lone surrogates` };
  return { ok: true };
}
type R = { ok: true; v: unknown } | { ok: false; why: string };
// what a refined kind must be, as the 400 says it: "1 to 8 bytes", "-100 to 100"
// what a refined kind refused says: its type, then its bounds, "expected Name, 1 to 8 bytes"
const rule = (k: Kind): string =>
  k.k === 'text' || k.k === 'int'
    ? `expected ${k.refined ?? ''}, ${k.min ?? 0} to ${k.max ?? 0}${k.k === 'text' ? ' bytes' : ''}`
    : '';
// a reason from inside `path`: "missing", "null", "expected …" and "not a valid …" take a colon; a deeper path a
// dot, or nothing before an index
const join = (path: string, why: string): string =>
  /^(missing|null|expected |not a valid )/.test(why) && !/^(missing|null)[^ ]/.test(why)
    ? `${path}: ${why}`
    : why.startsWith('[')
      ? path + why
      : `${path}.${why}`;
const fails = (k: Kind, v: unknown): boolean =>
  ('refined' in k && k.refined !== undefined && k.k === 'text' && typeof v === 'string'
    ? enc.encode(v).length < (k.min ?? 0) || enc.encode(v).length > (k.max ?? 1e9)
    : false) ||
  ('refined' in k && k.refined !== undefined && k.k === 'int' && typeof v === 'number'
    ? v < (k.min ?? -Infinity) || v > (k.max ?? Infinity)
    : false);
const scalar = (k: Kind, x: unknown): unknown =>
  x instanceof Num ? (k.k === 'int' ? whole(x.source) : k.k === 'float' ? Number(x.source) : x) : x;
function asRecord(type: string, o: Record<string, unknown>): R {
  const ctors = TYPES[type] ?? [];
  const fitOf = (c: Ctor): Fit =>
    c.fields.reduce<Fit>((f, [name, kind], j) => (f.ok ? check(o[name], Object.hasOwn(o, name), kind, name, j) : f), {
      ok: true,
    });
  // the constructor that has all its fields (bar Options) among the keys and names the most of them, the first on
  // a tie; a key no field names is left unread
  const named = (c: Ctor): number =>
    c.fields.some(([n, k]) => k.k !== 'opt' && !Object.hasOwn(o, n))
      ? -1
      : c.fields.filter(([n]) => Object.hasOwn(o, n)).length;
  let best: Ctor | undefined,
    most = -1;
  for (const c of ctors) if (named(c) > most) [best, most] = [c, named(c)];
  if (!best) {
    // none has its fields: the reason of the one that got furthest
    let far = -1,
      why = '';
    for (const c of ctors) {
      const f = fitOf(c);
      if (!f.ok && f.depth > far) [far, why] = [f.depth, f.why];
    }
    return { ok: false, why };
  }
  const c = best;
  const fit = fitOf(c);
  if (!fit.ok) return { ok: false, why: fit.why };
  const values: Record<string, unknown> = {};
  for (const [name, kind] of c.fields) {
    const k = kind.k === 'opt' ? kind.of : kind;
    if (k.k === 'rec' || k.k === 'list') continue;
    const v = Object.hasOwn(o, name) && o[name] !== null ? scalar(k, o[name]) : undefined;
    if (v !== undefined && fails(k, v)) return { ok: false, why: `${name}: ${rule(k)}` };
    values[name] = v;
  }
  for (const [name, kind] of c.fields) {
    const k = kind.k === 'opt' ? kind.of : kind;
    if (k.k !== 'rec' && k.k !== 'list') continue;
    if (!Object.hasOwn(o, name) || o[name] === null) continue;
    const got = deepOf(k, o[name]);
    if (!got.ok) return { ok: false, why: join(name, got.why) };
    values[name] = got.v;
  }
  return { ok: true, v: { c: c.name, values } };
}
function deepOf(k: Kind, x: unknown): R {
  if (k.k === 'rec') return isObject(x) ? asRecord(k.name, x) : { ok: false, why: 'expected an object' };
  if (k.k !== 'list' || !Array.isArray(x)) return { ok: false, why: 'expected an array' };
  const out: unknown[] = [];
  for (const [i, el] of x.entries()) {
    const got = item(k.of, el);
    if (!got.ok) return { ok: false, why: join(`[${i}]`, got.why) };
    out.push(got.v);
  }
  return { ok: true, v: out };
}
function item(k: Kind, el: unknown): R {
  if (k.k === 'rec')
    return isObject(el) ? asRecord(k.name, el) : { ok: false, why: el === null ? 'null' : 'expected an object' };
  const fit = check(el, true, k, 'value', 0);
  if (!fit.ok) return { ok: false, why: fit.why.replace(/^value(: )?/, '') };
  if (k.k === 'list') return deepOf(k, el);
  const v = scalar(k, el);
  return fails(k, v) ? { ok: false, why: rule(k) } : { ok: true, v };
}
// the answer the program writes
type Rec = { c: string; values: Record<string, unknown> };
const isRec = (x: unknown): x is Rec => isObject(x) && typeof x['c'] === 'string' && isObject(x['values']);
const asRec = (x: unknown): Rec => (isRec(x) ? x : { c: '', values: {} });
const asList = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const text = (s: unknown): string => JSON.stringify(typeof s === 'string' ? s : '');
function written(type: string, v: unknown): string {
  const r = asRec(v);
  const ctor = (TYPES[type] ?? []).find(c => c.name === r.c);
  const field = (k: Kind, x: unknown): string =>
    k.k === 'text'
      ? text(x)
      : k.k === 'int' || k.k === 'float'
        ? String(x)
        : k.k === 'bool'
          ? String(x)
          : k.k === 'rec'
            ? written(k.name, x)
            : k.k === 'list'
              ? `[${asList(x)
                  .map(e => field(k.of, e))
                  .join(',')}]`
              : field(k.of, x);
  return `{${(ctor?.fields ?? []).map(([n, k]) => `${JSON.stringify(n)}:${field(k, r.values[n])}`).join(',')}}`;
}
function answer(type: string, v: unknown): string {
  const r = asRec(v);
  const x = r.values;
  if (type === 'Maybe') {
    const opt = (y: unknown, f: (z: unknown) => string): string => (y === undefined ? '-' : f(y));
    return `a=${opt(x['a'], String)} b=${opt(x['b'], text)} c=${opt(x['c'], p => written('Point', p))} d=${opt(
      x['d'],
      l =>
        asList(l)
          .map(t => `${written('Tag', t)};`)
          .join(''),
    )} e=${text(x['e'])}`;
  }
  if (type === 'Shape')
    return r.c === 'Circle'
      ? `circle ${String(x['r'])}`
      : r.c === 'Rect'
        ? `rect ${String(x['w'])} ${String(x['h'])}`
        : r.c === 'Label'
          ? `label ${text(x['text'])} ${written('Point', x['at'])}`
          : `square ${String(x['w'])} ${String(x['r'])}`;
  if (type === 'Empty') return 'empty';
  return written(type, v);
}
function reference(type: string, bytes: Uint8Array): string {
  let v: unknown;
  let t: string;
  try {
    t = strict.decode(bytes);
    v = JSON.parse(t);
  } catch {
    return `error: ${bytes.length > 0 ? 'not JSON' : 'empty'}`;
  }
  // each number as its text (the reviver recurses, so a document nested thousands deep keeps its numbers as parsed:
  // its numbers are all under a key no type has)
  try {
    v = JSON.parse(t, (_k, value: unknown, context?: { source?: string }) =>
      typeof value === 'number' ? new Num(context?.source ?? String(value)) : value,
    );
  } catch {
    // RangeError: too deep for the reviver
  }
  if (!isObject(v)) return 'error: expected an object';
  const got = asRecord(type, v);
  return got.ok ? answer(type, got.v) : `error: ${got.why}`;
}

// ---- the documents
let seed = 20261123;
const rand = (n: number): number => {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return (seed >>> 8) % n;
};
const pick = <T>(xs: readonly T[]): T => {
  const x = xs[rand(xs.length)];
  if (x === undefined) throw new Error('nothing to pick from');
  return x;
};
const NUMBERS = [
  '0',
  '-0',
  '7',
  '-42',
  '1e3',
  '2.0',
  '-2.50e1',
  '100',
  '-100',
  '101',
  '1.5',
  '9007199254740991',
  '-9007199254740991',
  '9007199254740992',
  '1e400',
  '1e-400',
  '0.0e99',
  '1E+2',
  '12e-1',
  '120e-1',
  '0.000',
  '5e15',
  '1e16',
  '123456789012345678',
  '1.0000000000000000001',
  '00',
  '01',
  '1.',
  '.5',
  '-',
  '1e',
  '+1',
  '0x10',
];
const STRINGS = [
  '"a"',
  '"ab"',
  '""',
  '"x y"',
  '"12345678"',
  '"123456789"',
  '"\\u00e9"',
  '"é"',
  '"😀"',
  '"\\ud83d\\ude00"',
  '"\\ud800"',
  '"a\\udc00b"',
  '"\\n\\t\\"\\\\\\/"',
  '"\\u0041\\u00"',
  '"\\q"',
  '"tab\there"',
  '"\\u2028"',
  '"ñññññ"',
];
function scalarText(k: Kind): string {
  if (k.k === 'int') return rand(4) === 0 ? pick(NUMBERS) : String(rand(250) - 125);
  if (k.k === 'float') return rand(3) === 0 ? pick(NUMBERS) : pick(['0.1', '-2.5e3', '3', '1e-7', '123.456', '1e308']);
  if (k.k === 'bool') return pick(['true', 'false']);
  return rand(3) === 0 ? pick(STRINGS) : JSON.stringify('abcdefghij'.slice(0, rand(11)));
}
function valueOf(k: Kind, depth: number): string {
  if (rand(25) === 0) return pick(['null', '{}', '[]', '"s"', '3', 'true']); // the wrong kind now and then
  if (k.k === 'opt') return valueOf(k.of, depth);
  if (k.k === 'rec') return objectOf(k.name, depth + 1);
  if (k.k === 'list')
    return `[${Array.from({ length: rand(4) }, () => valueOf(k.of, depth + 1)).join(pick([',', ', ', ' ,\n']))}]`;
  return scalarText(k);
}
function objectOf(type: string, depth: number): string {
  const ctors = TYPES[type] ?? [];
  const ctor = pick(ctors);
  const members: string[] = [];
  // of several constructors, now and then the keys of two, so the one that names the most is chosen, or the first
  const fields = ctors.length > 1 && rand(3) === 0 ? [...ctor.fields, ...pick(ctors).fields] : ctor.fields;
  for (const [name, kind] of fields) {
    if (rand(kind.k === 'opt' ? 3 : 30) === 0) continue; // absent
    members.push(`${JSON.stringify(name)}:${valueOf(kind, depth)}`);
    if (rand(30) === 0) members.push(`${JSON.stringify(name)}:${valueOf(kind, depth)}`); // repeated: the last counts
  }
  if (rand(6) === 0)
    members.splice(rand(members.length + 1), 0, `${pick(['"zz"', '"0"', '"x"', '"\\ud800"'])}:${valueOf(INT, depth)}`);
  if (rand(5) === 0) members.reverse();
  return `{${members.join(pick([',', ', ', ',\n  ']))}}`;
}
function documentOf(type: string): Uint8Array {
  let t = objectOf(type, 0);
  const r = rand(40);
  if (r === 0)
    t = t.slice(0, rand(t.length + 1)); // cut short
  else if (r === 1) t += pick([' x', ',', '}', ' \n']);
  else if (r === 2) t = pick(['[]', '3', '"x"', 'null', '', ' ', '[{}]']);
  else if (r === 3) t = `﻿${t}`;
  else if (r === 4) t = `{"x":${'['.repeat(3000)}${']'.repeat(3000)}}`;
  else if (r === 5) t = ` \t\r\n${t}\n`;
  const b = enc.encode(t);
  if (rand(40) === 0 && b.length > 0) {
    const bad = Uint8Array.from(b);
    bad[rand(bad.length)] = pick([0xff, 0xc0, 0xed, 0x80]);
    return bad;
  }
  return b;
}

// ---- the module, the interpreter, the reference
const program = readFileSync(new URL('../testdata/json-fuzz.tape', import.meta.url), 'utf8');
const sources = [...std, { name: 'json-fuzz.tape', text: program }];
const built = compile(sources);
if (!built.wasm) throw new Error(built.errors.map(e => `${e.line} ${e.code} ${e.message}`).join('\n'));
const app = instantiate(new WebAssembly.Module(built.wasm), { log: false });
const it = interpret(sources);
const dec = new TextDecoder();
const N = 10000;
let agree = 0,
  interpAgree = 0,
  interpRuns = 0,
  oks = 0;
const shown: string[] = [];
const reasons = new Set<string>();
for (let i = 0; i < N; i++) {
  const type = TOP[i % TOP.length] ?? 'Flat';
  const doc = documentOf(type);
  const req = Uint8Array.from([...enc.encode(`${type}\n`), ...doc]);
  const want = reference(type, doc);
  const got = dec.decode(app.handle(req));
  if (got === want) agree++;
  else if (shown.length < 5)
    shown.push(
      `${type} ${JSON.stringify(dec.decode(doc)).slice(0, 160)}\n   module    ${got.slice(0, 160)}\n   reference ${want.slice(0, 160)}`,
    );
  if (!want.startsWith('error: ')) oks++;
  else reasons.add(want.replaceAll(/\[\d+\]/g, '[i]').replace(/"[^"]*"/, '"k"'));
  if (FLAT.has(type)) {
    interpRuns++;
    const said = dec.decode(it.handle(req));
    if (said === want) interpAgree++;
    else if (shown.length < 5)
      shown.push(
        `interpreter ${type} ${JSON.stringify(dec.decode(doc)).slice(0, 160)}\n   interp    ${said.slice(0, 160)}\n   reference ${want.slice(0, 160)}`,
      );
  }
}
same(`${N} documents: the module's decode answers as the reference`, agree, N);
same(`the interpreter, on the ${interpRuns} of flat types`, interpAgree, interpRuns);
for (const s of shown) console.log(`  ${s}`);
// the documents are not all one kind: many decode, and the reasons are of many kinds
ok(
  `${oks} decoded, ${N - oks} refused, for ${reasons.size} kinds of reason`,
  oks > 1500 && N - oks > 1500 && reasons.size > 40,
);
finish();
