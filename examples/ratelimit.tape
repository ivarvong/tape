// ratelimit.tape: at most `limit` requests per caller in each ten-second window. Time is a capability, so the
// window a request fell in is in its log, and a replay next week gives the same verdict. Every attempt counts
// against the limit, a retry included: that is what a limit is for (`repeat: True`: rule C54).

flag limit: Int = 3

schema "CREATE TABLE IF NOT EXISTS hits(who TEXT NOT NULL, slot INTEGER NOT NULL, n \
    INTEGER NOT NULL, PRIMARY KEY(who, slot))"

type Hits { Hits(n: Int) }

fn handle(raw: View, db: Sql, clock: Clock) -> Buf {
  match request(raw) {
    Request(method: "POST", path: "/check/" ++ who) -> verdict(seen: sql_first(
      row: Hits,
      repeat: True,
      query: "INSERT INTO hits(who, slot, n) VALUES (:who, :slot, 1) ON CONFLICT(who, slot) \
          DO UPDATE SET n = n + 1 RETURNING n",
      who,
      slot: now(clock) / 10000
    ))
    _ -> respond(status: 404) |> append(view: "{\"error\":\"no such route\"}")
  }
}

fn verdict(seen: Option[Hits]) -> Buf {
  match seen {
    Some(value: Hits(n)) if n <= flags.limit -> respond(status: 200)
      |> append(view: "{\"allowed\":true,\"used\":\(n)}")
    Some(value: Hits(n)) -> respond(status: 429)
      |> append(view: "{\"allowed\":false,\"used\":\(n)}")
    None -> respond(status: 500) |> append(view: "{\"error\":\"no row\"}")
  }
}

invariant "a slot with a row has at least one hit" {
  SELECT who, slot, n FROM hits WHERE n < 1
}
