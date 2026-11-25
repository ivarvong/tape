// Machines: a version without a machine. It pays, and it voids a paid row.
schema "CREATE TABLE IF NOT EXISTS s(id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, state \
    TEXT NOT NULL DEFAULT 'pending')"

type Text { Text(text: View) }

fn handle(raw: View, db: Sql) -> Response {
  match request(raw) {
    Request(method: Post, path: "/new/" ++ key) -> done(
      n: sql_exec(db, query: "INSERT INTO s(key) VALUES (:key) ON CONFLICT(key) DO NOTHING", key)
    )
    Request(
      method: Post,
      path: "/pay/" ++ key
    ) -> done(n: sql_exec(
      db,
      query: "UPDATE s SET state = 'paid' WHERE key = :key AND state = 'pending'",
      key
    ))
    Request(
      method: Post,
      path: "/void/" ++ key
    ) -> done(n: sql_exec(
      db,
      query: "UPDATE s SET state = 'void' WHERE key = :key AND state = 'paid'",
      key
    ))
    Request(method: Get, path: "/triggers") -> buf()
      |> append(view: sql_first(
        db,
        row: Text,
        query: "SELECT coalesce(group_concat(sql, ' ; '), '') AS text FROM sqlite_master \
            WHERE type = 'trigger'"
      ) |> shown)
      |> respond(status: 200)
    _ -> empty(status: 404)
  }
}

fn shown(found: Option[Text]) -> View {
  match found {
    Some(value: Text(text)) -> text
    None -> ""
  }
}

fn done(n: Int) -> Response {
  buf() |> write_int(value: n) |> respond(status: 200)
}
