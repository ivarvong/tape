// transfer.tape: a money transfer as a saga (ported from the Temporal samples' money transfer and saga): withdraw
// from one account, deposit to the other; a deposit the bank refuses is compensated by a refund of the
// withdrawal. Each step is a call with a once key; a step that does not answer is tried again by a timer, with
// std/retry's backoff, and after the last attempt the transfer waits for POST /transfers/<id>/resume. The first
// timer is set in the request that makes the transfer, before its first call.
//
//   POST /transfers               {"key","from","to","amount"}
//   POST /transfers/<id>/resume
//   GET  /transfers/<id>

migration 1 "transfers" {
  CREATE TABLE transfers(
    id INTEGER PRIMARY KEY,
    client TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL,
    target TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK (amount > 0),
    state TEXT NOT NULL DEFAULT 'withdrawing' CHECK (state IN ('withdrawing', 'depositing', 'refunding', 'done', 'failed')),
    tries INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT ''
  )
}

type TransferState { Withdrawing Depositing Failed Done Refunding }

machine transfers.state: TransferState {
  Withdrawing -> Depositing
  Withdrawing -> Failed
  Depositing -> Done
  Depositing -> Refunding
  Refunding -> Failed
}

type Key = View where len(self) >= 1 and len(self) <= 64
type NewTransfer { NewTransfer(key: Key, from: View, to: View, amount: Int) }
type Transfer { Transfer(
  id: Int,
  source: View,
  target: View,
  amount: Int,
  state: TransferState,
  tries: Int,
  note: View
) }
type Entry { Entry(account: View, amount: Int) }
type Booked { Booked(balance: Int) }
type Step { Step(transfer: Int, step: View) }

type Outcome {
  Shown(status: Int, transfer: Transfer)
  Problem(status: Int, reason: View)
}

fn policy() -> Backoff {
  Backoff(first: 1000, factor: 2, most: 60000, tries: 6)
}

fn handle(raw: View, db: Sql, bank: Remote, timer: Timer) -> Response {
  match request(raw) {
    Request(method: Post, path: "/transfers", body) -> started(body) |> rendered
    Request(
      method: Post,
      path: "/transfers/" ++ decimal(id) ++ "/resume"
    ) -> resumed(found: load(id))
      |> rendered
    Request(method: Get, path: "/transfers/" ++ decimal(id)) -> shown(found: load(id)) |> rendered
    _ -> rendered(outcome: Problem(status: 404, reason: "no such route"))
  }
}

export fn woken(db: Sql, bank: Remote, timer: Timer, message: Wake) -> Result[Transfer, View] {
  let Wake(key) = message
  match advance(found: load(id: key)) {
    Shown(transfer) -> Ok(value: transfer)
    Problem(reason) -> Err(error: reason)
  }
}

fn load(id: Int) -> Option[Transfer] {
  sql_first(row: Transfer, query: "SELECT * FROM transfers WHERE id = :id", id)
}

fn started(body: View) -> Outcome {
  let Ok(value: NewTransfer(key, from, to, amount)) = decode(json: body, as: NewTransfer) else {
    Err(error) -> Problem(status: 400, reason: error)
  }
  let Some(value: t) = sql_first(
    row: Transfer,
    query: "INSERT INTO transfers(client, source, target, amount) \
        VALUES (:key, :from, :to, :amount) ON CONFLICT(client) DO NOTHING RETURNING *",
    key,
    from,
    to,
    amount
  ) else {
    None -> shown(
      found: sql_first(row: Transfer, query: "SELECT * FROM transfers WHERE client = :key", key)
    )
  }
  do wake(after: 10000, key: t.id)
  first(transfer: t)
}

// A transfer that gave up is put back in the hands of its timer: its attempts are counted from none again, and
// the timer makes them. Sent twice, the second finds the count back at none already and changes nothing, so a
// resume heard twice is not two rounds of attempts. Any other transfer is shown as it is: its timer is at work, or
// it is finished.
fn resumed(found: Option[Transfer]) -> Outcome {
  let Some(
    value: t = Transfer(id, state, tries)
  ) = found else -> Problem(status: 404, reason: "no such transfer")
  match backoff(policy: policy(), failed: tries) {
    GaveUp -> {
      let Moved(value: again) = sql_move(
        row: Transfer,
        query: "UPDATE transfers SET tries = 0, note = 'resumed' WHERE id = :id \
            AND state = :state RETURNING *",
        id,
        state
      ) else {
        Raced(now) -> Shown(status: 200, transfer: now)
        NoRow -> Problem(status: 404, reason: "no such transfer")
      }
      do wake(after: 0, key: id)
      Shown(status: 202, transfer: again)
    }
    RetryIn -> Shown(status: 200, transfer: t)
  }
}

fn first(transfer: Transfer) -> Outcome {
  advance(found: Some(value: transfer))
}

// The state names the step; its reply decides the move, and advance goes on from the state the move leaves.
fn advance(found: Option[Transfer]) -> Outcome {
  let Some(value: t) = found else -> Problem(status: 404, reason: "no such transfer")
  match t {
    Transfer(id, source, amount, state: Withdrawing, tries) -> {
      let Ok(value) = call(
        to: bank,
        method: "withdraw",
        send: Entry(account: source, amount),
        reply: Booked,
        within: 2000,
        once: Step(transfer: id, step: "withdraw")
      ) else {
        Err(error: Rejected(reason)) -> shown(
          found: moved(id, from: Withdrawing, to: Failed, note: reason)
        )
        Err(error) -> failed(id, state: Withdrawing, tries)
      }
      advance(found: moved(id, from: Withdrawing, to: Depositing, note: ""))
    }
    Transfer(id, target, amount, state: Depositing, tries) -> {
      let Ok(value) = call(
        to: bank,
        method: "deposit",
        send: Entry(account: target, amount),
        reply: Booked,
        within: 2000,
        once: Step(transfer: id, step: "deposit")
      ) else {
        Err(error: Rejected(reason)) -> advance(
          found: moved(id, from: Depositing, to: Refunding, note: reason)
        )
        Err(error) -> failed(id, state: Depositing, tries)
      }
      shown(found: moved(id, from: Depositing, to: Done, note: ""))
    }
    Transfer(id, source, amount, state: Refunding, tries) -> {
      let Ok(value) = call(
        to: bank,
        method: "deposit",
        send: Entry(account: source, amount),
        reply: Booked,
        within: 2000,
        once: Step(transfer: id, step: "refund")
      ) else {
        // the bank refusing the refund is counted like no answer: failed gives up after its tries
        Err(error: Rejected(reason)) -> failed(id, state: Refunding, tries)
        Err(error) -> failed(id, state: Refunding, tries)
      }
      shown(found: moved(id, from: Refunding, to: Failed, note: "refunded"))
    }
    Transfer(state: Failed) -> Shown(status: 200, transfer: t)
    Transfer(state: Done) -> Shown(status: 200, transfer: t)
  }
}

fn moved(id: Int, from: TransferState, to: TransferState, note: View) -> Option[Transfer] {
  latest(
    id,
    m: sql_move(
      row: Transfer,
      query: "UPDATE transfers SET state = :to, note = :note, tries = 0 WHERE id = :id \
          AND state = :from RETURNING *",
      to,
      note,
      id,
      from
    )
  )
}

// A step that did not answer (or was refused while compensating): one more failure, and a timer to try again,
// or none after the last attempt (the transfer says so, and waits for resume).
fn failed(id: Int, state: TransferState, tries: Int) -> Outcome {
  match sql_move(
    row: Transfer,
    query: "UPDATE transfers SET tries = :tries + 1 WHERE id = :id AND state = :state \
        AND tries = :tries RETURNING *",
    tries,
    id,
    state
  ) {
    Moved(value: Transfer(tries: n)) -> told(
      id,
      state,
      plan: retry_later(timer, key: id, policy: policy(), failed: n)
    )
    Raced(now) -> Shown(status: 200, transfer: now)
    NoRow -> Problem(status: 404, reason: "no such transfer")
  }
}

fn told(id: Int, state: TransferState, plan: Retry) -> Outcome {
  match plan {
    RetryIn(after) -> shown(found: noted(id, state, note: "no answer; again in \(after) ms"))
    GaveUp(tries) -> shown(
      found: noted(id, state, note: "gave up after \(tries) attempts; POST /transfers/<id>/resume")
    )
  }
}

fn noted(id: Int, state: TransferState, note: View) -> Option[Transfer] {
  latest(
    id,
    m: sql_move(
      row: Transfer,
      query: "UPDATE transfers SET note = :note WHERE id = :id AND state = :state RETURNING *",
      note,
      id,
      state
    )
  )
}

fn latest(id: Int, m: Move[Transfer]) -> Option[Transfer] {
  match m {
    Moved(value) -> Some(value)
    Raced(now) -> Some(now)
    NoRow -> load(id)
  }
}

fn shown(found: Option[Transfer]) -> Outcome {
  let Some(value: t) = found else -> Problem(status: 404, reason: "no such transfer")
  Shown(status: 200, transfer: t)
}

fn rendered(outcome: Outcome) -> Response {
  match outcome {
    Shown(status, transfer) -> write_json(out: buf(), value: transfer) |> respond(status)
    Problem(status, reason) -> buf()
      |> append(view: "{\"error\":")
      |> write_json_string(text: reason)
      |> append(view: "}")
      |> respond(status)
  }
}

// What must hold after every commit. There is no settled rule: a transfer whose step ran out of attempts waits,
// in the state of that step, for POST /transfers/<id>/resume.
invariant "a finished transfer carries no attempts" {
  SELECT id, state, tries FROM transfers WHERE state IN ('done', 'failed') AND tries <> 0
}
