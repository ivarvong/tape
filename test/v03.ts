// Tape 0.3: the forms that remove what the usability benchmark measured agents tripping on
// (lab_notebook/tape-2026-11-21/usability-baseline.md). Each form is checked compiled and, where it gives a program a
// meaning, in the reference interpreter too; each refusal by its code.
import '../node25.ts';
import { DatabaseSync } from 'node:sqlite';
import { compile } from '../compiler.ts';
import { interpret } from '../interp.ts';
import { std } from '../std.ts';
import { instantiate, responseOf } from '../host.ts';
import { rng } from '../sim.ts';
import { nodeSql } from '../nodesql.ts';
import { call, finish, functionsOf, same as T, answered } from './harness.ts';

/** f(args) compiled and interpreted, as one answer when the two agree. */
const run = (src: string, fn: string, args: bigint[] = []): unknown => {
  const r = compile([...std, { name: 't.tape', text: src }], { exports: [fn] });
  const [no] = r.errors;
  if (r.wasm === null) return `ERR ${no?.code} line ${no?.line}: ${no?.message}`;
  const ex = functionsOf(new WebAssembly.Module(r.wasm));
  call(ex, 'reset');
  let compiled: unknown;
  try {
    compiled = call(ex, fn, ...args);
  } catch (e) {
    compiled = `TRAP ${e instanceof Error ? e.message : String(e)}`;
  }
  let interpreted: unknown;
  try {
    interpreted = interpret([...std, { name: 't.tape', text: src }]).call(fn, args);
  } catch (e) {
    interpreted = `TRAP ${e instanceof Error ? e.message : String(e)}`;
  }
  return typeof compiled === 'bigint' && compiled === interpreted
    ? Number(compiled)
    : `compiled ${String(compiled)}, interpreted ${String(interpreted)}`;
};
/** A program's handle, as text in and text out. */
const served = (src: string): ((request: string) => string) => {
  const r = compile([...std, { name: 't.tape', text: src }]);
  const [no] = r.errors;
  if (r.wasm === null) return () => `ERR ${no?.code} line ${no?.line}: ${no?.message}`;
  const app = instantiate(new WebAssembly.Module(r.wasm), { log: false });
  return request => answered(app.handle(new TextEncoder().encode(request)));
};
const codes = (src: string, exports: string[] = ['f']): string[] =>
  compile([...std, { name: 't.tape', text: src }], { exports }).errors.map(e => `${e.code}:${e.line}`);
const fix = (src: string, exports: string[] = ['f']): string =>
  compile([...std, { name: 't.tape', text: src }], { exports }).errors.map(
    e => `${e.code} ${e.message} | ${e.hint}`,
  )[0] ?? 'it compiles';

// ---- 1. match is an expression wherever a value is
const O = `type O {
  A(n: Int)
  B
}

`;
T(
  'match: a let value',
  run(
    `${O}fn f(o: O) -> Int {
  let n = match o {
    A(n: k) -> k * 2
    B -> 1
  }
  n + 1
}

fn t(k: Int) -> Int {
  f(o: A(n: k))
}
`,
    't',
    [5n],
  ),
  11,
);
T(
  'match: a condition match as a let value',
  run(
    `fn f(n: Int) -> Int {
  let big = match {
    n > 5 -> 100
    else -> 0
  }
  big + n
}
`,
    'f',
    [7n],
  ),
  107,
);
T(
  'match: an argument',
  run(
    `fn twice(n: Int) -> Int {
  n * 2
}

fn f(n: Int) -> Int {
  twice(match n {
    0 -> 10
    _ -> n
  })
}
`,
    'f',
    [0n],
  ),
  20,
);
T(
  'match: the left side of a pipe, and an operand',
  run(
    `fn plus(a: Int, b: Int) -> Int {
  a + b
}

fn f(n: Int) -> Int {
  let x = match n {
    1 -> 5
    _ -> 6
  }
    |> plus(b: 100)
  x + match {
    n == 1 -> 1000
    else -> 0
  }
}
`,
    'f',
    [1n],
  ),
  1105,
);
T(
  'match: in a let inside an arm inside a function value',
  run(
    `${O}fn f(k: Int) -> Int {
  let g = fn(o: O) -> Int {
    let m = match o {
      A(n) -> n
      B -> 0
    }
    m * 3
  }
  g(match k {
    0 -> B
    _ -> A(n: k)
  })
}
`,
    'f',
    [4n],
  ),
  12,
);
T(
  "match: a let's arms take steps of their own",
  run(
    `${O}fn f(k: Int) -> Int {
  let n = match k {
    0 -> {
      let A(n) = A(n: 9) else -> 0
      n
    }
    _ -> k
  }
  n + 1
}
`,
    'f',
    [0n],
  ),
  10,
);
T(
  'match: a Buf chosen by a let match is used once',
  run(
    `fn f(n: Int) -> Int {
  let out = match {
    n > 0 -> buf() |> append(view: "200\\n")
    else -> buf() |> append(view: "404\\n")
  }
  len(freeze(buf: out |> append(view: "ab")))
}
`,
    'f',
    [1n],
  ),
  6,
);
T(
  'match: a refined first arm gives its base type',
  run(
    `type Small = Int where self < 10

fn f(n: Int) -> Int {
  let m = match n {
    Small(s) -> s
    _ -> 99
  }
  m + 1
}
`,
    'f',
    [3n],
  ),
  4,
);
T(
  'match: a let match must still cover its subject (C24)',
  codes(`${O}fn f(o: O) -> Int {
  let n = match o {
    A(n: k) -> k
  }
  n
}
`),
  ['C24:7'],
);
T(
  'match: every arm has the first arm’s type (C14)',
  codes(`fn f(n: Int) -> Int {
  let x = match n {
    0 -> 1
    _ -> "one"
  }
  x
}
`),
  ['C14:4'],
);
T(
  'match: where nothing gives the type, the first arm says it (C21 names the fix)',
  fix(`fn f(n: Int) -> Int {
  let x = match n {
    0 -> None
    _ -> Some(value: n)
  }
  0
}
`).replace(/ \|.*/, ''),
  'C21 cannot tell which Option this None is',
);

// ---- 3. a reserved word names a field: declared, built, read with a dot, matched, decoded and written as JSON
const EVENT = `type Event {
  Event(type: View, match: Int)
}

type Nested {
  Nested(type: View, list: List[Event])
}

fn handle(raw: View) -> Response {
  let r = request(raw)
  match r.path {
    "/flat" -> {
      let Ok(value: e) = decode(json: r.body, as: Event) else {
        Err(error) -> buf() |> append(view: error) |> respond(status: 400)
      }
      let Event(type: kind, match: m) = e
      buf() |> append(view: "\\(e.type) \\(kind) \\(m) ") |> write_json(value: e) |> respond(status: 200)
    }
    _ -> {
      let Ok(value: n) = decode(json: r.body, as: Nested) else {
        Err(error) -> buf() |> append(view: error) |> respond(status: 400)
      }
      buf() |> write_json(value: n) |> respond(status: 200)
    }
  }
}
`;
{
  const app = served(EVENT);
  T(
    'a field named type: decoded, read with a dot, matched, written back',
    app('POST /flat\n{"type":"view","match":3}'),
    '200\nview view 3 {"type":"view","match":3}',
  );
  T(
    'a field named type, inside a record and a list',
    app('POST /nested\n{"type":"batch","list":[{"type":"a","match":1},{"type":"b","match":2}]}'),
    '200\n{"type":"batch","list":[{"type":"a","match":1},{"type":"b","match":2}]}',
  );
  T(
    'a field named type, built',
    run(
      `type Event {
  Event(type: Int, if: Int)
}

fn f(n: Int) -> Int {
  let e = Event(type: n, if: 2)
  e.type * e.if
}
`,
      'f',
      [4n],
    ),
    8,
  );
}
T(
  'a reserved word cannot be bound by its own name in a pattern (P01 says what to write)',
  fix(`type Event {
  Event(type: Int)
}

fn f(e: Event) -> Int {
  let Event(type) = e
  type
}
`),
  'P01 `type` is a reserved word: a field of that name is matched, not bound by its own name | Name what it binds: `type: kind`.',
);
T(
  'a reserved word as a variable: P01 names it and says where it can stand',
  fix(`fn f(type: Int) -> Int {
  type
}
`).split(' | ')[0],
  'P01 expected a name but found `type`, a reserved word',
);

// ---- 5. C69: a PRIMARY KEY column read into a field that cannot be NULL. SQLite is the oracle: each table is made
// in node:sqlite and sent a NULL key; the compiler must take a View/Int field exactly when SQLite refuses the NULL.
{
  const tables = [
    'CREATE TABLE t(id TEXT PRIMARY KEY, n INTEGER NOT NULL)',
    'CREATE TABLE t(id TEXT PRIMARY KEY NOT NULL, n INTEGER NOT NULL)',
    'CREATE TABLE t(id TEXT PRIMARY KEY, n INTEGER NOT NULL) STRICT',
    'CREATE TABLE t(id TEXT PRIMARY KEY, n INTEGER NOT NULL) WITHOUT ROWID',
    'CREATE TABLE t(id INTEGER PRIMARY KEY, n INTEGER NOT NULL)',
    'CREATE TABLE t(id INTEGER PRIMARY KEY DESC, n INTEGER NOT NULL)',
    'CREATE TABLE t(id INT PRIMARY KEY, n INTEGER NOT NULL)',
    'CREATE TABLE t(id INTEGER, n INTEGER NOT NULL, PRIMARY KEY(id))',
  ];
  for (const ddl of tables) {
    const db = new DatabaseSync(':memory:');
    db.exec(ddl);
    let refusesNull = false;
    try {
      db.exec('INSERT INTO t(id, n) VALUES (NULL, 1)');
      refusesNull = db.prepare('SELECT id FROM t').all()[0]?.['id'] !== null;
    } catch {
      refusesNull = true;
    }
    const field = ddl.includes('id TEXT') ? 'View' : 'Int';
    const src = `migration 1 "t" {
  ${ddl}
}

type Row {
  Row(id: ${field}, n: Int)
}

fn f(db: Sql) -> Int {
  match sql_first(row: Row, query: "SELECT id, n FROM t") {
    Some(value) -> value.n
    None -> 0
  }
}
`;
    T(
      `C69 agrees with SQLite: ${ddl.slice(13)} ${refusesNull ? 'never holds' : 'may hold'} a NULL key`,
      codes(src),
      refusesNull ? [] : ['C69:10'],
    );
  }
  T(
    'C69 on a PRIMARY KEY: the fix is the declaration to write',
    fix(`migration 1 "t" {
  CREATE TABLE t(id TEXT PRIMARY KEY, n INTEGER NOT NULL)
}

type Row {
  Row(id: View, n: Int)
}

fn f(db: Sql) -> Int {
  match sql_first(row: Row, query: "SELECT id, n FROM t") {
    Some(value) -> value.n
    None -> 0
  }
}
`).split(' | ')[1],
    'Add NOT NULL to the column in its migration: `id TEXT PRIMARY KEY NOT NULL`.',
  );
}

// ---- 9. every pattern a match arm takes stands in `let … else`, text patterns that open with a name too
{
  const Q = `fn f(n: Int) -> Int {
  let text = match n {
    0 -> "a=12&b=3"
    1 -> "b=3"
    _ -> "a=x"
  }
  value_of(text)
}

fn value_of(text: View) -> Int {
  let head ++ "&" ++ rest = text else -> -1
  let "a=" ++ digits = head else -> -2
  let decimal(v) = digits else -> -3
  v * 10 + len(rest)
}
`;
  T(
    'let: a split, a prefix and a function pattern, each with else',
    [0n, 1n, 2n].map(n => run(Q, 'f', [n])),
    [123, -1, -1],
  );
  T(
    'let: name = Pattern still binds the whole value inside brackets',
    run(
      `type W {
  W(text: View)
}

fn f(n: Int) -> Int {
  let W(text: whole = "x" ++ rest) = W(text: "xyz") else -> 0
  len(whole) * 10 + len(rest)
}
`,
      'f',
      [0n],
    ),
    32,
  );
}

// ---- 6. C14: a value of one type where another is wanted; the fix says the rewrite for the mistakes agents made
// (the todo and sales tasks passed an Option[View]; ledger a record to rollback; invoice a List to len)
{
  const hint = (src: string): string => fix(src, ['handle']).split(' | ')[1] ?? '';
  T(
    'C14 Option for its base: the fix is the step that takes the value out',
    hint(`fn handle(raw: View) -> Response {
  let r = request(raw)
  buf() |> append(view: r.query) |> respond(status: 200)
}
`),
    '`r.query` may be None. Take the value out first, with a step that says what happens when it is None: `let Some(value) = r.query else -> …`, then pass `value`. Or match it, with an arm for `Some(value)` and one for `None`.',
  );
  // the step the fix shows compiles where the refused call stood
  T(
    '…and the step it shows compiles',
    codes(
      `fn handle(raw: View) -> Response {
  let r = request(raw)
  let Some(value) = r.query else -> empty(status: 400)
  buf() |> append(view: value) |> respond(status: 200)
}
`,
      ['handle'],
    ),
    [],
  );
  T(
    'C14 a base where an Option is wanted: wrap it',
    fix(`fn g(o: Option[Int]) -> Int {
  0
}

fn f(n: Int) -> Int {
  g(o: n)
}
`).split(' | ')[1],
    'An Option is wanted: `Some(value: n)`, or `None`.',
  );
  T(
    'C14 a record where a Response is wanted: answer it as JSON',
    (
      fix(
        `type Outcome {
  Outcome(status: Int)
}

fn handle(raw: View) -> Response {
  rollback(out: Outcome(status: 409))
}
`,
        ['handle'],
      ).split(' | ')[1] ?? ''
    ).startsWith('A Response is an answer (std/http.tape), and Outcome is not: `json(status: 200, value: …)`'),
    true,
  );
}

// ---- 8. a field matched by a pattern binds its own name when nothing else binds it (the ledger agent wrote
// `Some(value: Account(balance: b)) if b == balance -> … value …` twice; queue and tickets did the same)
{
  const ACC = `type Account {
  Account(id: Int, balance: Int)
}

`;
  T(
    'a field matched by a pattern is bound by its name',
    run(
      `${ACC}fn f(n: Int) -> Int {
  match Some(value: Account(id: 7, balance: n)) {
    Some(value: Account(balance: b)) if b == 5 -> value.id * 100 + b
    Some(value) -> value.id
    None -> 0
  }
}
`,
      'f',
      [5n],
    ),
    705,
  );
  T(
    '…in a let … else step too, and the sibling arm that binds the name itself is unchanged',
    [5n, 6n].map(n =>
      run(
        `${ACC}fn f(n: Int) -> Int {
  let Some(value: Account(balance: 5)) = Some(value: Account(id: n, balance: n)) else {
    Some(value) -> value.id * 10
    None -> 0
  }
  value.id
}
`,
        'f',
        [n],
      ),
    ),
    [5, 60],
  );
  T(
    'two fields of one name in scope at once: neither is bound, and C16 says how to bind one',
    fix(`${ACC}fn f(o: Option[Account], p: Option[Account]) -> Int {
  match o {
    Some(value: Account(balance: 1)) -> match p {
      Some(value: Account(balance: 2)) -> value.id
      _ -> 0
    }
    _ -> 0
  }
}
`),
    'C16 unknown name value | `Some(value: Pattern)` matches the field value without binding it. To have both, write `Some(value: value = Pattern)` (name = Pattern).',
  );
  T(
    'a name the program binds wins: a parameter of the field’s name is read, not the field',
    run(
      `${ACC}fn g(value: Int, o: Option[Account]) -> Int {
  match o {
    Some(value: Account(balance: 1)) -> value
    _ -> 0
  }
}

fn f(n: Int) -> Int {
  g(value: n, o: Some(value: Account(id: 9, balance: 1)))
}
`,
      'f',
      [3n],
    ),
    3,
  );
}

// ---- 7. a parse or lex error names the problem and what to write (todo: `Some("")` in a pattern; webhook: a
// backtick to quote `type`, a reserved word as a field; and the forms other languages have that Tape does not)
{
  const said = (src: string): string => fix(src).replace(/ \| .*/, '');
  T(
    'a pattern alone for the one field of a constructor is that field’s, as an argument is',
    run(
      `fn f(n: Int) -> Int {
  let o = match n {
    0 -> Some(value: "")
    _ -> Some(value: "x")
  }
  match o {
    Some("") -> 1
    Some(decimal(k)) -> k
    _ -> 2
  }
}
`,
      'f',
      [0n],
    ),
    1,
  );
  T(
    'a pattern alone for a constructor of two fields: C10 names them',
    fix(`type P {
  P(a: Int, b: Int)
}

fn f(p: P) -> Int {
  match p {
    P(1, b) -> b
    _ -> 0
  }
}
`),
    'C10 a pattern for a field of P names the field | P has the fields (a, b): write `P(a: …, b: …)`, leaving out the ones not looked at. Only a constructor with one field takes its pattern unnamed, `Some("")`.',
  );
  T(
    'the characters and words other languages have',
    [
      'type E {\n  E(`type`: View)\n}\n\nfn f(n: Int) -> Int {\n  1\n}\n',
      'fn f(n: Int) -> Int {\n  let a = 1;\n  a\n}\n',
      'fn f(n: Int) -> Bool {\n  n > 1 && n < 3\n}\n',
      'fn f(n: Int) -> Bool {\n  !(n > 1)\n}\n',
      "fn f(n: Int) -> Int {\n  'hello'\n}\n",
      'fn f(n: Int) -> Int {\n  if n > 1 { 1 } else { 2 }\n}\n',
      'fn f(n: Int) -> Int {\n  return n\n}\n',
      'fn f(n: Int) -> Int {\n  let x: Int = n\n  x\n}\n',
      'fn f(n: Int) -> Int {\n  let a = 1 let b = 2\n  a\n}\n',
    ].map(said),
    [
      'L01 a backtick: Tape has no quoted names',
      'L01 a semicolon: a new line ends a step in Tape',
      'L01 && for and: Tape writes `and`',
      'L01 a `!`: Tape negates with `not`',
      'L07 a byte literal holds one byte',
      'P02 Tape has no `if`: a condition match branches',
      'P02 Tape has no `return`: a block is worth its last expression',
      'P01 a `let` names a value without a type',
      'P01 expected a new line but found `let`',
    ],
  );
  T(
    'C22 of a method call on a value says Tape has no methods',
    fix('fn f(n: Int) -> Int {\n  n.to_string()\n}\n').split(' | ')[1]?.startsWith('`n` is a value, not a capability'),
    true,
  );
}

// ---- 10. std helpers agents wrote by hand: byte classes, every_byte, min/max, parse_int. parse_int is checked
// against BigInt on generated texts (an independent reading), compiled and interpreted.
{
  const P = `fn handle(raw: View) -> Response {
  match parse_int(text: request(raw).body) {
    Some(value) -> buf() |> write_int(value) |> respond(status: 200)
    None -> empty(status: 400)
  }
}
`;
  const app = served(P);
  const it = interpret([...std, { name: 't.tape', text: P }]);
  const r = rng(7);
  const pick = (xs: readonly string[]): string => xs[Math.floor(r() * xs.length)] ?? '';
  const texts = [
    '',
    '-',
    '+',
    '0',
    '-0',
    '007',
    '9223372036854775807',
    '9223372036854775808',
    '-9223372036854775808',
    '-9223372036854775809',
    '00000000000000000000009223372036854775807',
    ' 1',
    '1 ',
    '1.5',
    '--1',
    '+-1',
    ...Array.from({ length: 400 }, () =>
      Array.from({ length: 1 + Math.floor(r() * 22) }, (_, i) =>
        pick(i === 0 ? ['-', '+', '0', '1', '9', 'x', ''] : ['0', '1', '5', '9', '9', '9', 'a', ' ']),
      ).join(''),
    ),
  ];
  const oracle = (t: string): string => {
    if (!/^[+-]?\d+$/.test(t)) return 'None';
    const v = BigInt(t);
    return v >= -(2n ** 63n) && v < 2n ** 63n ? String(v) : 'None';
  };
  const compiled = (t: string): string => {
    const out = app(`POST /\n${t}`);
    return out.startsWith('200\n') ? out.slice(4) : 'None';
  };
  const interpreted = (t: string): string => {
    const v: unknown = it.call('parse_int', [new TextEncoder().encode(t)]);
    if (typeof v !== 'object' || v === null || !('c' in v) || v.c !== 'Some' || !('f' in v)) return 'None';
    const f: unknown = v.f;
    return typeof f === 'object' && f !== null && 'value' in f ? String(f.value) : 'None';
  };
  const wrong = texts.filter(t => compiled(t) !== oracle(t) || interpreted(t) !== oracle(t));
  T(
    `parse_int agrees with BigInt on ${texts.length} texts (${texts.filter(t => oracle(t) !== 'None').length} numbers), compiled and interpreted`,
    wrong.map(t => `${JSON.stringify(t)}: ${compiled(t)} ${interpreted(t)} want ${oracle(t)}`),
    [],
  );
  T(
    'decimal stays strict: no sign, no leading zero',
    ['007', '-1', '+1', '7'].map(t => served(P.replace('parse_int(text:', 'decimal(v:'))(`POST /\n${t}`)),
    ['400\n', '400\n', '400\n', '200\n7'],
  );
  T(
    'the byte classes against JavaScript’s, on every byte, compiled and interpreted',
    (() => {
      const names = ['is_digit', 'is_alpha', 'is_alnum', 'is_space', 'is_lower', 'is_upper'];
      const src = `fn f(b: Int) -> Int {\n${names.map((f, i) => `  let b${i} = match {\n    ${f}(b) -> ${1 << i}\n    else -> 0\n  }\n`).join('')}  ${names.map((_, i) => `b${i}`).join(' + ')}\n}\n`;
      const ex = functionsOf(
        new WebAssembly.Module(
          compile([...std, { name: 't.tape', text: src }], { exports: ['f'] }).wasm ?? new Uint8Array(),
        ),
      );
      const ip = interpret([...std, { name: 't.tape', text: src }]);
      return Array.from({ length: 256 }, (_, b) => b).filter(b => {
        const ch = String.fromCodePoint(b);
        const want = [/[0-9]/, /[a-zA-Z]/, /[a-zA-Z0-9]/, /[ \t\n\r]/, /[a-z]/, /[A-Z]/].reduce(
          (m, re, i) => m + (b < 128 && re.test(ch) ? 1 << i : 0),
          0,
        );
        call(ex, 'reset');
        return call(ex, 'f', BigInt(b)) !== BigInt(want) || ip.call('f', [BigInt(b)]) !== BigInt(want);
      });
    })(),
    [],
  );
  T(
    'every_byte with a byte class, and min and max',
    run(
      `fn f(n: Int) -> Int {
  let slug = match n {
    0 -> "order-17"
    _ -> "Order 17"
  }
  let ok = match {
    every_byte(v: slug, keep: fn(b: Int) -> Bool { is_lower(b) or is_digit(b) or b == 45 }) -> 1
    else -> 0
  }
  ok * 100 + max(a: n, b: 3) * 10 + min(a: n, b: 3)
}
`,
      'f',
      [0n],
    ),
    130,
  );
}

// ---- 11. C54: a debit that runs only after its op id was claimed (an INSERT … ON CONFLICT DO NOTHING whose row a
// step requires) runs once per op id, so it needs no `repeat: True` (the ledger task's transfer)
{
  const LEDGER = `migration 1 "ledger" {
  CREATE TABLE accounts(id TEXT PRIMARY KEY NOT NULL, balance INTEGER NOT NULL);
  CREATE TABLE transfers(transfer_id TEXT PRIMARY KEY NOT NULL, from_id TEXT NOT NULL, amount INTEGER NOT NULL)
}

type Transfer {
  Transfer(transfer_id: View, from_id: View, amount: Int)
}

fn handle(raw: View, db: Sql) -> Response {
  let r = request(raw)
  match r.path {
    "/t/" ++ id -> moved(id, from: r.body, amount: 5)
    _ -> empty(status: 404)
  }
}

fn moved(id: View, from: View, amount: Int) -> Response {
  let Some(value: t) = sql_first(
    row: Transfer,
    query: "INSERT INTO transfers(transfer_id, from_id, amount) VALUES (:id, :from, :amount) CLAIM RETURNING *",
    id,
    from,
    amount
  ) else -> empty(status: 200)
  let 1 = sql_exec(
    query: "UPDATE accounts SET balance = balance - :amount WHERE id = :from AND balance >= :amount",
    amount,
    from
  ) else -> rollback(out: empty(status: 409))
  buf() |> append(view: t.transfer_id) |> respond(status: 201)
}
`;
  const claimed = LEDGER.replace('CLAIM', 'ON CONFLICT(transfer_id) DO NOTHING');
  T('C54: a debit after its transfer id is claimed is taken', codes(claimed, ['handle']), []);
  T(
    '…and it runs once: the same transfer sent twice debits once',
    (() => {
      const r = compile([...std, { name: 't.tape', text: claimed }]);
      if (!r.wasm) return 'does not compile';
      const sql = nodeSql();
      const app = instantiate(new WebAssembly.Module(r.wasm), { sql, log: false });
      sql.exec("INSERT INTO accounts VALUES ('a', 100)");
      const send = (): string => answered(app.handle(new TextEncoder().encode('POST /t/x1\na')));
      return [send(), send(), sql.exec("SELECT balance FROM accounts WHERE id = 'a'").toArray()[0]?.['balance']];
    })(),
    ['201\nx1', '200\n', 95],
  );
  T(
    'C54: the debit before the claim is still refused',
    codes(
      claimed.replace(
        'fn moved(id: View, from: View, amount: Int) -> Response {\n',
        'fn moved(id: View, from: View, amount: Int) -> Response {\n  let _ = sql_exec(query: "UPDATE accounts SET balance = balance - :amount WHERE id = :from AND balance >= :amount", amount, from)\n',
      ),
      ['handle'],
    ).map(x => x.split(':')[0]),
    ['C54'],
  );
  T(
    'C54: an insert that does not claim (no ON CONFLICT DO NOTHING) does not guard it',
    codes(LEDGER.replace(' CLAIM', ' ON CONFLICT(transfer_id) DO UPDATE SET amount = :amount'), ['handle']).map(
      x => x.split(':')[0],
    ),
    ['C54'],
  );
}

// ---- 4. a JSON list of computed items (the invoice task kept a Buf in a record to fold over its lines, C08):
// the items are mapped into a record type and write_json writes the list; a nested Cons needs nothing around it
// to say its type
{
  const INV = `type Line {
  Line(name: View, qty: Int, cents: Int)
}

type Shown {
  Shown(name: View, total: Int)
}

type Invoice {
  Invoice(lines: List[Shown], total: Int, names: View)
}

fn handle(raw: View) -> Response {
  let lines = Cons(head: Line(name: "a", qty: 2, cents: 150), tail: Cons(head: Line(name: "b\\"", qty: 1, cents: 5), tail: Nil))
  let total = fold(list: lines, from: 0, by: fn(sum: Int, l: Line) -> Int { sum + l.qty * l.cents })
  let shown = map(list: lines, by: fn(l: Line) -> Shown { Shown(name: l.name, total: l.qty * l.cents) })
  let names = join(list: map(list: lines, by: fn(l: Line) -> View { l.name }), sep: "+")
  buf() |> write_json(value: Invoice(lines: shown, total, names)) |> respond(status: 200)
}
`;
  const out = served(INV)('GET /');
  T(
    'map, fold, join and write_json: the answer is the JSON JavaScript reads back',
    out.startsWith('200\n') ? JSON.parse(out.slice(4)) : out,
    {
      lines: [
        { name: 'a', total: 300 },
        { name: 'b"', total: 5 },
      ],
      total: 305,
      names: 'a+b"',
    },
  );
  T(
    'C08 on a Buf in a record says how to write a list',
    fix('type Acc {\n  Acc(out: Buf, n: Int)\n}\n\nfn f(n: Int) -> Int {\n  let a = Acc(out: buf(), n)\n  a.n\n}\n')
      .split(' | ')[1]
      ?.includes('write_json(value: list)'),
    true,
  );
}

// ---- 2. response headers: std/http's header, on the status line after a carriage return, read by the host
// (responseOf) for every host alike; and request headers, by header_of. The shortener task needed a Location.
{
  const R = `fn handle(raw: View) -> Response {
  let r = request(raw)
  match r.path {
    "/go/" ++ code -> empty(status: 302) |> header(name: "Location", value: "https://example.com/" ++ code)
    "/twice" -> buf()
      |> append(view: "{}") |> respond_as(status: 200, content: Json)
      |> header(name: "cache-control", value: "no-store")
      |> header(name: "x-n", value: "2")
    "/key" -> buf()
      |> append(view: match header_of(request: r, name: "idempotency-key") {
        Some(value) -> value
        None -> "none"
      }) |> respond(status: 200)
    "/cookie" -> empty(status: 200) |> header(name: "set-cookie", value: "a=b")
    "/split" -> empty(status: 200) |> header(name: "x-v", value: r.body)
    _ -> empty(status: 200) |> header(name: "bad name", value: "x")
  }
}
`;
  const r = compile([...std, { name: 't.tape', text: R }]);
  const app = r.wasm ? instantiate(new WebAssembly.Module(r.wasm), { log: false }) : null;
  const it = interpret([...std, { name: 't.tape', text: R }]);
  const enc = new TextEncoder();
  const both = (req: string): unknown => {
    if (!app) return `does not compile: ${r.errors[0]?.code} ${r.errors[0]?.message}`;
    const a = responseOf(app.handle(enc.encode(req))),
      b = responseOf(it.handle(enc.encode(req)));
    const shown = (x: typeof a): unknown => [x.status, x.type, x.headers, new TextDecoder().decode(x.body)];
    return JSON.stringify(shown(a)) === JSON.stringify(shown(b)) ? shown(a) : ['differ', shown(a), shown(b)];
  };
  const PLAIN = 'text/plain; charset=utf-8';
  T('a redirect carries its Location, compiled and interpreted', both('GET /go/abc'), [
    302,
    PLAIN,
    [{ name: 'location', value: 'https://example.com/abc' }],
    '',
  ]);
  T('headers with a content type, before and after the body is written', both('GET /twice'), [
    200,
    'application/json',
    [
      { name: 'cache-control', value: 'no-store' },
      { name: 'x-n', value: '2' },
    ],
    '{}',
  ]);
  T(
    'a request header read by name, in any case',
    [both('GET /key\ridempotency-key: k-1\n'), both('GET /key')],
    [
      [200, PLAIN, [], 'k-1'],
      [200, PLAIN, [], 'none'],
    ],
  );
  const why = (req: string): unknown => {
    const x = both(req);
    return Array.isArray(x) ? [x[0], x[3]] : x;
  };
  T(
    'a header the host owns, a value that would split the head, a name that is not a token: 500, and why',
    [why('GET /cookie'), why('POST /split\nfine\r\nset-cookie: x=1'), why('GET /other')],
    [
      [500, "the program set a response header the host refuses: set-cookie is the host's to set"],
      [500, 'the program set a response header the host refuses: invalid header value for x-v'],
      [500, 'the program set a response header the host refuses: invalid header name "bad name"'],
    ],
  );
}

finish();
