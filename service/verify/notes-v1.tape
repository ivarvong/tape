migration 1 "notes" {
  CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT NOT NULL)
}
type Count { Count(n: Int) }
fn handle(raw: View, db: Sql) -> Buf {
  match request(raw) {
    Request(method: "POST", path: "/notes/" ++ decimal(id), body) -> kept(
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
    Request(method: "POST", path: "/notes") -> append(
      buf: respond(status: 428),
      view: "POST /notes/<id>: the client names each note, so a retry cannot make a second"
    )
    Request(method: "GET", path: "/notes") -> count(
      found: sql_first(db, row: Count, query: "SELECT count(*) AS n FROM notes")
    )
    _ -> append(buf: respond(status: 404), view: "no such route")
  }
}
// the note this request wrote, or the one an earlier request with the same id wrote
fn kept(db: Sql, id: Int, found: Option[Count]) -> Buf {
  match found {
    Some(value) -> count(found)
    None -> count(
      found: sql_first(db, row: Count, query: "SELECT id AS n FROM notes WHERE id = :id", id)
    )
  }
}
fn count(found: Option[Count]) -> Buf {
  match found {
    Some(value: Count(n)) -> write_int(out: respond(status: 200), value: n)
    None -> respond(status: 500)
  }
}
