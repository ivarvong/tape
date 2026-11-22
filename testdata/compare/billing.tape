// billing.tape: subscriptions billed once per period. A subscription's `state` is a machine:
//
//   trialing -> active <-> past_due        (a renewal charged / declined; a payment made elsewhere)
//   trialing, active, past_due -> canceled  (for good: nothing moves a canceled subscription, nothing bills it)
//
// A renewal is a command to payments with the key Period(sub, period), so each period is charged at most once
// however often its renewal is sent (a scheduler that fires twice, a retry after a lost reply). The renewal's
// result is written only while the subscription is still in the state it was read in: a cancel that lands while
// the charge is out wins. That charge may still have run, so the period being charged is written down before the
// charge goes out (`charging`), and a renewal of a canceled subscription sends it again, with the same key, to
// learn its outcome: a charge that ran is invoiced and receipted, and the subscription stays canceled.
//
//   POST /subs              {"key":"c-1","card":"ann","price":10}
//   POST /renew/<id>        {"period":n}: bill period n (a scheduler sends it; again after a 202)
//   POST /paid/<id>         the customer paid the overdue period elsewhere
//   POST /cancel/<id>
//   GET  /subs/<id>

migration 1 "subs" {
  CREATE TABLE subs(
    id INTEGER PRIMARY KEY,
    client TEXT NOT NULL UNIQUE,
    card TEXT NOT NULL,
    price INTEGER NOT NULL CHECK (price > 0),
    state TEXT NOT NULL DEFAULT 'trialing' CHECK (state IN ('trialing', 'active', 'past_due', 'canceled')),
    paid_through INTEGER NOT NULL DEFAULT 0,
    charging INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE invoices(
    sub INTEGER NOT NULL,
    period INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    PRIMARY KEY (sub, period)
  ) WITHOUT ROWID
}

machine subs.state {
  "trialing" -> "active"
  "trialing" -> "past_due"
  "active" -> "past_due"
  "past_due" -> "active"
  "trialing" -> "canceled"
  "active" -> "canceled"
  "past_due" -> "canceled"
}

type Key = View where len(self) >= 1 and len(self) <= 64
type NewSub { NewSub(key: Key, card: View, price: Int) }
type Sub { Sub(
  id: Int,
  card: View,
  price: Int,
  state: View,
  paid_through: Int,
  charging: Int,
  invoices: Int
) }
type Period { Period(sub: Int, period: Int) }
type Renew { Renew(period: Int) }
type Charge { Charge(card: View, amount: Int) }
type Charged { Charged(balance: Int) }
type Receipt { Receipt(sub: Int, period: Int) }
type Email { Email(tool: View, input: View) }
type Sent { Sent(output: View) }

type Outcome {
  Shown(status: Int, sub: Sub)
  Problem(status: Int, reason: View)
}

fn handle(raw: View, db: Sql, payments: Remote, tools: Remote) -> Buf {
  routed(raw) |> rendered
}

// db, payments and tools are the capabilities handle declares: the functions below use them by name (the compiler
// passes them; an entry point that does not declare one it reaches is refused, C72).
fn routed(raw: View) -> Outcome {
  match request(raw) {
    Request(method: "POST", path: "/subs", body) -> {
      let Ok(value: NewSub(key, card, price)) = decode(json: body, as: NewSub) else {
        Err(error) -> Problem(status: 400, reason: error)
      }
      let Some(value: sub) = sql_first(
        row: Sub,
        query: "INSERT INTO subs(client, card, price) VALUES (:key, :card, :price) \
            ON CONFLICT(client) DO NOTHING RETURNING *, 0 AS invoices",
        key,
        card,
        price
      ) else {
        None -> show(
          status: 200,
          found: sql_first(
            row: Sub,
            query: "SELECT *, (SELECT count(*) FROM invoices WHERE sub = subs.id) AS invoices \
                FROM subs WHERE client = :key",
            key
          )
        )
      }
      Shown(status: 201, sub)
    }
    Request(method: "POST", path: "/renew/" ++ decimal(id), body) -> {
      let Ok(value: Renew(period)) = decode(json: body, as: Renew) else {
        Err(error) -> Problem(status: 400, reason: error)
      }
      let Some(value: sub) = load(id) else -> missing()
      renew(sub, period)
    }
    Request(method: "POST", path: "/paid/" ++ decimal(id)) -> show(
      status: 200,
      found: latest(
        id,
        moved: sql_move(
          row: Sub,
          query: "UPDATE subs SET state = 'active' WHERE id = :id AND state = 'past_due' \
              RETURNING *, (SELECT count(*) FROM invoices WHERE sub = subs.id) AS invoices",
          id
        )
      )
    )
    Request(method: "POST", path: "/cancel/" ++ decimal(id)) -> show(
      status: 200,
      found: latest(
        id,
        moved: sql_move(
          row: Sub,
          query: "UPDATE subs SET state = 'canceled' WHERE id = :id AND state \
              IN ('trialing', 'active', 'past_due') RETURNING *, (SELECT count(*) FROM invoices \
              WHERE sub = subs.id) AS invoices",
          id
        )
      )
    )
    Request(method: "GET", path: "/subs/" ++ decimal(id)) -> show(status: 200, found: load(id))
    _ -> Problem(status: 404, reason: "no such route")
  }
}

fn load(id: Int) -> Option[Sub] {
  sql_first(
    row: Sub,
    query: "SELECT *, (SELECT count(*) FROM invoices WHERE sub = subs.id) AS invoices FROM subs \
        WHERE id = :id",
    id
  )
}

// Bill period n, unless it is billed already or the subscription is canceled. A canceled subscription whose last
// charge went out without an answer has that charge sent again (same key: it runs at most once) to settle it.
// Otherwise the period is written down (and committed: a call is a commit point) before its charge goes out.
fn renew(sub: Sub, period: Int) -> Outcome {
  match sub {
    Sub(
      id,
      card,
      price,
      state: "canceled",
      paid_through,
      charging
    ) if charging > paid_through -> charged(
      id,
      period: charging,
      price,
      state: "canceled",
      reply: call(
        to: payments,
        method: "charge",
        send: Charge(card, amount: price),
        reply: Charged,
        within: 50,
        once: Period(sub: id, period: charging)
      )
    )
    Sub(state: "canceled") -> Shown(status: 409, sub)
    Sub(paid_through) if paid_through >= period -> Shown(status: 200, sub)
    Sub(id, state) -> {
      let Moved(value: Sub(card, price)) = sql_move(
        row: Sub,
        query: "UPDATE subs SET charging = :period WHERE id = :id AND state = :state \
            RETURNING *, (SELECT count(*) FROM invoices WHERE sub = subs.id) AS invoices",
        period,
        id,
        state
      ) else {
        Raced(now) -> Shown(status: 409, sub: now)
        NoRow -> missing()
      }
      charged(
        id,
        period,
        price,
        state,
        reply: call(
          to: payments,
          method: "charge",
          send: Charge(card, amount: price),
          reply: Charged,
          within: 50,
          once: Period(sub: id, period)
        )
      )
    }
  }
}

// The charge's outcome, written only from the state the subscription was in when it was sent. Invoiced; the
// receipt sent (or sent again by the next renewal, under the same key); the period paid. A canceled subscription
// stays canceled: its settled charge only moves paid_through.
fn charged(
  id: Int,
  period: Int,
  price: Int,
  state: View,
  reply: Result[Charged, CallError]
) -> Outcome {
  match reply {
    Ok(value) -> {
      do sql_exec(
        query: "INSERT INTO invoices(sub, period, amount) VALUES (:id, :period, :price) \
            ON CONFLICT(sub, period) DO NOTHING",
        id,
        period,
        price
      )
      let Ok(value: Sent) = call(
        to: tools,
        method: "tool",
        send: Email(tool: "email", input: "\(id)/\(period)"),
        reply: Sent,
        within: 50,
        once: Receipt(sub: id, period)
      ) else -> show(status: 202, found: load(id))
      match state {
        "canceled" -> show(
          status: 200,
          found: latest(
            id,
            moved: sql_move(
              row: Sub,
              query: "UPDATE subs SET paid_through = max(paid_through, :period) WHERE id = :id \
                  AND state = 'canceled' RETURNING *, (SELECT count(*) FROM invoices \
                  WHERE sub = subs.id) AS invoices",
              period,
              id
            )
          )
        )
        _ -> show(
          status: 200,
          found: latest(
            id,
            moved: sql_move(
              row: Sub,
              query: "UPDATE subs SET state = 'active', paid_through = max(paid_through, :period) \
                  WHERE id = :id AND state = :state RETURNING *, (SELECT count(*) FROM invoices \
                  WHERE sub = subs.id) AS invoices",
              period,
              id,
              state
            )
          )
        )
      }
    }
    Err(error: Rejected(reason)) -> show(
      status: 402,
      found: latest(
        id,
        moved: sql_move(
          row: Sub,
          query: "UPDATE subs SET state = 'past_due', charging = paid_through WHERE id = :id \
              AND state IN ('trialing', 'active') AND state = :state \
              RETURNING *, (SELECT count(*) FROM invoices WHERE sub = subs.id) AS invoices",
          id,
          state
        )
      )
    )
    Err(error: Skew(reason)) -> Problem(status: 502, reason)
    Err(error) -> show(status: 202, found: load(id))
  }
}

fn latest(id: Int, moved: Move[Sub]) -> Option[Sub] {
  match moved {
    Moved(value) -> Some(value)
    Raced(now) -> Some(now)
    NoRow -> load(id)
  }
}

fn show(status: Int, found: Option[Sub]) -> Outcome {
  let Some(value: sub) = found else -> missing()
  Shown(status, sub)
}

fn missing() -> Outcome {
  Problem(status: 404, reason: "no such subscription")
}

fn rendered(outcome: Outcome) -> Buf {
  match outcome {
    Shown(status, sub) -> write_json(out: respond(status), value: sub)
    Problem(status, reason) -> respond(status)
      |> append(view: "{\"error\":")
      |> write_json_string(text: reason)
      |> append(view: "}")
  }
}

// What must hold after every commit (checked by `tape sim` and by app.invariants() in the host).
invariant "a period paid through has its invoice" {
  SELECT s.id, s.paid_through FROM subs AS s WHERE s.paid_through > 0 AND NOT EXISTS (SELECT 1 FROM invoices AS i WHERE i.sub = s.id AND i.period = s.paid_through)
}

invariant "an invoice is for its subscription's price" {
  SELECT i.sub, i.period, i.amount FROM invoices AS i JOIN subs AS s ON s.id = i.sub WHERE i.amount <> s.price
}
