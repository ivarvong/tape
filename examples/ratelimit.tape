// ratelimit.tape: at most `limit` requests per caller in each ten-second window. Time is a capability, so the
// window a request fell in is in its log, and a replay next week gives the same verdict. Every attempt counts
// against the limit, a retry included: that is what a limit is for (`repeat: True`: rule C54).

flag limit: Int = 3

schema "CREATE TABLE IF NOT EXISTS hits(who TEXT NOT NULL, slot INTEGER NOT NULL, n \
    INTEGER NOT NULL, PRIMARY KEY(who, slot))"

type Hits { Hits(n: Int) }

fn handle(raw: View, db: Sql, clock: Clock) -> Response {
  match request(raw) {
    Request(method: Post, path: "/check/" ++ who) -> verdict(seen: sql_first(
      row: Hits,
      repeat: True,
      query: "INSERT INTO hits(who, slot, n) VALUES (:who, :slot, 1) ON CONFLICT(who, slot) \
          DO UPDATE SET n = n + 1 RETURNING n",
      who,
      slot: now(clock) / 10000
    ))
    _ -> buf() |> append(view: "{\"error\":\"no such route\"}") |> respond(status: 404)
  }
}

fn verdict(seen: Option[Hits]) -> Response {
  match seen {
    Some(value: Hits(n)) if n <= flags.limit -> buf()
      |> append(view: "{\"allowed\":true,\"used\":\(n)}")
      |> respond(status: 200)
    Some(value: Hits(n)) -> buf()
      |> append(view: "{\"allowed\":false,\"used\":\(n)}")
      |> respond(status: 429)
    None -> buf() |> append(view: "{\"error\":\"no row\"}") |> respond(status: 500)
  }
}

invariant "a slot with a row has at least one hit" {
  SELECT who, slot, n FROM hits WHERE n < 1
}
