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
// so in `stall`, and answers 202. Running the workflow on from that state sends the step that timed out again with
// the same key, so if it did run the first time, its stored reply comes back and nothing is repeated. That happens
// by itself: the step sets a timer with std/retry.tape (1 s, then 2, 4, 8; five attempts in all), and when it is
// due the host calls `woken` below, which resumes the order. After the last attempt the order waits for
// POST /advance/<id>, which resumes it the same way. `retries` counts the failures of the current step.
//
// An order is created once per client key: POST /orders sent again with the same key (a client that got no answer)
// is the same order, carried on from where it stands; the same key with another order is 422. Without a key a
// retried POST made a second order; the compiler now refuses an INSERT that no client key guards (rules.ts, C55).
//
//   POST /orders                  {"key":"c-1","sku":"lamp","qty":1,"card":"ann-4242","address":"1 Main St"}   2000 ms per step
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

// How many times in a row the current step has failed to answer; every transition sets it back to 0.
migration 3 "retries" {
  ALTER TABLE orders ADD COLUMN retries INTEGER NOT NULL DEFAULT 0
}

// The client's key for each order (see POST /orders). Orders made before it have none (NULL), which UNIQUE allows.
migration 4 "client keys" {
  ALTER TABLE orders ADD COLUMN client TEXT;
  CREATE UNIQUE INDEX orders_client ON orders(client)
}

// The workflow drawn above, as the compiler checks it: every write of orders.state makes one of these moves, from
// the state its WHERE names (rules.ts, C57-C61), and the host installs SQLite triggers that refuse any other.
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

type Qty = Int where self >= 1 and self <= 10
type Key = View where len(self) >= 1 and len(self) <= 64
type NewOrder { NewOrder(key: Key, sku: View, qty: Qty, card: View, address: View) }
type Order { Order(id: Int, sku: View, qty: Int, card: View, address: View, amount: Int, state: View, label: Int, note: View, stall: View, steps: Int, retries: Int) }

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

// What a run of the workflow comes to: the order as it now stands, or why there is none. handle writes it as an
// HTTP response; woken, run by a timer, returns it as its reply.
type Outcome {
  Shown(status: Int, order: Order)
  Problem(status: Int, reason: View)
}

// When a step that did not answer is sent again (std/retry.tape): 1 s after the first failure, then twice as long
// each time, at most 30 s apart, five attempts in all.
fn resume() -> Backoff {
  Backoff(first: 1000, factor: 2, most: 30000, tries: 5)
}

fn handle(raw: View, db: Sql, inventory: Remote, payments: Remote, shipping: Remote, timer: Timer) -> Response {
  routed(raw, db, inventory, payments, shipping, timer) |> rendered
}

fn routed(raw: View, db: Sql, inventory: Remote, payments: Remote, shipping: Remote, timer: Timer) -> Outcome {
  match request(raw) {
    Request(method: Post, path: "/orders", body) -> start(db, inventory, payments, shipping, timer, wait: 2000, order: decode(json: body, as: NewOrder))
    Request(method: Post, path: "/orders/wait/" ++ decimal(ms), body) -> start(db, inventory, payments, shipping, timer, wait: ms, order: decode(json: body, as: NewOrder))
    Request(method: Post, path: "/advance/" ++ decimal(id)) -> advance(db, inventory, payments, shipping, timer, wait: 2000, found: load(db, id))
    Request(method: Get, path: "/orders/" ++ decimal(id)) -> shown(found: load(db, id))
    _ -> Problem(status: 404, reason: "no such route")
  }
}

// A timer a stalled step set is due: carry the order on from where it is now, as POST /advance/<id> would.
export fn woken(db: Sql, inventory: Remote, payments: Remote, shipping: Remote, timer: Timer, message: Wake) -> Result[Order, View] {
  let Wake(key) = message
  advance(db, inventory, payments, shipping, timer, wait: 2000, found: load(db, id: key)) |> settled
}

fn settled(outcome: Outcome) -> Result[Order, View] {
  match outcome {
    Shown(order) -> Ok(value: order)
    Problem(reason) -> Err(error: reason)
  }
}

fn load(db: Sql, id: Int) -> Option[Order] {
  sql_first(db, row: Order, query: "SELECT id, sku, qty, card, address, amount, state, label, note, stall, steps, retries FROM orders WHERE id = :id", id)
}

fn start(db: Sql, inventory: Remote, payments: Remote, shipping: Remote, timer: Timer, wait: Int, order: Result[NewOrder, View]) -> Outcome {
  match order {
    Ok(value: NewOrder(key, sku, qty, card, address)) -> created(db, inventory, payments, shipping, timer, wait, asked: NewOrder(key, sku, qty, card, address), made: sql_first(db, row: Order, query: "INSERT INTO orders(client, sku, qty, card, address) VALUES (:key, :sku, :qty, :card, :address) ON CONFLICT(client) DO NOTHING RETURNING id, sku, qty, card, address, amount, state, label, note, stall, steps, retries", key, sku, qty, card, address))
    Err(error) -> Problem(status: 400, reason: error)
  }
}

// The order this request made; or the one an earlier request with this key made, carried on from where it stands;
// or 422 when the key was used for another order.
fn created(db: Sql, inventory: Remote, payments: Remote, shipping: Remote, timer: Timer, wait: Int, asked: NewOrder, made: Option[Order]) -> Outcome {
  let NewOrder(key, sku, qty, card, address) = asked
  match made {
    Some(value) -> advance(db, inventory, payments, shipping, timer, wait, found: Some(value))
    None -> again(db, inventory, payments, shipping, timer, wait, key, same: sql_first(db, row: Order, query: "SELECT id, sku, qty, card, address, amount, state, label, note, stall, steps, retries FROM orders WHERE client = :key AND sku = :sku AND qty = :qty AND card = :card AND address = :address", key, sku, qty, card, address))
  }
}

fn again(db: Sql, inventory: Remote, payments: Remote, shipping: Remote, timer: Timer, wait: Int, key: View, same: Option[Order]) -> Outcome {
  match same {
    Some(value) -> advance(db, inventory, payments, shipping, timer, wait, found: Some(value))
    None -> Problem(status: 422, reason: "the key " ++ key ++ " was already used for another order")
  }
}

// The state names the next step. A finished order (done or failed) is shown as it is.
fn advance(db: Sql, inventory: Remote, payments: Remote, shipping: Remote, timer: Timer, wait: Int, found: Option[Order]) -> Outcome {
  match found {
    Some(value: Order(id, sku, qty, state: "reserving")) -> reserved(db, inventory, payments, shipping, timer, wait, id, reply: call(to: inventory, method: "reserve", send: Reserve(sku, qty), reply: Reserved, within: wait, once: id))
    Some(value: Order(id, card, amount, state: "charging")) -> charged(db, inventory, payments, shipping, timer, wait, id, reply: call(to: payments, method: "charge", send: Charge(card, amount), reply: Charged, within: wait, once: id))
    Some(value: Order(id, sku, qty, address, state: "shipping")) -> shipped(db, inventory, payments, shipping, timer, wait, id, reply: call(to: shipping, method: "label", send: Ship(address, sku, qty), reply: Shipped, within: wait, once: id))
    Some(value: Order(id, card, amount, state: "refunding")) -> refunded(db, inventory, payments, shipping, timer, wait, id, reply: call(to: payments, method: "refund", send: Refund(card, amount), reply: Refunded, within: wait, once: id))
    Some(value: Order(id, sku, qty, state: "releasing")) -> released(db, inventory, payments, shipping, timer, wait, id, reply: call(to: inventory, method: "release", send: Release(sku, qty), reply: Released, within: wait, once: id))
    Some(value: order = Order(state: "done")) -> Shown(status: 201, order)
    Some(value: order) -> Shown(status: 200, order)
    None -> Problem(status: 404, reason: "no such order")
  }
}

// One transition: from the state the step belonged to, to the next. Nothing changes if the order has moved on.
// When another request moved the order first (a retry racing this one), the order as it is now: the workflow
// carries on from there, and its steps' keys make anything sent again harmless.
fn move(db: Sql, id: Int, from: View, to: View, note: View) -> Option[Order] {
  sql_first(db, row: Order, query: "UPDATE orders SET state = :to, note = :note, stall = '', retries = 0, steps = steps + 1 WHERE id = :id AND state = :from RETURNING id, sku, qty, card, address, amount, state, label, note, stall, steps, retries", to, note, id, from)
}

fn reserved(db: Sql, inventory: Remote, payments: Remote, shipping: Remote, timer: Timer, wait: Int, id: Int, reply: Result[Reserved, CallError]) -> Outcome {
  match reply {
    Ok(value: Reserved(price)) -> advance(db, inventory, payments, shipping, timer, wait, found: current(db, id, found: sql_first(db, row: Order, query: "UPDATE orders SET state = 'charging', amount = :price * qty, note = '', stall = '', retries = 0, steps = steps + 1 WHERE id = :id AND state = 'reserving' RETURNING id, sku, qty, card, address, amount, state, label, note, stall, steps, retries", price, id)))
    Err(error: Rejected(reason)) -> show(status: 409, found: move(db, id, from: "reserving", to: "failed", note: reason))
    Err(error) -> stalled(db, timer, id, state: "reserving", step: "inventory.reserve", error)
  }
}

fn charged(db: Sql, inventory: Remote, payments: Remote, shipping: Remote, timer: Timer, wait: Int, id: Int, reply: Result[Charged, CallError]) -> Outcome {
  match reply {
    Ok(value) -> advance(db, inventory, payments, shipping, timer, wait, found: move(db, id, from: "charging", to: "shipping", note: ""))
    Err(error: Rejected(reason)) -> advance(db, inventory, payments, shipping, timer, wait, found: move(db, id, from: "charging", to: "releasing", note: reason))
    Err(error) -> stalled(db, timer, id, state: "charging", step: "payments.charge", error)
  }
}

fn shipped(db: Sql, inventory: Remote, payments: Remote, shipping: Remote, timer: Timer, wait: Int, id: Int, reply: Result[Shipped, CallError]) -> Outcome {
  match reply {
    Ok(value: Shipped(label)) -> advance(db, inventory, payments, shipping, timer, wait, found: current(db, id, found: sql_first(db, row: Order, query: "UPDATE orders SET state = 'done', label = :label, note = '', stall = '', retries = 0, steps = steps + 1 WHERE id = :id AND state = 'shipping' RETURNING id, sku, qty, card, address, amount, state, label, note, stall, steps, retries", label, id)))
    Err(error: Rejected(reason)) -> advance(db, inventory, payments, shipping, timer, wait, found: move(db, id, from: "shipping", to: "refunding", note: reason))
    Err(error) -> stalled(db, timer, id, state: "shipping", step: "shipping.label", error)
  }
}

// Compensation: the note keeps the reason the workflow turned back.
fn refunded(db: Sql, inventory: Remote, payments: Remote, shipping: Remote, timer: Timer, wait: Int, id: Int, reply: Result[Refunded, CallError]) -> Outcome {
  match reply {
    Ok(value) -> advance(db, inventory, payments, shipping, timer, wait, found: current(db, id, found: sql_first(db, row: Order, query: "UPDATE orders SET state = 'releasing', stall = '', retries = 0, steps = steps + 1 WHERE id = :id AND state = 'refunding' RETURNING id, sku, qty, card, address, amount, state, label, note, stall, steps, retries", id)))
    Err(error) -> stalled(db, timer, id, state: "refunding", step: "payments.refund", error)
  }
}

fn released(db: Sql, inventory: Remote, payments: Remote, shipping: Remote, timer: Timer, wait: Int, id: Int, reply: Result[Released, CallError]) -> Outcome {
  match reply {
    Ok(value) -> show(status: 200, found: current(db, id, found: sql_first(db, row: Order, query: "UPDATE orders SET state = 'failed', stall = '', retries = 0, steps = steps + 1 WHERE id = :id AND state = 'releasing' RETURNING id, sku, qty, card, address, amount, state, label, note, stall, steps, retries", id)))
    Err(error) -> stalled(db, timer, id, state: "releasing", step: "inventory.release", error)
  }
}

// A step that did not finish: the order stays in that step's state, and says why. A step that did not answer is
// tried again later, by a timer (retrying); a refusal while compensating (a refund or a release turned down) is
// not, as it needs a person. Each write happens only while the order is still in that state: another request
// may have finished the step meanwhile (a retry racing this one), and then the order is shown as that request left it.
fn stalled(db: Sql, timer: Timer, id: Int, state: View, step: View, error: CallError) -> Outcome {
  match error {
    Timeout -> retrying(db, timer, id, why: step ++ " did not answer in time", found: failed_again(db, id, state))
    Unreachable -> retrying(db, timer, id, why: step ++ " is unreachable", found: failed_again(db, id, state))
    Rejected(reason) -> show(status: 500, found: noted(db, id, state, stall: step ++ " was refused while compensating: " ++ reason))
    Skew(reason) -> show(status: 502, found: noted(db, id, state, stall: step ++ ": " ++ reason))
  }
}

// One more failure in a row of the order's current step.
fn failed_again(db: Sql, id: Int, state: View) -> Option[Order] {
  sql_first(db, row: Order, query: "UPDATE orders SET retries = retries + 1 /* each attempt counts */ WHERE id = :id AND state = :state RETURNING id, sku, qty, card, address, amount, state, label, note, stall, steps, retries", id, state)
}

// Set a timer to try the step again (or give up, after the last attempt), and say which in `stall`.
fn retrying(db: Sql, timer: Timer, id: Int, why: View, found: Option[Order]) -> Outcome {
  match found {
    Some(value: Order(state, retries)) -> show(status: 202, found: noted(db, id, state, stall: why ++ waiting(decided: retry_later(timer, key: id, policy: resume(), failed: retries))))
    None -> show(status: 202, found: load(db, id))
  }
}

fn waiting(decided: Retry) -> View {
  match decided {
    RetryIn(after, attempt) -> "; attempt " ++ decimal_text(value: attempt) ++ " in " ++ decimal_text(value: after) ++ " ms"
    GaveUp(tries) -> "; gave up after " ++ decimal_text(value: tries) ++ " attempts; POST /advance/<id> resumes from here"
  }
}

fn noted(db: Sql, id: Int, state: View, stall: View) -> Option[Order] {
  current(db, id, found: sql_first(db, row: Order, query: "UPDATE orders SET stall = :stall WHERE id = :id AND state = :state RETURNING id, sku, qty, card, address, amount, state, label, note, stall, steps, retries", stall, id, state))
}

// The order a transition returned, or, when another request moved it first, the order as it is now.
fn current(db: Sql, id: Int, found: Option[Order]) -> Option[Order] {
  match found {
    Some(value) -> Some(value)
    None -> load(db, id)
  }
}

// GET /orders/<id>: the order, or 404 when there is none. (It answered 409 "not in the state this step
// expected" for a missing order, a status meant for a step that lost a race; found 15 November 2026, P2.)
fn shown(found: Option[Order]) -> Outcome {
  match found {
    Some(value: order) -> Shown(status: 200, order)
    None -> Problem(status: 404, reason: "no such order")
  }
}

fn show(status: Int, found: Option[Order]) -> Outcome {
  match found {
    Some(value: order) -> Shown(status, order)
    None -> Problem(status: 409, reason: "the order is not in the state this step expected")
  }
}

// An outcome as an HTTP response: the order as JSON, or {"error": reason}.
fn rendered(outcome: Outcome) -> Response {
  match outcome {
    Shown(status, order) -> write_json(out: buf(), value: order) |> respond(status)
    Problem(status, reason) -> buf() |> append(view: "{\"error\":") |> write_json_string(text: reason) |> append(view: "}") |> respond(status)
  }
}
