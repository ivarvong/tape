// ratelimit.tape: at most `limit` requests per caller in each ten-second window. Time is a capability, so the
// window a request fell in is in its log, and a replay next week gives the same verdict.

flag limit: Int = 3

schema "CREATE TABLE IF NOT EXISTS hits(who TEXT NOT NULL, slot INTEGER NOT NULL, n INTEGER NOT NULL, PRIMARY KEY(who, slot))"

type Hits { Hits(n: Int) }

fn handle(raw: View, db: Sql, clock: Clock) -> Buf {
  match request(raw) {
    Request(method: "POST", path: "/check/" ++ who) -> verdict(seen: sql_first(db, row: Hits, query: "INSERT INTO hits(who, slot, n) VALUES (:who, :slot, 1) ON CONFLICT(who, slot) DO UPDATE SET n = n + 1 RETURNING n", who, slot: now(clock) / 10000))
    _ -> append(buf: respond(status: 404), view: "{\"error\":\"no such route\"}")
  }
}

fn verdict(seen: Option[Hits]) -> Buf {
  match seen {
    Some(value: Hits(n)) if n <= flags.limit -> push(buf: write_int(out: append(buf: respond(status: 200), view: "{\"allowed\":true,\"used\":"), value: n), byte: 125)
    Some(value: Hits(n)) -> push(buf: write_int(out: append(buf: respond(status: 429), view: "{\"allowed\":false,\"used\":"), value: n), byte: 125)
    None -> append(buf: respond(status: 500), view: "{\"error\":\"no row\"}")
  }
}
