// The host's float_of (host/run.ts: Number of host/memory.ts textIn, the text decoded where it lies in the module's
// memory, not copied out) against JavaScript's Number of the same text, compared with Object.is (so -0 and NaN
// count): edge cases, 200,000 random decimal strings, each at a random place in memory between bytes that are not
// part of it, one at the very end of the memory and one after memory.grow; invalid UTF-8 throws as textAt does.
// Then parse_float in a compiled program through the host, against the same oracle. Then parse_float's own reading
// of a plain decimal in the module (compiler/math/decimal.ts), which asks the host only for the rest: the compiled
// build and the interpreter against Number(text) with Object.is, on the edge cases, every text of up to 4 characters
// of `0-9 . - + e` and space, and 500,000 decimals made to sit on the fast path's bounds (14 to 17 digits, 21 to 23
// after the point, mantissas within 20 of 2^53); and for each text, whether the host was asked is what the fast
// path's rule says (m <= 2^53, at most 22 places, `-?digits(.digits)?`), so the fast path is seen taken.
import '../node25.ts';
import { compile } from '../compiler.ts';
import { instantiate, responseOf } from '../host.ts';
import { interpret } from '../interp.ts';
import { MAX_MANTISSA, MAX_PLACES, POWERS } from '../compiler/math/decimal.ts';
import { textAt, textIn } from '../host/memory.ts';
import type { Mem } from '../host/memory.ts';
import { finish, ok, same, std } from './harness.ts';

/** None differ; else how many, and the first five (a line of 200,000 is cut short when the test exits). */
const none = (what: string, differ: readonly string[]): void =>
  ok(
    what,
    differ.length === 0,
    differ.length > 0 ? `${differ.length} differ, first: ${differ.slice(0, 5).join('; ')}` : '',
  );

const enc = new TextEncoder(),
  dec = new TextDecoder();
const memory = new WebAssembly.Memory({ initial: 1, maximum: 4 });
const mem: Mem = { memory, alloc: () => 0 };
const show = (x: number): string => (Object.is(x, -0) ? '-0' : String(x));

// an LCG mod 2^32 in 32-bit integer arithmetic (period 2^32); in doubles, seed * 1103515245 lost its low bits past
// 2^53 and the sequence repeated every 10,466 draws
let seed = 20261123;
const rand = (n: number): number => {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return Math.floor((seed / 4294967296) * n);
};
/** `text` written at `at` with a digit on either side, and what float_of reads there. */
const floatOfAt = (text: string, at: number): number => {
  const b = enc.encode(text),
    u = new Uint8Array(memory.buffer);
  if (at > 0) u[at - 1] = 0x37;
  u.set(b, at);
  if (at + b.length < u.length) u[at + b.length] = 0x39;
  return Number(textIn(mem, at, b.length));
};
/** What parse_float reads: the Float nearest a decimal number as std.md says it, `-1.5`, `+2`, `.5`, `1.`, `6.02e23`,
 * and NaN for any other text: the empty text, spaces around it, hex, binary or octal, `Infinity`, which JavaScript's
 * Number reads as numbers (`""` was 0, so a query parameter left empty was read as the number 0). */
const decimalNumber = (text: string): number =>
  /^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(text) ? Number(text) : NaN;
/** What `f` returned, or what it threw. */
const thrown = (f: () => unknown): unknown => {
  try {
    return f();
  } catch (e) {
    return e instanceof Error ? e.name : 'thrown';
  }
};
/** The texts whose float_of differs from Number(text), at random places in the first page. */
const wrong = (texts: readonly string[]): string[] =>
  texts
    .map(t => ({ t, got: thrown(() => floatOfAt(t, 1 + rand(60000 - 2 * enc.encode(t).length))), want: Number(t) }))
    .filter(r => !Object.is(r.got, r.want))
    .map(
      r => `${JSON.stringify(r.t)}: ${typeof r.got === 'number' ? show(r.got) : String(r.got)}, wanted ${show(r.want)}`,
    );

const EDGES = [
  '',
  ' ',
  ' \t\n',
  ' 12 ',
  '\u00A01',
  '\uFEFF1',
  '+1',
  '-0',
  '-0.0',
  '0',
  '1e400',
  '-1e400',
  '1e-400',
  '-1e-400',
  '0x10',
  '0b101',
  '0o17',
  '-0x10',
  'Infinity',
  '-Infinity',
  '+Infinity',
  'infinity',
  'NaN',
  '1_000',
  '.5',
  '5.',
  '.',
  '-.5e-3',
  '1e',
  '1e+',
  'e5',
  '١٢٣',
  '１２',
  '1€',
  '€',
  '😀',
  '9'.repeat(400),
  `0.${'0'.repeat(399)}1`,
  `1${'0'.repeat(308)}`,
  `1${'0'.repeat(309)}`,
  '5e-324',
  '2.4703282292062327e-324',
  '2.4703282292062328e-324',
  '4.9406564584124654e-324',
  '2.2250738585072011e-308',
  '2.2250738585072014e-308',
  '1.7976931348623157e308',
  '1.7976931348623158e308',
  '1.7976931348623159e308',
  '0.1',
  '0.2',
  '0.30000000000000004',
  '0.3',
  '9007199254740993',
  '9007199254740992.5',
  '1.00000000000000011102230246251565404236316680908203125',
  '123456789012345678901234567890',
];
const ROUND = [0.1 + 0.2, 1 / 3, 2 / 3, Math.PI, Math.E, Number.MIN_VALUE, Number.MAX_VALUE, Number.EPSILON, -1e-7];
const seventeen = [
  ...ROUND,
  ...Array.from({ length: 1000 }, () => (rand(2) ? -1 : 1) * (rand(2 ** 30) / 2 ** 30) * 10 ** (rand(600) - 300)),
].map(x => x.toPrecision(17));
none('edge cases: float_of is Number(text), -0 and NaN included', wrong(EDGES));
none('17 significant digits of 1,009 Floats read back as Number reads them', wrong(seventeen));
ok(
  'and those 17 digits round-trip to the Float they came from',
  ROUND.every(x =>
    Object.is(
      thrown(() => floatOfAt(x.toPrecision(17), 100)),
      x,
    ),
  ),
);

const digits = (n: number): string => Array.from({ length: n }, () => String(rand(10))).join('');
const randomText = (): string => {
  const sign = ['', '', '-', '+'][rand(4)] ?? '';
  const whole = digits(rand(25));
  const point = rand(3) === 0 ? '' : `.${digits(rand(25))}`;
  const exp = rand(3) === 0 ? `${['e', 'E'][rand(2)] ?? 'e'}${['', '-', '+'][rand(3)] ?? ''}${rand(420)}` : '';
  const pad = rand(10) === 0 ? ' ' : '';
  return `${pad}${sign}${whole}${point}${exp}${pad}`;
};
const randoms = Array.from({ length: 200000 }, randomText);
none('200,000 random decimal strings', wrong(randoms));
const atEnd = '12.5e-3';
ok(
  'text ending at the last byte of the memory',
  Object.is(
    thrown(() => floatOfAt(atEnd, memory.buffer.byteLength - atEnd.length)),
    0.0125,
  ),
);
memory.grow(1);
ok(
  'after memory.grow, read from the new buffer (in the page the old one did not have)',
  Object.is(
    thrown(() => floatOfAt('-6.25', 70000)),
    -6.25,
  ),
);
const bad = new Uint8Array(memory.buffer);
bad.set([0x31, 0xff, 0x32], 10);
same(
  'invalid UTF-8 throws, as textAt does',
  [thrown(() => textIn(mem, 10, 3)), thrown(() => textAt(mem, 10, 3))],
  ['TypeError', 'TypeError'],
);

// parse_float in a program, through the host: Some of the nearest Float, None when it is not finite or not a number
// (the program names no Float itself: parse_float is what makes the module import float_of, test/imports.ts)
const program = `fn handle(raw: View) -> Buf {
  let Request(body) = request(raw) else -> respond(status: 400)
  match parse_float(body) {
    Some(value: x) -> respond(status: 200) |> append(view: "\\(x)")
    None -> respond(status: 200) |> append(view: "none")
  }
}
`;
const b = compile([...std, { name: 'float-of.tape', text: program }]);
if (!b.wasm) throw new Error(b.errors.map(e => `${e.code} ${e.line} ${e.message}`).join('; '));
const app = instantiate(new WebAssembly.Module(b.wasm), { name: 'float-of' });
const answer = (text: string): string => dec.decode(responseOf(app.handle(enc.encode(`POST /f\n${text}`))).body);
const oracle = (text: string): string => {
  const x = decimalNumber(text);
  return Number.isFinite(x) ? String(x) : 'none';
};
const through = [...EDGES, ...seventeen.slice(0, 200), ...randoms.slice(0, 20000)];
const differ = through
  .filter(t => thrown(() => answer(t)) !== oracle(t))
  .map(t => `${JSON.stringify(t)}: ${String(thrown(() => answer(t)))}, wanted ${oracle(t)}`);
none(
  `parse_float in a compiled program, ${through.length} texts: the shortest digits of Number(text), or none`,
  differ,
);

// ---- the fast path: the module reads a plain decimal itself, Object.is-equal to Number(text)
same(
  'the powers of ten it divides by are exact: 10^k for k = 0..22',
  POWERS.map((x, k) => BigInt(x) === 10n ** BigInt(k)),
  POWERS.map(() => true),
);
/** The fast path's rule, written apart from it: is `text` one the module reads without the host? */
const plain = (text: string): boolean => {
  const m = /^-?(\d*)(?:\.(\d*))?$/.exec(text);
  if (!m) return false;
  const [, whole = '', frac = ''] = m;
  return whole.length + frac.length > 0 && frac.length <= MAX_PLACES && BigInt(`0${whole}${frac}`) <= MAX_MANTISSA;
};
const readers = `fn read_float(text: View) -> Float {
  match parse_float(text) {
    Some(value: x) -> x
    None -> 0.25f
  }
}

fn is_number(text: View) -> Int {
  match parse_float(text) {
    Some(value: _) -> 1
    None -> 0
  }
}
`;
const readerSources = [...std, { name: 'readers.tape', text: readers }];
const rb = compile(readerSources, { exports: ['read_float', 'is_number'] });
if (!rb.wasm) throw new Error(rb.errors.map(e => `${e.code} ${e.line} ${e.message}`).join('; '));
// the module with a host that counts its float_of calls
const linked: { memory: WebAssembly.Memory | null } = { memory: null };
let asked = 0;
const { exports: rx } = new WebAssembly.Instance(new WebAssembly.Module(rb.wasm), {
  env: {
    float_text: () => 0,
    float_of: (ptr: number, len: number): number => {
      asked++;
      const bytes = new Uint8Array(linked.memory?.buffer ?? new ArrayBuffer(0), ptr, len);
      return decimalNumber(new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes));
    },
  },
});
const fn = (name: string): ((...a: number[]) => unknown) => {
  const f = rx[name];
  if (typeof f !== 'function') throw new TypeError(`no export ${name}`);
  return (...a: number[]): unknown => Reflect.apply(f, null, a);
};
if (!(rx['memory'] instanceof WebAssembly.Memory)) throw new TypeError('no memory');
linked.memory = rx['memory'];
const reset = fn('reset'),
  alloc = fn('alloc'),
  readFloat = fn('read_float'),
  isNumber = fn('is_number');
const it = interpret(readerSources);
const want = (text: string): [number, bigint] => {
  const x = decimalNumber(text);
  return Number.isFinite(x) ? [x, 1n] : [0.25, 0n];
};
type Tally = { fast: number; host: number; differ: string[]; rule: string[] };
/** Each text through the module and the interpreter: what differs from Number(text), and the host calls. */
function check(texts: Iterable<string>): Tally {
  const t: Tally = { fast: 0, host: 0, differ: [], rule: [] };
  for (const text of texts) {
    const bytes = enc.encode(text);
    reset();
    const at = Number(alloc(bytes.length));
    new Uint8Array(linked.memory?.buffer ?? new ArrayBuffer(0), at, bytes.length).set(bytes);
    const before = asked;
    const x = readFloat(at, bytes.length);
    const tookHost = asked > before;
    const has = isNumber(at, bytes.length);
    const [wx, wh] = want(text);
    const ix = it.call('read_float', [bytes]),
      ih = it.call('is_number', [bytes]);
    const shown = (v: unknown): string => (typeof v === 'number' ? show(v) : typeof v);
    if (!(Object.is(x, wx) && Object.is(ix, wx) && has === wh && ih === wh))
      t.differ.push(`${JSON.stringify(text)}: ${shown(x)}/${shown(ix)}, wanted ${show(wx)}`);
    if (tookHost === plain(text)) t.rule.push(`${JSON.stringify(text)}: host ${tookHost ? 'asked' : 'not asked'}`);
    if (tookHost) t.host++;
    else t.fast++;
  }
  return t;
}
const tallies: string[] = [];
function holds(what: string, texts: Iterable<string>, leastFast: number): void {
  const t = check(texts);
  none(`${what}: the module and the interpreter give Number(text), -0 included`, t.differ);
  none(`${what}: the host is asked exactly when the text is not a plain decimal the module reads`, t.rule);
  ok(
    `${what}: ${t.fast} read in the module, ${t.host} by the host`,
    t.fast >= leastFast,
    t.fast >= leastFast ? '' : `fewer than ${leastFast}`,
  );
  tallies.push(`${what}: ${t.fast} fast, ${t.host} host`);
}
holds('edge cases', EDGES, 3);

// every text of up to 4 characters over 0-9 . - + e and space
const ALPHABET = '0123456789.-+e ';
function* short(n: number): Generator<string> {
  if (n === 0) {
    yield '';
    return;
  }
  for (const rest of short(n - 1)) for (const ch of ALPHABET) yield rest + ch;
}
function* upTo4(): Generator<string> {
  for (let n = 0; n <= 4; n++) yield* short(n);
}
holds('every text of up to 4 of `0-9.-+e `', upTo4(), 10000);

// decimals on the bounds: 14-17 significant digits (and 1-20), 21-23 places (and 0-25), mantissas near 2^53;
// with leading and trailing zeros, `.5` and `5.` forms, and a sign
const pick = <T>(xs: readonly T[]): T => {
  const x = xs[rand(xs.length)];
  if (x === undefined) throw new Error('empty');
  return x;
};
const onBounds = (): string => {
  const near = rand(8) === 0;
  const sig = near
    ? (MAX_MANTISSA + BigInt(rand(41) - 20)).toString()
    : `${1 + rand(9)}${digits((rand(3) === 0 ? 1 + rand(20) : pick([14, 15, 16, 17])) - 1)}`;
  const all = `${rand(4) === 0 ? '0'.repeat(1 + rand(3)) : ''}${sig}${rand(5) === 0 ? '0'.repeat(1 + rand(3)) : ''}`;
  const places = rand(2) === 0 ? pick([21, 22, 23]) : rand(26);
  const body =
    places > all.length
      ? `${rand(4) === 0 ? '' : '0'}.${'0'.repeat(places - all.length)}${all}`
      : `${all.slice(0, all.length - places)}${places > 0 || rand(8) === 0 ? '.' : ''}${all.slice(all.length - places)}`;
  return `${pick(['', '', '-', '-', '+'])}${body}`;
};
const bounds = Array.from({ length: 500000 }, onBounds);
const distinct = new Set(bounds).size;
ok(`the 500,000 decimals are ${distinct} different texts`, distinct > 400000);
holds('500,000 decimals on the bounds', bounds, 100000);
console.log(`fast path: ${tallies.join('; ')}`);
finish();
