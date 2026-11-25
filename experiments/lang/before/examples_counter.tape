// counter.tape: a counter per name. The step is a feature flag: reading it is one load, and the value each
// request ran under is the first line of its log.

flag step: Int = 1

schema "CREATE TABLE IF NOT EXISTS counters(name TEXT PRIMARY KEY, n INTEGER NOT NULL)"

type Count { Count(n: Int) }

fn handle(raw: View, db: Sql) -> Response {
  match request(raw) {
    Request(method: Post, path: "/" ++ name) -> show(found: sql_first(db, row: Count, query: "INSERT INTO counters(name, n) VALUES (:name, :step) ON CONFLICT(name) DO UPDATE SET n = n + :step RETURNING n", name, step: flags.step))
    Request(method: Get, path: "/" ++ name) -> show(found: sql_first(db, row: Count, query: "SELECT n FROM counters WHERE name = :name", name))
    _ -> append(buf: buf(), view: "{\"error\":\"method_not_allowed\"}") |> respond(status: 405)
  }
}

fn show(found: Option[Count]) -> Response {
  match found {
    Some(value) -> push(buf: write_int(out: append(buf: buf(), view: "{\"count\":"), value: value.n), byte: 125) |> respond(status: 200)
    None -> append(buf: buf(), view: "{\"count\":0}") |> respond(status: 200)
  }
}
