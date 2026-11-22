// trial.tape: a free trial with a reminder (ported from the Temporal samples' subscription workflow: timers that
// drive a state, and an email that must go out once). A trial gets a timer for its reminder day; the timer's run
// sends the reminder (a call with a once key), and then sets a timer for the trial's end, when an unpaid trial
// expires. A reminder that does not answer is sent again by a timer a minute later.
//
//   POST /trials               {"key","email"}
//   POST /trials/<id>/pay
//   GET  /trials/<id>

migration 1 "trials" {
  CREATE TABLE trials(
    id INTEGER PRIMARY KEY,
    client TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'trial' CHECK (state IN ('trial', 'reminded', 'paid', 'expired')),
    ends INTEGER NOT NULL
  )
}

machine trials.state {
  "trial" -> "reminded"
  "trial" -> "paid"
  "reminded" -> "paid"
  "reminded" -> "expired"
}

flag remind_ms: Int = 604800000
flag trial_ms: Int = 1209600000

type Key = View where len(self) >= 1 and len(self) <= 64
type NewTrial { NewTrial(key: Key, email: View) }
type Trial { Trial(id: Int, email: View, state: View, ends: Int) }
type Email { Email(to: View, template: View) }
type Sent { Sent(message: View) }
type Reminder { Reminder(trial: Int) }

type Outcome {
  Shown(status: Int, trial: Trial)
  Problem(status: Int, reason: View)
}

fn handle(raw: View, db: Sql, mail: Remote, clock: Clock, timer: Timer) -> Buf {
  match request(raw) {
    Request(method: "POST", path: "/trials", body) -> started(body) |> rendered
    Request(method: "POST", path: "/trials/" ++ decimal(id) ++ "/pay") -> shown(found: latest(
      id,
      m: sql_move(
        row: Trial,
        query: "UPDATE trials SET state = 'paid' WHERE id = :id AND state \
            IN ('trial', 'reminded') RETURNING *",
        id
      )
    ))
      |> rendered
    Request(method: "GET", path: "/trials/" ++ decimal(id)) -> shown(found: load(id)) |> rendered
    _ -> rendered(outcome: Problem(status: 404, reason: "no such route"))
  }
}

export fn woken(
  db: Sql,
  mail: Remote,
  clock: Clock,
  timer: Timer,
  message: Wake
) -> Result[Trial, View] {
  let Wake(key) = message
  match due(found: load(id: key)) {
    Shown(trial) -> Ok(value: trial)
    Problem(reason) -> Err(error: reason)
  }
}

fn load(id: Int) -> Option[Trial] {
  sql_first(row: Trial, query: "SELECT * FROM trials WHERE id = :id", id)
}

fn started(body: View) -> Outcome {
  let Ok(value: NewTrial(key, email)) = decode(json: body, as: NewTrial) else {
    Err(error) -> Problem(status: 400, reason: error)
  }
  let Some(value: t) = sql_first(
    row: Trial,
    query: "INSERT INTO trials(client, email, ends) VALUES (:key, :email, :ends) \
        ON CONFLICT(client) DO NOTHING RETURNING *",
    key,
    email,
    ends: now() + flags.trial_ms
  ) else {
    None -> shown(
      found: sql_first(row: Trial, query: "SELECT * FROM trials WHERE client = :key", key)
    )
  }
  do wake(after: flags.remind_ms, key: t.id)
  Shown(status: 201, trial: t)
}

// The timer's run: a trial is reminded (and its end is a timer); a reminded trial past its end expires (one not
// yet due is waited for again); a paid or expired one is left as it is.
fn due(found: Option[Trial]) -> Outcome {
  let Some(value: t) = found else -> Problem(status: 404, reason: "no such trial")
  match t {
    Trial(id, email, state: "trial") -> reminded(
      id,
      reply: call(
        to: mail,
        method: "send",
        send: Email(to: email, template: "trial-ends-soon"),
        reply: Sent,
        within: 5000,
        once: Reminder(trial: id)
      )
    )
    Trial(id, state: "reminded", ends) if ends <= now() -> shown(found: latest(
      id,
      m: sql_move(
        row: Trial,
        query: "UPDATE trials SET state = 'expired' WHERE id = :id AND state = 'reminded' \
            RETURNING *",
        id
      )
    ))
    Trial(id, state: "reminded", ends) -> {
      do wake(after: ends - now(), key: id)
      later(trial: t)
    }
    _ -> Shown(status: 200, trial: t)
  }
}

fn reminded(id: Int, reply: Result[Sent, CallError]) -> Outcome {
  match reply {
    Ok(value) -> ending(
      id,
      found: latest(
        id,
        m: sql_move(
          row: Trial,
          query: "UPDATE trials SET state = 'reminded' WHERE id = :id AND state = 'trial' \
              RETURNING *",
          id
        )
      )
    )
    // a reminder the mail service refuses will be refused again: the trial goes on to its end without one
    Err(error: Rejected(reason)) -> ending(
      id,
      found: latest(
        id,
        m: sql_move(
          row: Trial,
          query: "UPDATE trials SET state = 'reminded' WHERE id = :id AND state = 'trial' \
              RETURNING *",
          id
        )
      )
    )
    Err(error) -> {
      do wake(after: 60000, key: id)
      later_reminder(id)
    }
  }
}

fn ending(id: Int, found: Option[Trial]) -> Outcome {
  match found {
    Some(value: t = Trial(state: "reminded", ends)) -> {
      do wake(after: ends - now(), key: id)
      later(trial: t)
    }
    _ -> shown(found)
  }
}

fn later_reminder(id: Int) -> Outcome {
  shown(found: load(id))
}

fn later(trial: Trial) -> Outcome {
  Shown(status: 200, trial)
}

fn latest(id: Int, m: Move[Trial]) -> Option[Trial] {
  match m {
    Moved(value) -> Some(value)
    Raced(now) -> Some(now)
    NoRow -> load(id)
  }
}

fn shown(found: Option[Trial]) -> Outcome {
  let Some(value: t) = found else -> Problem(status: 404, reason: "no such trial")
  Shown(status: 200, trial: t)
}

fn rendered(outcome: Outcome) -> Buf {
  match outcome {
    Shown(status, trial) -> write_json(out: respond(status), value: trial)
    Problem(status, reason) -> respond(status)
      |> append(view: "{\"error\":")
      |> write_json_string(text: reason)
      |> append(view: "}")
  }
}

// What must hold: (settled) once nothing is in flight and every timer has run.
invariant "no trial is left running" settled {
  SELECT id, state FROM trials WHERE state IN ('trial', 'reminded')
}

invariant "a trial has an end" {
  SELECT id, ends FROM trials WHERE ends <= 0
}
