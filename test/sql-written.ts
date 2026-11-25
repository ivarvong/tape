// How many rows a statement wrote, as the effect log records it (`r`), for every way a program runs SQL: sql_exec,
// and a write that returns its rows (sql_first, sql_all, sql_move with RETURNING), which was logged with its rows
// and no count, so the trace and tape-mcp said a request that wrote rows wrote none. A read writes nothing, even
// right after a write (SQLite's changes() still holds the last write's count then). The count is SQLite's, not
// the database's rowsWritten: in Durable Object SQLite that counts index rows too (service/test/rows-written.test.ts).
//
// The expected counts are SQLite's own: the same statements, with the same values, run on a second database
// through node:sqlite, each followed by `SELECT changes()`, and checked against a count of the table's rows.
import '../node25.ts';
import { DatabaseSync } from 'node:sqlite';
import { instantiate, isHead } from '../host.ts';
import type { Effect } from '../host.ts';
import { nodeSql } from '../nodesql.ts';
import { built, finish, moduleOf, same, answered } from './harness.ts';

const TABLE = 'CREATE TABLE kv(k TEXT PRIMARY KEY NOT NULL, v INTEGER NOT NULL)';
const program = `migration 1 "kv" {
  ${TABLE}
}

type Kv { Kv(k: View, v: Int) }

fn handle(raw: View, db: Sql) -> Response {
  match raw {
    "upsert " ++ k -> upsert(k)
    "insert " ++ k -> buf()
      |> write_rows(rows: sql_all(
        row: Kv,
        query: "INSERT INTO kv(k, v) VALUES (:k || '1', 1), (:k || '2', 2) RETURNING *",
        k
      )) |> respond(status: 200)
    "bump" -> buf()
      |> write_rows(rows: sql_all(row: Kv, query: "UPDATE kv SET v = v + 1 WHERE v < 100 RETURNING *", repeat: True)) |> respond(status: 200)
    "exec " ++ k -> buf()
      |> write_int(value: sql_exec(query: "DELETE FROM kv WHERE k = :k", k)) |> respond(status: 200)
    "read" -> buf() |> write_rows(rows: sql_all(row: Kv, query: "SELECT * FROM kv ORDER BY k")) |> respond(status: 200)
    _ -> empty(status: 404)
  }
}

fn upsert(k: View) -> Response uses db {
  let Some(value: row) = sql_first(
    row: Kv,
    query: "INSERT INTO kv(k, v) VALUES (:k, 1) ON CONFLICT(k) DO UPDATE SET v = v + 1 RETURNING *",
    k,
    repeat: True
  ) else -> empty(status: 500)
  buf() |> write_json(value: row) |> respond(status: 200)
}
`;

// the requests, and the statement each runs with its values, as the oracle runs it
const steps: [request: string, sql: string, params: string[]][] = [
  ['upsert a', 'INSERT INTO kv(k, v) VALUES (?1, 1) ON CONFLICT(k) DO UPDATE SET v = v + 1 RETURNING *', ['a']],
  ['upsert a', 'INSERT INTO kv(k, v) VALUES (?1, 1) ON CONFLICT(k) DO UPDATE SET v = v + 1 RETURNING *', ['a']],
  ['read', 'SELECT * FROM kv ORDER BY k', []],
  ['insert b', "INSERT INTO kv(k, v) VALUES (?1 || '1', 1), (?1 || '2', 2) RETURNING *", ['b']],
  ['read', 'SELECT * FROM kv ORDER BY k', []],
  ['bump', 'UPDATE kv SET v = v + 1 WHERE v < 100 RETURNING *', []],
  ['exec b1', 'DELETE FROM kv WHERE k = ?1', ['b1']],
  ['exec nothing', 'DELETE FROM kv WHERE k = ?1', ['nothing']],
  ['read', 'SELECT * FROM kv ORDER BY k', []],
];

const oracle = new DatabaseSync(':memory:');
oracle.exec(TABLE);
const count = (): number => Number(oracle.prepare('SELECT count(*) AS n FROM kv').get()?.['n']);
/** SQLite's own count of the rows a statement wrote: changes() after a write, nothing for a read. */
function written(sql: string, params: string[]): number {
  const before = count();
  const st = oracle.prepare(sql);
  if (st.columns().length > 0) st.all(...params);
  else st.run(...params);
  if (sql.startsWith('SELECT')) {
    if (count() !== before) throw new Error('a read changed the rows');
    return 0;
  }
  return Number(oracle.prepare('SELECT changes() AS n').get()?.['n']);
}

const app = instantiate(moduleOf(built([{ name: 'written.tape', text: program }])), { sql: nodeSql() });
const enc = new TextEncoder();
for (const [request, sql, params] of steps) {
  const want = written(sql, params);
  app.handle(enc.encode(request));
  const logged = app.effects.filter((e: Effect) => !isHead(e) && 'q' in e);
  const r = logged.map(e => ('q' in e ? (e.r ?? 0) : null));
  same(`${request}: the rows it wrote, as SQLite counts them`, r, [want]);
}
// node:sqlite gives the count with the write (the cursor's `changes`), so the host runs no `SELECT changes()`;
// Durable Object SQLite's cursor has none, and the host asks. Both ways log the same effects, and answer alike.
function counted(hide: boolean): { log: string; answers: string; asked: number } {
  const db = nodeSql();
  let asked = 0;
  const sql = {
    exec: (q: string, ...p: Parameters<typeof db.exec>[1][]) => {
      if (q === 'SELECT changes()') asked++;
      const cur = db.exec(q, ...p);
      if (!hide) return cur;
      const { changes: _, ...rest } = cur;
      return rest;
    },
  };
  const a = instantiate(moduleOf(built([{ name: 'written.tape', text: program }])), { sql });
  const answers: string[] = [];
  const logs: unknown[] = [];
  for (const [request] of steps) {
    answers.push(answered(a.handle(enc.encode(request))));
    logs.push(a.effects.filter((e: Effect) => !isHead(e)));
  }
  return { log: JSON.stringify(logs), answers: answers.join('\n'), asked };
}
const given = counted(false),
  asked = counted(true);
same('the count given with the write: the same effects as asking SQLite after it', given.log, asked.log);
same('the count given with the write: the same answers', given.answers, asked.answers);
same(
  'a database that gives the count is not asked for it; one that does not is asked once a sql_exec',
  [given.asked, asked.asked],
  [0, 2],
);

// The stand-in's rowsWritten is how far total_changes() moved while the statement ran. It reads the statement's own
// count instead until a trigger or a foreign key is made; the same statements on a second database, total_changes()
// asked around each, give the same numbers before and after one is (a trigger's writes and a cascade's count too).
{
  const stand = nodeSql(),
    db = new DatabaseSync(':memory:');
  const total = (): number => Number(db.prepare('SELECT total_changes() AS n').get()?.['n']);
  const statements: [string, ...(string | number)[]][] = [
    ['CREATE TABLE a(k TEXT PRIMARY KEY NOT NULL, v INTEGER NOT NULL)'],
    ["INSERT INTO a VALUES ('x', 1), ('y', 2)"],
    ['INSERT INTO a VALUES (?1, 3) ON CONFLICT(k) DO NOTHING', 'x'],
    ['INSERT OR REPLACE INTO a VALUES (?1, 4)', 'x'],
    ['UPDATE a SET v = v + 1'],
    ['SELECT * FROM a'],
    ["INSERT INTO a VALUES ('z', 5) RETURNING k"],
    ['CREATE TABLE log(n INTEGER)'],
    ['CREATE TRIGGER t AFTER UPDATE ON a BEGIN INSERT INTO log VALUES (new.v); END'],
    ['UPDATE a SET v = v + 1'],
    ['CREATE TABLE child(k TEXT NOT NULL REFERENCES a(k) ON DELETE CASCADE)'],
    ["INSERT INTO child VALUES ('y'), ('y')"],
    ["DELETE FROM a WHERE k = 'y'"],
    ['SELECT count(*) AS n FROM child'],
  ];
  const got: number[] = [],
    want: number[] = [];
  for (const [q, ...p] of statements) {
    got.push(stand.exec(q, ...p).rowsWritten);
    const before = total(),
      st = db.prepare(q);
    if (st.columns().length > 0) st.all(...p);
    else st.run(...p);
    want.push(total() - before);
  }
  same(
    "the stand-in's rowsWritten is how far total_changes() moved, before and after a trigger or a foreign key",
    got,
    want,
  );
  same("the trigger and the cascade write rows that are not their statement's own", [want[9], want[12]], [6, 3]);
}

// a write SQLite counts as having changed rows: the oracle itself says so, so the test above is not vacuous
same('the oracle counts the upsert and the two-row insert', [written(steps[0]?.[1] ?? '', ['z']), count()], [1, 3]);

finish();
