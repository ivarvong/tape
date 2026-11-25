// broken-stock.tape: examples/stock.tape's `reserve`, with a bug: after it takes one from the stock it divides by
// zero. The trap rolls its write back; the service records the failed run and answers the caller `skew` (a trap is
// not a refusal: a refusal is a value of the method's error type).
schema "CREATE TABLE IF NOT EXISTS stock(item TEXT PRIMARY KEY, remaining INTEGER NOT NULL)"
schema "INSERT OR IGNORE INTO stock VALUES ('lamp', 2), ('desk', 5)"

type Reserve { Reserve(item: View) }
type Reserved { Reserved(item: View, remaining: Int) }
type Remaining { Remaining(remaining: Int) }
// why stock refuses, as examples/stock.tape declares it
type StockError {
  NoneLeft
  NoSuchItem
}

export fn reserve(db: Sql, message: Reserve) -> Result[Reserved, StockError] {
  let Some(value: left) = sql_first(
    row: Remaining,
    query: "UPDATE stock SET remaining = remaining - 1 WHERE item = :item AND remaining > 0 \
        RETURNING *",
    item: message.item
  ) else -> Err(error: NoneLeft)
  Ok(value: Reserved(item: message.item, remaining: left.remaining / (left.remaining - 1)))
}
