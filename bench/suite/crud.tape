// crud.tape: a batch JSON API on SQLite. POST /items with {"batch": key, "items": [{key, name, qty, cents}, …]}:
// every item is checked as it is decoded, inserted under its own key (a key seen before is not inserted
// again), and the answer is the batch's totals and its rows, as JSON. Same behaviour as crud-js.ts.
schema "CREATE TABLE IF NOT EXISTS items(id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, batch \
    TEXT NOT NULL, name TEXT NOT NULL, qty INTEGER NOT NULL, cents INTEGER NOT NULL)"
schema "CREATE INDEX IF NOT EXISTS items_batch ON items(batch)"

type Key = View where len(self) >= 1 and len(self) <= 64
type Name = View where len(self) >= 1 and len(self) <= 200
type Qty = Int where self >= 0 and self <= 1000000
type Cents = Int where self >= 0 and self <= 100000000
type NewItem { NewItem(key: Key, name: Name, qty: Qty, cents: Cents) }
type Batch { Batch(batch: Key, items: List[NewItem]) }
type Item { Item(id: Int, key: View, batch: View, name: View, qty: Int, cents: Int) }
type Sum { Sum(n: Int, units: Int, cents: Int) }

fn handle(raw: View, db: Sql) -> Response {
  match request(raw) {
    Request(method: Post, path: "/items", body) -> create(body)
    _ -> problem(status: 404, detail: "no such route")
  }
}

fn create(body: View) -> Response {
  let Ok(value: Batch(batch, items)) = decode(json: body, as: Batch) else {
    Err(error) -> problem(status: 400, detail: error)
  }
  let made = insert_all(batch, items, made: 0)
  let Some(
    value: Sum(n, units, cents)
  ) = sql_first(
    row: Sum,
    query: "SELECT count(*) AS n, coalesce(sum(qty), 0) AS units, coalesce(sum(qty * cents), 0) \
        AS cents FROM items WHERE batch = :batch",
    batch
  ) else -> problem(status: 500, detail: "no totals")
  buf()
    |> append(
      view: "{\"created\":\(made),\"n\":\(n),\"units\":\(units),\"cents\":\(cents),\"items\":"
    )
    |> write_rows(rows: sql_all(
      row: Item,
      query: "SELECT * FROM items WHERE batch = :batch ORDER BY id",
      batch
    ))
    |> append(view: "}")
    |> respond(status: 200)
}

fn insert_all(batch: Key, items: List[NewItem], made: Int) -> Int {
  match items {
    Cons(head: NewItem(key, name, qty, cents), tail) -> insert_all(
      batch,
      items: tail,
      made: made + sql_exec(
        query: "INSERT INTO items(key, batch, name, qty, cents) \
            VALUES (:key, :batch, :name, :qty, :cents) ON CONFLICT(key) DO NOTHING",
        key,
        batch,
        name,
        qty,
        cents
      )
    )
    Nil -> made
  }
}
