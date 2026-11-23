// Machines: a version without a machine. It pays, and it voids a paid row.
schema "CREATE TABLE IF NOT EXISTS s(id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, state \
    TEXT NOT NULL DEFAULT 'pending')"

type Text { Text(text: View) }

fn handle(raw: View, db: Sql) -> Buf {
  match request(raw) {
    Request(method: "POST", path: "/new/" ++ key) -> done(
      n: sql_exec(db, query: "INSERT INTO s(key) VALUES (:key) ON CONFLICT(key) DO NOTHING", key)
    )
    Request(
      method: "POST",
      path: "/pay/" ++ key
    ) -> done(n: sql_exec(
      db,
      query: "UPDATE s SET state = 'paid' WHERE key = :key AND state = 'pending'",
      key
    ))
    Request(
      method: "POST",
      path: "/void/" ++ key
    ) -> done(n: sql_exec(
      db,
      query: "UPDATE s SET state = 'void' WHERE key = :key AND state = 'paid'",
      key
    ))
    Request(method: "GET", path: "/triggers") -> respond(status: 200)
      |> append(view: sql_first(
      db,
      row: Text,
      query: "SELECT coalesce(group_concat(sql, ' ; '), '') AS text FROM sqlite_master \
          WHERE type = 'trigger'"
    ) |> shown)
    _ -> respond(status: 404)
  }
}

fn shown(found: Option[Text]) -> View {
  match found {
    Some(value: Text(text)) -> text
    None -> ""
  }
}

fn done(n: Int) -> Buf {
  respond(status: 200) |> write_int(value: n)
}
