// undone.tape: a write, then rollback(out) on /undo and a trap on /trap; any other path keeps it (mcp/test.ts).
// /wake sets a timer and rolls back: the timer is undone too.
schema "CREATE TABLE IF NOT EXISTS t(k TEXT PRIMARY KEY)"

fn handle(raw: View, db: Sql, timer: Timer) -> Buf {
  let w = sql_exec(query: "INSERT OR IGNORE INTO t(k) VALUES ('a')")
  match request(raw) {
    Request(path: "/undo") -> rollback(out: respond(status: 409) |> append(view: "undone \(w)"))
    Request(path: "/trap") -> respond(status: 200) |> append(view: "\(w / (w - w))")
    Request(path: "/wake") -> {
      do wake(after: 1000, key: 1)
      rollback(out: respond(status: 409) |> append(view: "no timer"))
    }
    _ -> respond(status: 200) |> append(view: "kept \(w)")
  }
}

type Woke { Woke(key: Int) }

export fn woken(db: Sql, message: Wake) -> Result[Woke, View] {
  let Wake(key) = message
  Ok(value: Woke(key))
}
