migration 1 "notes" {
  CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT NOT NULL)
}
migration 2 "pins" {
  ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX notes_pinned ON notes(pinned)
}
migration 3 "one note per body" {
  CREATE UNIQUE INDEX notes_body ON notes(body)
}
type Count { Count(n: Int) }
fn handle(raw: View, db: Sql) -> Response {
  match request(raw) {
    Request(method: Post, path: "/notes", body) -> count(found: sql_first(
      db,
      row: Count,
      query: "INSERT INTO notes(body) VALUES (:body) RETURNING id AS n",
      body
    ))
    Request(method: Get, path: "/notes") -> count(
      found: sql_first(db, row: Count, query: "SELECT count(*) AS n FROM notes")
    )
    Request(method: Get, path: "/unpinned") -> count(
      found: sql_first(db, row: Count, query: "SELECT count(*) AS n FROM notes WHERE pinned = 0")
    )
    _ -> append(buf: buf(), view: "no such route") |> respond(status: 404)
  }
}
fn count(found: Option[Count]) -> Response {
  match found {
    Some(value: Count(n)) -> write_int(out: buf(), value: n) |> respond(status: 200)
    None -> empty(status: 500)
  }
}
