// Text with holes, "Hello, \(name)": what it gives, that it is the code of the append chain it stands for, and what
// is refused. The compiled build and the reference interpreter must agree on every one.
import '../node25.ts';
import { compile } from '../compiler.ts';
import { interpret } from '../interp.ts';
import { ok, same, finish, built, moduleOf, bare, handleBare, codes, std } from './harness.ts';

const program = (body: string): string => `type P { P(n: Int) }\nfn handle(raw: View) -> Buf {\n  ${body}\n}\n`;
const answer = (body: string, input = 'ada'): string =>
  handleBare(bare(moduleOf(built(program(body)))), new TextEncoder().encode(input));
const sizeOf = (body: string): number => built(program(body)).wasm.length;

// ---- what it gives
const cases: readonly (readonly [string, string, string])[] = [
  ['text in a hole', 'buf() |> append(view: "Hello, \\(raw)!")', 'Hello, ada!'],
  [
    'a number in a hole, in decimal',
    'buf() |> append(view: "\\(len(raw)) letters, \\(0 - 42) below")',
    '3 letters, -42 below',
  ],
  ['holes side by side and at both ends', 'buf() |> append(view: "\\(raw)\\(len(raw))\\(raw)")', 'ada3ada'],
  [
    'an expression with parentheses of its own',
    'buf() |> append(view: "<\\(slice(v: raw, from: 1, to: len(raw)))>")',
    '<da>',
  ],
  ['an escape beside a hole', 'buf() |> append(view: "{\\"n\\":\\(len(raw))}\\n")', '{"n":3}\n'],
  [
    'as a value of its own (a View), not only an argument of append',
    'buf() |> append(view: "[" ++ "\\(raw):\\(len(raw))" ++ "]")',
    '[ada:3]',
  ],
  ['a literal with no hole is the text it was', 'buf() |> append(view: "no (holes) here")', 'no (holes) here'],
];
for (const [what, body, want] of cases) same(what, answer(body), want);

// ---- appended, it goes straight into that Buf: the chain of appends it stands for, with each hole's value held
// in a local on the way (a few bytes), and no Buf of its own
const chain =
  'buf() |> append(view: "Hello, ") |> append(view: raw) |> append(view: " #") |> write_int(value: len(raw)) |> append(view: "!")';
const extra = sizeOf('buf() |> append(view: "Hello, \\(raw) #\\(len(raw))!")') - sizeOf(chain);
ok(
  'appended text with holes is the chain of appends, with no Buf of its own',
  extra >= 0 && extra < 24,
  `${extra} bytes more`,
);

// ---- the interpreter agrees
for (const [what, body, want] of cases) {
  const said = interpret([...std, { name: 'program.tape', text: program(body) }]).handle(
    new TextEncoder().encode('ada'),
  );
  same(`interpreted: ${what}`, new TextDecoder().decode(said), want);
}

// ---- what is refused
same('a hole that is not closed', codes(program('buf() |> append(view: "a \\(raw")')), ['L05:3']);
same('a text literal inside a hole', codes(program('buf() |> append(view: "a \\("b")")')), ['L05:3']);
same('two expressions in a hole', codes(program('buf() |> append(view: "a \\(raw raw)")')), ['P02:3']);
same('a value that is neither text nor a number', codes(program('buf() |> append(view: "a \\(P(n: 1))")')), ['C19:3']);
same('a Buf in a hole', codes(program('buf() |> append(view: "a \\(buf())")')), ['C19:3']);
ok(
  'a query is still a literal: a hole in one is refused',
  codes(
    'schema "CREATE TABLE IF NOT EXISTS t(k TEXT PRIMARY KEY)"\nfn handle(raw: View, db: Sql) -> Buf {\n  let _ = sql_exec(db, query: "DELETE FROM t WHERE k = \'\\(raw)\'")\n  respond(status: 200)\n}\n',
  ).includes('C32:3'),
);

// ---- an Int in a hole is written by std's write_int whatever the program names its own functions: the call the
// compiler writes is text.write_int, so a program's own write_int (here of another type) is neither taken for it
// in the program's file (it was C11) nor found beside std's from a file of std (it was C45)
const OWN = 'fn write_int(x: Int) -> Int {\n  x + 1\n}\n';
const holed = (stdExtra: string, body: string): string => {
  const sources = [
    ...std.map(s => (s.name === 'std/json.tape' ? { ...s, text: `${s.text}\n${stdExtra}` } : s)),
    { name: 'own.tape', text: `${OWN}fn handle(raw: View) -> Buf {\n  ${body}\n}\n` },
  ];
  const b = compile(sources);
  if (!b.wasm) return b.errors.map(e => `${e.code}:${e.line}`).join(' ');
  return handleBare(bare(new WebAssembly.Module(b.wasm)), new TextEncoder().encode('ada'));
};
same(
  "a program's own write_int, and an Int hole in the program's file",
  holed('', 'buf() |> append(view: "\\(write_int(x: len(raw))) and \\(len(raw))")'),
  '4 and 3',
);
same(
  "an Int hole in a file of std, beside a program's own write_int",
  holed('fn hole_of(n: Int) -> View {\n  "n=\\(n)"\n}\n', 'buf() |> append(view: json.hole_of(n: len(raw)))'),
  'n=3',
);

finish();
