// clock.tape: a program for mcp/test.ts: the run's own clock (at_ms), its timers, and a query that returns many rows.
migration 1 "hits" {
  CREATE TABLE hits(id INTEGER PRIMARY KEY, at INTEGER NOT NULL);
  CREATE TABLE fired(key INTEGER PRIMARY KEY, at INTEGER NOT NULL)
}

type Hit { Hit(id: Int, at: Int) }
type Fired { Fired(key: Int, at: Int) }
type Count { Count(n: Int) }

fn handle(raw: View, db: Sql, clock: Clock, timer: Timer) -> Response {
  match request(raw) {
    Request(method: Post, path: "/hit") -> counted(
      n: sql_exec(query: "INSERT INTO hits(at) VALUES (:now)", now: now(), repeat: True)
    )
    Request(method: Get, path: "/window") -> in_window(since: now() - 60000)
    Request(method: Post, path: "/later/" ++ decimal(key)) -> later(key)
    Request(method: Get, path: "/fired") -> buf()
      |> write_rows(rows: sql_all(row: Fired, query: "SELECT key, at FROM fired ORDER BY key"))
      |> respond_as(status: 200, content: Json)
    Request(method: Post, path: "/rows/" ++ decimal(n)) -> counted(n: added(n))
    Request(method: Get, path: "/rows") -> buf()
      |> write_rows(rows: sql_all(row: Hit, query: "SELECT id, at FROM hits ORDER BY id"))
      |> respond_as(status: 200, content: Json)
    _ -> empty(status: 404)
  }
}

export fn woken(db: Sql, clock: Clock, message: Wake) -> Result[Count, View] {
  let Wake(key) = message
  Ok(value: Count(n: sql_exec(
    query: "INSERT INTO fired(key, at) VALUES (:key, :now) ON CONFLICT(key) DO NOTHING",
    key,
    now: now()
  )))
}

// the hits within the last 60 s: at > since
fn in_window(since: Int) -> Response {
  let Some(value: Count(n)) = sql_first(
    row: Count,
    query: "SELECT count(*) AS n FROM hits WHERE at > :since",
    since
  ) else -> empty(status: 500)
  counted(n)
}

fn later(key: Int) -> Response {
  do wake(after: 5000, key)
  empty(status: 202)
}

fn added(n: Int) -> Int {
  match {
    n <= 0 -> 0
    else -> sql_exec(query: "INSERT INTO hits(at) VALUES (:n)", n, repeat: True) + added(n: n - 1)
  }
}

fn counted(n: Int) -> Response {
  json(status: 200, value: Count(n))
}
