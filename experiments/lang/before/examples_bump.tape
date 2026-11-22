// bump.tape: change the version in a git repository. The repository is a capability with an interface; the host
// binds it to one repository with ply (adapters/ply.mjs), so no URL or token appears here or in the log.
// The intent is written down before the push, with the head it expects and the time to stamp, so the same push
// can be sent again after a timeout and lands exactly once.

interface Git {
  read head(Ref) -> Head
  read read_file(ReadFile) -> File
  write edit_file(Edit) -> Pushed
}

type Ref { Ref(ref: View) }
type Head { Head(commit: View) }
type ReadFile { ReadFile(ref: View, path: View) }
type File { File(content: View, size: Int) }
type Edit { Edit(ref: View, path: View, find: View, replace: View, message: View, time: Int, expected: View) }
type Pushed { Pushed(commit: View, noop: Bool) }

schema "CREATE TABLE IF NOT EXISTS bumps(id INTEGER PRIMARY KEY, find TEXT NOT NULL, replace TEXT NOT NULL, expected TEXT NOT NULL, time INTEGER NOT NULL, state TEXT NOT NULL)"

type Bump { Bump(from: View, to: View) }
type Intent { Intent(id: Int, find: View, replace: View, expected: View, time: Int) }

fn handle(raw: View, db: Sql, clock: Clock, repo: Git) -> Buf {
  match request(raw) {
    Request(method: "GET", path: "/version") -> version(file: repo.read_file(send: ReadFile(ref: "main", path: "VERSION"), within: 2000))
    Request(method: "POST", path: "/bump", body) -> start(db, clock, repo, bump: decode(json: body, as: Bump))
    Request(method: "POST", path: "/retry/" ++ decimal(id)) -> send_edit(db, repo, intent: sql_first(db, row: Intent, query: "SELECT id, find, replace, expected, time FROM bumps WHERE id = :id AND state = 'pending'", id))
    _ -> problem(status: 404, reason: "no such route")
  }
}

fn version(file: Result[File, CallError]) -> Buf {
  match file {
    Ok(value: File(content)) -> append(buf: write_json_string(out: append(buf: respond(status: 200), view: "{\"version\":"), text: until(v: content, byte: 10)), view: "}")
    Err(error: Rejected(reason)) -> problem(status: 502, reason)
    _ -> problem(status: 504, reason: "the repository did not answer")
  }
}

fn start(db: Sql, clock: Clock, repo: Git, bump: Result[Bump, View]) -> Buf {
  match bump {
    Ok(value: Bump(from, to)) -> planned(db, clock, repo, from, to, head: repo.head(send: Ref(ref: "main"), within: 2000))
    Err(error) -> problem(status: 400, reason: error)
  }
}

// Write the intent down first: what to change, from which head, stamped with which time.
fn planned(db: Sql, clock: Clock, repo: Git, from: View, to: View, head: Result[Head, CallError]) -> Buf {
  match head {
    Ok(value: Head(commit)) -> send_edit(db, repo, intent: sql_first(db, row: Intent, query: "INSERT INTO bumps(find, replace, expected, time, state) VALUES (:from, :to, :commit, :time, 'pending') RETURNING id, find, replace, expected, time", from, to, commit, time: now(clock) / 1000))
    _ -> problem(status: 502, reason: "could not read the branch")
  }
}

fn send_edit(db: Sql, repo: Git, intent: Option[Intent]) -> Buf {
  match intent {
    Some(value: Intent(id, find, replace, expected, time)) -> settle(db, id, reply: repo.edit_file(send: Edit(ref: "main", path: "VERSION", find, replace, message: "Bump version", time, expected), within: 3000, once: id))
    None -> problem(status: 404, reason: "no such pending bump")
  }
}

fn settle(db: Sql, id: Int, reply: Result[Pushed, CallError]) -> Buf {
  match reply {
    Ok(value: Pushed(commit)) -> pushed(commit, count: sql_exec(db, query: "UPDATE bumps SET state = 'pushed' WHERE id = :id", id))
    Err(error: Rejected(reason)) -> refused(reason, count: sql_exec(db, query: "UPDATE bumps SET state = 'refused' WHERE id = :id", id))
    Err(error: Timeout) -> problem(status: 504, reason: "the push did not finish in time; the bump stays pending")
    _ -> problem(status: 502, reason: "the repository is unavailable; the bump stays pending")
  }
}

fn pushed(commit: View, count: Int) -> Buf {
  append(buf: write_json_string(out: append(buf: respond(status: 200), view: "{\"commit\":"), text: commit), view: "}")
}

fn refused(reason: View, count: Int) -> Buf {
  problem(status: 409, reason)
}

fn problem(status: Int, reason: View) -> Buf {
  append(buf: write_json_string(out: append(buf: respond(status), view: "{\"error\":"), text: reason), view: "}")
}
