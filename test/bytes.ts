// A byte literal is the Int that byte is (`'*'` is 42), checked as it is lexed, so the parser, the types and the
// code are the digits' own. This holds the spelling, the refusals, and that a program which had the digits has
// the same code, the same data and the same steps with the literal. `"*"[0]` is the contrast: a load, paid for
// at run time. No vector type is added; a parameter `Vec[Int]` stays C06.
//   node test/bytes.ts
import '../node25.ts';
import { compile } from '../compiler.ts';
import type { Options } from '../compiler.ts';
import { BYTE_ESC } from '../compiler/lex.ts';
import { format } from '../fmt.ts';
import { interpret } from '../interp.ts';
import { finish, ok, problems, same, std } from './harness.ts';

const BUILDS: Partial<Options>[] = [{}, { reuse: false }, { check: true }];

function readUleb(bytes: Uint8Array, at: number): { n: number; next: number } {
  let n = 0;
  let shift = 0;
  let i = at;
  for (;;) {
    const b = bytes[i];
    if (b === undefined) throw new Error('a uleb runs past the end of the module');
    i++;
    n += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) return { n, next: i };
    shift += 7;
  }
}

type Section = { id: number; name: string; body: Uint8Array };
/** The module's sections, a custom section named from its payload. */
function sections(wasm: Uint8Array): Section[] {
  const out: Section[] = [];
  let i = 8;
  while (i < wasm.length) {
    const id = wasm[i];
    if (id === undefined) throw new Error('a section id runs past the end of the module');
    i++;
    const size = readUleb(wasm, i);
    i = size.next;
    const body = wasm.subarray(i, i + size.n);
    i += size.n;
    let name = '';
    if (id === 0) {
      const len = readUleb(body, 0);
      name = new TextDecoder().decode(body.subarray(len.next, len.next + len.n));
    }
    out.push({ id, name, body });
  }
  return out;
}

const equal = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

function wasmOf(text: string, options: Partial<Options> = {}): Uint8Array {
  const exports = [...text.matchAll(/^fn (\w+)/gm)].map(m => m[1] ?? '');
  const r = compile([...std, { name: 't.tape', text }], { ...options, exports });
  if (r.wasm === null)
    throw new Error(`does not compile: ${r.errors.map(e => `${e.code}:${e.line} ${e.message}`).join('; ')}`);
  return r.wasm;
}

/** Every section but `build` (a hash of the source, fixed length) is the digits' own. */
function sameModule(what: string, digits: string, literal: string, options: Partial<Options> = {}): void {
  const a = sections(wasmOf(digits, options));
  const b = sections(wasmOf(literal, options));
  const bad: string[] = [];
  const shown = (s: Section): string => `${s.id}:${s.name}`;
  if (a.map(shown).join(' ') !== b.map(shown).join(' ')) bad.push('the sections differ');
  for (const left of a) {
    const right = b.find(s => s.id === left.id && s.name === left.name);
    if (!right) continue;
    if (left.name === 'build') {
      if (equal(left.body, right.body) || left.body.length !== right.body.length)
        bad.push(`build hash ${left.body.length} against ${right.body.length}`);
      continue;
    }
    if (!equal(left.body, right.body))
      bad.push(`section ${left.id || left.name}: ${left.body.length} against ${right.body.length}`);
  }
  ok(`${what}: the same module, apart from the build hash`, bad.length === 0, bad.join('; '));
}

function ran(text: string, arg: bigint): { value: string; steps: number; interp: string } {
  const wasm = wasmOf(text);
  const ex = new WebAssembly.Instance(new WebAssembly.Module(wasm), {
    env: { float_text: () => 0, float_of: () => 0 },
  }).exports;
  const reset = ex['reset'];
  const f = ex['hit'];
  const cost = ex['cost'];
  if (typeof reset !== 'function' || typeof f !== 'function' || !(cost instanceof WebAssembly.Global))
    throw new TypeError('no hit');
  reset();
  const value = String(f(arg));
  let interp: string;
  try {
    const v = interpret([...std, { name: 't.tape', text }]).call('hit', [arg]);
    interp = typeof v === 'bigint' ? String(v) : `not an int`;
  } catch (e) {
    interp = `error ${e instanceof Error ? e.message : String(e)}`;
  }
  return { value, steps: Number(cost.value), interp };
}

const hit = (test: string): string => `fn hit(b: Int) -> Int {\n  match {\n    ${test} -> 1\n    else -> 0\n  }\n}\n`;

// ---- the spelling is the Int, and the code of the digits
{
  const digits = hit('b == 42');
  const literal = hit("b == '*'");
  for (const options of BUILDS) sameModule(`'*' against 42 (${JSON.stringify(options)})`, digits, literal, options);
  for (const arg of [42n, 0n, 96n]) {
    const a = ran(digits, arg);
    const b = ran(literal, arg);
    same(
      `'*' against 42 at ${arg}: value, steps, interpreter`,
      [b.value, b.steps, b.interp],
      [a.value, a.steps, a.interp],
    );
  }
  const index = hit('b == "*"[0]');
  const d = ran(digits, 42n);
  const x = ran(index, 42n);
  const code = (text: string): number => sections(wasmOf(text)).find(s => s.id === 10)?.body.length ?? 0;
  const data = (text: string): number => sections(wasmOf(text)).find(s => s.id === 11)?.body.length ?? 0;
  // `cost` counts a recursive entry and a fused fold, not a comparison and not this load, so both stay 0.
  // What the index costs is code and a data segment.
  ok(
    '"*"[0] answers 1, in more code and more data, and the step counter charges neither',
    x.value === '1' &&
      x.interp === '1' &&
      code(index) > code(digits) &&
      data(index) > data(digits) &&
      x.steps === d.steps,
  );
  console.log(
    `  '*' is 42's code (${code(digits)} bytes of code, ${d.steps} steps); "*"[0] is +${code(index) - code(digits)} code, +${data(index) - data(digits)} data, steps ${x.steps}`,
  );
}

// ---- the call sites a byte classifier writes. Each pair is one function, the digits and then the literal.
const pairs: [string, string, string][] = [
  [
    'is_ws, the vertical tab left as 11',
    `fn is_ws(b: Int) -> Bool {\n  b == 32 or b == 9 or b == 10 or b == 13 or b == 12 or b == 11\n}\n`,
    `fn is_ws(b: Int) -> Bool {\n  b == ' ' or b == '\\t' or b == '\\n' or b == '\\r' or b == '\\f' or b == 11\n}\n`,
  ],
  [
    'is_punct, the four ranges',
    `fn is_punct(b: Int) -> Bool {\n  b >= 33 and b <= 47 or b >= 58 and b <= 64 or b >= 91 and b <= 96 or b >= 123 and b <= 126\n}\n`,
    `fn is_punct(b: Int) -> Bool {\n  b >= '!' and b <= '/' or b >= ':' and b <= '@' or b >= '[' and b <= '\`' or b >= '{' and b <= '~'\n}\n`,
  ],
  [
    'the arms of esc_from, and the two marks',
    `fn mark(b: Int) -> Int {\n  match b {\n    42 -> 1\n    96 -> 2\n    38 -> 3\n    60 -> 4\n    62 -> 5\n    34 -> 6\n    _ -> 0\n  }\n}\n`,
    "fn mark(b: Int) -> Int {\n  match b {\n    '*' -> 1\n    '`' -> 2\n    '&' -> 3\n    '<' -> 4\n    '>' -> 5\n    '\"' -> 6\n    _ -> 0\n  }\n}\n",
  ],
  [
    "hex_digit's '0'",
    `fn hex_digit(n: Int) -> Int {\n  match {\n    n < 10 -> 48 + n\n    else -> 55 + n\n  }\n}\n`,
    `fn hex_digit(n: Int) -> Int {\n  match {\n    n < 10 -> '0' + n\n    else -> 55 + n\n  }\n}\n`,
  ],
  [
    'find of a byte',
    `fn at(v: View) -> Int {\n  find(v, byte: 42, at: 0)\n}\n`,
    `fn at(v: View) -> Int {\n  find(v, byte: '*', at: 0)\n}\n`,
  ],
  [
    'single, the operator table',
    `fn single(b: Int) -> Bool {\n  match b {\n    40 -> True\n    41 -> True\n    123 -> True\n    125 -> True\n    91 -> True\n    93 -> True\n    44 -> True\n    58 -> True\n    46 -> True\n    61 -> True\n    60 -> True\n    62 -> True\n    43 -> True\n    45 -> True\n    42 -> True\n    47 -> True\n    37 -> True\n    38 -> True\n    124 -> True\n    94 -> True\n    95 -> True\n    _ -> False\n  }\n}\n`,
    `fn single(b: Int) -> Bool {\n  match b {\n    '(' -> True\n    ')' -> True\n    '{' -> True\n    '}' -> True\n    '[' -> True\n    ']' -> True\n    ',' -> True\n    ':' -> True\n    '.' -> True\n    '=' -> True\n    '<' -> True\n    '>' -> True\n    '+' -> True\n    '-' -> True\n    '*' -> True\n    '/' -> True\n    '%' -> True\n    '&' -> True\n    '|' -> True\n    '^' -> True\n    '_' -> True\n    _ -> False\n  }\n}\n`,
  ],
  [
    'is_escape',
    `fn is_escape(b: Int) -> Bool {\n  match b {\n    34 -> True\n    92 -> True\n    47 -> True\n    110 -> True\n    114 -> True\n    116 -> True\n    98 -> True\n    102 -> True\n    _ -> False\n  }\n}\n`,
    `fn is_escape(b: Int) -> Bool {\n  match b {\n    '"' -> True\n    '\\\\' -> True\n    '/' -> True\n    'n' -> True\n    'r' -> True\n    't' -> True\n    'b' -> True\n    'f' -> True\n    _ -> False\n  }\n}\n`,
  ],
  [
    'escaped',
    `fn escaped(out: Buf, b: Int) -> Buf {\n  match b {\n    38 -> append(buf: out, view: "&amp;")\n    60 -> append(buf: out, view: "&lt;")\n    62 -> append(buf: out, view: "&gt;")\n    34 -> append(buf: out, view: "&quot;")\n    _ -> push(buf: out, byte: b)\n  }\n}\n`,
    `fn escaped(out: Buf, b: Int) -> Buf {\n  match b {\n    '&' -> append(buf: out, view: "&amp;")\n    '<' -> append(buf: out, view: "&lt;")\n    '>' -> append(buf: out, view: "&gt;")\n    '"' -> append(buf: out, view: "&quot;")\n    _ -> push(buf: out, byte: b)\n  }\n}\n`,
  ],
];
for (const [what, digits, literal] of pairs) sameModule(what, digits, literal);

// 'A' + n - 10 answers what 55 + n does and is a different expression, so it is not the spelling of that arm.
{
  const digits = `fn hit(n: Int) -> Int {\n  55 + n\n}\n`;
  const literal = `fn hit(n: Int) -> Int {\n  'A' + n - 10\n}\n`;
  const a = sections(wasmOf(digits)).find(s => s.id === 10);
  const b = sections(wasmOf(literal)).find(s => s.id === 10);
  ok("'A' + n - 10 is more code than 55 + n", (b?.body.length ?? 0) > (a?.body.length ?? 0));
  console.log(`  'A' + n - 10 is +${(b?.body.length ?? 0) - (a?.body.length ?? 0)} bytes of code against 55 + n`);
  for (const n of [10n, 15n])
    same(`'A' + n - 10 at ${n} answers what 55 + n does`, ran(literal, n).value, ran(digits, n).value);
}

// ---- values, including the minus fused the way -42 is, and a hole that writes the digits
{
  const one = (expr: string, want: bigint): void => {
    const text = `fn hit(b: Int) -> Int {\n  ${expr}\n}\n`;
    const got = ran(text, 0n);
    same(`${expr} is ${want}`, [got.value, got.interp], [String(want), String(want)]);
  };
  one("'*'", 42n);
  // the closer is the next character, so the operator after it is still the operator
  one("'*' + 1", 43n);
  one("'`'", 96n);
  one("'\\n'", 10n);
  one("'\\''", 39n);
  one("'\\\\'", 92n);
  one("'\"'", 34n);
  one("' '", 32n);
  one("'\\t'", 9n);
  one("'\\r'", 13n);
  one("'\\b'", 8n);
  one("'\\f'", 12n);
  one("'\\/'", 47n);
  one("'\\\"'", 34n);
  one("-'*'", -42n);
  const neg = `fn hit(b: Int) -> Int {\n  -'*'\n}\n`;
  sameModule("-'*' against -42", `fn hit(b: Int) -> Int {\n  -42\n}\n`, neg);
  const hole = `fn hit(b: Int) -> Int {\n  len("\\('*')")\n}\n`;
  const got = ran(hole, 0n);
  same("a hole writes the digits of '*'", [got.value, got.interp], ['2', '2']);
  // a byte literal in a hole is one token: `')'` does not close the hole, and `'"'` does not end the text (it was
  // L07 and L05)
  for (const [lit, digits] of [
    ["')'", '2'],
    ["'('", '2'],
    ["'\"'", '2'],
    ["'\\''", '2'],
  ] as const) {
    const r = ran(`fn hit(b: Int) -> Int {\n  len("\\(${lit})")\n}\n`, 0n);
    same(`a hole holds ${lit}`, [r.value, r.interp], [digits, digits]);
  }
}

// ---- what is not one byte
{
  const refused = (expr: string): string =>
    problems(`fn f() -> Int {\n  ${expr}\n}\n`)
      .map(e => `${e.code} ${e.message}`)
      .join('; ');
  same("'' holds one byte", refused("''"), 'L07 a byte literal holds one byte');
  same("'ab' holds one byte", refused("'ab'"), 'L07 a byte literal holds one byte');
  same("'é' holds one byte", refused("'é'"), 'L07 a byte literal holds one byte');
  same('a bare quote is not closed', refused("'"), 'L07 a byte literal is not closed');
  same("'\\n without its quote is not closed", refused("'\\n"), 'L07 a byte literal is not closed');
  same('an unknown escape', refused("'\\q'"), 'L07 unknown escape \\q in a byte literal');
  same('an emoji is more than one byte', refused("'😀'"), 'L07 a byte literal holds one byte');
  // a raw control character between the quotes is invisible in the source: its escape or its number says it
  same('a raw tab', refused("'\t'"), 'L07 a byte literal holds a control character (9)');
  same('a raw DEL', refused("'\u007F'"), 'L07 a byte literal holds a control character (127)');
  // an error inside a hole is on the hole's line, not the hole's first line counted from 1
  same(
    'a hole reports its own line',
    problems(`fn f() -> Int {\n  let n = 1\n  len("\\(;)")\n}\n`).map(e => `${e.code}:${e.line}`),
    ['L01:3'],
  );
}

// ---- a pattern `"…"[0]` is P01, and the fix spells the byte from BYTE_ESC (the table the lexer reads)
{
  const hintFor = (text: string): string => {
    const [e] = problems(`fn f(v: View) -> Int {\n  match v[0] {\n    ${text}[0] -> 1\n    _ -> 0\n  }\n}\n`);
    return e ? `${e.code} ${e.hint}` : 'compiled';
  };
  const cases: readonly [string, string][] = [
    [String.raw`"*"`, String.raw`'*'`],
    [String.raw`"\n"`, String.raw`'\n'`],
    [String.raw`"\t"`, String.raw`'\t'`],
    [String.raw`"\r"`, String.raw`'\r'`],
    [String.raw`"\b"`, String.raw`'\b'`],
    [String.raw`"\f"`, String.raw`'\f'`],
    [String.raw`"\\"`, String.raw`'\\'`],
    [String.raw`"'"`, String.raw`'\''`],
    [String.raw`"\""`, `'"'`],
    [String.raw`"/"`, String.raw`'/'`],
    [String.raw`"\/"`, String.raw`'/'`],
    [`"${String.fromCodePoint(11)}"`, '11'],
  ];
  for (const [text, spelling] of cases) {
    const got = hintFor(text);
    same(`P01 for ${text}[0] spells ${spelling}`, got.includes(`\`${spelling} ->\``) ? 'P01' : got, 'P01');
  }
  // the cases above are the letter escapes, the quote and the backslash: the ones BYTE_ESC spells itself
  const missing: string[] = [];
  for (const [ch, byte] of Object.entries(BYTE_ESC)) {
    if (!((ch >= 'a' && ch <= 'z') || ch === '\\' || ch === "'")) continue;
    const spelling = `'\\${ch}'`;
    if (!cases.some(([, s]) => s === spelling)) missing.push(`${JSON.stringify(ch)}=${byte} as ${spelling}`);
  }
  same('every letter escape, the quote and the backslash is a hint above', missing, []);
}

// ---- the formatter keeps the spelling
{
  const src = `fn star(b: Int) -> Bool {\n  b == '*' or b == '\\n' or b == '\\''\n}\n`;
  same('fmt keeps a byte literal', format(src), src);
}

// ---- a vector is not added. The report's `let xs: Vec[Int]` is P01, the annotation, before the name is a type;
// a parameter is where the name is read, and the nearest type is Dec.
{
  same(
    'let xs: Vec[Int] is P01, the annotation',
    problems(`fn f() -> Int {\n  let xs: Vec[Int] = 1\n  xs\n}\n`).map(e => `${e.code} ${e.message}`),
    ['P01 a `let` names a value without a type'],
  );
  const [e] = problems(`fn f(xs: Vec[Int]) -> Int {\n  1\n}\n`);
  same(
    'Vec[Int] is an unknown type, and Dec is the nearest',
    e ? `${e.code} ${e.message} ${e.hint}` : 'compiled',
    'C06 unknown type Vec Did you mean `Dec`?',
  );
}

finish();
