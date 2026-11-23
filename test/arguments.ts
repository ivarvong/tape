// How a call passes its arguments (LANGUAGE.md section 4): by name; a variable named like the parameter bare; and
// the one argument of a one-parameter function bare, whatever expression it is, for a function, a generic
// function, a function value and a built-in alike. A call of a function with two or more parameters names every
// argument that is not such a variable (C10), and the refusal shows the call written that way.
import '../node25.ts';
import { compile } from '../compiler.ts';
import { interpret } from '../interp.ts';
import { std } from '../std.ts';
import { bare, call, finish, same } from './harness.ts';

const program = `fn fact(n: Int) -> Int {
  match {
    n <= 1 -> 1
    else -> n * fact(n - 1)
  }
}

fn twice[T](x: T) -> List[T] {
  Cons(head: x, tail: Cons(head: x, tail: Nil))
}

fn count[T](list: List[T]) -> Int {
  match list {
    Cons(tail) -> 1 + count(tail)
    Nil -> 0
  }
}

fn apply(f: Fn[Int, Int], x: Int) -> Int {
  f(f(x + 1))
}

fn nested() -> Int {
  let pair = twice(fact(2))
  fact(fact(3) - 2) + count(pair) + len("ab" ++ "c")
}

fn through_value() -> Int {
  apply(f: fn(v: Int) -> Int { v * 10 }, x: 1)
}

fn of_five() -> Int {
  fact(5)
}
`;
// fact(fact(3) - 2) = 4! = 24; a list of two; "abc" is 3 long. ((1 + 1) * 10) * 10 = 200. 5! = 120.
const want = { nested: 24n + 2n + 3n, through_value: 200n, of_five: 120n };
const r = compile([...std, { name: 't.tape', text: program }], { exports: Object.keys(want) });
same(
  'one-parameter calls with any expression compile',
  r.errors.map(e => `${e.code} ${e.line} ${e.message}`),
  [],
);
if (r.wasm) {
  const ex = bare(new WebAssembly.Module(r.wasm));
  const it = interpret([...std, { name: 't.tape', text: program }]);
  for (const [fn, value] of Object.entries(want)) {
    call(ex.fns, 'reset');
    same(`${fn}: compiled and interpreted`, [call(ex.fns, fn), it.call(fn, [])], [value, value]);
  }
}

const refusal = (text: string): string => {
  const [e] = compile([...std, { name: 't.tape', text }], { exports: ['f'] }).errors;
  return e ? `${e.code} ${e.line}: ${e.message} | ${e.hint}` : 'compiled';
};
const POW = `fn pow(b: Int, e: Int) -> Int {
  match {
    e <= 0 -> 1
    else -> b * pow(b, e - 1)
  }
}

fn f() -> Int {
  pow(b: 2, e: 10)
}
`;
const RULE = "A variable with the parameter's name can be passed bare.";
same(
  'two parameters: an unnamed expression is refused, and the fix is shown',
  refusal(POW),
  `C10 4: arguments must be named | function pow takes (b, e): the first argument may be written without its name, and each one after it is \`name: value\`, as in \`pow(b, e: e - 1)\`. ${RULE}`,
);
same(
  'two parameters, both unnamed',
  refusal('fn add(a: Int, b: Int) -> Int {\n  a + b\n}\n\nfn f() -> Int {\n  add(1, 2 * 3)\n}\n'),
  `C10 6: arguments must be named | function add takes (a, b): the first argument may be written without its name, and each one after it is \`name: value\`, as in \`add(a: 1, b: 2 * 3)\`. ${RULE}`,
);
same('named, it compiles', refusal(POW.replace('pow(b, e - 1)', 'pow(b, e: e - 1)')), 'compiled');

// The 0.3 usability bench: `load(order.id)` for `fn load(id: Int)` that reads the database was C10 "takes (id,
// db)", and `existing(invoice_id)` for a parameter `id` was C11, in 10 of its 12 C11s. The `db` the compiler adds
// (compiler/ambient.ts) is not a parameter the program wrote: a function of one written parameter takes its
// argument bare, and no refusal names the added one.
const AMBIENT = `schema "CREATE TABLE t(id INTEGER PRIMARY KEY, n INTEGER NOT NULL)"

type Row { Row(id: Int, n: Int) }

fn handle(raw: View, db: Sql) -> Buf {
  let invoice_id = 7
  match load(invoice_id) {
    Some(value: Row(n)) -> respond(status: 200) |> append(view: "\\(n + total(id: invoice_id, scale: 2))")
    None -> respond(status: 404)
  }
}

fn load(id: Int) -> Option[Row] {
  sql_first(row: Row, query: "SELECT id, n FROM t WHERE id = :id", id)
}

fn total(id: Int, scale: Int) -> Int {
  let Some(value: Row(n)) = load(id) else -> 0
  n * scale
}
`;
const ambientRefusal = (text: string): string => {
  const [e] = compile([...std, { name: 't.tape', text }]).errors;
  return e ? `${e.code} ${e.line}: ${e.message} | ${e.hint}` : 'compiled';
};
same(
  'a function of one written parameter and the added db takes its argument bare',
  ambientRefusal(AMBIENT),
  'compiled',
);
{
  // the interpreter binds the bare argument the same way: with the row (7, 5), n + total = 5 + 5 * 2
  const it = interpret([...std, { name: 't.tape', text: AMBIENT }], { rows: () => [[7, 5]], exec: () => 0 });
  same(
    'the interpreter takes the bare argument too',
    new TextDecoder().decode(it.handle(new TextEncoder().encode('GET /\n'))),
    '200\n15',
  );
}
same(
  'with an expression too',
  ambientRefusal(AMBIENT.replace('match load(invoice_id)', 'match load(invoice_id + 0)')),
  'compiled',
);
same(
  'C10 names the written parameters only, and the call written that way',
  ambientRefusal(AMBIENT.replace('total(id: invoice_id, scale: 2)', 'total(invoice_id + 0, 2)')),
  `C10 8: arguments must be named | function total takes (id, scale): the first argument may be written without its name, and each one after it is \`name: value\`, as in \`total(id: invoice_id + 0, scale: 2)\`. ${RULE}`,
);
same(
  'the added db passed by hand is taken too',
  ambientRefusal(AMBIENT.replace('total(id: invoice_id, scale: 2)', 'total(id: invoice_id, scale: 2, db)')),
  'compiled',
);
same(
  'C11 for a shorthand argument shows the call written with the parameter name',
  ambientRefusal(AMBIENT.replace('total(id: invoice_id, scale: 2)', 'total(scale: 2, invoice_id)')),
  'C11 8: function total has no parameter invoice_id | function total takes (id, scale). `invoice_id` was read as shorthand for `invoice_id: invoice_id`; write `total(scale: 2, id: invoice_id)`.',
);
same(
  'C11 for a named argument shows the call written with the parameter it most likely meant',
  ambientRefusal(AMBIENT.replace('total(id: invoice_id, scale: 2)', 'total(id: invoice_id, scal: 2)')),
  'C11 8: function total has no parameter scal | function total takes (id, scale): write `total(id: invoice_id, scale: 2)`.',
);

finish();
