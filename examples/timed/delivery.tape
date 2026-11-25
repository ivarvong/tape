// delivery.tape: a food order (ported from the Temporal samples' food delivery): the card is charged, the
// restaurant has a few minutes to accept, then the courier picks it up and delivers it. An order the restaurant
// does not accept in time, or the customer cancels before it is accepted, is refunded. Each call is made with a
// timer already set for its row (in the same commit, before the call): the timer's run asks again, with the same
// once key, when a run is cut short or a call does not answer.
//
//   POST /orders                 {"key","card","amount"}
//   POST /orders/<id>/accept     (the restaurant)
//   POST /orders/<id>/pickup     (the courier)
//   POST /orders/<id>/deliver    (the courier)
//   POST /orders/<id>/cancel     (the customer, before it is accepted)
//   GET  /orders/<id>

migration 1 "orders" {
  CREATE TABLE orders(
    id INTEGER PRIMARY KEY,
    client TEXT NOT NULL UNIQUE,
    card TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK (amount > 0),
    state TEXT NOT NULL DEFAULT 'charging',
    accept_by INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT ''
  )
}

type OrderState {
  Charging
  Placed
  Declined
  Accepted
  Refunding
  PickedUp
  Delivered
  Canceled
  RefundFailed
}

machine orders.state: OrderState {
  Charging -> Placed
  Charging -> Declined
  Placed -> Accepted
  Placed -> Refunding
  Accepted -> PickedUp
  PickedUp -> Delivered
  Refunding -> Canceled
  Refunding -> RefundFailed
}

flag accept_ms: Int = 300000

type Key = View where len(self) >= 1 and len(self) <= 64
type NewOrder { NewOrder(key: Key, card: View, amount: Int) }
type Order { Order(
  id: Int,
  card: View,
  amount: Int,
  state: OrderState,
  accept_by: Int,
  note: View
) }
type Charge { Charge(card: View, amount: Int) }
type Charged { Charged(payment: Int) }
type Refund { Refund(card: View, amount: Int) }
type Refunded { Refunded(payment: Int) }
type ChargeFor { ChargeFor(order: Int) }
type RefundFor { RefundFor(order: Int) }

type Outcome {
  Shown(status: Int, order: Order)
  Problem(status: Int, reason: View)
}

// what the payment provider refuses with: why it turned a charge or a refund down
type PaymentError { Refused(reason: View) }

fn handle(raw: View, db: Sql, payments: Remote, clock: Clock, timer: Timer) -> Response {
  match request(raw) {
    Request(method: Post, path: "/orders", body) -> placed(body) |> rendered
    Request(method: Post, path: "/orders/" ++ decimal(id) ++ "/accept") -> shown(found: latest(
      id,
      m: sql_move(
        row: Order,
        query: "UPDATE orders SET state = 'accepted' WHERE id = :id AND state = 'placed' \
            RETURNING *",
        id
      )
    ))
      |> rendered
    Request(method: Post, path: "/orders/" ++ decimal(id) ++ "/pickup") -> shown(found: latest(
      id,
      m: sql_move(
        row: Order,
        query: "UPDATE orders SET state = 'picked_up' WHERE id = :id AND state = 'accepted' \
            RETURNING *",
        id
      )
    ))
      |> rendered
    Request(method: Post, path: "/orders/" ++ decimal(id) ++ "/deliver") -> shown(found: latest(
      id,
      m: sql_move(
        row: Order,
        query: "UPDATE orders SET state = 'delivered' WHERE id = :id AND state = 'picked_up' \
            RETURNING *",
        id
      )
    ))
      |> rendered
    Request(
      method: Post,
      path: "/orders/" ++ decimal(id) ++ "/cancel"
    ) -> cancel(id, why: "canceled by the customer")
      |> rendered
    Request(method: Get, path: "/orders/" ++ decimal(id)) -> shown(found: load(id)) |> rendered
    _ -> rendered(outcome: Problem(status: 404, reason: "no such route"))
  }
}

export fn woken(
  db: Sql,
  payments: Remote,
  clock: Clock,
  timer: Timer,
  message: Wake
) -> Result[Order, View] {
  let Wake(key) = message
  match due(found: load(id: key)) {
    Shown(order) -> Ok(value: order)
    Problem(reason) -> Err(error: reason)
  }
}

fn load(id: Int) -> Option[Order] {
  sql_first(row: Order, query: "SELECT * FROM orders WHERE id = :id", id)
}

fn placed(body: View) -> Outcome {
  let Ok(value: NewOrder(key, card, amount)) = decode(json: body, as: NewOrder) else {
    Err(error) -> Problem(status: 400, reason: error)
  }
  let Some(value: o) = sql_first(
    row: Order,
    query: "INSERT INTO orders(client, card, amount) VALUES (:key, :card, :amount) \
        ON CONFLICT(client) DO NOTHING RETURNING *",
    key,
    card,
    amount
  ) else {
    None -> shown(
      found: sql_first(row: Order, query: "SELECT * FROM orders WHERE client = :key", key)
    )
  }
  do wake(after: 5000, key: o.id)
  charging(order: o)
}

fn charging(order: Order) -> Outcome {
  charge(order)
}

fn charge(order: Order) -> Outcome {
  let Order(id, card, amount) = order
  charged(
    id,
    reply: call(
      to: payments,
      method: "charge",
      send: Charge(card, amount),
      reply: Charged,
      error: PaymentError,
      within: 2000,
      once: ChargeFor(order: id)
    )
  )
}

// Charged: placed, and the restaurant's deadline is a timer. Declined: done. No answer: the timer set before the
// call asks again.
fn charged(id: Int, reply: Result[Charged, CallError[PaymentError]]) -> Outcome {
  match reply {
    Ok(value) -> {
      do wake(after: flags.accept_ms, key: id)
      waiting(found: latest(
        id,
        m: sql_move(
          row: Order,
          query: "UPDATE orders SET state = 'placed', accept_by = :accept_by WHERE id = :id \
              AND state = 'charging' RETURNING *",
          accept_by: now() + flags.accept_ms,
          id
        )
      ))
    }
    Err(error: Rejected(reason: Refused(reason))) -> shown(found: latest(
      id,
      m: sql_move(
        row: Order,
        query: "UPDATE orders SET state = 'declined', note = :reason WHERE id = :id \
            AND state = 'charging' RETURNING *",
        reason,
        id
      )
    ))
    // set again here: in a timer's run the timer that started it is spent (C79 found this one missing)
    Err(error) -> {
      do wake(after: 5000, key: id)
      again(found: load(id))
    }
  }
}

fn waiting(found: Option[Order]) -> Outcome {
  shown(found)
}

// Not accepted: refunding, with a timer for the refund, set before it goes out.
fn cancel(id: Int, why: View) -> Outcome {
  match sql_move(
    row: Order,
    query: "UPDATE orders SET state = 'refunding', note = :why WHERE id = :id \
        AND state = 'placed' RETURNING *",
    why,
    id
  ) {
    Moved(value) -> {
      do wake(after: 5000, key: id)
      refunding(order: value)
    }
    Raced(now) -> Shown(status: 409, order: now)
    NoRow -> Problem(status: 404, reason: "no such order")
  }
}

fn refunding(order: Order) -> Outcome {
  refund(order)
}

fn refund(order: Order) -> Outcome {
  let Order(id, card, amount) = order
  refunded(
    id,
    reply: call(
      to: payments,
      method: "refund",
      send: Refund(card, amount),
      reply: Refunded,
      error: PaymentError,
      within: 2000,
      once: RefundFor(order: id)
    )
  )
}

fn refunded(id: Int, reply: Result[Refunded, CallError[PaymentError]]) -> Outcome {
  match reply {
    Ok(value) -> shown(found: latest(
      id,
      m: sql_move(
        row: Order,
        query: "UPDATE orders SET state = 'canceled' WHERE id = :id AND state = 'refunding' \
            RETURNING *",
        id
      )
    ))
    // a refund the payment service refuses will be refused again: the order rests in refund_failed, for a person
    Err(error: Rejected(reason: Refused(reason))) -> shown(found: latest(
      id,
      m: sql_move(
        row: Order,
        query: "UPDATE orders SET state = 'refund_failed', note = :reason WHERE id = :id \
            AND state = 'refunding' RETURNING *",
        reason,
        id
      )
    ))
    Err(error) -> {
      do wake(after: 5000, key: id)
      again(found: load(id))
    }
  }
}

fn again(found: Option[Order]) -> Outcome {
  shown(found)
}

// The timer's run: a charge or a refund still out is asked again; a placed order past its deadline is canceled
// (one not yet due is waited for again).
fn due(found: Option[Order]) -> Outcome {
  let Some(value: o) = found else -> Problem(status: 404, reason: "no such order")
  match o {
    Order(state: Charging) -> charge(order: o)
    Order(
      id,
      state: Placed,
      accept_by
    ) if accept_by <= now() -> cancel(id, why: "not accepted in time")
    Order(id, state: Placed, accept_by) -> {
      do wake(after: accept_by - now(), key: id)
      waiting(found: Some(value: o))
    }
    Order(state: Refunding) -> refund(order: o)
    Order(state: Declined) -> Shown(status: 200, order: o)
    Order(state: Accepted) -> Shown(status: 200, order: o)
    Order(state: PickedUp) -> Shown(status: 200, order: o)
    Order(state: Delivered) -> Shown(status: 200, order: o)
    Order(state: Canceled) -> Shown(status: 200, order: o)
    Order(state: RefundFailed) -> Shown(status: 200, order: o)
  }
}

fn latest(id: Int, m: Move[Order]) -> Option[Order] {
  match m {
    Moved(value) -> Some(value)
    Raced(now) -> Some(now)
    NoRow -> load(id)
  }
}

fn shown(found: Option[Order]) -> Outcome {
  let Some(value: o) = found else -> Problem(status: 404, reason: "no such order")
  Shown(status: 200, order: o)
}

fn rendered(outcome: Outcome) -> Response {
  match outcome {
    Shown(status, order) -> write_json(out: buf(), value: order) |> respond(status)
    Problem(status, reason) -> problem(status, detail: reason)
  }
}

// What must hold: after every commit, and (settled) once nothing is in flight and every timer has run.
invariant "a placed order has a time to accept it by" {
  SELECT id, accept_by FROM orders WHERE state = 'placed' AND accept_by <= 0
}

invariant "no order is left charging, placed or refunding" settled {
  SELECT id, state, note FROM orders WHERE state IN ('charging', 'placed', 'refunding')
}
