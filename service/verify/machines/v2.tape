// Machines: the same table as v1.tape with a machine, which has no "void".
schema "CREATE TABLE IF NOT EXISTS s(id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, state \
    TEXT NOT NULL DEFAULT 'pending')"

type SaleState { Pending Paid Declined }

machine s.state: SaleState {
  Pending -> Paid
  Pending -> Declined
}

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
    _ -> empty(status: 404)
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
