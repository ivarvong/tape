// bump.tape: change the version in a git repository. The repository is a capability with an interface; the host
// binds it to one repository with ply (adapters/ply.mjs), so no URL or token appears here or in the log.
// The intent is written down before the push, with the head it expects and the time to stamp, so the same push
// can be sent again after a timeout and lands exactly once. POST /bump carries the client's key, so a retried
// request is the same bump, not a second intent (the compiler refuses an INSERT without one: C55).

interface Git {
  read head(Ref) -> Head
  read read_file(ReadFile) -> File
  write edit_file(Edit) -> Edited
}

type Ref { Ref(ref: View) }
type Head { Head(commit: View) }
type ReadFile { ReadFile(ref: View, path: View) }
type File { File(content: View, size: Int) }
type Edit { Edit(
  ref: View,
  path: View,
  find: View,
  replace: View,
  message: View,
  time: Int,
  expected: View
) }
type Edited { Edited(commit: View, noop: Bool) }

// A bump waits as pending until the push is answered; the compiler checks every write of its state against these
// moves (each from the state its WHERE names), and the host installs SQLite triggers that refuse any other.
type BumpState { Pending Pushed Refused }

machine bumps.state: BumpState {
  Pending -> Pushed
  Pending -> Refused
}

schema "CREATE TABLE IF NOT EXISTS bumps(id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, find \
    TEXT NOT NULL, replace TEXT NOT NULL, expected TEXT NOT NULL, time INTEGER NOT NULL, state \
    TEXT NOT NULL)"

type Key = View where len(self) >= 1 and len(self) <= 64
type Bump { Bump(key: Key, from: View, to: View) }
type Intent { Intent(id: Int, find: View, replace: View, expected: View, time: Int) }
type Bumped { Bumped(id: Int, state: BumpState) }
type ForBump { ForBump(bump: Int) }

fn handle(raw: View, db: Sql, clock: Clock, repo: Git) -> Buf {
  match request(raw) {
    Request(method: "GET", path: "/version") -> version()
    Request(method: "POST", path: "/bump", body) -> start(body)
    Request(method: "POST", path: "/retry/" ++ decimal(id)) -> retry(id)
    _ -> problem(status: 404, reason: "no such route")
  }
}

fn version() -> Buf {
  let Ok(value: File(content)) = repo.read_file(
    send: ReadFile(ref: "main", path: "VERSION"),
    within: 2000
  ) else {
    Err(error: Rejected(reason)) -> problem(status: 502, reason)
    _ -> problem(status: 504, reason: "the repository did not answer")
  }
  respond(status: 200)
    |> append(view: "{\"version\":")
    |> write_json_string(text: until(v: content, byte: 10))
    |> append(view: "}")
}

fn start(body: View) -> Buf {
  let Ok(value: Bump(key, from, to)) = decode(json: body, as: Bump) else {
    Err(error) -> problem(status: 400, reason: error)
  }
  let Ok(value: Head(commit)) = repo.head(
    send: Ref(ref: "main"),
    within: 2000
  ) else -> problem(status: 502, reason: "could not read the branch")
  // Write the intent down first: what to change, from which head, stamped with which time. The same key again
  // finds the intent written before, if it is still pending.
  let Some(value: intent) = sql_first(
    row: Intent,
    query: "INSERT INTO bumps(key, find, replace, expected, time, state) \
        VALUES (:key, :from, :to, :commit, :time, 'pending') ON CONFLICT(key) \
        DO NOTHING RETURNING *",
    key,
    from,
    to,
    commit,
    time: now(clock) / 1000
  ) else -> again(found: sql_first(
    row: Intent,
    query: "SELECT * FROM bumps WHERE key = :key AND find = :from AND replace = :to \
        AND state = 'pending'",
    key,
    from,
    to
  ))
  edit(intent)
}

fn again(found: Option[Intent]) -> Buf {
  match found {
    Some(value) -> edit(intent: value)
    None -> problem(status: 404, reason: "no such pending bump")
  }
}

fn retry(id: Int) -> Buf {
  let Some(value: intent) = sql_first(
    row: Intent,
    query: "SELECT * FROM bumps WHERE id = :id AND state = 'pending'",
    id
  ) else -> problem(status: 404, reason: "no such pending bump")
  edit(intent)
}

// The edit is a command with the bump's key: sent again, the repository answers what it did the first time.
fn edit(intent: Intent) -> Buf {
  let Intent(id, find, replace, expected, time) = intent
  let Ok(value: Edited(commit)) = repo.edit_file(
    send: Edit(
      ref: "main",
      path: "VERSION",
      find,
      replace,
      message: "Bump version",
      time,
      expected
    ),
    within: 3000,
    once: ForBump(bump: id)
  ) else {
    Err(error: Rejected(reason)) -> refused(
      reason,
      moved: sql_move(
        row: Bumped,
        query: "UPDATE bumps SET state = 'refused' WHERE id = :id AND state = 'pending' \
            RETURNING *",
        id
      )
    )
    Err(error: Timeout) -> problem(
      status: 504,
      reason: "the push did not finish in time; the bump stays pending"
    )
    _ -> problem(status: 502, reason: "the repository is unavailable; the bump stays pending")
  }
  pushed(
    commit,
    moved: sql_move(
      row: Bumped,
      query: "UPDATE bumps SET state = 'pushed' WHERE id = :id AND state = 'pending' RETURNING *",
      id
    )
  )
}

// Pushed, whether this request moved the bump or a retry racing it did (both heard the same stored reply).
fn pushed(commit: View, moved: Move[Bumped]) -> Buf {
  match moved {
    NoRow -> problem(status: 404, reason: "no such pending bump")
    _ -> respond(status: 200)
      |> append(view: "{\"commit\":")
      |> write_json_string(text: commit)
      |> append(view: "}")
  }
}

fn refused(reason: View, moved: Move[Bumped]) -> Buf {
  match moved {
    NoRow -> problem(status: 404, reason: "no such pending bump")
    _ -> problem(status: 409, reason)
  }
}

fn problem(status: Int, reason: View) -> Buf {
  respond(status)
    |> append(view: "{\"error\":")
    |> write_json_string(text: reason)
    |> append(view: "}")
}
