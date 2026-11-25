// An Option as a query's parameter: None is bound as NULL, Some(value) as the value. Three reports and LANGUAGE.md's
// optional-filter row asked for it: a value that may be absent (a decoded `Option` field, a filter not given) went
// into a query through a flag beside it (`WHERE (:all = 1 OR region = :only)`, `all: True, only: ""`), since a
// query's values could not be Options (C14). Here each of sql_exec, sql_first, sql_all and sql_move takes one, run
// in node:sqlite, and each answer is SQLite's own: the same statements run directly on the same rows, with null
// for None. And the checker reads such a parameter as one that may be NULL: into a NOT NULL column it is C69, and
// compared with `=` where nothing in the statement asks whether it is NULL (`= NULL` is never true, so the row is
// silently missed) it is C69 with the two forms that say what is meant.
import '../node25.ts';
import { DatabaseSync } from 'node:sqlite';
import { compile } from '../compiler.ts';
import { instantiate } from '../host.ts';
import { nodeSql } from '../nodesql.ts';
import { std } from '../std.ts';
import { finish, same, answered } from './harness.ts';

const SCHEMA = [
  'CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT NOT NULL, region TEXT, qty INTEGER, state TEXT NOT NULL)',
];
const program = (body: string, machine = true): string => `migration 1 "items" {
  ${SCHEMA.join(';\n  ')}
}
${machine ? '\nmachine items.state: ItemState { Open -> Closed }\n' : ''}
type ItemState { Open Closed }
type NewItem { NewItem(name: View, region: Option[View], qty: Option[Int]) }
type Item { Item(id: Int, name: View, region: Option[View], qty: Option[Int], state: ItemState) }
type Count { Count(n: Int) }
${body}`;

const PROGRAM = program(`
fn handle(raw: View, db: Sql) -> Response {
  let r = request(raw)
  match r {
    Request(method: Post, path: "/items", body) -> added(body)
    Request(method: Get, path: "/count/" ++ region) -> counted(found: sql_first(
      row: Count,
      query: "SELECT count(*) AS n FROM items WHERE (:only IS NULL OR region = :only)",
      only: given(region)
    ))
    Request(method: Get, path: "/names/" ++ region) -> named(
      rows: sql_all(row: Item, query: "SELECT * FROM items WHERE region IS :only ORDER BY id", only: given(region)),
      out: buf()
    ) |> respond(status: 200)
    Request(method: Post, path: "/close/" ++ id ++ "/" ++ region) -> closed(id: parse_int(text: id), region)
    _ -> empty(status: 404)
  }
}

// "" is no value
fn given(v: View) -> Option[View] {
  match v {
    "" -> None
    _ -> Some(value: v)
  }
}

fn added(body: View) -> Response uses db {
  let Ok(value: NewItem(name, region, qty)) = decode(json: body, as: NewItem) else {
    Err(error) -> buf() |> append(view: error) |> respond(status: 400)
  }
  let _ = sql_exec(
    query: "INSERT INTO items(name, region, qty, state) VALUES (:name, :region, :qty, 'open')",
    name,
    region,
    qty,
    repeat: True
  )
  empty(status: 201)
}

fn counted(found: Option[Count]) -> Response {
  match found {
    Some(value: Count(n)) -> buf() |> write_int(value: n) |> respond(status: 200)
    None -> empty(status: 500)
  }
}

fn named(rows: Rows[Item], out: Buf) -> Buf {
  match next(rows) {
    Next(value: Item(name), rest) -> named(rows: rest, out: out |> append(view: name) |> append(view: ","))
    End -> out
  }
}

// "-" is a region cleared
fn cleared(v: View) -> Option[View] {
  match v {
    "-" -> None
    _ -> Some(value: v)
  }
}

// the region set as it closes
fn closed(id: Option[Int], region: View) -> Response uses db {
  let Some(value: n) = id else -> empty(status: 400)
  match sql_move(
    row: Item,
    query: "UPDATE items SET state = 'closed', region = :region WHERE id = :id AND state = 'open' RETURNING *",
    id: n,
    region: cleared(region)
  ) {
    Moved -> buf() |> append(view: "moved") |> respond(status: 200)
    Raced -> empty(status: 409)
    NoRow -> empty(status: 404)
  }
}
`);

const r = compile([...std, { name: 'items.tape', text: PROGRAM }]);
same(
  'a program that passes Options to sql_exec, sql_first, sql_all and sql_move compiles',
  r.errors.map(e => `${e.code} ${e.line}: ${e.message}`),
  [],
);

if (r.wasm) {
  const theirs = nodeSql();
  const app = instantiate(new WebAssembly.Module(r.wasm), { sql: theirs, log: false });
  const answer = (request: string): string => {
    const out = answered(app.handle(new TextEncoder().encode(request)));
    const [head = '', ...rest] = out.split('\n');
    return `${head.split(' ')[0]} ${rest.join('\n')}`.trim();
  };
  // SQLite itself, the same statements on the same rows, with null for None
  const db = new DatabaseSync(':memory:');
  for (const s of SCHEMA) db.exec(s);
  const insert = db.prepare("INSERT INTO items(name, region, qty, state) VALUES (?, ?, ?, 'open')");
  const items: readonly [string, string | null, number | null][] = [
    ['lamp', 'north', 3],
    ['desk', null, null],
    ['chair', 'south', null],
    ['shelf', null, 7],
  ];
  for (const [name, region, qty] of items) {
    const body = JSON.stringify({ name, ...(region === null ? {} : { region }), ...(qty === null ? {} : { qty }) });
    same(`POST /items ${body}`, answer(`POST /items\n${body}`), '201');
    insert.run(name, region, qty);
  }
  const all = (): unknown => db.prepare('SELECT * FROM items ORDER BY id').all();
  const count = (only: string | null): string =>
    String(db.prepare('SELECT count(*) AS n FROM items WHERE (? IS NULL OR region = ?)').get(only, only)?.['n']);
  const names = (only: string | null): string =>
    db
      .prepare('SELECT name FROM items WHERE region IS ? ORDER BY id')
      .all(only)
      .map(x => `${String(x['name'])},`)
      .join('');
  for (const region of ['', 'north', 'south', 'west'])
    same(`GET /count/${region}: as SQLite counts`, answer(`GET /count/${region}`), `200 ${count(region || null)}`);
  for (const region of ['', 'north'])
    same(`GET /names/${region}: as SQLite selects`, answer(`GET /names/${region}`), `200 ${names(region || null)}`);
  // sql_move: a region set, a region cleared, and the same move again (Raced)
  const close = db.prepare("UPDATE items SET state = 'closed', region = ? WHERE id = ? AND state = 'open'");
  same('POST /close/2/east: moved', answer('POST /close/2/east'), '200 moved');
  close.run('east', 2);
  same('POST /close/1/-: moved, the region NULL', answer('POST /close/1/-'), '200 moved');
  close.run(null, 1);
  same('POST /close/1/-: again, Raced', answer('POST /close/1/-'), '409');
  // the program's own table, read back: NULL wherever a None was bound
  same(
    "the program's rows are SQLite's, NULL where a None was bound",
    JSON.stringify(theirs.exec('SELECT * FROM items ORDER BY id').toArray()),
    JSON.stringify(all()),
  );
  same('GET /count/: after the moves', answer('GET /count/'), `200 ${count(null)}`);
  same('GET /names/: the regions set NULL', answer('GET /names/'), `200 ${names(null)}`);
  same('GET /names/east', answer('GET /names/east'), `200 ${names('east')}`);
}

// ---- the checker: a parameter that may be NULL
const said = (body: string): string => {
  const [e] = compile([...std, { name: 'items.tape', text: program(body, false) }]).errors;
  return e ? `${e.code}: ${e.message} | ${e.hint ?? ''}` : 'compiled';
};
const into = said(`
fn handle(raw: View, db: Sql) -> Response {
  let Ok(value: NewItem(region)) = decode(json: raw, as: NewItem) else -> empty(status: 400)
  let _ = sql_exec(query: "INSERT INTO items(name, state) VALUES (:region, 'open')", region, repeat: True)
  empty(status: 200)
}
`);
same(
  'an Option into a NOT NULL column: C69, which may be NULL',
  [into.slice(0, 4), into.includes('which may be NULL')],
  ['C69:', true],
);
const eq = said(`
fn handle(raw: View, db: Sql) -> Response {
  let Ok(value: NewItem(region)) = decode(json: raw, as: NewItem) else -> empty(status: 400)
  match sql_first(row: Count, query: "SELECT count(*) AS n FROM items WHERE region = :region", region) {
    Some(value: Count(n)) -> buf() |> write_int(value: n) |> respond(status: 200)
    None -> empty(status: 200)
  }
}
`);
same(
  'an Option compared with = and never asked IS NULL: C69, with both forms',
  [eq.slice(0, 4), eq.includes('`(:region IS NULL OR region = :region)`'), eq.includes('`region IS :region`')],
  ['C69:', true, true],
);

finish();
