// hello.tape: greet someone, and count how many times each name has been greeted.
schema "CREATE TABLE IF NOT EXISTS greeted(name TEXT PRIMARY KEY, n INTEGER NOT NULL)"

type Count { Count(n: Int) }

fn handle(raw: View, db: Sql) -> Response {
  match request(raw) {
    Request(method: Get, path: "/hello/" ++ name) if len(name) > 0 -> greet(name, seen: sql_first(db, row: Count, query: "INSERT INTO greeted(name, n) VALUES (:name, 1) ON CONFLICT(name) DO UPDATE SET n = n + 1 RETURNING n", name))
    _ -> buf() |> append(view: "no such route") |> respond(status: 404)
  }
}

fn greet(name: View, seen: Option[Count]) -> Response {
  match seen {
    Some(value: Count(n)) if n == 1 -> buf() |> append(view: "Hello, ") |> append(view: name) |> respond(status: 200)
    Some(value: Count(n)) -> buf() |> append(view: "Hello again, ") |> append(view: name) |> append(view: " #") |> write_int(value: n) |> push(byte: 33) |> respond(status: 200)
    None -> empty(status: 500)
  }
}
