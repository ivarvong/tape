// Calls another program's woken: refused, because only that program's timers run it (VERIFY check 17).
type Got { Got(id: Int) }
fn handle(raw: View, fulfill: Remote) -> Response {
  match call(
    to: fulfill,
    method: "woken",
    send: Wake(key: 1),
    reply: Got,
    within: 2000,
    once: raw
  ) {
    Ok(value) -> empty(status: 200)
    Err(error: Rejected(reason)) -> buf() |> append(view: reason) |> respond(status: 403)
    Err(error) -> empty(status: 500)
  }
}
