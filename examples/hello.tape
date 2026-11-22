// hello.tape: greet someone, and count how many times each name has been greeted. A repeated request is
// another greeting, so the count says so (`repeat: True`: rule C54).
schema "CREATE TABLE IF NOT EXISTS greeted(name TEXT PRIMARY KEY, n INTEGER NOT NULL)"

type Count { Count(n: Int) }

fn handle(raw: View, db: Sql) -> Buf {
  match request(raw) {
    Request(method: "GET", path: "/hello/" ++ name) if len(name) > 0 -> greet(
      name,
      seen: sql_first(
        row: Count,
        repeat: True,
        query: "INSERT INTO greeted(name, n) VALUES (:name, 1) ON CONFLICT(name) \
            DO UPDATE SET n = n + 1 RETURNING n",
        name
      )
    )
    _ -> respond(status: 404) |> append(view: "no such route")
  }
}

fn greet(name: View, seen: Option[Count]) -> Buf {
  match seen {
    Some(value: Count(n)) if n == 1 -> respond(status: 200) |> append(view: "Hello, \(name)")
    Some(value: Count(n)) -> respond(status: 200) |> append(view: "Hello again, \(name) #\(n)!")
    None -> respond(status: 500)
  }
}

invariant "a name greeted has been greeted at least once" {
  SELECT name, n FROM greeted WHERE n < 1
}
