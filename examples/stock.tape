// stock.tape: the stock object. `reserve` is a method other objects call; it has no `handle`.

schema "CREATE TABLE IF NOT EXISTS stock(item TEXT PRIMARY KEY, remaining INTEGER NOT NULL)"
schema "INSERT OR IGNORE INTO stock VALUES ('lamp', 2), ('desk', 5)"

type Reserve { Reserve(item: View) }
type Reserved { Reserved(item: View, remaining: Int) }
type Remaining { Remaining(remaining: Int) }
// why stock refuses: a reservation of an item with none left, a count of one it does not keep
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
  Ok(value: Reserved(item: message.item, remaining: left.remaining))
}

export fn remaining(db: Sql, message: Reserve) -> Result[Remaining, StockError] {
  let Some(value) = sql_first(
    row: Remaining,
    query: "SELECT * FROM stock WHERE item = :item",
    item: message.item
  ) else -> Err(error: NoSuchItem)
  Ok(value)
}

invariant "an item has no fewer than none left, and no more than it started with" {
  SELECT item, remaining FROM stock WHERE remaining < 0 OR remaining > CASE item WHEN 'lamp' THEN 2 WHEN 'desk' THEN 5 ELSE 0 END
}
