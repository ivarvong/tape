// orders.tape: an order service that reserves stock in another object before confirming.
// Every call has a time budget, and every way it can fail is a value the code must handle. `reserve` is a
// command, so it carries a key (the order's id): after a timeout, POST /retry/<id> sends it again and the stock
// object answers with what it did the first time.
//
// POST /orders carries the client's key, {"key":"o-1","item":"lamp"}: sent again with the same key (no answer came)
// it is the same order, and a pending one is sent to stock again with the same once key; the same key for another
// item is 422. Without a key a retried POST made a second order; the compiler refuses that INSERT now (C55).

// How long to wait for the stock object. Calls between objects in production were measured at 34 to 66 ms, so
// the default leaves room; tests set it to 50 to see a timeout.
flag stock_budget_ms: Int = 2000

schema "CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY, item TEXT NOT NULL, state \
    TEXT NOT NULL, client TEXT NOT NULL UNIQUE)"

// An order waits as pending for its stock; the compiler checks every write of its state against these moves (each
// from the state its WHERE names), and the host installs SQLite triggers that refuse any other.
type OrderState { Pending Confirmed Refused }

machine orders.state: OrderState {
  Pending -> Confirmed
  Pending -> Refused
}

type Order { Order(id: Int, item: View, state: OrderState) }
type Key = View where len(self) >= 1 and len(self) <= 64
type ForOrder { ForOrder(order: Int) }
type NewOrder { NewOrder(key: Key, item: View) }
// what stock refuses with: the same type stock.tape declares, so the two fingerprints agree
type StockError {
  NoneLeft
  NoSuchItem
}

// the stock object's `reserve` method: what is sent and what comes back
type Reserve { Reserve(item: View) }
type Reserved { Reserved(item: View, remaining: Int) }

fn handle(raw: View, db: Sql, stock: Remote) -> Response {
  match request(raw) {
    Request(method: Post, path: "/orders", body) -> place(body)
    Request(method: Post, path: "/retry/" ++ decimal(id)) -> retry(id)
    Request(method: Get, path: "/orders") -> buf()
      |> write_rows(rows: sql_all(row: Order, query: "SELECT * FROM orders ORDER BY id"))
      |> respond(status: 200)
    _ -> problem(status: 404, detail: "no such route")
  }
}

// The order this request makes, or the one an earlier request with the same key made.
fn place(body: View) -> Response uses db, stock {
  let Ok(value: NewOrder(key, item)) = decode(json: body, as: NewOrder) else {
    Err(error) -> problem(status: 400, detail: error)
  }
  let Some(value: order) = sql_first(
    row: Order,
    query: "INSERT INTO orders(client, item, state) VALUES (:key, :item, 'pending') \
        ON CONFLICT(client) DO NOTHING RETURNING *",
    key,
    item
  ) else {
    None -> again(found: sql_first(
      row: Order,
      query: "SELECT * FROM orders WHERE client = :key AND item = :item",
      key,
      item
    ))
  }
  reserve(order)
}

// The same key again: a pending order is sent to stock again (same once key); a settled one is shown as it stands.
fn again(found: Option[Order]) -> Response uses db, stock {
  match found {
    Some(value: order = Order(state: Pending)) -> reserve(order)
    Some(value: order = Order(state: Confirmed)) -> shown(status: 200, order)
    Some(value: Order(state: Refused)) -> problem(status: 409, detail: "this order was refused")
    None -> problem(status: 422, detail: "the key was already used for another order")
  }
}

fn retry(id: Int) -> Response uses db, stock {
  let Some(value: order) = sql_first(
    row: Order,
    query: "SELECT * FROM orders WHERE id = :id AND state = 'pending'",
    id
  ) else -> problem(status: 404, detail: "no such pending order")
  reserve(order)
}

// The order is committed before the call is made: a call is a commit point. Each way the call can fail is an arm.
fn reserve(order: Order) -> Response uses db, stock {
  let Order(id, item) = order
  let Ok(value: Reserved) = call(
    to: stock,
    method: "reserve",
    send: Reserve(item),
    reply: Reserved,
    error: StockError,
    within: flags.stock_budget_ms,
    once: ForOrder(order: id)
  ) else {
    Err(error: Rejected(reason)) -> refused(
      reason,
      moved: sql_move(
        row: Order,
        query: "UPDATE orders SET state = 'refused' WHERE id = :id AND state = 'pending' \
            RETURNING *",
        id
      )
    )
    Err(error: Timeout) -> problem(
      status: 504,
      detail: "stock did not answer in time; the order stays pending"
    )
    Err(error: Skew(reason)) -> problem(status: 502, detail: reason)
    Err(error: Unreachable) -> problem(
      status: 503,
      detail: "stock is unreachable; the order stays pending"
    )
  }
  // confirmed by this request or, when a retry racing it moved the order first (both heard the same stored reply),
  // by that one
  match sql_move(
    row: Order,
    query: "UPDATE orders SET state = 'confirmed' WHERE id = :id AND state = 'pending' RETURNING *",
    id
  ) {
    Moved(value) -> shown(status: 201, order: value)
    Raced(now) -> shown(status: 201, order: now)
    NoRow -> problem(status: 500, detail: "the order vanished")
  }
}

// Refused, whether this request moved the order or a retry racing it did.
fn refused(reason: StockError, moved: Move[Order]) -> Response {
  match moved {
    NoRow -> problem(status: 404, detail: "no such pending order")
    _ -> problem(status: 409, detail: refusal(reason))
  }
}

// What stock's refusal tells the client.
fn refusal(reason: StockError) -> View {
  match reason {
    NoneLeft -> "none left"
    NoSuchItem -> "no such item"
  }
}

fn shown(status: Int, order: Order) -> Response {
  buf() |> write_json(value: order) |> respond(status)
}

// Across two programs: what stock gave out, against the orders. Each order's reserve carries the order's key, so an
// order takes one at most; a pending order may or may not have taken its one (its reply may be lost), so the count
// taken lies between the confirmed orders and the confirmed and pending ones. Only the simulator has both
// programs' rows (`tape sim orders.tape stock.tape`).
invariant "stock taken for an item is at least its confirmed orders, and at most those and its pending ones" with stock {
  SELECT t.item, t.taken FROM (SELECT item, CASE item WHEN 'lamp' THEN 2 WHEN 'desk' THEN 5 ELSE 0 END - remaining AS taken FROM stock.stock) AS t WHERE t.taken < (SELECT count(*) FROM orders AS o WHERE o.item = t.item AND o.state = 'confirmed') OR t.taken > (SELECT count(*) FROM orders AS o WHERE o.item = t.item AND o.state IN ('confirmed', 'pending'))
}
