// Tape 0.3: the forms that remove what the usability benchmark measured agents tripping on
// (lab_notebook/tape-2026-11-21/usability-baseline.md). Each form is checked compiled and, where it gives a program a
// meaning, in the reference interpreter too; each refusal by its code.
import '../node25.ts';
import { DatabaseSync } from 'node:sqlite';
import { compile } from '../compiler.ts';
import { interpret } from '../interp.ts';
import { std } from '../std.ts';
import { instantiate } from '../host.ts';
import { call, finish, functionsOf, same as T } from './harness.ts';

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
  return request => new TextDecoder().decode(app.handle(new TextEncoder().encode(request)));
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
    n > 0 -> respond(status: 200)
    else -> respond(status: 404)
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

fn handle(raw: View) -> Buf {
  let r = request(raw)
  match r.path {
    "/flat" -> {
      let Ok(value: e) = decode(json: r.body, as: Event) else {
        Err(error) -> respond(status: 400) |> append(view: error)
      }
      let Event(type: kind, match: m) = e
      respond(status: 200) |> append(view: "\\(e.type) \\(kind) \\(m) ") |> write_json(value: e)
    }
    _ -> {
      let Ok(value: n) = decode(json: r.body, as: Nested) else {
        Err(error) -> respond(status: 400) |> append(view: error)
      }
      respond(status: 200) |> write_json(value: n)
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

finish();
