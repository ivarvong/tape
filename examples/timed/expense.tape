// expense.tape: an expense waits for its approver, for a day at most (ported from the Temporal samples' expense
// workflow: a human decision with a timeout, then a payment). The request that files it sets a timer for its
// deadline; the timer's run expires it if nobody decided. Approving moves it to paying and sets a timer before the
// payment goes out, so a run cut short at the call (or a payment that does not answer) is asked again by the
// timer's run, with the same once key.
//
//   POST /expenses               {"key","amount","approver"}
//   POST /expenses/<id>/approve
//   POST /expenses/<id>/reject
//   GET  /expenses/<id>

migration 1 "expenses" {
  CREATE TABLE expenses(
    id INTEGER PRIMARY KEY,
    client TEXT NOT NULL UNIQUE,
    amount INTEGER NOT NULL CHECK (amount > 0),
    approver TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting', 'paying', 'paid', 'declined', 'expired', 'failed')),
    deadline INTEGER NOT NULL,
    note TEXT NOT NULL DEFAULT ''
  )
}

type ExpenseState { Waiting Paying Declined Expired Paid Failed }

machine expenses.state: ExpenseState {
  Waiting -> Paying
  Waiting -> Declined
  Waiting -> Expired
  Paying -> Paid
  Paying -> Failed
}

flag decide_ms: Int = 86400000

type Key = View where len(self) >= 1 and len(self) <= 64
type NewExpense { NewExpense(key: Key, amount: Int, approver: View) }
type Expense { Expense(
  id: Int,
  amount: Int,
  approver: View,
  state: ExpenseState,
  deadline: Int,
  note: View
) }
type Pay { Pay(amount: Int, ref: View) }
type Payout { Payout(payment: Int) }
type PayFor { PayFor(expense: Int) }

type Outcome {
  Shown(status: Int, expense: Expense)
  Problem(status: Int, reason: View)
}

fn handle(raw: View, db: Sql, payments: Remote, clock: Clock, timer: Timer) -> Response {
  match request(raw) {
    Request(method: Post, path: "/expenses", body) -> filed(body) |> rendered
    Request(method: Post, path: "/expenses/" ++ decimal(id) ++ "/approve") -> approve(id)
      |> rendered
    Request(method: Post, path: "/expenses/" ++ decimal(id) ++ "/reject") -> shown(found: latest(
      id,
      m: sql_move(
        row: Expense,
        query: "UPDATE expenses SET state = 'declined' WHERE id = :id AND state = 'waiting' \
            RETURNING *",
        id
      )
    ))
      |> rendered
    Request(method: Get, path: "/expenses/" ++ decimal(id)) -> shown(found: load(id)) |> rendered
    _ -> rendered(outcome: Problem(status: 404, reason: "no such route"))
  }
}

export fn woken(
  db: Sql,
  payments: Remote,
  clock: Clock,
  timer: Timer,
  message: Wake
) -> Result[Expense, View] {
  let Wake(key) = message
  match due(found: load(id: key)) {
    Shown(expense) -> Ok(value: expense)
    Problem(reason) -> Err(error: reason)
  }
}

fn load(id: Int) -> Option[Expense] {
  sql_first(row: Expense, query: "SELECT * FROM expenses WHERE id = :id", id)
}

fn filed(body: View) -> Outcome {
  let Ok(value: NewExpense(key, amount, approver)) = decode(json: body, as: NewExpense) else {
    Err(error) -> Problem(status: 400, reason: error)
  }
  let Some(value: e) = sql_first(
    row: Expense,
    query: "INSERT INTO expenses(client, amount, approver, deadline) \
        VALUES (:key, :amount, :approver, :deadline) ON CONFLICT(client) DO NOTHING RETURNING *",
    key,
    amount,
    approver,
    deadline: now() + flags.decide_ms
  ) else {
    None -> shown(
      found: sql_first(row: Expense, query: "SELECT * FROM expenses WHERE client = :key", key)
    )
  }
  do wake(after: flags.decide_ms, key: e.id)
  Shown(status: 201, expense: e)
}

// Approved in time: paying, with a timer for the payment's outcome, set before the call.
fn approve(id: Int) -> Outcome {
  let Some(value: e) = load(id) else -> Problem(status: 404, reason: "no such expense")
  match e {
    Expense(state: Waiting, deadline) if deadline <= now() -> Problem(
      status: 410,
      reason: "the deadline has passed"
    )
    Expense(state: Waiting) -> {
      do wake(after: 5000, key: id)
      paying(moved: sql_move(
        row: Expense,
        query: "UPDATE expenses SET state = 'paying' WHERE id = :id AND state = 'waiting' \
            RETURNING *",
        id
      ))
    }
    Expense(state: Paying) -> pay(expense: e)
    Expense(state: Declined) -> Shown(status: 409, expense: e)
    Expense(state: Expired) -> Shown(status: 409, expense: e)
    Expense(state: Paid) -> Shown(status: 409, expense: e)
    Expense(state: Failed) -> Shown(status: 409, expense: e)
  }
}

fn paying(moved: Move[Expense]) -> Outcome {
  match moved {
    Moved(value) -> pay(expense: value)
    Raced(now) -> Shown(status: 409, expense: now)
    NoRow -> Problem(status: 404, reason: "no such expense")
  }
}

fn pay(expense: Expense) -> Outcome {
  let Expense(id, amount) = expense
  paid(
    id,
    reply: call(
      to: payments,
      method: "pay",
      send: Pay(amount, ref: "expense-\(id)"),
      reply: Payout,
      within: 2000,
      once: PayFor(expense: id)
    )
  )
}

fn paid(id: Int, reply: Result[Payout, CallError]) -> Outcome {
  match reply {
    Ok(value) -> shown(found: latest(
      id,
      m: sql_move(
        row: Expense,
        query: "UPDATE expenses SET state = 'paid', note = '' WHERE id = :id \
            AND state = 'paying' RETURNING *",
        id
      )
    ))
    Err(error: Rejected(reason)) -> shown(found: latest(
      id,
      m: sql_move(
        row: Expense,
        query: "UPDATE expenses SET state = 'failed', note = :reason WHERE id = :id \
            AND state = 'paying' RETURNING *",
        reason,
        id
      )
    ))
    Err(error) -> {
      do wake(after: 5000, key: id)
      unknown(id)
    }
  }
}

// No answer: the payment is asked again by the timer this sets.
fn unknown(id: Int) -> Outcome {
  match load(id) {
    Some(value) -> Shown(status: 202, expense: value)
    None -> Problem(status: 404, reason: "no such expense")
  }
}

// The timer's run: a waiting expense past its deadline expires (one not yet due is waited for again); a payment
// still out is asked again.
fn due(found: Option[Expense]) -> Outcome {
  let Some(value: e) = found else -> Problem(status: 404, reason: "no such expense")
  match e {
    Expense(id, state: Waiting, deadline) if deadline <= now() -> shown(found: latest(
      id,
      m: sql_move(
        row: Expense,
        query: "UPDATE expenses SET state = 'expired' WHERE id = :id AND state = 'waiting' \
            RETURNING *",
        id
      )
    ))
    Expense(id, state: Waiting, deadline) -> {
      do wake(after: deadline - now(), key: id)
      later(expense: e)
    }
    Expense(state: Paying) -> pay(expense: e)
    Expense(state: Declined) -> Shown(status: 200, expense: e)
    Expense(state: Expired) -> Shown(status: 200, expense: e)
    Expense(state: Paid) -> Shown(status: 200, expense: e)
    Expense(state: Failed) -> Shown(status: 200, expense: e)
  }
}

fn later(expense: Expense) -> Outcome {
  Shown(status: 200, expense)
}

fn latest(id: Int, m: Move[Expense]) -> Option[Expense] {
  match m {
    Moved(value) -> Some(value)
    Raced(now) -> Some(now)
    NoRow -> load(id)
  }
}

fn shown(found: Option[Expense]) -> Outcome {
  let Some(value: e) = found else -> Problem(status: 404, reason: "no such expense")
  Shown(status: 200, expense: e)
}

fn rendered(outcome: Outcome) -> Response {
  match outcome {
    Shown(status, expense) -> write_json(out: buf(), value: expense) |> respond(status)
    Problem(status, reason) -> buf()
      |> append(view: "{\"error\":")
      |> write_json_string(text: reason)
      |> append(view: "}")
      |> respond(status)
  }
}

// What must hold: after every commit, and (settled) once nothing is in flight and every timer has run.
invariant "a paid expense carries no failure note" {
  SELECT id, note FROM expenses WHERE state = 'paid' AND note <> ''
}

invariant "no expense is left waiting or paying" settled {
  SELECT id, state, note FROM expenses WHERE state IN ('waiting', 'paying')
}
