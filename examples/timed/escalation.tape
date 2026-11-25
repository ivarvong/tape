// escalation.tape: an approval with an SLA (ported from the Temporal samples' human-in-the-loop workflow with a
// timeout and escalation). A request waits for its approver; if nobody decides within the SLA, the timer's run
// escalates it: the manager is paged (a call with a once key), and the request is denied if the manager does not
// decide within a second SLA. A page that does not answer is sent again by a timer.
//
//   POST /requests               {"key","approver","manager"}
//   POST /requests/<id>/approve
//   POST /requests/<id>/deny
//   GET  /requests/<id>

migration 1 "requests" {
  CREATE TABLE requests(
    id INTEGER PRIMARY KEY,
    client TEXT NOT NULL UNIQUE,
    approver TEXT NOT NULL,
    manager TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    due INTEGER NOT NULL,
    paged INTEGER NOT NULL DEFAULT 0
  )
}

type RequestState { Pending Approved Denied Escalated }

machine requests.state: RequestState {
  Pending -> Approved
  Pending -> Denied
  Pending -> Escalated
  Escalated -> Approved
  Escalated -> Denied
}

flag sla_ms: Int = 14400000

type Key = View where len(self) >= 1 and len(self) <= 64
type NewRequest { NewRequest(key: Key, approver: View, manager: View) }
type Req { Req(id: Int, approver: View, manager: View, state: RequestState, due: Int, paged: Int) }
type Page { Page(to: View, text: View) }
type Paged { Paged(at: Int) }
type PageFor { PageFor(request: Int) }

type Outcome {
  Shown(status: Int, request: Req)
  Problem(status: Int, reason: View)
}

// what the pager refuses with: why it would not page
type PageError { Refused(reason: View) }

fn handle(raw: View, db: Sql, pager: Remote, clock: Clock, timer: Timer) -> Response {
  match request(raw) {
    Request(method: Post, path: "/requests", body) -> opened(body) |> rendered
    Request(method: Post, path: "/requests/" ++ decimal(id) ++ "/approve") -> shown(found: latest(
      id,
      m: sql_move(
        row: Req,
        query: "UPDATE requests SET state = 'approved' WHERE id = :id AND state \
            IN ('pending', 'escalated') RETURNING *",
        id
      )
    ))
      |> rendered
    Request(method: Post, path: "/requests/" ++ decimal(id) ++ "/deny") -> shown(found: latest(
      id,
      m: sql_move(
        row: Req,
        query: "UPDATE requests SET state = 'denied' WHERE id = :id AND state \
            IN ('pending', 'escalated') RETURNING *",
        id
      )
    ))
      |> rendered
    Request(method: Get, path: "/requests/" ++ decimal(id)) -> shown(found: load(id)) |> rendered
    _ -> rendered(outcome: Problem(status: 404, reason: "no such route"))
  }
}

export fn woken(
  db: Sql,
  pager: Remote,
  clock: Clock,
  timer: Timer,
  message: Wake
) -> Result[Req, View] {
  let Wake(key) = message
  match due(found: load(id: key)) {
    Shown(request) -> Ok(value: request)
    Problem(reason) -> Err(error: reason)
  }
}

fn load(id: Int) -> Option[Req] uses db {
  sql_first(row: Req, query: "SELECT * FROM requests WHERE id = :id", id)
}

fn opened(body: View) -> Outcome uses clock, db, timer {
  let Ok(value: NewRequest(key, approver, manager)) = decode(json: body, as: NewRequest) else {
    Err(error) -> Problem(status: 400, reason: error)
  }
  let Some(value: r) = sql_first(
    row: Req,
    query: "INSERT INTO requests(client, approver, manager, due) \
        VALUES (:key, :approver, :manager, :due) ON CONFLICT(client) DO NOTHING RETURNING *",
    key,
    approver,
    manager,
    due: now() + flags.sla_ms
  ) else {
    None -> shown(
      found: sql_first(row: Req, query: "SELECT * FROM requests WHERE client = :key", key)
    )
  }
  do wake(after: flags.sla_ms, key: r.id)
  Shown(status: 201, request: r)
}

// The timer's run: a pending request past its SLA is escalated, with a new SLA (a timer, set in the same commit,
// before the page goes out); an escalated one past it is denied; an escalated one not yet paged is paged.
fn due(found: Option[Req]) -> Outcome uses clock, db, pager, timer {
  let Some(value: r) = found else -> Problem(status: 404, reason: "no such request")
  match r {
    Req(id, state: Pending, due) if due <= now() -> escalate(id)
    Req(id, state: Pending, due) -> {
      do wake(after: due - now(), key: id)
      later(request: r)
    }
    Req(id, state: Escalated, due) if due <= now() -> shown(found: latest(
      id,
      m: sql_move(
        row: Req,
        query: "UPDATE requests SET state = 'denied' WHERE id = :id AND state = 'escalated' \
            RETURNING *",
        id
      )
    ))
    Req(id, state: Escalated, paged: 0) -> page(request: r)
    Req(id, state: Escalated, due) -> {
      do wake(after: due - now(), key: id)
      later(request: r)
    }
    Req(state: Approved) -> Shown(status: 200, request: r)
    Req(state: Denied) -> Shown(status: 200, request: r)
  }
}

fn escalate(id: Int) -> Outcome uses clock, db, pager, timer {
  match sql_move(
    row: Req,
    query: "UPDATE requests SET state = 'escalated', due = :due WHERE id = :id \
        AND state = 'pending' RETURNING *",
    due: now() + flags.sla_ms,
    id
  ) {
    Moved(value) -> {
      do wake(after: flags.sla_ms, key: id)
      escalated(request: value)
    }
    Raced(now) -> Shown(status: 200, request: now)
    NoRow -> Problem(status: 404, reason: "no such request")
  }
}

fn escalated(request: Req) -> Outcome uses clock, db, pager, timer {
  page(request)
}

// A page that did not answer is sent again a minute later. A row has one timer (setting it again moves it), so
// that retry replaced the SLA's: a page that went out sets the SLA's timer again. (Written first with the Ok arm
// only noting the page; C79 found the escalated request left with no timer for its SLA.)
fn page(request: Req) -> Outcome uses clock, db, pager, timer {
  let Req(id, manager, due) = request
  match call(
    to: pager,
    method: "page",
    send: Page(to: manager, text: "an approval waits for you"),
    reply: Paged,
    error: PageError,
    within: 2000,
    once: PageFor(request: id)
  ) {
    Ok(value) -> {
      do wake(after: left(until: due), key: id)
      noted(id)
    }
    // a page the pager refuses will be refused again: the SLA still runs
    Err(error: Rejected(reason: Refused(reason))) -> {
      do wake(after: left(until: due), key: id)
      noted(id)
    }
    Err(error) -> {
      do wake(after: 60000, key: id)
      later(request)
    }
  }
}

fn noted(id: Int) -> Outcome uses db {
  shown(found: latest(
    id,
    m: sql_move(
      row: Req,
      query: "UPDATE requests SET paged = 1 WHERE id = :id AND state = 'escalated' RETURNING *",
      id
    )
  ))
}

fn left(until: Int) -> Int uses clock {
  match {
    until > now() -> until - now()
    else -> 0
  }
}

fn later(request: Req) -> Outcome {
  Shown(status: 200, request)
}

fn latest(id: Int, m: Move[Req]) -> Option[Req] uses db {
  match m {
    Moved(value) -> Some(value)
    Raced(now) -> Some(now)
    NoRow -> load(id)
  }
}

fn shown(found: Option[Req]) -> Outcome {
  let Some(value: r) = found else -> Problem(status: 404, reason: "no such request")
  Shown(status: 200, request: r)
}

fn rendered(outcome: Outcome) -> Response {
  match outcome {
    Shown(status, request) -> write_json(out: buf(), value: request) |> respond(status)
    Problem(status, reason) -> problem(status, detail: reason)
  }
}

// What must hold: after every commit, and (settled) once nothing is in flight and every timer has run.
invariant "nobody is paged for a request that has not escalated" {
  SELECT id, state FROM requests WHERE paged = 1 AND state = 'pending'
}

invariant "no request is left undecided" settled {
  SELECT id, state FROM requests WHERE state IN ('pending', 'escalated')
}
