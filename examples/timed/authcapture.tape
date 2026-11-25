// authcapture.tape: authorize a card now, capture it when the goods ship, void it if they have not shipped in
// seven days (ported from the Temporal samples' "delayed capture": a timer, and two calls that may not answer).
// Every call has a timer for its row set in the same commit, before it goes out, and the timer's run asks again
// with the same once key. The void deadline is a timer too; the timer's run voids an authorization past it.
//
//   POST /payments               {"key","card","amount"}
//   POST /payments/<id>/capture
//   GET  /payments/<id>

migration 1 "payments" {
  CREATE TABLE payments(
    id INTEGER PRIMARY KEY,
    client TEXT NOT NULL UNIQUE,
    card TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK (amount > 0),
    state TEXT NOT NULL DEFAULT 'authorizing',
    void_at INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT ''
  )
}

type PaymentState { Authorizing Authorized Declined Capturing Voiding Captured Voided VoidFailed }

machine payments.state: PaymentState {
  Authorizing -> Authorized
  Authorizing -> Declined
  Authorized -> Capturing
  Authorized -> Voiding
  Capturing -> Captured
  Capturing -> Authorized
  Voiding -> Voided
  Voiding -> VoidFailed
}

flag void_ms: Int = 604800000

type Key = View where len(self) >= 1 and len(self) <= 64
type NewPayment { NewPayment(key: Key, card: View, amount: Int) }
type Payment { Payment(
  id: Int,
  card: View,
  amount: Int,
  state: PaymentState,
  void_at: Int,
  note: View
) }
type Auth { Auth(card: View, amount: Int) }
type Authorization { Authorization(auth: Int) }
type Ref { Ref(amount: Int) }
type Done { Done(ok: Int) }
type Step { Step(payment: Int, step: View) }

type Outcome {
  Shown(status: Int, payment: Payment)
  Problem(status: Int, reason: View)
}

fn handle(raw: View, db: Sql, gateway: Remote, clock: Clock, timer: Timer) -> Buf {
  match request(raw) {
    Request(method: "POST", path: "/payments", body) -> made(body) |> rendered
    Request(method: "POST", path: "/payments/" ++ decimal(id) ++ "/capture") -> capture(id)
      |> rendered
    Request(method: "GET", path: "/payments/" ++ decimal(id)) -> shown(found: load(id)) |> rendered
    _ -> rendered(outcome: Problem(status: 404, reason: "no such route"))
  }
}

export fn woken(
  db: Sql,
  gateway: Remote,
  clock: Clock,
  timer: Timer,
  message: Wake
) -> Result[Payment, View] {
  let Wake(key) = message
  match due(found: load(id: key)) {
    Shown(payment) -> Ok(value: payment)
    Problem(reason) -> Err(error: reason)
  }
}

fn load(id: Int) -> Option[Payment] {
  sql_first(row: Payment, query: "SELECT * FROM payments WHERE id = :id", id)
}

fn made(body: View) -> Outcome {
  let Ok(value: NewPayment(key, card, amount)) = decode(json: body, as: NewPayment) else {
    Err(error) -> Problem(status: 400, reason: error)
  }
  let Some(value: p) = sql_first(
    row: Payment,
    query: "INSERT INTO payments(client, card, amount) VALUES (:key, :card, :amount) \
        ON CONFLICT(client) DO NOTHING RETURNING *",
    key,
    card,
    amount
  ) else {
    None -> shown(
      found: sql_first(row: Payment, query: "SELECT * FROM payments WHERE client = :key", key)
    )
  }
  do wake(after: 5000, key: p.id)
  authorize(payment: p)
}

fn authorize(payment: Payment) -> Outcome {
  let Payment(id, card, amount) = payment
  authorized(
    id,
    reply: call(
      to: gateway,
      method: "authorize",
      send: Auth(card, amount),
      reply: Authorization,
      within: 2000,
      once: Step(payment: id, step: "authorize")
    )
  )
}

fn authorized(id: Int, reply: Result[Authorization, CallError]) -> Outcome {
  match reply {
    Ok(value) -> {
      do wake(after: flags.void_ms, key: id)
      held(found: latest(
        id,
        m: sql_move(
          row: Payment,
          query: "UPDATE payments SET state = 'authorized', void_at = :void_at WHERE id = :id \
              AND state = 'authorizing' RETURNING *",
          void_at: now() + flags.void_ms,
          id
        )
      ))
    }
    Err(error: Rejected(reason)) -> shown(found: latest(
      id,
      m: sql_move(
        row: Payment,
        query: "UPDATE payments SET state = 'declined', note = :reason WHERE id = :id \
            AND state = 'authorizing' RETURNING *",
        reason,
        id
      )
    ))
    Err(error) -> {
      do wake(after: 5000, key: id)
      pending(found: load(id))
    }
  }
}

fn held(found: Option[Payment]) -> Outcome {
  shown(found)
}

fn pending(found: Option[Payment]) -> Outcome {
  match found {
    Some(value) -> Shown(status: 202, payment: value)
    None -> Problem(status: 404, reason: "no such payment")
  }
}

// Shipped: capturing, with a timer set before the call. A refused capture is authorized again, and its void
// deadline is a timer again.
fn capture(id: Int) -> Outcome {
  let Some(value: p) = load(id) else -> Problem(status: 404, reason: "no such payment")
  match p {
    Payment(state: Authorized) -> {
      do wake(after: 5000, key: id)
      capturing(moved: sql_move(
        row: Payment,
        query: "UPDATE payments SET state = 'capturing' WHERE id = :id AND state = 'authorized' \
            RETURNING *",
        id
      ))
    }
    Payment(state: Capturing) -> captured(payment: p)
    Payment(state: Authorizing) -> Shown(status: 409, payment: p)
    Payment(state: Declined) -> Shown(status: 409, payment: p)
    Payment(state: Voiding) -> Shown(status: 409, payment: p)
    Payment(state: Captured) -> Shown(status: 409, payment: p)
    Payment(state: Voided) -> Shown(status: 409, payment: p)
    Payment(state: VoidFailed) -> Shown(status: 409, payment: p)
  }
}

fn capturing(moved: Move[Payment]) -> Outcome {
  match moved {
    Moved(value) -> captured(payment: value)
    Raced(now) -> Shown(status: 409, payment: now)
    NoRow -> Problem(status: 404, reason: "no such payment")
  }
}

fn captured(payment: Payment) -> Outcome {
  let Payment(id, amount, void_at) = payment
  settled(
    id,
    void_at,
    reply: call(
      to: gateway,
      method: "capture",
      send: Ref(amount),
      reply: Done,
      within: 2000,
      once: Step(payment: id, step: "capture")
    )
  )
}

fn settled(id: Int, void_at: Int, reply: Result[Done, CallError]) -> Outcome {
  match reply {
    Ok(value) -> shown(found: latest(
      id,
      m: sql_move(
        row: Payment,
        query: "UPDATE payments SET state = 'captured' WHERE id = :id AND state = 'capturing' \
            RETURNING *",
        id
      )
    ))
    Err(error: Rejected(reason)) -> {
      do wake(after: left(until: void_at), key: id)
      held(found: latest(
        id,
        m: sql_move(
          row: Payment,
          query: "UPDATE payments SET state = 'authorized', note = :reason WHERE id = :id \
              AND state = 'capturing' RETURNING *",
          reason,
          id
        )
      ))
    }
    Err(error) -> {
      do wake(after: 5000, key: id)
      pending(found: load(id))
    }
  }
}

fn left(until: Int) -> Int {
  match {
    until > now() -> until - now()
    else -> 0
  }
}

fn voiding(payment: Payment) -> Outcome {
  let Payment(id) = payment
  match sql_move(
    row: Payment,
    query: "UPDATE payments SET state = 'voiding' WHERE id = :id AND state = 'authorized' \
        RETURNING *",
    id
  ) {
    Moved(value) -> {
      do wake(after: 5000, key: id)
      void(payment: value)
    }
    Raced(now) -> Shown(status: 200, payment: now)
    NoRow -> Problem(status: 404, reason: "no such payment")
  }
}

fn void(payment: Payment) -> Outcome {
  let Payment(id, amount) = payment
  voided(
    id,
    reply: call(
      to: gateway,
      method: "void",
      send: Ref(amount),
      reply: Done,
      within: 2000,
      once: Step(payment: id, step: "void")
    )
  )
}

fn voided(id: Int, reply: Result[Done, CallError]) -> Outcome {
  match reply {
    Ok(value) -> shown(found: latest(
      id,
      m: sql_move(
        row: Payment,
        query: "UPDATE payments SET state = 'voided' WHERE id = :id AND state = 'voiding' \
            RETURNING *",
        id
      )
    ))
    // a void the gateway refuses will be refused again: the payment rests in void_failed, for a person
    Err(error: Rejected(reason)) -> shown(found: latest(
      id,
      m: sql_move(
        row: Payment,
        query: "UPDATE payments SET state = 'void_failed', note = :reason WHERE id = :id \
            AND state = 'voiding' RETURNING *",
        reason,
        id
      )
    ))
    Err(error) -> {
      do wake(after: 5000, key: id)
      pending(found: load(id))
    }
  }
}

// The timer's run: a call still out is asked again; an authorization past its deadline is voided (one not yet
// due is waited for again).
fn due(found: Option[Payment]) -> Outcome {
  let Some(value: p) = found else -> Problem(status: 404, reason: "no such payment")
  match p {
    Payment(state: Authorizing) -> authorize(payment: p)
    Payment(state: Authorized, void_at) if void_at <= now() -> voiding(payment: p)
    Payment(id, state: Authorized, void_at) -> {
      do wake(after: void_at - now(), key: id)
      held(found: Some(value: p))
    }
    Payment(state: Capturing) -> captured(payment: p)
    Payment(state: Voiding) -> void(payment: p)
    Payment(state: Declined) -> Shown(status: 200, payment: p)
    Payment(state: Captured) -> Shown(status: 200, payment: p)
    Payment(state: Voided) -> Shown(status: 200, payment: p)
    Payment(state: VoidFailed) -> Shown(status: 200, payment: p)
  }
}

fn latest(id: Int, m: Move[Payment]) -> Option[Payment] {
  match m {
    Moved(value) -> Some(value)
    Raced(now) -> Some(now)
    NoRow -> load(id)
  }
}

fn shown(found: Option[Payment]) -> Outcome {
  let Some(value: p) = found else -> Problem(status: 404, reason: "no such payment")
  Shown(status: 200, payment: p)
}

fn rendered(outcome: Outcome) -> Buf {
  match outcome {
    Shown(status, payment) -> write_json(out: respond(status), value: payment)
    Problem(status, reason) -> respond(status)
      |> append(view: "{\"error\":")
      |> write_json_string(text: reason)
      |> append(view: "}")
  }
}

// What must hold: after every commit, and (settled) once nothing is in flight and every timer has run.
invariant "an authorized payment has a time to void it" {
  SELECT id, void_at FROM payments WHERE state = 'authorized' AND void_at <= 0
}

invariant "no payment is left authorizing, authorized, capturing or voiding" settled {
  SELECT id, state, note FROM payments WHERE state IN ('authorizing', 'authorized', 'capturing', 'voiding')
}
