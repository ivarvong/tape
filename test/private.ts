// `private fn` (C94): a function called, passed as a value or matched as a pattern only in the file that defines
// it. std's helpers are private, and a program's own function of a helper's name is the program's. The calls the
// compiler writes of std's helpers (decode's decoders, write_json, write_rows, the holes of a text, fold over a
// range) are made after the check, from the program's own file, and are not refused; the program uses none of the
// helpers itself here.
import '../node25.ts';
import { compile, parseProgram } from '../compiler.ts';
import { CompileError } from '../compiler/common.ts';
import { finish, ok, problems, same, std } from './harness.ts';

// the body is a Buf, answered as its handle's 200; on the lines it was on before handle gave a Response
const handle = (body: string, more = ''): string =>
  `${more}fn answer(raw: View) -> Buf {\n  ${body}\n}\nfn handle(raw: View) -> Response {\n  answer(raw) |> respond(status: 200)\n}\n`;
const c94 = (program: string | { name: string; text: string }[]): string[] =>
  problems(program)
    .filter(p => p.code === 'C94')
    .map(p => `${p.code}:${p.file}:${p.line}`);

// ---- refused: each way a program can name one of std's helpers
same(
  'a call of a helper of std/json.tape',
  c94(handle('match json_tree(v: raw) {\n    Some -> buf()\n    None -> buf()\n  }')),
  ['C94:program.tape:2'],
);
same('by its qualified name', c94(handle('buf() |> write_int(value: json.json_ws(v: raw, at: 0))')), [
  'C94:program.tape:2',
]);
same(
  'a helper passed as a function value',
  c94(
    handle('match fold(list: Cons(head: 1, tail: Nil), from: 0, by: ten_power) {\n    0 -> buf()\n    _ -> buf()\n  }'),
  ),
  ['C94:program.tape:2'],
);
same('a helper as a function pattern', c94(handle('match raw {\n    json_tree(t) -> buf()\n    _ -> buf()\n  }')), [
  'C94:program.tape:3',
]);
same("a helper in a refined type's condition", c94(handle('buf()', 'type Token = View where cont(v: self, at: 0)\n')), [
  'C94:program.tape:1',
]);
const [hint] = problems(handle('buf() |> write_int(value: json_ws(v: raw, at: 0))'));
ok(
  'the hint of a JSON helper names decode, is_json and json_member',
  ['decode(json: body', 'is_json(text: body)', 'json_member(json: body'].every(n => hint?.hint.includes(n) ?? false),
  hint?.hint,
);
same('the message names the file', hint?.message, 'json_ws is private to std/json.tape: it may be called only there');
let interpreted = '';
try {
  parseProgram([...std, { name: 'program.tape', text: handle('buf() |> write_int(value: json_ws(v: raw, at: 0))') }]);
} catch (e) {
  if (e instanceof CompileError) interpreted = e.info.code;
}
same("the interpreter's reading of the program refuses it too", interpreted, 'C94');

// ---- a program's own `private fn`: its own file may call it, another file may not
const two = (call: string) => [
  { name: 'a.tape', text: handle(`buf() |> write_int(value: ${call})`) },
  {
    name: 'b.tape',
    text: 'private fn secret(n: Int) -> Int {\n  n + 1\n}\nfn open(n: Int) -> Int {\n  secret(n)\n}\n',
  },
];
same("another file's private fn", c94(two('secret(n: 1)')), ['C94:a.tape:2']);
same('the public function beside it', c94(two('open(n: 1)')), []);

// ---- not refused
const compiles = (what: string, program: string): void => {
  const b = compile([...std, { name: 'program.tape', text: program }]);
  ok(what, b.wasm !== null, b.errors.map(e => `${e.code}:${e.line} ${e.message}`).join('; '));
};
compiles(
  "a program's own function of a helper's name (json_ws, height), called by it",
  handle(
    'buf() |> write_int(value: json_ws(v: raw, at: 0) + height(n: 2))',
    'fn json_ws(v: View, at: Int) -> Int {\n  at + 1\n}\nfn height(n: Int) -> Int {\n  n * 2\n}\n',
  ),
);
compiles(
  "a local of a helper's name, holding a function value",
  handle('let json_ws = fn(n: Int) -> Int { n + 1 }\n  buf() |> write_int(value: json_ws(len(raw)))'),
);
compiles(
  "what the compiler writes of std's helpers: decode, write_json, write_rows, holes, fold over a range, is_json",
  `type Item { Item(sku: View, qty: Int, tags: List[View], at: Option[Int]) }
type Shape {
  Circle(r: Int)
  Square(w: Int)
}
type Row { Row(n: Int) }
schema "CREATE TABLE t(n INTEGER NOT NULL)"
fn handle(raw: View, db: Sql) -> Response {
  let total = fold(list: range(from: 1, to: 3), from: 0, by: fn(a: Int, i: Int) -> Int { a + i })
  let out = buf() |> append(view: "\\(total) \\(1.5f) \\(1.25)") |> write_bool(value: is_json(text: raw))
  let out2 = match decode(json: raw, as: Item) {
    Ok(value) -> write_json(out, value)
    Err(error) -> append(buf: out, view: error)
  }
  let out3 = match decode(json: raw, as: List[Shape]) {
    Ok(value) -> write_json(out: out2, value)
    Err -> out2
  }
  let out4 = match decode(json: raw, as: Int) {
    Ok(value) -> write_json(out: out3, value)
    Err -> out3
  }
  write_rows(out: out4, rows: sql_all(db, row: Row, query: "SELECT n FROM t")) |> respond(status: 200)
}
`,
);
finish();
