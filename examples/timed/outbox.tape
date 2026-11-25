// outbox.tape: webhook delivery with retries (ported from the Temporal samples' "retry an activity with backoff"
// shape, as an outbox). A delivery is written in the request that makes it, with a timer for now; the timer's run
// sends it to the subscriber (a call with a once key, so a resend is answered from the subscriber's stored reply).
// A delivery that does not answer is tried again with std/retry's backoff; after the last attempt it is dead. A
// refusal is dead at once. POST /deliveries/<id>/redeliver puts a dead delivery back to pending.
//
//   POST /deliveries                {"key","topic","body"}      201 pending
//   GET  /deliveries/<id>
//   POST /deliveries/<id>/redeliver

migration 1 "outbox" {
  CREATE TABLE deliveries(
    id INTEGER PRIMARY KEY,
    client TEXT NOT NULL UNIQUE,
    topic TEXT NOT NULL,
    body TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'delivered', 'dead')),
    tries INTEGER NOT NULL DEFAULT 0,
    round INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT ''
  )
}

type DeliveryState { Pending Delivered Dead }

machine deliveries.state: DeliveryState {
  Pending -> Delivered
  Pending -> Dead
  Dead -> Pending
}

type Key = View where len(self) >= 1 and len(self) <= 64
type NewDelivery { NewDelivery(key: Key, topic: View, body: View) }
type Delivery { Delivery(
  id: Int,
  topic: View,
  body: View,
  state: DeliveryState,
  tries: Int,
  round: Int,
  note: View
) }
type Publish { Publish(topic: View, body: View) }
type Posted { Posted(status: Int) }
// a redelivery is a new command: the round is part of the key
type Once { Once(delivery: Int, round: Int) }

type Outcome {
  Shown(status: Int, delivery: Delivery)
  Problem(status: Int, reason: View)
}

// what the endpoint refuses a post with
type PostError { Refused(reason: View) }

fn handle(raw: View, db: Sql, hook: Remote, timer: Timer) -> Response {
  match request(raw) {
    Request(method: Post, path: "/deliveries", body) -> made(body) |> rendered
    Request(method: Get, path: "/deliveries/" ++ decimal(id)) -> shown(found: load(id)) |> rendered
    Request(method: Post, path: "/deliveries/" ++ decimal(id) ++ "/redeliver") -> redeliver(id)
      |> rendered
    _ -> rendered(outcome: Problem(status: 404, reason: "no such route"))
  }
}

export fn woken(db: Sql, hook: Remote, timer: Timer, message: Wake) -> Result[Delivery, View] {
  let Wake(key) = message
  match send(found: load(id: key)) {
    Shown(delivery) -> Ok(value: delivery)
    Problem(reason) -> Err(error: reason)
  }
}

fn load(id: Int) -> Option[Delivery] {
  sql_first(row: Delivery, query: "SELECT * FROM deliveries WHERE id = :id", id)
}

fn made(body: View) -> Outcome {
  let Ok(value: NewDelivery(key, topic, body: text)) = decode(json: body, as: NewDelivery) else {
    Err(error) -> Problem(status: 400, reason: error)
  }
  let Some(value: d) = sql_first(
    row: Delivery,
    query: "INSERT INTO deliveries(client, topic, body) VALUES (:key, :topic, :text) \
        ON CONFLICT(client) DO NOTHING RETURNING *",
    key,
    topic,
    text
  ) else {
    None -> shown(
      found: sql_first(row: Delivery, query: "SELECT * FROM deliveries WHERE client = :key", key)
    )
  }
  do wake(after: 0, key: d.id)
  Shown(status: 201, delivery: d)
}

fn redeliver(id: Int) -> Outcome {
  match sql_move(
    row: Delivery,
    query: "UPDATE deliveries SET state = 'pending', tries = 0, round = round + 1, note = '' \
        WHERE id = :id AND state = 'dead' RETURNING *",
    id
  ) {
    Moved(value) -> {
      do wake(after: 0, key: id)
      again(delivery: value)
    }
    Raced(now) -> Shown(status: 409, delivery: now)
    NoRow -> Problem(status: 404, reason: "no such delivery")
  }
}

fn again(delivery: Delivery) -> Outcome {
  Shown(status: 202, delivery)
}

// The timer's run: a pending delivery is sent; any other is shown as it is.
fn send(found: Option[Delivery]) -> Outcome {
  let Some(value: d) = found else -> Problem(status: 404, reason: "no such delivery")
  match d {
    Delivery(id, topic, body, state: Pending, tries, round) -> sent(
      id,
      tries,
      reply: call(
        to: hook,
        method: "post",
        send: Publish(topic, body),
        reply: Posted,
        error: PostError,
        within: 2000,
        once: Once(delivery: id, round)
      )
    )
    Delivery(state: Delivered) -> Shown(status: 200, delivery: d)
    Delivery(state: Dead) -> Shown(status: 200, delivery: d)
  }
}

fn sent(id: Int, tries: Int, reply: Result[Posted, CallError[PostError]]) -> Outcome {
  match reply {
    Ok(value) -> shown(found: moved(id, to: Delivered, note: ""))
    Err(error: Rejected(reason: Refused(reason))) -> shown(found: moved(id, to: Dead, note: reason))
    Err(error: Skew(reason)) -> shown(found: moved(id, to: Dead, note: reason))
    Err(error) -> failed(
      id,
      tried: sql_move(
        row: Delivery,
        query: "UPDATE deliveries SET tries = :tries + 1 WHERE id = :id AND state = 'pending' \
            AND tries = :tries RETURNING *",
        tries,
        id
      )
    )
  }
}

// Another failure in a row: try again later, or give up after the last attempt (the delivery is dead).
fn failed(id: Int, tried: Move[Delivery]) -> Outcome {
  match tried {
    Moved(value: Delivery(tries)) -> decided(
      id,
      plan: retry_later(
        timer,
        key: id,
        policy: Backoff(first: 1000, factor: 2, most: 60000, tries: 8),
        failed: tries
      )
    )
    Raced(now) -> Shown(status: 200, delivery: now)
    NoRow -> Problem(status: 404, reason: "no such delivery")
  }
}

fn decided(id: Int, plan: Retry) -> Outcome {
  match plan {
    RetryIn(after) -> shown(found: noted(id, note: "no answer; again in \(after) ms"))
    GaveUp(tries) -> shown(found: moved(id, to: Dead, note: "no answer after \(tries) attempts"))
  }
}

fn moved(id: Int, to: DeliveryState, note: View) -> Option[Delivery] {
  latest(
    id,
    m: sql_move(
      row: Delivery,
      query: "UPDATE deliveries SET state = :to, note = :note WHERE id = :id \
          AND state = 'pending' RETURNING *",
      to,
      note,
      id
    )
  )
}

fn noted(id: Int, note: View) -> Option[Delivery] {
  latest(
    id,
    m: sql_move(
      row: Delivery,
      query: "UPDATE deliveries SET note = :note WHERE id = :id AND state = 'pending' RETURNING *",
      note,
      id
    )
  )
}

fn latest(id: Int, m: Move[Delivery]) -> Option[Delivery] {
  match m {
    Moved(value) -> Some(value)
    Raced(now) -> Some(now)
    NoRow -> load(id)
  }
}

fn shown(found: Option[Delivery]) -> Outcome {
  let Some(value: d) = found else -> Problem(status: 404, reason: "no such delivery")
  Shown(status: 200, delivery: d)
}

fn rendered(outcome: Outcome) -> Response {
  match outcome {
    Shown(status, delivery) -> write_json(out: buf(), value: delivery) |> respond(status)
    Problem(status, reason) -> problem(status, detail: reason)
  }
}

// What must hold: after every commit, and (settled) once nothing is in flight and every timer has run.
invariant "a delivery has failed no more often than its policy allows" {
  SELECT id, tries FROM deliveries WHERE tries < 0 OR tries > 8
}

invariant "a delivered delivery carries no failure note" {
  SELECT id, note FROM deliveries WHERE state = 'delivered' AND note <> ''
}

invariant "no delivery is left pending" settled {
  SELECT id, tries, note FROM deliveries WHERE state = 'pending'
}
