// Calls another program's woken: refused, because only that program's timers run it (VERIFY check 17).
type Got { Got(id: Int) }
fn handle(raw: View, fulfill: Remote) -> Buf {
  match call(
    to: fulfill,
    method: "woken",
    send: Wake(key: 1),
    reply: Got,
    within: 2000,
    once: raw
  ) {
    Ok(value) -> respond(status: 200)
    Err(error: Rejected(reason)) -> respond(status: 403) |> append(view: reason)
    Err(error) -> respond(status: 500)
  }
}
