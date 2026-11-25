migration 1 "notes" {
  CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT NOT NULL)
}
migration 2 "pins" {
  ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX notes_pinned ON notes(pinned)
}
type Count { Count(n: Int) }
fn handle(raw: View, db: Sql) -> Response {
  match request(raw) {
    Request(method: Post, path: "/notes/" ++ decimal(id), body) -> kept(
      db,
      id,
      found: sql_first(
        db,
        row: Count,
        query: "INSERT INTO notes(id, body) VALUES (:id, :body) ON CONFLICT(id) \
            DO NOTHING RETURNING id AS n",
        id,
        body
      )
    )
    Request(method: Post, path: "/notes") -> append(
      buf: buf(),
      view: "POST /notes/<id>: the client names each note, so a retry cannot make a second"
    )
      |> respond(status: 428)
    Request(method: Get, path: "/notes") -> count(
      found: sql_first(db, row: Count, query: "SELECT count(*) AS n FROM notes")
    )
    Request(method: Get, path: "/unpinned") -> count(
      found: sql_first(db, row: Count, query: "SELECT count(*) AS n FROM notes WHERE pinned = 0")
    )
    _ -> append(buf: buf(), view: "no such route") |> respond(status: 404)
  }
}
// the note this request wrote, or the one an earlier request with the same id wrote
fn kept(db: Sql, id: Int, found: Option[Count]) -> Response {
  match found {
    Some(value) -> count(found)
    None -> count(
      found: sql_first(db, row: Count, query: "SELECT id AS n FROM notes WHERE id = :id", id)
    )
  }
}
fn count(found: Option[Count]) -> Response {
  match found {
    Some(value: Count(n)) -> write_int(out: buf(), value: n) |> respond(status: 200)
    None -> empty(status: 500)
  }
}
