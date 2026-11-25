// queue.tape: a job queue that workers pull from. A job is leased to one worker for a time; the worker acks it
// (done), nacks it (tried again later, with a longer wait each time), or says nothing, and the lease runs out: a
// timer set with the lease puts the job back. A job that has been tried as often as it may be is dead until
// someone asks for it again.
//
//   POST /jobs                 {"key","kind","payload","delay_ms"?,"most"?}   201 the job; the same key again, 200
//   POST /lease                {"key","worker","kind","for_ms"}               200 a job, leased; 204 when none is due
//   POST /jobs/<id>/ack        {"attempt"}                                    200 done
//   POST /jobs/<id>/nack       {"attempt","error"}                            200 ready again, or dead
//   POST /jobs/<id>/extend     {"attempt","for_ms"}                           200 the lease, longer
//   POST /jobs/<id>/retry                                                     200 a dead job, ready again, with five more tries
//   GET  /jobs/<id>            GET /jobs            GET /stats
//
// Every request may arrive twice (a worker that got no answer asks again), so each says which thing it is about:
// a new job carries the client's key; a lease carries the worker's key for that lease, and the same key again is
// that lease, not a second job; ack, nack and extend carry the attempt they are about, so one that arrives after
// the lease was lost changes nothing. A job's attempts only ever count up (a dead job asked for again is given more
// tries, not a count set back to 0), so an attempt's number never names two leases.

migration 1 "jobs" {
  CREATE TABLE jobs(
    id INTEGER PRIMARY KEY,
    client TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'ready',
    run_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    most INTEGER NOT NULL DEFAULT 5 CHECK (most >= 1),
    worker TEXT NOT NULL DEFAULT '',
    lease TEXT NOT NULL DEFAULT '',
    lease_until INTEGER NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX jobs_due ON jobs(kind, state, run_at);
  CREATE INDEX jobs_lease ON jobs(lease)
}

type JobState { Ready Leased Done Dead }

machine jobs.state: JobState {
  Ready -> Leased
  Leased -> Done
  Leased -> Ready
  Leased -> Dead
  Dead -> Ready
}

invariant "a leased job has a worker and a time its lease ends" {
  SELECT id, worker, lease_until FROM jobs WHERE state = 'leased' AND (worker = '' OR lease_until <= 0)
}

invariant "only a leased job has a worker" {
  SELECT id, state, worker FROM jobs WHERE state <> 'leased' AND worker <> ''
}

invariant "a job is tried no more often than it may be" {
  SELECT id, attempts, most FROM jobs WHERE attempts > most
}

invariant "a done job was tried, and a dead one as often as it may be" {
  SELECT id, state, attempts, most FROM jobs WHERE (state = 'done' AND attempts < 1) OR (state = 'dead' AND attempts < most)
}

invariant "a job that has been tried was leased under a key" {
  SELECT id, attempts FROM jobs WHERE attempts > 0 AND lease = ''
}

invariant "no lease key holds two jobs" {
  SELECT lease, count(*) AS jobs FROM jobs WHERE lease <> '' GROUP BY lease HAVING count(*) > 1
}

invariant "no job is left leased" settled {
  SELECT id, worker, attempts FROM jobs WHERE state = 'leased'
}

type Key = View where len(self) >= 1 and len(self) <= 64
type Name = View where len(self) >= 1 and len(self) <= 64
type Delay = Int where self >= 0 and self <= 86400000
type Most = Int where self >= 1 and self <= 20
type LeaseMs = Int where self >= 1000 and self <= 3600000

type NewJob { NewJob(
  key: Key,
  kind: Name,
  payload: View,
  delay_ms: Option[Delay],
  most: Option[Most]
) }
type LeaseReq { LeaseReq(key: Key, worker: Name, kind: Name, for_ms: LeaseMs) }
type Ack { Ack(attempt: Int) }
type Nack { Nack(attempt: Int, error: View) }
type Extend { Extend(attempt: Int, for_ms: LeaseMs) }
type Job { Job(
  id: Int,
  kind: View,
  payload: View,
  state: JobState,
  run_at: Int,
  attempts: Int,
  most: Int,
  worker: View,
  lease_until: Int,
  error: View
) }
type Stat { Stat(state: JobState, jobs: Int) }

type Outcome {
  Shown(status: Int, job: Job)
  Nothing
  Problem(status: Int, reason: View)
}

fn handle(raw: View, db: Sql, clock: Clock, timer: Timer) -> Buf {
  match request(raw) {
    Request(method: "POST", path: "/jobs", body) -> add(body) |> rendered
    Request(method: "POST", path: "/lease", body) -> lease(body) |> rendered
    Request(method: "POST", path: "/jobs/" ++ decimal(id) ++ "/ack", body) -> ack(id, body)
      |> rendered
    Request(method: "POST", path: "/jobs/" ++ decimal(id) ++ "/nack", body) -> nack(id, body)
      |> rendered
    Request(method: "POST", path: "/jobs/" ++ decimal(id) ++ "/extend", body) -> extend(id, body)
      |> rendered
    Request(method: "POST", path: "/jobs/" ++ decimal(id) ++ "/retry") -> moved(m: sql_move(
      row: Job,
      query: "UPDATE jobs SET state = 'ready', most = attempts + 5, run_at = :run_at, error = '' \
          WHERE id = :id AND state = 'dead' RETURNING *",
      run_at: now(),
      id
    ))
      |> rendered
    Request(method: "GET", path: "/jobs/" ++ decimal(id)) -> shown(found: load(id)) |> rendered
    Request(method: "GET", path: "/jobs") -> respond(status: 200)
      |> write_rows(rows: sql_all(row: Job, query: "SELECT * FROM jobs ORDER BY id DESC LIMIT 100"))
    Request(method: "GET", path: "/stats") -> respond(status: 200)
      |> write_rows(rows: sql_all(
        row: Stat,
        query: "SELECT state, count(*) AS jobs FROM jobs GROUP BY state ORDER BY state"
      ))
    _ -> rendered(outcome: Problem(status: 404, reason: "no such route"))
  }
}

// A lease's timer: a lease that has run out gives the job back; one that was extended is waited for again.
export fn woken(db: Sql, clock: Clock, timer: Timer, message: Wake) -> Result[Job, View] {
  let Wake(key) = message
  let Some(value: job) = load(id: key) else -> Err(error: "no such job")
  match job {
    Job(id, state: Leased, attempts, most, lease_until) if lease_until <= now() -> answer(
      outcome: back(id, attempt: attempts, most, error: "the lease ran out")
    )
    Job(id, state: Leased, lease_until) -> {
      do wake(after: lease_until - now(), key: id)
      Ok(value: job)
    }
    Job(state: Ready) -> Ok(value: job)
    Job(state: Done) -> Ok(value: job)
    Job(state: Dead) -> Ok(value: job)
  }
}

fn answer(outcome: Outcome) -> Result[Job, View] {
  match outcome {
    Shown(job) -> Ok(value: job)
    Nothing -> Err(error: "nothing")
    Problem(reason) -> Err(error: reason)
  }
}

fn add(body: View) -> Outcome {
  let Ok(value: NewJob(key, kind, payload, delay_ms, most)) = decode(json: body, as: NewJob) else {
    Err(error) -> Problem(status: 400, reason: error)
  }
  let Some(value: job) = sql_first(
    row: Job,
    query: "INSERT INTO jobs(client, kind, payload, run_at, most) \
        VALUES (:key, :kind, :payload, :run_at, :most) ON CONFLICT(client) DO NOTHING RETURNING *",
    key,
    kind,
    payload,
    run_at: now() + value_or(given: delay_ms, otherwise: 0),
    most: value_or(given: most, otherwise: 5)
  ) else {
    None -> again(found: sql_first(row: Job, query: "SELECT * FROM jobs WHERE client = :key", key))
  }
  Shown(status: 201, job)
}

fn again(found: Option[Job]) -> Outcome {
  match found {
    Some(value) -> Shown(status: 200, job: value)
    None -> Problem(status: 500, reason: "the job vanished")
  }
}

// The oldest job of this kind that is due. The lease's key is written with it, so the same request again finds
// the job it was given instead of taking another.
fn lease(body: View) -> Outcome {
  let Ok(value: LeaseReq(key, worker, kind, for_ms)) = decode(json: body, as: LeaseReq) else {
    Err(error) -> Problem(status: 400, reason: error)
  }
  let None = sql_first(row: Job, query: "SELECT * FROM jobs WHERE lease = :key", key) else {
    Some(value) -> Shown(status: 200, job: value)
  }
  let Some(value: Job(id)) = sql_first(
    row: Job,
    query: "SELECT * FROM jobs WHERE state = 'ready' AND kind = :kind AND run_at <= :run_at \
        ORDER BY run_at, id LIMIT 1",
    kind,
    run_at: now()
  ) else {
    None -> Nothing
  }
  let Moved(value: job) = sql_move(
    row: Job,
    query: "UPDATE jobs SET state = 'leased', attempts = attempts + 1, worker = :worker, lease = \
        :key, lease_until = :lease_until WHERE id = :id AND state = 'ready' RETURNING *",
    worker,
    key,
    lease_until: now() + for_ms,
    id
  ) else {
    Raced(now) -> Nothing
    NoRow -> Nothing
  }
  do wake(after: for_ms, key: job.id)
  Shown(status: 200, job)
}

// Done, by the attempt that holds the lease. The same ack again finds the job done by that attempt.
fn ack(id: Int, body: View) -> Outcome {
  let Ok(value: Ack(attempt)) = decode(json: body, as: Ack) else {
    Err(error) -> Problem(status: 400, reason: error)
  }
  match sql_move(
    row: Job,
    query: "UPDATE jobs SET state = 'done', worker = '', error = '' WHERE id = :id \
        AND state = 'leased' AND attempts = :attempt RETURNING *",
    id,
    attempt
  ) {
    Moved(value) -> Shown(status: 200, job: value)
    Raced(now: job = Job(state: Done, attempts)) if attempts == attempt -> Shown(status: 200, job)
    Raced(now) -> Problem(status: 409, reason: "this attempt no longer holds the lease")
    NoRow -> Problem(status: 404, reason: "no such job")
  }
}

fn nack(id: Int, body: View) -> Outcome {
  let Ok(value: Nack(attempt, error)) = decode(json: body, as: Nack) else {
    Err(error) -> Problem(status: 400, reason: error)
  }
  let Some(value: Job(most)) = load(id) else -> Problem(status: 404, reason: "no such job")
  back(id, attempt, most, error)
}

// The job goes back: ready after a wait that doubles with each attempt, or dead when this was its last.
fn back(id: Int, attempt: Int, most: Int, error: View) -> Outcome {
  match {
    attempt >= most -> held(m: sql_move(
      row: Job,
      query: "UPDATE jobs SET state = 'dead', worker = '', error = :error WHERE id = :id \
          AND state = 'leased' AND attempts = :attempt RETURNING *",
      error,
      id,
      attempt
    ))
    else -> held(m: sql_move(
      row: Job,
      query: "UPDATE jobs SET state = 'ready', worker = '', error = :error, run_at = :run_at \
          WHERE id = :id AND state = 'leased' AND attempts = :attempt RETURNING *",
      error,
      run_at: now() + wait(attempt),
      id,
      attempt
    ))
  }
}

fn wait(attempt: Int) -> Int {
  match backoff(policy: Backoff(first: 1000, factor: 2, most: 60000, tries: 21), failed: attempt) {
    RetryIn(after) -> after
    GaveUp -> 60000
  }
}

fn extend(id: Int, body: View) -> Outcome {
  let Ok(value: Extend(attempt, for_ms)) = decode(json: body, as: Extend) else {
    Err(error) -> Problem(status: 400, reason: error)
  }
  let Moved(value: job) = sql_move(
    row: Job,
    query: "UPDATE jobs SET lease_until = :lease_until WHERE id = :id AND state = 'leased' \
        AND attempts = :attempt RETURNING *",
    lease_until: now() + for_ms,
    id,
    attempt
  ) else {
    Raced(now) -> Problem(status: 409, reason: "this attempt does not hold the lease")
    NoRow -> Problem(status: 404, reason: "no such job")
  }
  do wake(after: for_ms, key: id)
  Shown(status: 200, job)
}

fn load(id: Int) -> Option[Job] {
  sql_first(row: Job, query: "SELECT * FROM jobs WHERE id = :id", id)
}

fn held(m: Move[Job]) -> Outcome {
  match m {
    Moved(value) -> Shown(status: 200, job: value)
    Raced(now) -> Problem(status: 409, reason: "this attempt no longer holds the lease")
    NoRow -> Problem(status: 404, reason: "no such job")
  }
}

fn moved(m: Move[Job]) -> Outcome {
  match m {
    Moved(value) -> Shown(status: 200, job: value)
    Raced(now) -> Shown(status: 200, job: now)
    NoRow -> Problem(status: 404, reason: "no such job")
  }
}

fn shown(found: Option[Job]) -> Outcome {
  match found {
    Some(value) -> Shown(status: 200, job: value)
    None -> Problem(status: 404, reason: "no such job")
  }
}

fn rendered(outcome: Outcome) -> Buf {
  match outcome {
    Shown(status, job) -> respond(status) |> write_json(value: job)
    Nothing -> respond(status: 204)
    Problem(status, reason) -> respond(status)
      |> append(view: "{\"error\":")
      |> write_json_string(text: reason)
      |> append(view: "}")
  }
}
