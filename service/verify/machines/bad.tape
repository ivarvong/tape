// Machines: three writes the machine refuses: no guard (C58), a move back (C59), a misspelt state (C61).
schema "CREATE TABLE IF NOT EXISTS s(id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, state \
    TEXT NOT NULL DEFAULT 'pending')"

type SaleState { Pending Paid Declined }

machine s.state: SaleState {
  Pending -> Paid
  Pending -> Declined
}

type Text { Text(text: View) }

fn handle(raw: View, db: Sql) -> Buf {
  match request(raw) {
    Request(method: "POST", path: "/new/" ++ key) -> done(
      n: sql_exec(db, query: "INSERT INTO s(key) VALUES (:key) ON CONFLICT(key) DO NOTHING", key)
    )
    Request(method: "POST", path: "/note/" ++ key) -> done(
      n: sql_exec(db, query: "UPDATE s SET key = key || '!' WHERE key = :key", key)
    )
    Request(method: "POST", path: "/back/" ++ key) -> moved(m: sql_move(
      db,
      row: Sold,
      query: "UPDATE s SET state = 'pending' WHERE key = :key AND state = 'paid' RETURNING id",
      key
    ))
    Request(method: "GET", path: "/count") -> done(
      n: sql_exec(db, query: "SELECT count(*) FROM s WHERE state = 'payed'")
    )
    Request(method: "GET", path: "/triggers") -> respond(status: 200)
      |> append(view: sql_first(
        db,
        row: Text,
        query: "SELECT coalesce(group_concat(sql, ' ; '), '') AS text FROM sqlite_master \
            WHERE type = 'trigger'"
      ) |> shown)
    _ -> respond(status: 404)
  }
}

fn shown(found: Option[Text]) -> View {
  match found {
    Some(value: Text(text)) -> text
    None -> ""
  }
}

fn done(n: Int) -> Buf {
  respond(status: 200) |> write_int(value: n)
}

// the compare-and-set is a sql_move (C62): Moved, Raced (another request moved the row first) or NoRow
type Sold { Sold(id: Int) }

fn moved(m: Move[Sold]) -> Buf {
  match m {
    Moved(value) -> respond(status: 200) |> write_int(value: 1)
    Raced(now) -> respond(status: 409)
    NoRow -> respond(status: 404)
  }
}
