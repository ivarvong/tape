// orders.tape: an order service that reserves stock in another object before confirming.
// Every call has a time budget, and every way it can fail is a value the code must handle. `reserve` is a
// command, so it carries a key (the order's id): after a timeout, POST /retry/<id> sends it again and the stock
// object answers with what it did the first time.

// How long to wait for the stock object. Calls between objects in production were measured at 34 to 66 ms, so
// the default leaves room; tests set it to 50 to see a timeout.
flag stock_budget_ms: Int = 2000

schema "CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY, item TEXT NOT NULL, state TEXT NOT NULL)"

type Order { Order(id: Int, item: View, state: View) }
type NewOrder { NewOrder(item: View) }

// the stock object's `reserve` method: what is sent and what comes back
type Reserve { Reserve(item: View) }
type Reserved { Reserved(item: View, remaining: Int) }

fn handle(raw: View, db: Sql, stock: Remote) -> Response {
  match request(raw) {
    Request(method: Post, path: "/orders", body) -> place(db, stock, order: decode(json: body, as: NewOrder))
    Request(method: Post, path: "/retry/" ++ decimal(id)) -> reserve(db, stock, made: sql_first(db, row: Order, query: "SELECT id, item, state FROM orders WHERE id = :id AND state = 'pending'", id))
    Request(method: Get, path: "/orders") -> orders(out: append(buf: buf(), view: "["), rows: sql_all(db, row: Order, query: "SELECT id, item, state FROM orders ORDER BY id"), first: True) |> respond(status: 200)
    _ -> problem(status: 404, reason: "no such route")
  }
}

fn place(db: Sql, stock: Remote, order: Result[NewOrder, View]) -> Response {
  match order {
    Ok(value: NewOrder(item)) -> reserve(db, stock, made: sql_first(db, row: Order, query: "INSERT INTO orders(item, state) VALUES (:item, 'pending') RETURNING id, item, state", item))
    Err(error) -> problem(status: 400, reason: error)
  }
}

// The insert above is committed before the call below is made: a call is a commit point.
fn reserve(db: Sql, stock: Remote, made: Option[Order]) -> Response {
  match made {
    Some(value: Order(id, item)) -> settle(db, id, reply: call(to: stock, method: "reserve", send: Reserve(item), reply: Reserved, within: flags.stock_budget_ms, once: id))
    None -> problem(status: 404, reason: "no such pending order")
  }
}

fn settle(db: Sql, id: Int, reply: Result[Reserved, CallError]) -> Response {
  match reply {
    Ok(value) -> finish(status: 201, found: sql_first(db, row: Order, query: "UPDATE orders SET state = 'confirmed' WHERE id = :id RETURNING id, item, state", id))
    Err(error: Rejected(reason)) -> refuse(status: 409, reason, count: sql_exec(db, query: "UPDATE orders SET state = 'refused' WHERE id = :id", id))
    Err(error: Timeout) -> problem(status: 504, reason: "stock did not answer in time; the order stays pending")
    Err(error: Skew(reason)) -> problem(status: 502, reason)
    Err(error: Unreachable) -> problem(status: 503, reason: "stock is unreachable; the order stays pending")
  }
}

fn refuse(status: Int, reason: View, count: Int) -> Response {
  problem(status, reason)
}

fn finish(status: Int, found: Option[Order]) -> Response {
  match found {
    Some(value) -> write_json(out: buf(), value) |> respond(status)
    None -> problem(status: 500, reason: "the order vanished")
  }
}

fn problem(status: Int, reason: View) -> Response {
  append(buf: write_json_string(out: append(buf: buf(), view: "{\"error\":"), text: reason), view: "}") |> respond(status)
}

fn orders(out: Buf, rows: Rows[Order], first: Bool) -> Buf {
  match next(rows) {
    Next(value, rest) if first -> orders(out: write_json(out, value), rows: rest, first: False)
    Next(value, rest) -> orders(out: write_json(out: push(buf: out, byte: 44), value), rows: rest, first: False)
    End -> push(buf: out, byte: 93)
  }
}
