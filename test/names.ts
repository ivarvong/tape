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
machine subs.state {
  "trialing" -> "active"
  "past_due" -> "active"
  "trialing" -> "canceled"
  "active" -> "canceled"
}
fn handle(raw: View, db: Sql) -> Buf {
  match request(raw) {
    Request(path: "/a/" ++ decimal(id)) -> settle(id, state: "canceled")
    Request(path: "/b/" ++ decimal(id), body) -> settle(id, state: body)
    _ -> respond(status: 404)
  }
}
fn settle(id: Int, state: View) -> Buf {
  match state {
${arm}
  }
}
fn done(n: Int) -> Buf {
  respond(status: 200) |> write_int(value: n)
}
`;
const W = `done(n: sql_exec(query: "UPDATE subs SET state = 'active' WHERE id = :id AND state = :state", id, state))`;
const c59 = (src: string) =>
  codes(src)
    .filter(c => /^C(59|60)/.test(c))
    .map(c => c.split(':')[0]);
T(
  'after a "canceled" arm, the state is not canceled: the write passes',
  c59(M(`    "canceled" -> respond(status: 409)\n    _ -> ${W}`)),
  [],
);
T('without the arm, canceled -> active from the literal path is C59', c59(M(`    _ -> ${W}`)), ['C59']);
T(
  'a guarded arm excludes nothing after it',
  c59(M(`    "canceled" if id > 5 -> respond(status: 409)\n    _ -> ${W}`)),
  ['C59'],
);
T(
  'in the "past_due" arm the state is past_due: the write passes',
  c59(M(`    "past_due" -> ${W}\n    _ -> respond(status: 409)`)),
  [],
);
T(
  'excluding canceled leaves active -> active (a no-op) and past_due -> active, trialing -> active: declared',
  c59(M(`    "canceled" -> respond(status: 409)\n    "x" -> respond(status: 409)\n    _ -> ${W}`)),
  [],
);
T(
  'a condition match narrows too',
  c59(
    M(`    _ -> pick(id, state)`).replace(
      'fn done(',
      `fn pick(id: Int, state: View) -> Buf {\n  match {\n    state == "canceled" -> respond(status: 409)\n    else -> ${W}\n  }\n}\nfn done(`,
    ),
  ),
  [],
);
T(
  'a copy under another name is not followed (C60, documented)',
  c59(
    M(
      `    "canceled" -> respond(status: 409)\n    _ -> {\n      let s = state\n      ${W.replace(', state))', ', state: s))')}\n    }`,
    ),
  ),
  ['C60'],
);
// C77 is left out too: this fragment moves subs to "active" and never on to "canceled" (no way out; test/timers-way-out.ts)
T(
  'the machine programs above have no other errors (C62: they write through sql_exec; C77: no way out of active)',
  codes(M(`    "canceled" -> respond(status: 409)\n    _ -> ${W}`)).filter(
    c => !c.startsWith('C62') && !c.startsWith('C77'),
  ),
  [],
);
T(
  '… and C77 is that: no write moves a subscription out of "active"',
  codes(M(`    "canceled" -> respond(status: 409)\n    _ -> ${W}`)).filter(c => c.startsWith('C77')),
  ['C77:2'],
);
{
  const set = `done(n: sql_exec(query: "UPDATE subs SET state = :state WHERE id = :id AND state = 'trialing'", state, id))`;
  T(
    'a to-state known only by exclusion is still C60',
    c59(M(`    "canceled" -> respond(status: 409)\n    _ -> ${set}`)),
    ['C60'],
  );
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

finish();
