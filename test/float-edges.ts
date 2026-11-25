// A Float at the edges of a program: decoded from JSON (a finite number; not text, not 1e400), written to JSON in
// the shortest digits that read back as it, in a list too, bound to a query as a number (SQLite keeps it REAL) and
// read back from a REAL column. The compiled build with the host, and the reference interpreter with a database of
// its own, against what JavaScript's JSON says.
import '../node25.ts';
import { DatabaseSync } from 'node:sqlite';
import { compile } from '../compiler.ts';
import { instantiate, responseOf } from '../host.ts';
import { interpret } from '../interp.ts';
import type { SqlParam } from '../interp.ts';
import { nodeSql } from '../nodesql.ts';
import { finish, same, std } from './harness.ts';

const program = `migration 1 "readings" {
  CREATE TABLE readings(id INTEGER PRIMARY KEY, r REAL NOT NULL)
}

type In {
  In(id: Int, r: Float, rs: List[Float])
}

type Reading {
  Reading(id: Int, r: Float)
}

type Out {
  Out(r: Float, twice: Float, rs: List[Float], read: Float)
}

fn handle(raw: View, db: Sql) -> Buf {
  match request(raw) {
    Request(method: "PUT", path: "/r", body) -> put(body, db)
    _ -> respond(status: 404)
  }
}

fn put(body: View, db: Sql) -> Buf {
  let Ok(value: In(id, r, rs)) = decode(json: body, as: In) else {
    Err(error) -> respond(status: 400) |> append(view: error)
  }
  let _ = sql_exec(query: "INSERT INTO readings(id, r) VALUES (:id, :r) ON CONFLICT(id) DO UPDATE SET r = excluded.r", id, r)
  let Some(value: Reading(r: back)) = sql_first(row: Reading, query: "SELECT id, r FROM readings WHERE id = :id", id) else -> respond(status: 404)
  respond_as(status: 200, content: Json) |> write_json(value: Out(r, twice: r * 2f, rs, read: back))
}
`;
const b = compile([...std, { name: 'edges.tape', text: program }]);
if (!b.wasm) throw new Error(b.errors.map(e => `${e.code} ${e.line} ${e.message}`).join('; '));
const app = instantiate(new WebAssembly.Module(b.wasm), { sql: nodeSql() });
const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE readings(id INTEGER PRIMARY KEY, r REAL NOT NULL)');
// the interpreter has no lists in JSON (interp.ts): it runs the program without them
const flatProgram = program
  .replaceAll(', rs: List[Float]', '')
  .replaceAll('In(id, r, rs)', 'In(id, r)')
  .replace(', rs, read', ', read');
const it = interpret([...std, { name: 'edges.tape', text: flatProgram }], {
  exec: (sql: string, p: SqlParam[]) => Number(db.prepare(sql).run(...p).changes),
  rows: (sql: string, p: SqlParam[]) => {
    const s = db.prepare(sql);
    s.setReturnArrays(true);
    // in arrays mode a row's values are its cells in order
    return s
      .all(...p)
      .map(r =>
        Object.values(r).map(c =>
          typeof c === 'bigint' ? Number(c) : typeof c === 'number' || typeof c === 'string' ? c : null,
        ),
      );
  },
});
const dec = new TextDecoder(),
  enc = new TextEncoder();
const compiled = (body: string): string => {
  try {
    const r = responseOf(app.handle(enc.encode(`PUT /r\n${body}`)));
    return `${r.status} ${dec.decode(r.body)}`;
  } catch (e) {
    return String(e);
  }
};
const interpreted = (body: string): string => {
  try {
    const out = dec.decode(it.handle(enc.encode(`PUT /r\n${body}`)));
    const [line = '', ...rest] = out.split('\n');
    return `${line.split(' ')[0] ?? ''} ${rest.join('\n')}`;
  } catch (e) {
    return `trap ${String(e)}`;
  }
};
const VALUES = [0, -0, 0.1, 0.1 + 0.2, 1e21, 1e-7, -123.456, 5e-324, 1e300, 2 ** 53 + 2, Math.PI];
const answers = VALUES.map((r, k) => [
  compiled(JSON.stringify({ id: k, r, rs: [r, 1.5, -2] })),
  interpreted(JSON.stringify({ id: k, r })),
]);
same(
  'a Float decoded, bound to a query, read back from REAL and written: the shortest digits, as JSON.stringify writes them, compiled and interpreted',
  answers,
  VALUES.map(r => [
    `200 ${JSON.stringify({ r, twice: r * 2, rs: [r, 1.5, -2], read: r })}`,
    `200 ${JSON.stringify({ r, twice: r * 2, read: r })}`,
  ]),
);
const refused = [
  '{"id": 1, "r": "1.5", "rs": []}',
  '{"id": 1, "r": 1e400, "rs": []}',
  '{"id": 1, "r": 1, "rs": [true]}',
];
const flat = (body: string): string => body.replace(/, "rs": \[[^\]]*\]/, '');
same(
  'refused in JSON: a Float as text, a number beyond the largest Float, a list item that is not a number',
  refused.map(body => compiled(body).split(' ')[0]),
  ['400', '400', '400'],
);
same(
  'the reasons name the field',
  refused.slice(0, 2).map(body => [compiled(body), interpreted(flat(body))]),
  [
    ['400 r: expected a number', '400 r: expected a number'],
    ['400 r: expected a number', '400 r: expected a number'],
  ],
);
same(
  'twice the largest Float traps (float not finite), compiled and interpreted',
  [
    compiled(JSON.stringify({ id: 9, r: 1.7976931348623157e308, rs: [] })),
    interpreted(JSON.stringify({ id: 9, r: 1.7976931348623157e308 })),
  ],
  ['Error: trap 8: float not finite', 'trap Error: trap 8'],
);
finish();
