// bench-caller.tape: one call per request, to measure the call path. GET /cmd/<n> sends ping with key n (a repeat
// of n is answered from the stored reply); GET /ask sends peek without a key. The caller writes nothing.
type Ping { Ping(n: Int) }
type Pong { Pong(n: Int) }
fn handle(raw: View, db: Sql, pong: Remote) -> Buf {
  match request(raw) {
    Request(method: "GET", path: "/cmd/" ++ decimal(n)) -> answer(reply: call(
      to: pong,
      method: "ping",
      send: Ping(n),
      reply: Pong,
      within: 5000,
      once: Ping(n)
    ))
    Request(method: "GET", path: "/ask") -> answer(
      reply: ask(to: pong, method: "peek", send: Ping(n: 0), reply: Pong, within: 5000)
    )
    _ -> respond(status: 404)
  }
}
fn answer(reply: Result[Pong, CallError]) -> Buf {
  match reply {
    Ok(value: Pong(n)) -> write_int(out: respond(status: 200), value: n)
    Err(error) -> respond(status: 504)
  }
}
