// ratelimit.tape: at most `limit` requests per caller in each ten-second window. Time is a capability, so the
// window a request fell in is in its log, and a replay next week gives the same verdict.

flag limit: Int = 3

schema "CREATE TABLE IF NOT EXISTS hits(who TEXT NOT NULL, slot INTEGER NOT NULL, n INTEGER NOT NULL, PRIMARY KEY(who, slot))"

type Hits { Hits(n: Int) }

fn handle(raw: View, db: Sql, clock: Clock) -> Response {
  match request(raw) {
    Request(method: Post, path: "/check/" ++ who) -> verdict(seen: sql_first(db, row: Hits, query: "INSERT INTO hits(who, slot, n) VALUES (:who, :slot, 1) ON CONFLICT(who, slot) DO UPDATE SET n = n + 1 RETURNING n", who, slot: now(clock) / 10000))
    _ -> append(buf: buf(), view: "{\"error\":\"no such route\"}") |> respond(status: 404)
  }
}

fn verdict(seen: Option[Hits]) -> Response {
  match seen {
    Some(value: Hits(n)) if n <= flags.limit -> push(buf: write_int(out: append(buf: buf(), view: "{\"allowed\":true,\"used\":"), value: n), byte: 125) |> respond(status: 200)
    Some(value: Hits(n)) -> push(buf: write_int(out: append(buf: buf(), view: "{\"allowed\":false,\"used\":"), value: n), byte: 125) |> respond(status: 429)
    None -> append(buf: buf(), view: "{\"error\":\"no row\"}") |> respond(status: 500)
  }
}
