// HAVING without GROUP BY: an aggregate over the whole selection, one row or none. SQLite takes it since 3.39
// (node:sqlite here is 3.50, sql.js 1.10.3 in the playground and tape-mcp is 3.45, a Durable Object's is newer), and
// it is the plain way to ask "the sum, or no row when nothing matched". The checker read HAVING only after a GROUP
// BY and refused the rest (C67 "expected the end of the statement at HAVING"). The answers here are SQLite's own,
// run on the same rows directly.
import '../node25.ts';
import { DatabaseSync } from 'node:sqlite';
import { compile } from '../compiler.ts';
import { instantiate } from '../host.ts';
import { nodeSql } from '../nodesql.ts';
import { std } from '../std.ts';
import { finish, same, answered } from './harness.ts';

const SCHEMA = 'CREATE TABLE e(id INTEGER PRIMARY KEY, acct TEXT NOT NULL, amt INTEGER NOT NULL)';
const QUERY = 'SELECT sum(amt) AS total FROM e WHERE acct = :acct HAVING count(*) > 0';
const PROGRAM = `schema "${SCHEMA}"

type Total { Total(total: Option[Int]) }

fn handle(raw: View, db: Sql) -> Response {
  let r = request(raw)
  match r.path {
    "/add/" ++ acct -> added(acct, amt: len(r.body))
    "/total/" ++ acct -> shown(found: sql_first(row: Total, query: "${QUERY}", acct))
    _ -> empty(status: 404)
  }
}

fn added(acct: View, amt: Int) -> Response {
  let _ = sql_exec(query: "INSERT INTO e(acct, amt) VALUES (:acct, :amt)", acct, amt, repeat: True)
  empty(status: 201)
}

fn shown(found: Option[Total]) -> Response {
  match found {
    Some(value: Total(total: Some(value))) -> buf() |> write_int(value) |> respond(status: 200)
    Some(value: Total(total: None)) -> buf() |> append(view: "null") |> respond(status: 200)
    None -> buf() |> append(view: "no row") |> respond(status: 200)
  }
}
`;
const r = compile([...std, { name: 'having.tape', text: PROGRAM }]);
same(
  'a query with HAVING and no GROUP BY compiles',
  r.errors.map(e => `${e.code}: ${e.message}`),
  [],
);

if (r.wasm) {
  const app = instantiate(new WebAssembly.Module(r.wasm), { sql: nodeSql(), log: false });
  const body = (request: string): string => {
    const out = answered(app.handle(new TextEncoder().encode(request)));
    return out.slice(out.indexOf('\n') + 1);
  };
  // the same rows in SQLite itself, asked the same query
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const theirs = (acct: string): string => {
    const row = db.prepare(QUERY.replace(':acct', '?')).get(acct);
    return row === undefined ? 'no row' : row['total'] === null ? 'null' : String(row['total']);
  };
  const steps: readonly (readonly [string, string | null])[] = [
    ['GET /total/a', null],
    ['POST /add/a\nxxx', 'a:3'],
    ['POST /add/a\nxx', 'a:2'],
    ['POST /add/b\nx', 'b:1'],
    ['GET /total/a', null],
    ['GET /total/b', null],
    ['GET /total/c', null],
  ];
  for (const [request, insert] of steps) {
    if (insert) {
      const [acct, amt] = insert.split(':');
      db.prepare('INSERT INTO e(acct, amt) VALUES (?, ?)').run(acct ?? '', Number(amt));
      body(request);
      continue;
    }
    const acct = request.slice('GET /total/'.length);
    same(`${request}: as SQLite answers`, body(request), theirs(acct));
  }
}

finish();
