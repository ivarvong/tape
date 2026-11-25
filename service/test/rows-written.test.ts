// Runs in workerd: the rows a statement changed, as a program and its trace are told, in Durable Object SQLite.
// The cursor's rowsWritten counts every b-tree row written, so one row inserted into a table with a TEXT PRIMARY
// KEY was 2 (the table and its index): sql_exec answered 2 for one row, and a write with RETURNING was traced as
// writing nothing. The expected counts are SQLite's changes() for these statements (test/sql-written.ts holds the
// same host to node:sqlite's own count), and the rows the last request reads back agree with them: 1 + 2 + 1.
import { expect, it } from 'vitest';
import { docOf } from '../jepsen/traces.ts';
import { anyone, at, call, got, json, num } from './help.ts';

const program = `migration 1 "kv" {
  CREATE TABLE kv(k TEXT PRIMARY KEY NOT NULL, v INTEGER NOT NULL)
}

type Kv { Kv(k: View, v: Int) }

fn handle(raw: View, db: Sql) -> Response {
  match request(raw) {
    Request(method: Post, path: "/up") -> upsert()
    Request(method: Post, path: "/two") -> buf()
      |> write_rows(rows: sql_all(row: Kv, query: "INSERT INTO kv(k, v) VALUES ('x', 1), ('y', 2) RETURNING *")) |> respond(status: 200)
    Request(method: Post, path: "/exec") -> buf()
      |> write_int(value: sql_exec(query: "INSERT INTO kv(k, v) VALUES ('e', 1) ON CONFLICT(k) DO NOTHING")) |> respond(status: 200)
    Request(method: Post, path: "/rename") -> buf()
      |> write_int(value: sql_exec(query: "UPDATE kv SET k = k || 'z' WHERE k = 'e'")) |> respond(status: 200)
    _ -> buf() |> write_rows(rows: sql_all(row: Kv, query: "SELECT * FROM kv ORDER BY k")) |> respond(status: 200)
  }
}

fn upsert() -> Response uses db {
  let Some(value: row) = sql_first(
    row: Kv,
    query: "INSERT INTO kv(k, v) VALUES ('a', 1) ON CONFLICT(k) DO UPDATE SET v = v + 1 RETURNING *",
    repeat: True
  ) else -> empty(status: 500)
  buf() |> write_json(value: row) |> respond(status: 200)
}
`;

/** The run span's tape.sql.rows_written in the trace a response links to. */
async function writtenIn(r: Response): Promise<(string | undefined)[]> {
  const link = new URL(r.headers.get('tape-otlp-url') ?? '');
  const doc = docOf(await json(await anyone(link.pathname + link.search)));
  return doc.resourceSpans.flatMap(rs =>
    rs.scopeSpans.flatMap(sc =>
      sc.spans.flatMap(sp => sp.attributes.filter(a => a.key === 'tape.sql.rows_written').map(a => a.value.intValue)),
    ),
  );
}

it('sql_exec answers, and a trace counts, the rows a statement changed: not the b-tree rows it wrote', async () => {
  const version = num(at(await got('/rw/kv', { method: 'POST', body: program }), 'version'));
  const seen: [string, string, (string | undefined)[]][] = [];
  for (const path of ['/up', '/up', '/two', '/exec', '/exec', '/rename']) {
    const r = await call(`/rw/kv/v/${version}${path}`, { method: 'POST', body: '' });
    const body = await r.text();
    seen.push([path, path === '/exec' || path === '/rename' ? body : '', await writtenIn(r)]);
  }
  expect(seen).toEqual([
    ['/up', '', ['1']],
    ['/up', '', ['1']],
    ['/two', '', ['2']],
    ['/exec', '1', ['1']],
    ['/exec', '0', ['0']],
    ['/rename', '1', ['1']],
  ]);
  const read = await call(`/rw/kv/v/${version}/`);
  expect([await read.text(), await writtenIn(read)]).toEqual([
    '[{"k":"a","v":2},{"k":"ez","v":1},{"k":"x","v":1},{"k":"y","v":2}]',
    ['0'],
  ]);
}, 60000);
