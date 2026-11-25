// `*` with `row: R` is R's fields, written into the query (compiler/rows.ts), and a field may be named by an SQL
// keyword the table quotes: `"from" TEXT`, read into `Transfer(from: View, to: View)`. The fields were written
// bare, so `SELECT * FROM transfers` became `SELECT id, from, to, amount FROM transfers`, and the checker refused
// it: C67 "expected an expression at "from"" (the 2026-11-23i bench, a ledger). Each keyword is quoted as the table
// quotes it, in a SELECT, with a table's name before it (`t.*`), and in RETURNING; the answers are SQLite's own on
// the same rows.
import '../node25.ts';
import { DatabaseSync } from 'node:sqlite';
import { compile } from '../compiler.ts';
import { instantiate } from '../host.ts';
import { nodeSql } from '../nodesql.ts';
import { std } from '../std.ts';
import { finish, same, answered } from './harness.ts';

const SCHEMA =
  'CREATE TABLE transfers(id INTEGER PRIMARY KEY, "from" TEXT NOT NULL, "to" TEXT NOT NULL, "order" INTEGER NOT NULL, state TEXT NOT NULL)';
const PROGRAM = `migration 1 "transfers" {
  ${SCHEMA};
  INSERT INTO transfers(id, "from", "to", "order", state) VALUES (1, 'ann', 'bo', 7, 'open')
}

type TransferState { Open Done }
machine transfers.state: TransferState { Open -> Done }

type Transfer { Transfer(id: Int, from: View, to: View, order: Int, state: TransferState) }

fn handle(raw: View, db: Sql) -> Response {
  match request(raw).path {
    "/first" -> shown(found: sql_first(row: Transfer, query: "SELECT * FROM transfers WHERE id = 1"))
    "/all" -> listed(rows: sql_all(row: Transfer, query: "SELECT t.* FROM transfers AS t ORDER BY t.id"), out: buf()) |> respond(status: 200)
    "/done" -> match sql_move(
      row: Transfer,
      query: "UPDATE transfers SET state = 'done' WHERE id = 1 AND state = 'open' RETURNING *"
    ) {
      Moved(value) -> shown(found: Some(value))
      Raced(now) -> buf() |> append(view: line(now)) |> respond(status: 409)
      NoRow -> empty(status: 404)
    }
    _ -> empty(status: 404)
  }
}

fn line(t: Transfer) -> View {
  "\\(t.id) \\(t.from)>\\(t.to) \\(t.order) \\(state_text(s: t.state))"
}

fn state_text(s: TransferState) -> View {
  match s {
    Open -> "open"
    Done -> "done"
  }
}

fn shown(found: Option[Transfer]) -> Response {
  match found {
    Some(value) -> buf() |> append(view: line(value)) |> respond(status: 200)
    None -> empty(status: 404)
  }
}

fn listed(rows: Rows[Transfer], out: Buf) -> Buf {
  match next(rows) {
    Next(value, rest) -> listed(rows: rest, out: out |> append(view: line(value)))
    End -> out
  }
}
`;
const r = compile([...std, { name: 'ledger.tape', text: PROGRAM }]);
same(
  'SELECT *, t.* and RETURNING * over columns named by keywords compile',
  r.errors.map(e => `${e.code} ${e.line}: ${e.message}`),
  [],
);
if (r.wasm) {
  const app = instantiate(new WebAssembly.Module(r.wasm), { sql: nodeSql(), log: false });
  const body = (request: string): string => {
    const out = answered(app.handle(new TextEncoder().encode(request)));
    return out.slice(out.indexOf('\n') + 1);
  };
  // SQLite itself, on the same row
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  db.exec(`INSERT INTO transfers(id, "from", "to", "order", state) VALUES (1, 'ann', 'bo', 7, 'open')`);
  const theirs = (): string => {
    const t = db.prepare('SELECT * FROM transfers WHERE id = 1').get() ?? {};
    return `${String(t['id'])} ${String(t['from'])}>${String(t['to'])} ${String(t['order'])} ${String(t['state'])}`;
  };
  same('SELECT *: the row as SQLite has it', body('GET /first'), theirs());
  same('SELECT t.*: the same', body('GET /all'), theirs());
  db.exec("UPDATE transfers SET state = 'done' WHERE id = 1");
  same('RETURNING *: the row moved, as SQLite has it', body('POST /done'), theirs());
  // again: the row is read back by its key alone (a SELECT made from the UPDATE), Raced
  same('the same move again: Raced, with the row as SQLite has it', body('POST /done'), theirs());
}

finish();
