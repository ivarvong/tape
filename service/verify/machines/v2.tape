// Machines: the same table as v1.tape with a machine, which has no "void".
schema "CREATE TABLE IF NOT EXISTS s(id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, state \
    TEXT NOT NULL DEFAULT 'pending')"

type SaleState { Pending Paid Declined }

machine s.state: SaleState {
  Pending -> Paid
  Pending -> Declined
}

type Text { Text(text: View) }

fn handle(raw: View, db: Sql) -> Response {
  match request(raw) {
    Request(method: Post, path: "/new/" ++ key) -> done(
      n: sql_exec(db, query: "INSERT INTO s(key) VALUES (:key) ON CONFLICT(key) DO NOTHING", key)
    )
    Request(method: Post, path: "/pay/" ++ key) -> moved(m: sql_move(
      db,
      row: Sold,
      query: "UPDATE s SET state = 'paid' WHERE key = :key AND state = 'pending' RETURNING id",
      key
    ))
    Request(method: Get, path: "/triggers") -> buf()
      |> append(view: sql_first(
        db,
        row: Text,
        query: "SELECT coalesce(group_concat(sql, ' ; '), '') AS text FROM sqlite_master \
            WHERE type = 'trigger'"
      ) |> shown)
      |> respond(status: 200)
    _ -> empty(status: 404)
  }
}

fn shown(found: Option[Text]) -> View {
  match found {
    Some(value: Text(text)) -> text
    None -> ""
  }
}

fn done(n: Int) -> Response {
  buf() |> write_int(value: n) |> respond(status: 200)
}

// the compare-and-set is a sql_move (C62): Moved, Raced (another request moved the row first) or NoRow
type Sold { Sold(id: Int) }

fn moved(m: Move[Sold]) -> Response {
  match m {
    Moved(value) -> buf() |> write_int(value: 1) |> respond(status: 200)
    Raced(now) -> empty(status: 409)
    NoRow -> empty(status: 404)
  }
}
