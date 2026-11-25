// Brief of Nov 17, 10:13: a program's names shadow std's (C01, C03, C04, C76), row-derived column lists (`*` in a
// sql_* call with `row:` is the row type's fields, C75), and the machine checker reading the program's matches.
import '../node25.ts';
import { compile, parseProgram } from '../compiler.ts';
import { instantiate } from '../host.ts';
import { interpret } from '../interp.ts';
import { std } from '../std.ts';
import { partsOf } from '../compiler/ast.ts';
import type { Expr } from '../compiler/ast.ts';
import { call, finish, functionsOf, same as T } from './harness.ts';
const run = (src: string, fn: string, args: bigint[] = []): unknown => {
  const r = compile([...std, { name: 't.tape', text: src }], { exports: [fn] });
  const [refused] = r.errors;
  if (r.wasm === null) return `ERR ${refused?.code} line ${refused?.line}: ${refused?.message}`;
  const ex = functionsOf(new WebAssembly.Module(r.wasm));
  call(ex, 'reset');
  try {
    return call(ex, fn, ...args);
  } catch (e) {
    return `TRAP ${e instanceof Error ? e.message : String(e)}`;
  }
};
const errs = (src: string, exports = src.includes('fn handle') ? undefined : ['f']) =>
  compile([...std, { name: 't.tape', text: src }], exports ? { exports } : {}).errors;
const codes = (src: string, exports?: string[]) => errs(src, exports).map(e => `${e.code}:${e.line}`);
const interp = (src: string, fn: string, args: bigint[] = []) =>
  interpret([...std, { name: 't.tape', text: src }]).call(fn, args);

// ---- 1. shadowing std
// a program's len is its own; std's code (after, decimal) keeps the built-in
const L = `fn len(v: View) -> Int {
  99
}
fn mine() -> Int {
  len(v: "abc")
}
fn theirs() -> Int {
  match after(v: "k=12345", byte: 61) {
    decimal(n) -> n
    _ -> 0
  }
}
`;
T("a program's len shadows the built-in in its file", run(L, 'mine'), 99);
T('std keeps the built-in len', run(L, 'theirs'), 12345);
T('interp agrees (program)', Number(interp(L, 'mine')), 99);
T('interp agrees (std)', Number(interp(L, 'theirs')), 12345);
// a program's find (another signature) does not capture std's after → find
const F = `fn find(v: View) -> Int {
  7
}
fn mine() -> Int {
  find(v: "x")
}
fn theirs() -> Int {
  match after(v: "k=42", byte: 61) {
    decimal(n) -> n
    _ -> 0
  }
}
`;
T("a program's find is its own", run(F, 'mine'), 7);
T("std's after still calls std's find", run(F, 'theirs'), 42);
// next, after, Step, Next, End
const N = `type Step {
  Next(n: Int)
  End
}
fn next(s: Step) -> Int {
  match s {
    Next(n) -> n + 1
    End -> 0
  }
}
fn after(n: Int) -> Int {
  n * 2
}
fn f(a: Int) -> Int {
  after(n: next(s: Next(n: a)))
}
`;
T('a program defines Step, Next, End, next and after', run(N, 'f', [20n]), 42);
T('…interp agrees', Number(interp(N, 'f', [20n])), 42);
// std's own row iteration keeps std's Step while the program has its own
const RW = `type Step {
  Walk(n: Int)
}
type Todo {
  Todo(id: Int)
}
fn total(rows: Rows[Todo], sum: Int) -> Int {
  match next(rows) {
    Next(value, rest) -> total(rows: rest, sum: sum + value.id)
    End -> sum
  }
}
fn f(db: Sql) -> Int {
  total(rows: sql_all(row: Todo, query: "SELECT id FROM todos"), sum: 0)
}
schema "CREATE TABLE todos (id INTEGER PRIMARY KEY)"
`;
T("rows iterate with std's Next/End while the program has its own Step", codes(RW), []);
const RW2 = RW.replace('type Step {\n  Walk(n: Int)\n}', 'type Go {\n  Next(n: Int)\n}');
T(
  "a program's Next where std's is meant is C76",
  codes(RW2).map(c => c.split(':')[0]),
  ['C76'],
);
T('…and the hint names std.Next', (errs(RW2)[0]?.hint ?? '').includes('std.Next'), true);
T("…hint says the program's shadows it", (errs(RW2)[0]?.hint ?? '').includes('shadows'), true);
T(
  'a core std type cannot be reused (C01)',
  codes('type Option {\n  Here\n}\nfn f(a: Int) -> Int {\n  a\n}\n').map(c => c.split(':')[0]),
  ['C01'],
);
T(
  'a core constructor cannot be reused (C03)',
  codes('type Got {\n  Some(n: Int)\n}\nfn f(a: Int) -> Int {\n  a\n}\n').map(c => c.split(':')[0]),
  ['C03'],
);
T(
  'a built-in the rules read cannot be redefined (C04)',
  codes('fn sql_first(a: Int) -> Int {\n  a\n}\nfn f(a: Int) -> Int {\n  a\n}\n').map(c => c.split(':')[0]),
  ['C04'],
);
T(
  'two program files with one constructor name is still C03',
  compile(
    [
      ...std,
      { name: 'a.tape', text: 'type A {\n  X\n}\n' },
      { name: 'b.tape', text: 'type B {\n  X\n}\nfn f(a: Int) -> Int {\n  a\n}\n' },
    ],
    { exports: ['f'] },
  ).errors.map(e => e.code),
  ['C03'],
);
T(
  "two program files with one function name: a third file's call is C45",
  compile(
    [
      ...std,
      { name: 'a.tape', text: 'fn g(a: Int) -> Int {\n  a\n}\n' },
      { name: 'b.tape', text: 'fn g(a: Int) -> Int {\n  a\n}\n' },
      { name: 'c.tape', text: 'fn f(a: Int) -> Int {\n  g(a)\n}\n' },
    ],
    { exports: ['f'] },
  ).errors.map(e => e.code),
  ['C45'],
);
// a program's refined type named as one of std's constructors (Content's Text): std's match on Content keeps its
// Text, and the program's Text(…) pattern is its refinement (examples/tools/notes.tape has `type Text`; until
// 2026-11-23, std/http.tape:225 was C14 in such a program as soon as it called respond_as)
const RT = `type Text = View where len(self) <= 5
fn handle(raw: View) -> Response {
  match raw {
    Text(t) -> buf() |> append(view: t) |> respond_as(status: 200, content: Json)
    _ -> empty(status: 413)
  }
}
`;
T("a program's refined Text beside std's Content.Text", codes(RT), []);
// and std's match tries its own Text arm on the way to Csv ("text/csv", 8 bytes), compiled and in the interpreter
const RT2 = `type Text = View where len(self) <= 5
fn f() -> Int {
  len(content_type(content: Csv))
}
`;
T("std's Text arm, beside a program's refined Text", run(RT2, 'f'), 8);
T("std's Text arm, beside a program's refined Text (interp)", Number(interp(RT2, 'f')), 8);
// a program constructor of the same name as a std one (Content's Atom, and the same for Text or Json) takes the
// bare name. `content: Atom` is then the program's, and C13 has to say so: the missing field is not a hint that
// std's Atom, which has none, was shadowed.
const SHADOW_ATOM = `type Atom { Atom(n: Int) }
fn f() -> Response {
  buf() |> respond_as(status: 200, content: Atom)
}
`;
const atomErr = compile([...std, { name: 't.tape', text: SHADOW_ATOM }], { exports: ['f'] }).errors.find(
  e => e.code === 'C13',
);
T(
  "a program's Atom shadows std's, and C13 says so",
  atomErr ? `${atomErr.code}: ${atomErr.message} | ${atomErr.hint}` : 'compiled',
  "C13: constructor Atom is missing argument n | constructor Atom takes (n). This program's Atom shadows std's Atom: rename the program's Atom to use std's here.",
);

// ---- 2. row-derived column lists
const B = `schema "CREATE TABLE orders (id INTEGER PRIMARY KEY, state TEXT NOT NULL, total INTEGER NOT NULL, note TEXT)"
schema "CREATE TABLE lines (id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL)"
type Order {
  Order(id: Int, state: View, total: Int)
}
type Counted {
  Counted(id: Int, total: Int, lines: Int)
}
`;
const Q = (row: string, query: string) =>
  B +
  `fn f(db: Sql, id: Int) -> Int {\n  match sql_first(row: ${row}, query: "${query}", id) {\n    Some(o) -> o.id\n    None -> 0\n  }\n}\n`;
const within = (e: Expr): Expr[] => [e, ...partsOf(e).flatMap(within)];
/** The query of the program's sql_first, as the compiler rewrote it. */
const queryOf = (src: string): string => {
  const body = parseProgram([...std, { name: 't.tape', text: src }]).fns.get('f')?.body;
  const queries = (body ? within(body) : []).flatMap(e => {
    const query = e.k === 'call' && e.name === 'sql_first' ? e.args.find(a => a.label === 'query')?.value : undefined;
    return query?.k === 'str' ? [new TextDecoder().decode(new Uint8Array(query.bytes))] : [];
  });
  return queries.at(-1) ?? '';
};
T(
  "SELECT * is the row type's fields",
  queryOf(Q('Order', 'SELECT * FROM orders WHERE id = :id')),
  'SELECT id, state, total FROM orders WHERE id = ?1',
);
T(
  'RETURNING * too',
  queryOf(Q('Order', "UPDATE orders SET state = 'x' WHERE id = :id RETURNING *")),
  "UPDATE orders SET state = 'x' WHERE id = ?1 RETURNING id, state, total",
);
T(
  'a table alias qualifies them',
  queryOf(Q('Order', 'SELECT * FROM orders AS o WHERE o.id = :id')),
  'SELECT o.id, o.state, o.total FROM orders AS o WHERE o.id = ?1',
);
T(
  "expr AS field fills a field that is no column, in the row's order",
  queryOf(
    Q(
      'Counted',
      'SELECT *, (SELECT count(*) FROM lines WHERE order_id = orders.id) AS lines FROM orders WHERE id = :id',
    ),
  ),
  'SELECT id, total, (SELECT count(*) FROM lines WHERE order_id = orders.id) AS lines FROM orders WHERE id = ?1',
);
T(
  'expanded queries compile and pass C69',
  [
    Q('Order', 'SELECT * FROM orders WHERE id = :id'),
    Q(
      'Counted',
      'SELECT *, (SELECT count(*) FROM lines WHERE order_id = orders.id) AS lines FROM orders WHERE id = :id',
    ),
  ].map(x => codes(x)),
  [[], []],
);
T(
  'a field that is neither is C75',
  codes(Q('Counted', 'SELECT * FROM orders WHERE id = :id')).map(c => c.split(':')[0]),
  ['C75'],
);
T(
  'an item that is no field is C75',
  codes(Q('Order', 'SELECT *, 1 AS zzz FROM orders WHERE id = :id')).map(c => c.split(':')[0]),
  ['C75'],
);
T(
  '* over a join is C75',
  codes(Q('Order', 'SELECT * FROM orders JOIN lines ON lines.order_id = orders.id WHERE orders.id = :id')).map(
    c => c.split(':')[0],
  ),
  ['C75'],
);
T(
  'count(*) is not a row star',
  queryOf(Q('Order', 'SELECT id, state, total FROM orders WHERE id = :id AND (SELECT count(*) FROM lines) > 0')),
  'SELECT id, state, total FROM orders WHERE id = ?1 AND (SELECT count(*) FROM lines) > 0',
);
T(
  'a column the row type lacks stays out (note)',
  queryOf(Q('Order', 'SELECT * FROM orders WHERE id = :id')).includes('note'),
  false,
);

// ---- 3. C59 reads the program's matches
const M = (arm: string) => `schema "CREATE TABLE subs (id INTEGER PRIMARY KEY, state TEXT NOT NULL DEFAULT 'trialing')"
machine subs.state: SubState {
  Trialing -> Active
  PastDue -> Active
  Trialing -> Canceled
  Active -> Canceled
}
fn handle(raw: View, db: Sql) -> Response {
  match request(raw) {
    Request(path: "/a/" ++ decimal(id)) -> settle(id, state: "canceled")
    Request(path: "/b/" ++ decimal(id), body) -> settle(id, state: body)
    _ -> empty(status: 404)
  }
}
fn settle(id: Int, state: View) -> Response {
  match state {
${arm}
  }
}
fn done(n: Int) -> Response {
  buf() |> write_int(value: n) |> respond(status: 200)
}
type SubState { Trialing Active PastDue Canceled }
`;
const W = `done(n: sql_exec(query: "UPDATE subs SET state = 'active' WHERE id = :id AND state = :state", id, state))`;
const c59 = (src: string) =>
  codes(src)
    .filter(c => /^C(59|60)/.test(c))
    .map(c => c.split(':')[0]);
T(
  'after a "canceled" arm, the state is not canceled: the write passes',
  c59(M(`    "canceled" -> empty(status: 409)\n    _ -> ${W}`)),
  [],
);
T('without the arm, canceled -> active from the literal path is C59', c59(M(`    _ -> ${W}`)), ['C59']);
T('a guarded arm excludes nothing after it', c59(M(`    "canceled" if id > 5 -> empty(status: 409)\n    _ -> ${W}`)), [
  'C59',
]);
T(
  'in the "past_due" arm the state is past_due: the write passes',
  c59(M(`    "past_due" -> ${W}\n    _ -> empty(status: 409)`)),
  [],
);
T(
  'excluding canceled leaves active -> active (a no-op) and past_due -> active, trialing -> active: declared',
  c59(M(`    "canceled" -> empty(status: 409)\n    "x" -> empty(status: 409)\n    _ -> ${W}`)),
  [],
);
T(
  'a condition match narrows too',
  c59(
    M(`    _ -> pick(id, state)`).replace(
      'fn done(',
      `fn pick(id: Int, state: View) -> Response {\n  match {\n    state == "canceled" -> empty(status: 409)\n    else -> ${W}\n  }\n}\nfn done(`,
    ),
  ),
  [],
);
T(
  'a copy under another name is not followed (C60, documented)',
  c59(
    M(
      `    "canceled" -> empty(status: 409)\n    _ -> {\n      let s = state\n      ${W.replace(', state))', ', state: s))')}\n    }`,
    ),
  ),
  ['C60'],
);
// C77 is left out too: this fragment moves subs to "active" and never on to "canceled" (no way out; test/timers-way-out.ts)
T(
  'the machine programs above have no other errors (C62: they write through sql_exec; C77: no way out of active)',
  codes(M(`    "canceled" -> empty(status: 409)\n    _ -> ${W}`)).filter(
    c => !c.startsWith('C62') && !c.startsWith('C77'),
  ),
  [],
);
T(
  '… and C77 is that: no write moves a subscription out of "active"',
  codes(M(`    "canceled" -> empty(status: 409)\n    _ -> ${W}`)).filter(c => c.startsWith('C77')),
  ['C77:2'],
);
{
  const set = `done(n: sql_exec(query: "UPDATE subs SET state = :state WHERE id = :id AND state = 'trialing'", state, id))`;
  T(
    'a to-state known only by exclusion is still C60',
    c59(M(`    "canceled" -> empty(status: 409)\n    _ -> ${set}`)),
    ['C60'],
  );
}
// a state passed as its constructor is its text, and an arm that names a constructor narrows as a text arm does
{
  const typed = (arms: string) =>
    M(arms)
      .replace('settle(id, state: "canceled")', 'settle(id, state: Canceled)')
      .replace('    Request(path: "/b/" ++ decimal(id), body) -> settle(id, state: body)\n', '')
      .replace('fn settle(id: Int, state: View)', 'fn settle(id: Int, state: SubState)');
  const rest = ['Trialing', 'Active', 'PastDue'].map(s => `    ${s} -> ${W}`).join('\n');
  T(
    'a constructor arm narrows: Canceled answers 409, the other states move to active',
    codes(typed(`    Canceled -> empty(status: 409)\n${rest}`)).filter(
      c => !c.startsWith('C62') && !c.startsWith('C77'),
    ),
    [],
  );
  T('… and Canceled -> active, passed as a constructor, is C59', c59(typed(`    Canceled -> ${W}\n${rest}`)), ['C59']);
}

// ---- a constructor named like one std keeps for itself (Malformed, in std/json.tape's JsonStep), in another of the
// program's files: the program's is its own, and JSON still decodes, nested records too. It was P01 in the
// generated `wire` source, with no fix, for std's `Wire_std.Malformed`.
{
  const files = [
    { name: 'parsed.tape', text: 'type Parsed {\n  Good(n: Int)\n  Malformed(reason: View)\n}\n' },
    {
      name: 'app.tape',
      text: `type Inner { Inner(n: Int) }
type Outer { Outer(inner: Inner, tag: View) }

fn f() -> Int {
  match decode(json: "{\\"inner\\":{\\"n\\":7},\\"tag\\":\\"x\\"}", as: Outer) {
    Ok(value: Outer(inner: Inner(n))) -> n + shown(p: Malformed(reason: "no"))
    Err(error) -> -1
  }
}

fn shown(p: Parsed) -> Int {
  match p {
    Good(n) -> n
    Malformed(reason) -> len(reason) * 100
  }
}
`,
    },
  ];
  const r = compile([...std, ...files], { exports: ['f'] });
  T(
    "a constructor named like std/json.tape's Malformed, in another file: it compiles",
    r.errors.map(e => `${e.code} ${e.file}:${e.line} ${e.message}`),
    [],
  );
  if (r.wasm) {
    const f = instantiate(new WebAssembly.Module(r.wasm)).exports['f'];
    T(
      'nested JSON decodes beside it (7), and the program\'s Malformed is its own (len("no") * 100)',
      typeof f === 'function' ? f() : null,
      207n,
    );
  }
}

// A name is the first file's (LANGUAGE.md §4). The blog is compiled before the renderer so its handle serves.
{
  const prog = parseProgram([
    { name: 'blog.tape', text: 'fn handle() -> Int {\n  1\n}\n' },
    { name: 'md.tape', text: 'fn handle() -> Int {\n  2\n}\n' },
  ]);
  T(
    "the first file's handle keeps the name; the later file's is md.handle",
    [...prog.fns.keys()].filter(n => n === 'handle' || n.endsWith('.handle')),
    ['handle', 'md.handle'],
  );
}

finish();
