// shipping.tape: labels for the fulfillment workflow. `label` is a command its caller sends with a key. Some
// addresses have no carrier, so a label can be refused, which is what sends a workflow into compensation.
// GET /labels shows every label made.

schema "CREATE TABLE IF NOT EXISTS labels(id INTEGER PRIMARY KEY, address TEXT NOT NULL, sku \
    TEXT NOT NULL, qty INTEGER NOT NULL)"
schema "CREATE TABLE IF NOT EXISTS unserved(address TEXT PRIMARY KEY)"
schema "INSERT OR IGNORE INTO unserved VALUES ('Atlantis')"

type Ship { Ship(address: View, sku: View, qty: Int) }
type Shipped { Shipped(label: Int) }
type Label { Label(id: Int, address: View, sku: View, qty: Int) }
// why shipping refuses a label: no carrier delivers to the address
type ShipError { NoCarrier(address: View) }

export fn label(db: Sql, message: Ship) -> Result[Shipped, ShipError] {
  let Some(value) = sql_first(
    row: Shipped,
    query: "INSERT INTO labels(address, sku, qty) SELECT :address, :sku, :qty WHERE :address \
        NOT IN (SELECT address FROM unserved) RETURNING id AS label",
    address: message.address,
    sku: message.sku,
    qty: message.qty
  ) else -> Err(error: NoCarrier(address: message.address))
  Ok(value)
}

fn handle(raw: View, db: Sql) -> Response {
  match request(raw) {
    Request(method: Get, path: "/labels") -> buf()
      |> write_rows(rows: sql_all(row: Label, query: "SELECT * FROM labels ORDER BY id"))
      |> respond(status: 200)
    _ -> problem(status: 404, detail: "no such route")
  }
}

invariant "no label goes to an address that is not served" {
  SELECT l.id, l.address FROM labels AS l JOIN unserved AS u ON u.address = l.address
}
