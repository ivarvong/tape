// fulfillment.tape: a durable order-fulfillment workflow. Each order is a row whose `state` names the step to
// do next; the CHECK constraint lists every state, so no other value can be stored:
//
//   reserving -> charging -> shipping -> done
//                   |            |
//                   |            +-> refunding -> releasing -> failed     (no carrier: give the money back, then the stock)
//                   +-> releasing -> failed                               (card declined: give the stock back)
//   reserving -> failed                                                   (not enough stock: nothing to undo)
//
// Every step is a `call` to another program with a time budget and a key: `once: id`, the order's id. The key the
// callee stores is <this program>/<method>/<id>, so each step of each order has its own, and sending a step again
// is answered from the reply the callee stored the first time, without running it again. A call is a commit
// point: the state written before it is durable when it is sent. Each transition is a compare-and-set on the state
// it leaves (`WHERE state = ...`), so a step's result is recorded at most once.
//
// A step that times out (or finds its callee unreachable) leaves the order in the state that step belongs to, says
// so in `stall`, and answers 202. POST /advance/<id> runs the workflow on from that state: the step that timed out is sent again with
// the same key, so if it did run the first time, its stored reply comes back and nothing is repeated. Resuming is
// manual: there is no timer.
//
//   POST /orders                  {"sku":"lamp","qty":1,"card":"ann-4242","address":"1 Main St"}   2000 ms per step
//   POST /orders/wait/<ms>        the same, waiting <ms> per step (a client in a hurry; tests use 1)
//   POST /advance/<id>            resume, 2000 ms per step
//   GET  /orders/<id>             the order and its state

migration 1 "orders" {
  CREATE TABLE orders(
    id INTEGER PRIMARY KEY,
    sku TEXT NOT NULL,
    qty INTEGER NOT NULL,
    card TEXT NOT NULL,
    address TEXT NOT NULL,
    amount INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'reserving' CHECK (state IN ('reserving', 'charging', 'shipping', 'done', 'refunding', 'releasing', 'failed')),
    label INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    steps INTEGER NOT NULL DEFAULT 0
  )
}

// Why a step is waiting, apart from `note` (why the order turned back): a stall during compensation used to
// overwrite the reason, and a finished order kept saying it was waiting. Every transition clears it.
migration 2 "stall" {
  ALTER TABLE orders ADD COLUMN stall TEXT NOT NULL DEFAULT ''
}

type Qty = Int where self >= 1 and self <= 10
type NewOrder { NewOrder(sku: View, qty: Qty, card: View, address: View) }
type Order { Order(id: Int, sku: View, qty: Int, card: View, address: View, amount: Int, state: View, label: Int, note: View, stall: View, steps: Int) }

// the other programs' methods: what is sent and what comes back (the same definitions as theirs)
type Reserve { Reserve(sku: View, qty: Int) }
type Reserved { Reserved(price: Int, remaining: Int) }
type Release { Release(sku: View, qty: Int) }
type Released { Released(remaining: Int) }
type Charge { Charge(card: View, amount: Int) }
type Charged { Charged(balance: Int) }
type Refund { Refund(card: View, amount: Int) }
type Refunded { Refunded(balance: Int) }
type Ship { Ship(address: View, sku: View, qty: Int) }
type Shipped { Shipped(label: Int) }

fn handle(raw: View, db: Sql, inventory: Remote, payments: Remote, shipping: Remote) -> Buf {
  match request(raw) {
    Request(method: "POST", path: "/orders", body) -> start(db, inventory, payments, shipping, wait: 2000, order: decode(json: body, as: NewOrder))
    Request(method: "POST", path: "/orders/wait/" ++ decimal(ms), body) -> start(db, inventory, payments, shipping, wait: ms, order: decode(json: body, as: NewOrder))
    Request(method: "POST", path: "/advance/" ++ decimal(id)) -> advance(db, inventory, payments, shipping, wait: 2000, found: load(db, id))
    Request(method: "GET", path: "/orders/" ++ decimal(id)) -> show(status: 200, found: load(db, id))
    _ -> problem(status: 404, reason: "no such route")
  }
}

fn load(db: Sql, id: Int) -> Option[Order] {
  sql_first(db, row: Order, query: "SELECT id, sku, qty, card, address, amount, state, label, note, stall, steps FROM orders WHERE id = :id", id)
}

fn start(db: Sql, inventory: Remote, payments: Remote, shipping: Remote, wait: Int, order: Result[NewOrder, View]) -> Buf {
  match order {
    Ok(value: NewOrder(sku, qty, card, address)) -> advance(db, inventory, payments, shipping, wait, found: sql_first(db, row: Order, query: "INSERT INTO orders(sku, qty, card, address) VALUES (:sku, :qty, :card, :address) RETURNING id, sku, qty, card, address, amount, state, label, note, stall, steps", sku, qty, card, address))
    Err(error) -> problem(status: 400, reason: error)
  }
}

// The state names the next step. A finished order (done or failed) is shown as it is.
fn advance(db: Sql, inventory: Remote, payments: Remote, shipping: Remote, wait: Int, found: Option[Order]) -> Buf {
  match found {
    Some(value: Order(id, sku, qty, state: "reserving")) -> reserved(db, inventory, payments, shipping, wait, id, reply: call(to: inventory, method: "reserve", send: Reserve(sku, qty), reply: Reserved, within: wait, once: id))
    Some(value: Order(id, card, amount, state: "charging")) -> charged(db, inventory, payments, shipping, wait, id, reply: call(to: payments, method: "charge", send: Charge(card, amount), reply: Charged, within: wait, once: id))
    Some(value: Order(id, sku, qty, address, state: "shipping")) -> shipped(db, inventory, payments, shipping, wait, id, reply: call(to: shipping, method: "label", send: Ship(address, sku, qty), reply: Shipped, within: wait, once: id))
    Some(value: Order(id, card, amount, state: "refunding")) -> refunded(db, inventory, payments, shipping, wait, id, reply: call(to: payments, method: "refund", send: Refund(card, amount), reply: Refunded, within: wait, once: id))
    Some(value: Order(id, sku, qty, state: "releasing")) -> released(db, inventory, payments, shipping, wait, id, reply: call(to: inventory, method: "release", send: Release(sku, qty), reply: Released, within: wait, once: id))
    Some(value: Order(id, state: "done")) -> show(status: 201, found: load(db, id))
    Some(value) -> show(status: 200, found: Some(value))
    None -> problem(status: 404, reason: "no such order")
  }
}

// One transition: from the state the step belonged to, to the next. Nothing changes if the order has moved on.
// When another request moved the order first (a retry racing this one), the order as it is now: the workflow
// carries on from there, and its steps' keys make anything sent again harmless.
fn move(db: Sql, id: Int, from: View, to: View, note: View) -> Option[Order] {
  current(db, id, found: sql_first(db, row: Order, query: "UPDATE orders SET state = :to, note = :note, stall = '', steps = steps + 1 WHERE id = :id AND state = :from RETURNING id, sku, qty, card, address, amount, state, label, note, stall, steps", to, note, id, from))
}

fn reserved(db: Sql, inventory: Remote, payments: Remote, shipping: Remote, wait: Int, id: Int, reply: Result[Reserved, CallError]) -> Buf {
  match reply {
    Ok(value: Reserved(price)) -> advance(db, inventory, payments, shipping, wait, found: current(db, id, found: sql_first(db, row: Order, query: "UPDATE orders SET state = 'charging', amount = :price * qty, note = '', stall = '', steps = steps + 1 WHERE id = :id AND state = 'reserving' RETURNING id, sku, qty, card, address, amount, state, label, note, stall, steps", price, id)))
    Err(error: Rejected(reason)) -> show(status: 409, found: move(db, id, from: "reserving", to: "failed", note: reason))
    Err(error) -> stalled(db, id, state: "reserving", step: "inventory.reserve", error)
  }
}

fn charged(db: Sql, inventory: Remote, payments: Remote, shipping: Remote, wait: Int, id: Int, reply: Result[Charged, CallError]) -> Buf {
  match reply {
    Ok(value) -> advance(db, inventory, payments, shipping, wait, found: move(db, id, from: "charging", to: "shipping", note: ""))
    Err(error: Rejected(reason)) -> advance(db, inventory, payments, shipping, wait, found: move(db, id, from: "charging", to: "releasing", note: reason))
    Err(error) -> stalled(db, id, state: "charging", step: "payments.charge", error)
  }
}

fn shipped(db: Sql, inventory: Remote, payments: Remote, shipping: Remote, wait: Int, id: Int, reply: Result[Shipped, CallError]) -> Buf {
  match reply {
    Ok(value: Shipped(label)) -> advance(db, inventory, payments, shipping, wait, found: current(db, id, found: sql_first(db, row: Order, query: "UPDATE orders SET state = 'done', label = :label, note = '', stall = '', steps = steps + 1 WHERE id = :id AND state = 'shipping' RETURNING id, sku, qty, card, address, amount, state, label, note, stall, steps", label, id)))
    Err(error: Rejected(reason)) -> advance(db, inventory, payments, shipping, wait, found: move(db, id, from: "shipping", to: "refunding", note: reason))
    Err(error) -> stalled(db, id, state: "shipping", step: "shipping.label", error)
  }
}

// Compensation: the note keeps the reason the workflow turned back.
fn refunded(db: Sql, inventory: Remote, payments: Remote, shipping: Remote, wait: Int, id: Int, reply: Result[Refunded, CallError]) -> Buf {
  match reply {
    Ok(value) -> advance(db, inventory, payments, shipping, wait, found: current(db, id, found: sql_first(db, row: Order, query: "UPDATE orders SET state = 'releasing', stall = '', steps = steps + 1 WHERE id = :id AND state = 'refunding' RETURNING id, sku, qty, card, address, amount, state, label, note, stall, steps", id)))
    Err(error) -> stalled(db, id, state: "refunding", step: "payments.refund", error)
  }
}

fn released(db: Sql, inventory: Remote, payments: Remote, shipping: Remote, wait: Int, id: Int, reply: Result[Released, CallError]) -> Buf {
  match reply {
    Ok(value) -> show(status: 200, found: current(db, id, found: sql_first(db, row: Order, query: "UPDATE orders SET state = 'failed', stall = '', steps = steps + 1 WHERE id = :id AND state = 'releasing' RETURNING id, sku, qty, card, address, amount, state, label, note, stall, steps", id)))
    Err(error) -> stalled(db, id, state: "releasing", step: "inventory.release", error)
  }
}

// A step that did not finish: the order stays in that step's state, and says why. A refusal while compensating
// (a refund or a release turned down) is not retried by itself either; it needs a person. The note is written
// only while the order is still in that state: another request may have finished the step meanwhile (a retry
// racing this one), and then the order is shown as that request left it.
fn stalled(db: Sql, id: Int, state: View, step: View, error: CallError) -> Buf {
  match error {
    Timeout -> show(status: 202, found: noted(db, id, state, step, what: " did not answer in time; POST /advance/<id> resumes from here", reason: ""))
    Unreachable -> show(status: 202, found: noted(db, id, state, step, what: " is unreachable; POST /advance/<id> resumes from here", reason: ""))
    Rejected(reason) -> show(status: 500, found: noted(db, id, state, step, what: " was refused while compensating: ", reason))
    Skew(reason) -> show(status: 502, found: noted(db, id, state, step, what: ": ", reason))
  }
}

// Tape has no string concatenation in expressions (`++` is a pattern), so SQL joins the note's parts.
fn noted(db: Sql, id: Int, state: View, step: View, what: View, reason: View) -> Option[Order] {
  current(db, id, found: sql_first(db, row: Order, query: "UPDATE orders SET stall = :step || :what || :reason WHERE id = :id AND state = :state RETURNING id, sku, qty, card, address, amount, state, label, note, stall, steps", step, what, reason, id, state))
}

// The order a transition returned, or, when another request moved it first, the order as it is now.
fn current(db: Sql, id: Int, found: Option[Order]) -> Option[Order] {
  match found {
    Some(value) -> Some(value)
    None -> load(db, id)
  }
}

fn show(status: Int, found: Option[Order]) -> Buf {
  match found {
    Some(value) -> write_json(out: respond(status), value)
    None -> problem(status: 409, reason: "the order is not in the state this step expected")
  }
}

fn problem(status: Int, reason: View) -> Buf {
  append(buf: write_json_string(out: append(buf: respond(status), view: "{\"error\":"), text: reason), view: "}")
}
// added for rule RM: the states of the table and the moves between them
machine orders.state {
  "reserving" -> "charging"
  "reserving" -> "failed"
  "charging" -> "shipping"
  "charging" -> "releasing"
  "shipping" -> "done"
  "shipping" -> "refunding"
  "refunding" -> "releasing"
  "releasing" -> "failed"
}
