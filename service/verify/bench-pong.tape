// bench-pong.tape: the callee for measuring calls. `ping` writes one row (a command); `peek` only reads (a query).
schema "CREATE TABLE IF NOT EXISTS pings(n INTEGER PRIMARY KEY)"
type Ping { Ping(n: Int) }
type Pong { Pong(n: Int) }
type Count { Count(n: Int) }
export fn ping(db: Sql, message: Ping) -> Result[Pong, View] {
  ponged(found: sql_first(
    db,
    row: Pong,
    query: "INSERT INTO pings(n) VALUES (:n) RETURNING n",
    n: message.n
  ))
}
fn ponged(found: Option[Pong]) -> Result[Pong, View] {
  match found {
    Some(value) -> Ok(value)
    None -> Err(error: "no row")
  }
}
export fn peek(db: Sql, message: Ping) -> Result[Pong, View] {
  counted(found: sql_first(db, row: Count, query: "SELECT count(*) AS n FROM pings"))
}
fn counted(found: Option[Count]) -> Result[Pong, View] {
  match found {
    Some(value: Count(n)) -> Ok(value: Pong(n))
    None -> Err(error: "no count")
  }
}
