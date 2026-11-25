// A page and an admin route: the operator may POST /reset, anyone may GET / and POST /visit.
migration 1 "visits" {
  CREATE TABLE visits(id INTEGER PRIMARY KEY, who TEXT NOT NULL)
}

type Count { Count(n: Int) }

fn handle(raw: View, db: Sql) -> Response {
  match request(raw) {
    Request(method: Get, path: "/", caller) -> page(
      caller,
      found: sql_first(row: Count, query: "SELECT count(*) AS n FROM visits")
    )
    Request(method: Get, path: "/n.json") -> counted(
      n: sql_first(row: Count, query: "SELECT count(*) AS n FROM visits")
    )
    Request(method: Post, path: "/visit", body) -> {
      let _ = sql_exec(repeat: True, query: "INSERT INTO visits(who) VALUES (:body)", body)
      visited()
    }
    Request(method: Post, path: "/reset", caller: Operator) -> append(buf: buf(), view: "reset")
      |> respond(status: 200)
    Request(method: Post, path: "/reset") -> append(buf: buf(), view: "the operator's")
      |> respond(status: 403)
    _ -> append(buf: buf(), view: "no such page") |> respond(status: 404)
  }
}

fn page(caller: Caller, found: Option[Count]) -> Response {
  let Some(value: Count(n)) = found else -> empty(status: 500)
  buf() |> append(view: "<p>\(who(caller)) \(n)</p>") |> respond_as(status: 200, content: Html)
}

fn counted(n: Option[Count]) -> Response {
  let Some(value: c) = n else -> empty(status: 500)
  write_json(out: buf(), value: c) |> respond_as(status: 200, content: Json)
}

fn visited() -> Response {
  append(buf: buf(), view: "ok") |> respond_as(status: 201, content: Text)
}

fn who(caller: Caller) -> View {
  match caller {
    Operator -> "operator"
    Anyone -> "anyone"
  }
}
