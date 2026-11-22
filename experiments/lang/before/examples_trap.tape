// trap.tape: writes a row, then divides by zero. Tests that a real trap rolls the request back.
schema "CREATE TABLE IF NOT EXISTS todos(id INTEGER PRIMARY KEY, title TEXT NOT NULL, done INTEGER NOT NULL)"

fn handle(request: View, db: Sql) -> Buf {
  let written = sql_exec(db, query: "INSERT INTO todos(title, done) VALUES ('never stored', 0)")
  push(buf: buf(), byte: 1 / (written - 1))
}
