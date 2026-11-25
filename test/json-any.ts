// std's JSON of any shape (is_json, json_member) and decode of one value (as: View, Int, Bool, a refinement),
// against JSON.parse, on the default build, the build that reuses nothing, the checked build and the interpreter
// (testdata/json-any.tape). The documents are generated values (objects and arrays nested at random, strings
// with escapes, astral characters and lone surrogate escapes, numbers at the edges of the grammar, whitespace),
// the same with one change (a byte cut, added, replaced or doubled, a byte that is not UTF-8, cut short), and
// nesting past 60 (where is_json's record of what is open spills a word) up to 100,000 deep.
// is_json is right when it is JSON.parse of the bytes read as strict UTF-8. json_member is checked against the
// member written: the last with the key (as JSON.parse and decode take it), its value's text as written; on a
// changed document, it finds a value exactly when JSON.parse reads an object with the key, and the value it finds
// is JSON.parse's.
import '../node25.ts';
import { readFileSync } from 'node:fs';
import { compile } from '../compiler.ts';
import { instantiate, responseOf } from '../host.ts';
import { interpret } from '../interp.ts';
import { std } from '../std.ts';
import { finish, ok, same } from './harness.ts';

const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const enc = new TextEncoder();
const parsed = (b: Uint8Array): { ok: true; v: unknown } | { ok: false } => {
  try {
    return { ok: true, v: JSON.parse(strict.decode(b)) };
  } catch {
    return { ok: false };
  }
};

let seed = Number(process.env['FUZZ_SEED'] ?? 20261125);
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
  '1.5',
  '9007199254740991',
  '-9007199254740991',
  '9007199254740992',
  '1e400',
  '1e-400',
  '0.0e99',
  '1E+2',
  '12e-1',
  '0.000',
  '123456789012345678901234567890',
  '1.0000000000000000001',
  '-0.0E-0',
  '0e0',
  '00',
  '01',
  '-01',
  '1.',
  '.5',
  '-',
  '1e',
  '1e+',
  '+1',
  '0x10',
  '1.e3',
  '--1',
  'Infinity',
  'NaN',
];
const STRINGS = [
  '"a"',
  '""',
  '"x y"',
  '"\\u00e9"',
  '"é"',
  '"😀"',
  '"\\ud83d\\ude00"',
  '"\\ud800"',
  '"\\udc00"',
  '"a\\udc00b"',
  '"\\ud800\\ud800"',
  '"\\ud83d\\u0041"',
  '"\\n\\t\\"\\\\\\/\\b\\f\\r"',
  '"\\u0041\\u00"',
  '"\\uZZZZ"',
  '"\\q"',
  '"\\\'"',
  '"tab\there"',
  '"\\u2028"',
  '"\u007F"',
  '"ñññññññññññññññññññññññ"',
  '"0123456789abcdef0123456789abcdef"',
  '"\\u0069d"',
  '"id"',
];
const GOOD_STRINGS = STRINGS.filter(s => parsed(enc.encode(s)).ok);
const KEYS = ['"id"', '"\\u0069d"', '"name"', '"a"', '""', '"é"', '"\\ud800"', '"x\\ny"', '"id "'];
const WS = ['', '', '', ' ', '\n', '\t', '\r\n  '];
const ws = (): string => pick(WS);
const LITERALS = ['true', 'false', 'null', 'tru', 'nul', 'falsey', 'True'];
// a member as written: its key's text, and its value's
type Member = { key: string; value: string };
function valueText(depth: number): string {
  const r = rand(depth > 5 ? 4 : 7);
  if (r === 0) return pick(NUMBERS.slice(0, 21));
  if (r === 1) return pick(GOOD_STRINGS);
  if (r === 2) return pick(LITERALS.slice(0, 3));
  if (r === 3) return String(rand(1000) - 500);
  if (r === 4)
    return `[${ws()}${Array.from({ length: rand(4) }, () => valueText(depth + 1)).join(`${ws()},${ws()}`)}${ws()}]`;
  return objectText(membersOf(depth + 1));
}
const membersOf = (depth: number): Member[] =>
  Array.from({ length: rand(5) }, () => ({ key: pick(KEYS), value: valueText(depth) }));
const objectText = (ms: readonly Member[]): string =>
  `{${ws()}${ms.map(m => `${m.key}${ws()}:${ws()}${m.value}`).join(`${ws()},${ws()}`)}${ws()}}`;
// the same text with one thing changed
function changed(t: string): Uint8Array {
  const b = enc.encode(t);
  const at = rand(b.length + 1);
  const r = rand(8);
  const BYTES = [0x7b, 0x7d, 0x5b, 0x5d, 0x2c, 0x3a, 0x22, 0x5c, 0x20, 0x30, 0x65, 0x2d, 0x2e, 0x75, 0x09, 0x00];
  if (r === 0) return Uint8Array.from([...b.subarray(0, at), ...b.subarray(at + 1)]); // a byte cut
  if (r === 1) return Uint8Array.from([...b.subarray(0, at), pick(BYTES), ...b.subarray(at)]); // a byte added
  if (r === 2 && b.length > 0) {
    const c = Uint8Array.from(b);
    c[Math.min(at, b.length - 1)] = pick(BYTES);
    return c;
  }
  if (r === 3) return b.subarray(0, at); // cut short
  if (r === 4 && b.length > 0) {
    const c = Uint8Array.from(b);
    c[Math.min(at, b.length - 1)] = pick([0xff, 0xc0, 0xed, 0x80, 0xf5, 0xe0]); // not UTF-8
    return c;
  }
  if (r === 5) return Uint8Array.from([...b.subarray(0, at), 0xed, 0xa0, 0x80, ...b.subarray(at)]); // a raw surrogate
  if (r === 6) return enc.encode(`﻿${t}`); // a BOM
  return Uint8Array.from([...b.subarray(0, at), ...b.subarray(at - 1 < 0 ? 0 : at - 1, at), ...b.subarray(at)]);
}
// nested past what one word of is_json's record holds: kinds at random, closed right or with one closer wrong
function nested(depth: number, wrong: boolean): string {
  const kinds = Array.from({ length: depth }, () => rand(2));
  const open = kinds.map(k => (k === 1 ? '{"k":' : '[')).join('');
  const close = kinds
    .toReversed()
    .map(k => (k === 1 ? '}' : ']'))
    .join('');
  const bad = wrong ? rand(close.length) : -1;
  const closing = close
    .split('')
    .map((c, i) => (i === bad ? (c === '}' ? ']' : '}') : c))
    .join('');
  return `${open}${pick(['1', '"s"', '[]', '{}'])}${closing}`;
}

// ---- the module on three builds, and the interpreter
const program = readFileSync(new URL('../testdata/json-any.tape', import.meta.url), 'utf8');
const sources = [...std, { name: 'json-any.tape', text: program }];
const BUILDS = { default: {}, 'no reuse': { reuse: false }, checked: { check: true } } as const;
const runs: [string, (req: Uint8Array) => Uint8Array][] = Object.entries(BUILDS).map(([name, opts]) => {
  const b = compile(sources, opts);
  if (!b.wasm) throw new Error(b.errors.map(e => `${e.line} ${e.code} ${e.message}`).join('\n'));
  const app = instantiate(new WebAssembly.Module(b.wasm), { log: false });
  // each answer is a 200 whose body the checks read
  return [name, (req: Uint8Array) => responseOf(app.handle(req)).body];
});
const it = interpret(sources);
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const text = (b: Uint8Array): string => Buffer.from(b).toString('latin1');
const cat = (...parts: (string | Uint8Array)[]): Uint8Array =>
  Uint8Array.from(parts.flatMap(p => [...(typeof p === 'string' ? enc.encode(p) : p)]));

let asked = 0;
const wrong: string[] = [];
/** One request on every build (the interpreter only when the document is small): each must answer `want`. */
function check(what: string, req: Uint8Array, want: (got: Uint8Array) => string | null, interp = true): void {
  const interpreter: [string, (r: Uint8Array) => Uint8Array] = [
    'interpreter',
    (r: Uint8Array) => responseOf(it.handle(r)).body,
  ];
  const all = interp ? [...runs, interpreter] : runs;
  for (const [name, run] of all) {
    asked++;
    const why = want(run(req));
    if (why !== null && wrong.length < 12) wrong.push(`${name}, ${what}: ${why} (${text(req).slice(0, 120)})`);
    else if (why !== null) wrong.push('');
  }
}
const isJson = (doc: Uint8Array, interp = true): void =>
  check(
    'is_json',
    cat('j', doc),
    got => {
      const want = parsed(doc).ok ? '1' : '0';
      return text(got) === want ? null : `gave ${text(got)}, JSON.parse says ${want}`;
    },
    interp,
  );

// ---- is_json
let valid = 0,
  invalid = 0;
const tally = (doc: Uint8Array): void => {
  if (parsed(doc).ok) valid++;
  else invalid++;
};
for (let i = 0; i < 1500; i++) {
  const t = `${ws()}${valueText(0)}${ws()}`;
  const doc = enc.encode(t);
  tally(doc);
  isJson(doc);
  const bad = changed(t);
  tally(bad);
  isJson(bad);
}
for (const n of NUMBERS) for (const d of [n, ` ${n} `, `[${n}]`, `{"a":${n}}`]) isJson(enc.encode(d));
for (const s of STRINGS) isJson(enc.encode(s));
for (const d of ['', ' ', '{', '}', '[', ']', '{}', '[]', '{"a"}', '{"a":}', '{,}', '[,]', '[1,]', '[1 2]', '"\u0001"'])
  isJson(enc.encode(d));
let nests = 0;
for (const depth of [59, 60, 61, 62, 119, 120, 121, 181, 1000]) {
  for (let i = 0; i < 6; i++) {
    const good = enc.encode(nested(depth, false)),
      bad = enc.encode(nested(depth, true));
    if (parsed(good).ok && !parsed(bad).ok) nests++;
    isJson(good, depth <= 200);
    isJson(bad, depth <= 200);
  }
}
same('nested 59 to 1,000 deep: JSON.parse reads each closed right, and none with a closer wrong', nests, 54);
for (const depth of [10000, 100000]) {
  isJson(enc.encode(`${'['.repeat(depth)}${']'.repeat(depth)}`), false);
  isJson(enc.encode(`${'['.repeat(depth)}${']'.repeat(depth - 1)}`), false);
}
ok(`is_json: ${valid} documents that are JSON, ${invalid} that are not`, valid > 1000 && invalid > 1000);

// ---- json_member
const key4 = (k: string): string => String(enc.encode(k).length).padStart(4, '0');
const memberOf = (k: string, doc: Uint8Array): Uint8Array => cat('m', key4(k), k, doc);
const deepEqual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const asObject = (v: unknown): Record<string, unknown> | null => (isRecord(v) ? v : null);
const keyOf = (written: string): string => {
  const k: unknown = JSON.parse(written);
  return typeof k === 'string' ? k : '';
};
let found = 0,
  absent = 0;
for (let i = 0; i < 1500; i++) {
  const ms = membersOf(1);
  const t = `${ws()}${objectText(ms)}${ws()}`;
  const k = keyOf(pick(KEYS));
  // the member written last with the key, once unescaped (a key with a lone surrogate is no text a request can
  // send: its UTF-8 is U+FFFD's, which the key's escape is not)
  const first = k.isWellFormed() ? ms.findLast(m => JSON.parse(m.key) === k) : undefined;
  if (first) found++;
  else absent++;
  check('json_member', memberOf(k, enc.encode(t)), got => {
    const want = first ? `some ${first.value}` : 'none';
    return hex(got) === hex(enc.encode(want)) ? null : `gave ${text(got)}, wanted ${want}`;
  });
  // changed: a value is found exactly when JSON.parse reads an object with the key, and it is JSON.parse's value
  const doc = changed(t);
  const read = parsed(doc);
  const obj = read.ok ? asObject(read.v) : null;
  const has = obj !== null && k.isWellFormed() && Object.hasOwn(obj, k);
  check('json_member of a changed document', memberOf(k, doc), got => {
    const said = text(got);
    if (said === 'none') return has ? `none, but JSON.parse finds ${JSON.stringify(k)}` : null;
    if (!said.startsWith('some ')) return `gave ${said}`;
    if (!has) return `${said}, but JSON.parse reads no object with ${JSON.stringify(k)}`;
    const raw = got.subarray(5);
    if (raw.length === 0 || [0x20, 0x09, 0x0a, 0x0d].some(c => c === raw[0] || c === raw.at(-1)))
      return 'the value is empty or has whitespace around it';
    const value = parsed(raw);
    if (!value.ok) return `the value ${said} is not JSON`;
    return deepEqual(obj[k], value.v) ? null : `${said} is not JSON.parse's value of ${JSON.stringify(k)}`;
  });
}
const M: [string, string, string][] = [
  ['id', '{"id":1,"id":2}', 'some 2'],
  ['id', '{"\\u0069d":"a","id":"b"}', 'some "b"'],
  ['id', '{"id": 1} x', 'none'],
  ['id', '{"id" : [1, {"x": 2}] , "n": 3}', 'some [1, {"x": 2}]'],
  ['id', '{"id": 1, nonsense', 'none'],
  ['n', '{"id": 1, nonsense', 'none'],
  ['id', '{"a": [1,, "id": 1}', 'none'],
  ['id', ' [ {"id": 1} ] ', 'none'],
  ['id', '"id"', 'none'],
  ['id', '{}', 'none'],
  ['id', '', 'none'],
  ['', '{"": 0}', 'some 0'],
  ['é', '{"\\u00e9": true}', 'some true'],
  ['id', '{"id": 1.5e3}', 'some 1.5e3'],
  ['id', '{"id": 01}', 'none'],
];
for (const [k, doc, want] of M)
  check(`json_member ${JSON.stringify(k)} of ${doc}`, memberOf(k, enc.encode(doc)), got =>
    text(got) === want ? null : `gave ${text(got)}, wanted ${want}`,
  );
ok(`json_member: ${found} documents with the key, ${absent} without`, found > 200 && absent > 200);

// ---- decode of one value
class Num {
  readonly source: string;
  constructor(source: string) {
    this.source = source;
  }
}
/** A JSON number's value when it is a whole number within ±(2^53 - 1), read exactly; else null. */
function whole(source: string): bigint | null {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(source);
  if (!m) return null;
  const digits = (m[2] ?? '') + (m[3] ?? '');
  const trimmed = digits.replace(/0+$/, '');
  if (/^0*$/.test(digits)) return 0n;
  const scale = Number(m[4] ?? '0') - (m[3] ?? '').length + (digits.length - trimmed.length);
  if (scale < 0) return null;
  const core = trimmed.replace(/^0+/, '');
  if (core.length + scale > 16) return null;
  const v = BigInt(core) * 10n ** BigInt(scale);
  if (v > 9007199254740991n) return null;
  return m[1] === '-' ? -v : v;
}
type Want = { ok: Uint8Array } | { error: string };
function reference(kind: 't' | 'i' | 'b' | 'n', doc: Uint8Array): Want {
  let v: unknown;
  try {
    v = JSON.parse(strict.decode(doc), (_k, x: unknown, context?: { source?: string }) =>
      typeof x === 'number' ? new Num(context?.source ?? String(x)) : x,
    );
  } catch {
    return { error: doc.length > 0 ? 'not JSON' : 'empty' };
  }
  if (v === null) return { error: 'null' };
  if (kind === 'b') return typeof v === 'boolean' ? { ok: enc.encode(String(v)) } : { error: 'expected true or false' };
  if (kind === 'i') {
    const n = v instanceof Num ? whole(v.source) : null;
    return n === null ? { error: 'expected an integer' } : { ok: enc.encode(String(n)) };
  }
  if (typeof v !== 'string') return { error: 'expected text' };
  if (!v.isWellFormed()) return { error: 'expected text without lone surrogates' };
  const b = enc.encode(v);
  if (kind === 'n' && (b.length === 0 || b.length > 8)) return { error: 'expected Name, 1 to 8 bytes' };
  return { ok: b };
}
let decoded = 0;
const docs = [
  ...NUMBERS,
  ...STRINGS,
  ...LITERALS,
  '',
  ' ',
  '[]',
  '{}',
  '{"a": 1}',
  ' "x" ',
  '"123456789"',
  '﻿"a"',
  '"a" "b"',
];
for (const d of docs)
  for (const kind of ['t', 'i', 'b', 'n'] as const) {
    const doc = enc.encode(d);
    const want = reference(kind, doc);
    if ('ok' in want) decoded++;
    check(`decode as ${kind} of ${d}`, cat(kind, doc), got => {
      const w = 'ok' in want ? hex(cat('ok ', want.ok)) : hex(enc.encode(`error ${want.error}`));
      return hex(got) === w
        ? null
        : `gave ${text(got)}, wanted ${'ok' in want ? `ok ${text(want.ok)}` : `error ${want.error}`}`;
    });
  }
ok(`decode of one value: ${decoded} of ${docs.length * 4} decoded`, decoded > 40);

// ---- what is_json costs, as its doc comment says: 64 KB of nested JSON, an array of records of five fields
// nested four deep, on each build; steps and arena bytes beyond a request that does not read the JSON
const rec = (i: number): string =>
  JSON.stringify({
    seq: i,
    name: `item ${i} é`,
    ok: i % 2 === 0,
    tags: ['a', 'b\n', `t${i}`],
    at: { x: i * 1.5, y: [-i, null, { z: 'deep' }] },
  });
const recs: string[] = [];
for (let i = 0, n = 2; n + enc.encode(rec(i)).length + 1 <= 65536; i++) {
  recs.push(rec(i));
  n += enc.encode(rec(i)).length + 1;
}
const big = enc.encode(`[${recs.join(',')}]`);
const said = /on 64 KB of nested JSON, ([\d,]+) steps and (\d+) bytes of memory/.exec(
  readFileSync(new URL('../std/json.tape', import.meta.url), 'utf8'),
);
for (const [name, opts] of Object.entries(BUILDS)) {
  const b = compile(sources, opts);
  if (!b.wasm) throw new Error('does not compile');
  const app = instantiate(new WebAssembly.Module(b.wasm), { log: false });
  const cost = (letter: string): [number, number] => {
    const answer = app.handle(cat(letter, big));
    const steps = app.exports['cost'];
    if (text(responseOf(answer).body) !== '1' || !(steps instanceof WebAssembly.Global))
      throw new Error('no answer or no cost');
    return [Number(steps.value), app.bytesUsed];
  };
  const [s0, b0] = cost('c'),
    [s1, b1] = cost('j');
  same(
    `is_json of ${big.length} bytes (${recs.length} records), ${name}: as std/json.tape says`,
    [(s1 - s0).toLocaleString('en'), String(b1 - b0)],
    [said?.[1], said?.[2]],
  );
}

same(`${asked} answers from the three builds and the interpreter agree with JSON.parse`, wrong.length, 0);
for (const w of wrong.filter(x => x !== '')) console.log(`  ${w}`);
finish();
