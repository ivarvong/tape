// A page and an admin route: the operator may POST /reset, anyone may GET / and POST /visit.
migration 1 "visits" {
  CREATE TABLE visits(id INTEGER PRIMARY KEY, who TEXT NOT NULL)
}

type Count { Count(n: Int) }

fn handle(raw: View, db: Sql) -> Buf {
  match request(raw) {
    Request(method: "GET", path: "/", caller) -> page(
      caller,
      found: sql_first(row: Count, query: "SELECT count(*) AS n FROM visits")
    )
    Request(method: "GET", path: "/n.json") -> counted(
      n: sql_first(row: Count, query: "SELECT count(*) AS n FROM visits")
    )
    Request(method: "POST", path: "/visit", body) -> {
      let _ = sql_exec(repeat: True, query: "INSERT INTO visits(who) VALUES (:body)", body)
      visited()
    }
    Request(method: "POST", path: "/reset", caller: Operator) -> append(
      buf: respond(status: 200),
      view: "reset"
    )
    Request(method: "POST", path: "/reset") -> append(
      buf: respond(status: 403),
      view: "the operator's"
    )
    _ -> append(buf: respond(status: 404), view: "no such page")
  }
}

fn page(caller: Caller, found: Option[Count]) -> Buf {
  let Some(value: Count(n)) = found else -> respond(status: 500)
  respond_as(status: 200, content: Html) |> append(view: "<p>\(who(caller)) \(n)</p>")
}

fn counted(n: Option[Count]) -> Buf {
  let Some(value: c) = n else -> respond(status: 500)
  write_json(out: respond_as(status: 200, content: Json), value: c)
}

fn visited() -> Buf {
  append(buf: respond_as(status: 201, content: Text), view: "ok")
}

fn who(caller: Caller) -> View {
  match caller {
    Operator -> "operator"
    Anyone -> "anyone"
  }
}
