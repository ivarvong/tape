// undone.tape: a write, then rollback(out) on /undo and a trap on /trap; any other path keeps it (mcp/test.ts).
schema "CREATE TABLE IF NOT EXISTS t(k TEXT PRIMARY KEY)"

fn handle(raw: View, db: Sql) -> Buf {
  let w = sql_exec(query: "INSERT OR IGNORE INTO t(k) VALUES ('a')")
  match request(raw) {
    Request(path: "/undo") -> rollback(out: respond(status: 409) |> append(view: "undone \(w)"))
    Request(path: "/trap") -> respond(status: 200) |> append(view: "\(w / (w - w))")
    _ -> respond(status: 200) |> append(view: "kept \(w)")
  }
}
