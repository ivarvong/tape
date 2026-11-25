// trap.tape: writes a row, then divides by zero. Tests that a real trap rolls the request back. The row names its
// key (id 1), so run twice it could not make a second row even if the first had been kept (rules.ts, C55).
schema "CREATE TABLE IF NOT EXISTS todos(id INTEGER PRIMARY KEY, title TEXT NOT NULL, done \
    INTEGER NOT NULL)"

fn handle(request: View, db: Sql) -> Response {
  divided(request, db) |> respond(status: 200)
}

fn divided(request: View, db: Sql) -> Buf {
  let written = sql_exec(query: "INSERT INTO todos(id, title, done) VALUES (1, 'never stored', 0)")
  push(buf: buf(), byte: 1 / (written - 1))
}
