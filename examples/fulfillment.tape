// fulfillment.tape: a durable order-fulfillment workflow. Each order is a row whose `state` names the step to
// do next; the CHECK constraint lists every state, so no other value can be stored:
//
//   reserving -> charging -> shipping -> done
//                   |            |
//                   |            +-> refunding -> releasing -> failed     (no carrier: give the money back, then the stock)
//                   +-> releasing -> failed                               (card declined: give the stock back)
//   reserving -> failed                                                   (not enough stock: nothing to undo)
//
// Every step is a `call` to another program with a time budget and a key: `once: ForOrder(order: id)`. The key
// the callee stores is <this program>/<method>/{"order":<id>}, so each step of each order has its own, and sending
// a step again with the same message is answered from the reply the callee stored the first time, without
// running it again (with another message, the callee refuses it). A call is a commit point: the state written
// before it is durable when it is sent. Each transition is a compare-and-set on the state
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
type OrderState { Reserving Charging Failed Shipping Releasing Done Refunding }

machine orders.state: OrderState {
  Reserving -> Charging
  Reserving -> Failed
  Charging -> Shipping
  Charging -> Releasing
  Shipping -> Done
  Shipping -> Refunding
  Refunding -> Releasing
  Releasing -> Failed
}

type Qty = Int where self >= 1 and self <= 10
type Key = View where len(self) >= 1 and len(self) <= 64
type ForOrder { ForOrder(order: Int) }
type NewOrder { NewOrder(key: Key, sku: View, qty: Qty, card: View, address: View) }
type Order { Order(
  id: Int,
  sku: View,
  qty: Int,
  card: View,
  address: View,
  amount: Int,
  state: OrderState,
  label: Int,
  note: View,
  stall: View,
  steps: Int,
  retries: Int
) }

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

fn handle(
  raw: View,
  db: Sql,
  inventory: Remote,
  payments: Remote,
  shipping: Remote,
  timer: Timer
) -> Response {
  routed(raw) |> rendered
}

// The functions below use the capabilities handle and woken declare (db, inventory, payments, shipping, timer) by
// name; the compiler passes them, and refuses an entry point that reaches one it does not declare (C72).
fn routed(raw: View) -> Outcome {
  match request(raw) {
    Request(method: Post, path: "/orders", body) -> start(
      wait: 2000,
      order: decode(json: body, as: NewOrder)
    )
    Request(method: Post, path: "/orders/wait/" ++ decimal(ms), body) -> start(
      wait: ms,
      order: decode(json: body, as: NewOrder)
    )
    Request(method: Post, path: "/advance/" ++ decimal(id)) -> advance(wait: 2000, found: load(id))
    Request(method: Get, path: "/orders/" ++ decimal(id)) -> shown(found: load(id))
    _ -> Problem(status: 404, reason: "no such route")
  }
}

// A timer a stalled step set is due: carry the order on from where it is now, as POST /advance/<id> would.
export fn woken(
  db: Sql,
  inventory: Remote,
  payments: Remote,
  shipping: Remote,
  timer: Timer,
  message: Wake
) -> Result[Order, View] {
  let Wake(key) = message
  advance(wait: 2000, found: load(id: key)) |> settled
}

fn settled(outcome: Outcome) -> Result[Order, View] {
  match outcome {
    Shown(order) -> Ok(value: order)
    Problem(reason) -> Err(error: reason)
  }
}

fn load(id: Int) -> Option[Order] {
  sql_first(row: Order, query: "SELECT * FROM orders WHERE id = :id", id)
}

// The order this request made; or the one an earlier request with this key made, carried on from where it stands;
// or 422 when the key was used for another order.
fn start(wait: Int, order: Result[NewOrder, View]) -> Outcome {
  let Ok(value: NewOrder(key, sku, qty, card, address)) = order else {
    Err(error) -> Problem(status: 400, reason: error)
  }
  let Some(value: made) = sql_first(
    row: Order,
    query: "INSERT INTO orders(client, sku, qty, card, address) \
        VALUES (:key, :sku, :qty, :card, :address) ON CONFLICT(client) DO NOTHING RETURNING *",
    key,
    sku,
    qty,
    card,
    address
  ) else {
    None -> {
      let Some(value: same) = sql_first(
        row: Order,
        query: "SELECT * FROM orders WHERE client = :key AND sku = :sku AND qty = :qty \
            AND card = :card AND address = :address",
        key,
        sku,
        qty,
        card,
        address
      ) else -> Problem(
        status: 422,
        reason: "the key " ++ key ++ " was already used for another order"
      )
      advance(wait, found: Some(value: same))
    }
  }
  advance(wait, found: Some(value: made))
}

// The state names the next step; each step is a call, and its reply decides the transition. A finished order
// (done or failed) is shown as it is. The workflow goes on by advance calling itself with the order each
// transition leaves.
fn advance(wait: Int, found: Option[Order]) -> Outcome {
  match found {
    Some(value: Order(id, sku, qty, state: Reserving)) -> {
      let Ok(value: Reserved(price)) = call(
        to: inventory,
        method: "reserve",
        send: Reserve(sku, qty),
        reply: Reserved,
        within: wait,
        once: ForOrder(order: id)
      ) else {
        Err(error: Rejected(reason)) -> show(
          status: 409,
          found: move(id, from: Reserving, to: Failed, note: reason)
        )
        Err(error) -> stalled(id, state: Reserving, step: "inventory.reserve", error)
      }
      advance(
        wait,
        found: latest(moved: sql_move(
          row: Order,
          query: "UPDATE orders SET state = 'charging', amount = :price * qty, note = '', stall = \
              '', retries = 0, steps = steps + 1 WHERE id = :id AND state = 'reserving' \
              RETURNING *",
          price,
          id
        ))
      )
    }
    Some(value: Order(id, card, amount, state: Charging)) -> {
      let Ok(value) = call(
        to: payments,
        method: "charge",
        send: Charge(card, amount),
        reply: Charged,
        within: wait,
        once: ForOrder(order: id)
      ) else {
        Err(error: Rejected(reason)) -> advance(
          wait,
          found: move(id, from: Charging, to: Releasing, note: reason)
        )
        Err(error) -> stalled(id, state: Charging, step: "payments.charge", error)
      }
      advance(wait, found: move(id, from: Charging, to: Shipping, note: ""))
    }
    Some(value: Order(id, sku, qty, address, state: Shipping)) -> {
      let Ok(value: Shipped(label)) = call(
        to: shipping,
        method: "label",
        send: Ship(address, sku, qty),
        reply: Shipped,
        within: wait,
        once: ForOrder(order: id)
      ) else {
        Err(error: Rejected(reason)) -> advance(
          wait,
          found: move(id, from: Shipping, to: Refunding, note: reason)
        )
        Err(error) -> stalled(id, state: Shipping, step: "shipping.label", error)
      }
      advance(
        wait,
        found: latest(moved: sql_move(
          row: Order,
          query: "UPDATE orders SET state = 'done', label = :label, note = '', stall = '', \
              retries = 0, steps = steps + 1 WHERE id = :id AND state = 'shipping' RETURNING *",
          label,
          id
        ))
      )
    }
    // Compensation: the note keeps the reason the workflow turned back.
    Some(value: Order(id, card, amount, state: Refunding)) -> {
      let Ok(value) = call(
        to: payments,
        method: "refund",
        send: Refund(card, amount),
        reply: Refunded,
        within: wait,
        once: ForOrder(order: id)
      ) else {
        // a compensation that is refused stalls like one with no answer: stalled stops after its retries
        Err(error: refusal = Rejected(reason)) -> stalled(
          id,
          state: Refunding,
          step: "payments.refund",
          error: refusal
        )
        Err(error) -> stalled(id, state: Refunding, step: "payments.refund", error)
      }
      advance(
        wait,
        found: latest(moved: sql_move(
          row: Order,
          query: "UPDATE orders SET state = 'releasing', stall = '', retries = 0, steps = steps + \
              1 WHERE id = :id AND state = 'refunding' RETURNING *",
          id
        ))
      )
    }
    Some(value: Order(id, sku, qty, state: Releasing)) -> {
      let Ok(value) = call(
        to: inventory,
        method: "release",
        send: Release(sku, qty),
        reply: Released,
        within: wait,
        once: ForOrder(order: id)
      ) else {
        Err(error: refusal = Rejected(reason)) -> stalled(
          id,
          state: Releasing,
          step: "inventory.release",
          error: refusal
        )
        Err(error) -> stalled(id, state: Releasing, step: "inventory.release", error)
      }
      show(
        status: 200,
        found: latest(moved: sql_move(
          row: Order,
          query: "UPDATE orders SET state = 'failed', stall = '', retries = 0, steps = steps + 1 \
              WHERE id = :id AND state = 'releasing' RETURNING *",
          id
        ))
      )
    }
    Some(value: order = Order(state: Done)) -> Shown(status: 201, order)
    Some(value: order = Order(state: Failed)) -> Shown(status: 200, order)
    None -> Problem(status: 404, reason: "no such order")
  }
}

// One transition: from the state the step belonged to, to the next. Nothing changes if the order has moved on.
// When another request moved the order first (a retry racing this one), the order as it is now: the workflow
// carries on from there, and its steps' keys make anything sent again harmless.
fn move(id: Int, from: OrderState, to: OrderState, note: View) -> Option[Order] {
  latest(moved: sql_move(
    row: Order,
    query: "UPDATE orders SET state = :to, note = :note, stall = '', retries = 0, steps = steps + \
        1 WHERE id = :id AND state = :from RETURNING *",
    to,
    note,
    id,
    from
  ))
}

// A step that did not finish: the order stays in that step's state, and says why. A step that did not answer is
// tried again later, by a timer (retrying); a refusal while compensating (a refund or a release turned down) is
// not, as it needs a person. Each write happens only while the order is still in that state: another request
// may have finished the step meanwhile (a retry racing this one), and then the order is shown as that request left it.
fn stalled(id: Int, state: OrderState, step: View, error: CallError) -> Outcome {
  match error {
    Timeout -> retrying(id, why: step ++ " did not answer in time", found: failed_again(id, state))
    Unreachable -> retrying(id, why: step ++ " is unreachable", found: failed_again(id, state))
    Rejected(reason) -> show(
      status: 500,
      found: noted(id, state, stall: step ++ " was refused while compensating: " ++ reason)
    )
    Skew(reason) -> show(status: 502, found: noted(id, state, stall: step ++ ": " ++ reason))
  }
}

// One more failure in a row of the order's current step.
fn failed_again(id: Int, state: OrderState) -> Move[Order] {
  sql_move(
    row: Order,
    repeat: True,
    query: "UPDATE orders SET retries = retries + 1 WHERE id = :id AND state = :state RETURNING *",
    id,
    state
  )
}

// Set a timer to try the step again (or give up, after the last attempt), and say which in `stall`.
fn retrying(id: Int, why: View, found: Move[Order]) -> Outcome {
  match found {
    Moved(value: Order(state, retries)) -> show(
      status: 202,
      found: noted(
        id,
        state,
        stall: why ++ waiting(
          decided: retry_later(timer, key: id, policy: resume(), failed: retries)
        )
      )
    )
    Raced(now) -> show(status: 202, found: Some(now))
    NoRow -> show(status: 202, found: None)
  }
}

fn waiting(decided: Retry) -> View {
  match decided {
    RetryIn(after, attempt) -> "; attempt \(attempt) in \(after) ms"
    GaveUp(tries) -> "; gave up after \(tries) attempts; POST /advance/<id> resumes from here"
  }
}

fn noted(id: Int, state: OrderState, stall: View) -> Option[Order] {
  latest(moved: sql_move(
    row: Order,
    query: "UPDATE orders SET stall = :stall WHERE id = :id AND state = :state RETURNING *",
    stall,
    id,
    state
  ))
}

// The order a transition moved, or, when another request moved it first, the order as it is now (sql_move reads
// it back by its key, in the same transaction, when its compare-and-set changes nothing).
fn latest(moved: Move[Order]) -> Option[Order] {
  match moved {
    Moved(value) -> Some(value)
    Raced(now) -> Some(now)
    NoRow -> None
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
    Problem(status, reason) -> buf()
      |> append(view: "{\"error\":")
      |> write_json_string(text: reason)
      |> append(view: "}")
      |> respond(status)
  }
}

// What must hold after every commit (checked by `tape sim` and by app.invariants() in the host).
invariant "an order is for one to ten of its item" {
  SELECT id, qty FROM orders WHERE qty < 1 OR qty > 10
}

// Across programs: what the others hold, against the orders. A step that has been sent may or may not have run (its
// reply may be lost), so each count lies between the orders whose step is known to have run and those and the ones
// in the step. Only the simulator has every program's rows (`tape sim fulfillment.tape inventory.tape payments.tape
// shipping.tape`).
invariant "stock gone for an item is at least what its paid-for orders hold, and at most that and what the orders in a stock step hold" with inventory {
  SELECT t.sku, t.gone FROM (SELECT sku, CASE sku WHEN 'lamp' THEN 5 WHEN 'desk' THEN 2 ELSE 0 END - remaining AS gone FROM inventory.stock) AS t WHERE t.gone < (SELECT coalesce(sum(o.qty), 0) FROM orders AS o WHERE o.sku = t.sku AND o.state IN ('charging', 'shipping', 'done', 'refunding')) OR t.gone > (SELECT coalesce(sum(o.qty), 0) FROM orders AS o WHERE o.sku = t.sku AND o.state IN ('reserving', 'charging', 'shipping', 'done', 'refunding', 'releasing'))
}

invariant "a card is charged at least for its shipped orders, and at most for those and the orders in a money step" with payments {
  SELECT t.card, t.charged FROM (SELECT card, CASE card WHEN 'ann-4242' THEN 300 WHEN 'bob-0001' THEN 50 ELSE 0 END - balance AS charged FROM payments.cards) AS t WHERE t.charged < (SELECT coalesce(sum(o.amount), 0) FROM orders AS o WHERE o.card = t.card AND o.state IN ('shipping', 'done')) OR t.charged > (SELECT coalesce(sum(o.amount), 0) FROM orders AS o WHERE o.card = t.card AND o.state IN ('charging', 'shipping', 'done', 'refunding'))
}

invariant "a done order has a label for its address" with shipping {
  SELECT o.id, o.label FROM orders AS o WHERE o.state = 'done' AND NOT EXISTS (SELECT 1 FROM shipping.labels AS l WHERE l.id = o.label AND l.address = o.address AND l.sku = o.sku AND l.qty = o.qty)
}
