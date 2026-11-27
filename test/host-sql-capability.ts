// A program's Sql capability must not reach the host's bookkeeping. Before host state left the program's
// SQLite, a program could CREATE TABLE IF NOT EXISTS _calls and INSERT a row, and that row was the host's
// stored reply. These checks expect the structural split: planting or dropping a table of that name must
// not change what the host answers for a keyed method, and sqlite_* must be unreachable. Seen failing on
// the expectations first, then the move lands.
import '../node25.ts';
import { instantiate, responseOf } from '../host.ts';
import { nodeSql } from '../nodesql.ts';
import { built, codes, finish, moduleOf, same as T } from './harness.ts';

const bytes = (s: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(s);
const text = (b: Uint8Array | undefined): string => (b === undefined ? '' : new TextDecoder().decode(b));

const PROGRAM = `schema "CREATE TABLE IF NOT EXISTS hits(n INTEGER NOT NULL)"
schema "INSERT OR IGNORE INTO hits VALUES (0)"
schema "CREATE TABLE IF NOT EXISTS _calls(key TEXT PRIMARY KEY, status TEXT NOT NULL, body TEXT NOT NULL, message TEXT)"
type Msg { Msg(n: Int) }
type Refusal { Refused(reason: View) }
export fn ping(db: Sql, message: Msg) -> Result[Msg, Refusal] {
  let _ = sql_exec(query: "UPDATE hits SET n = n + 1")
  Ok(value: Msg(n: message.n + 1))
}
fn handle(raw: View, db: Sql) -> Response {
  match request(raw) {
    Request(method: Post, path: "/plant") -> {
      let _ = sql_exec(query: "INSERT INTO _calls(key, status, body, message) VALUES (:k, 'ok', :b, '') ON CONFLICT(key) DO UPDATE SET status = 'ok', body = :b", k: "forged-key", b: "planted-reply")
      buf() |> append(view: "planted") |> respond(status: 200)
    }
    Request(method: Post, path: "/drop") -> {
      let _ = sql_exec(query: "DROP TABLE IF EXISTS _calls")
      buf() |> append(view: "dropped") |> respond(status: 200)
    }
    _ -> empty(status: 404)
  }
}
`;

const build = built(PROGRAM);
T('the plant program compiles (the name _calls is not a blocklist)', build.errors, []);
const fingerprint = build.methods.find(m => m.name === 'ping')?.fingerprint ?? '';
T('ping is exported', fingerprint.length > 0, true);

const sql = nodeSql();
const app = instantiate(moduleOf(build), { sql });
const planted = responseOf(app.handle(bytes('POST /plant\n')));
T(
  'handle plants a row in a table named _calls and answers 200',
  [planted.status, new TextDecoder().decode(planted.body)],
  [200, 'planted'],
);

const meta = { method: 'ping', fingerprint, key: 'forged-key' };
const first = await app.serve(meta, bytes('{"n":1}'));
const hitsAfterPlant = sql.exec('SELECT n FROM hits').raw().toArray()[0]?.[0];
T(
  'a program-written _calls row is not a stored host reply: the method runs',
  [first.status, text(first.body), hitsAfterPlant],
  ['ok', '{"n":2}', 1],
);

const again = await app.serve(meta, bytes('{"n":1}'));
T(
  'the real stored reply is what ping wrote, not the planted body, and ping ran once',
  [again.status, text(again.body), sql.exec('SELECT n FROM hits').raw().toArray()[0]?.[0]],
  ['ok', text(first.body), 1],
);

const dropped = responseOf(app.handle(bytes('POST /drop\n')));
T(
  "DROP TABLE _calls is the program's table, and answers 200",
  [dropped.status, new TextDecoder().decode(dropped.body)],
  [200, 'dropped'],
);
let afterDrop: { status: string; body: Uint8Array };
try {
  afterDrop = await app.serve(meta, bytes('{"n":1}'));
} catch (e) {
  afterDrop = { status: 'threw', body: bytes(e instanceof Error ? e.message : String(e)) };
}
T(
  'dropping a table named _calls does not erase the host reply: ping still does not run again',
  [afterDrop.status, text(afterDrop.body), sql.exec('SELECT n FROM hits').raw().toArray()[0]?.[0]],
  ['ok', text(first.body), 1],
);

const master =
  'fn handle(raw: View, db: Sql) -> Response {\n  match sql_first(row: N, query: "SELECT count(*) AS n FROM sqlite_master") {\n    Some(value: N(n)) -> buf() |> write_int(value: n) |> respond(status: 200)\n    None -> empty(status: 404)\n  }\n}\ntype N { N(n: Int) }\n';
const schema = master.replace('sqlite_master', 'sqlite_schema');
T(
  'sqlite_master is unreachable from program Sql',
  codes(master).some(c => c.startsWith('C68')),
  true,
);
T(
  'sqlite_schema is unreachable from program Sql',
  codes(schema).some(c => c.startsWith('C68')),
  true,
);

finish();
