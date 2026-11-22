migration 1 "notes" {
  CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT NOT NULL)
}
type Count { Count(n: Int) }
fn handle(raw: View, db: Sql) -> Buf {
  match request(raw) {
    Request(method: "POST", path: "/notes", body) -> count(found: sql_first(db, row: Count, query: "INSERT INTO notes(body) VALUES (:body) RETURNING id AS n", body))
    Request(method: "GET", path: "/notes") -> count(found: sql_first(db, row: Count, query: "SELECT count(*) AS n FROM notes"))
    _ -> append(buf: respond(status: 404), view: "no such route")
  }
}
fn count(found: Option[Count]) -> Buf {
  match found {
    Some(value: Count(n)) -> write_int(out: respond(status: 200), value: n)
    None -> respond(status: 500)
  }
}
