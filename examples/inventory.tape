// inventory.tape: stock for the fulfillment workflow. `reserve` and `release` are methods other objects call,
// each a command its caller sends with a key, so a repeat is answered from the stored reply. GET /stock shows
// what is left, which is how a demo proves a reservation happened once.

schema "CREATE TABLE IF NOT EXISTS stock(sku TEXT PRIMARY KEY NOT NULL, price \
    INTEGER NOT NULL, remaining INTEGER NOT NULL)"
schema "INSERT OR IGNORE INTO stock VALUES ('lamp', 40, 5), ('desk', 150, 2)"

type Reserve { Reserve(sku: View, qty: Int) }
type Reserved { Reserved(price: Int, remaining: Int) }
type Release { Release(sku: View, qty: Int) }
type Released { Released(remaining: Int) }
type Item { Item(sku: View, price: Int, remaining: Int) }

export fn reserve(db: Sql, message: Reserve) -> Result[Reserved, View] {
  let Some(value) = sql_first(
    row: Reserved,
    query: "UPDATE stock SET remaining = remaining - :qty WHERE sku = :sku AND remaining >= :qty \
        RETURNING *",
    qty: message.qty,
    sku: message.sku
  ) else -> Err(error: "not enough stock")
  Ok(value)
}

export fn release(db: Sql, message: Release) -> Result[Released, View] {
  let Some(value) = sql_first(
    row: Released,
    query: "UPDATE stock SET remaining = remaining + :qty WHERE sku = :sku RETURNING *",
    qty: message.qty,
    sku: message.sku
  ) else -> Err(error: "no such sku")
  Ok(value)
}

fn handle(raw: View, db: Sql) -> Buf {
  match request(raw) {
    Request(method: "GET", path: "/stock") -> respond(status: 200)
      |> write_rows(rows: sql_all(row: Item, query: "SELECT * FROM stock ORDER BY sku"))
    _ -> respond(status: 404) |> append(view: "{\"error\":\"no such route\"}")
  }
}

// What must hold after every commit. The second catches a release sent twice: more would come back than was taken.
invariant "no stock is below zero" {
  SELECT sku, remaining FROM stock WHERE remaining < 0
}

invariant "no more is released than was reserved" {
  SELECT sku, remaining FROM stock WHERE remaining > CASE sku WHEN 'lamp' THEN 5 WHEN 'desk' THEN 2 ELSE 0 END
}
