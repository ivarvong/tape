// broken-stock.tape: examples/stock.tape's `reserve`, with a bug: after it takes one from the stock it divides by
// zero. The trap rolls its write back; the service records the failed run and answers the caller `rejected`.
schema "CREATE TABLE IF NOT EXISTS stock(item TEXT PRIMARY KEY, remaining INTEGER NOT NULL)"
schema "INSERT OR IGNORE INTO stock VALUES ('lamp', 2), ('desk', 5)"

type Reserve { Reserve(item: View) }
type Reserved { Reserved(item: View, remaining: Int) }
type Remaining { Remaining(remaining: Int) }

export fn reserve(db: Sql, message: Reserve) -> Result[Reserved, View] {
  let Some(value: left) = sql_first(
    row: Remaining,
    query: "UPDATE stock SET remaining = remaining - 1 WHERE item = :item AND remaining > 0 \
        RETURNING *",
    item: message.item
  ) else -> Err(error: "none left")
  Ok(value: Reserved(item: message.item, remaining: left.remaining / (left.remaining - 1)))
}
