// The host's float_of (host/run.ts: Number of host/memory.ts textIn, the text decoded where it lies in the module's
// memory, not copied out) against JavaScript's Number of the same text, compared with Object.is (so -0 and NaN
// count): edge cases, 200,000 random decimal strings, each at a random place in memory between bytes that are not
// part of it, one at the very end of the memory and one after memory.grow; invalid UTF-8 throws as textAt does.
// Then parse_float in a compiled program through the host, against the same oracle.
import '../node25.ts';
import { compile } from '../compiler.ts';
import { instantiate, responseOf } from '../host.ts';
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

let seed = 20261123;
const rand = (n: number): number => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return Math.floor((seed / 2147483648) * n);
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
// (written with a Float parameter: a program whose own code names no Float does not import float_of, and its call of
// parse_float does not compile to valid Wasm; see the note in the commit)
const program = `fn handle(raw: View) -> Buf {
  let Request(body) = request(raw) else -> respond(status: 400)
  match parse_float(body) {
    Some(value: x) -> shown(x)
    None -> respond(status: 200) |> append(view: "none")
  }
}

fn shown(x: Float) -> Buf {
  respond(status: 200) |> append(view: "\\(x)")
}
`;
const b = compile([...std, { name: 'float-of.tape', text: program }]);
if (!b.wasm) throw new Error(b.errors.map(e => `${e.code} ${e.line} ${e.message}`).join('; '));
const app = instantiate(new WebAssembly.Module(b.wasm), { name: 'float-of' });
const answer = (text: string): string => dec.decode(responseOf(app.handle(enc.encode(`POST /f\n${text}`))).body);
const oracle = (text: string): string => {
  const x = Number(text);
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
finish();
