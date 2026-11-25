// Calls another program's woken: refused, because only that program's timers run it (VERIFY check 17). The service
// will not make the call, so it is a Skew: nothing ran, and the same call gets the same answer.
type Got { Got(id: Int) }
type Refusal { Refused(reason: View) }
fn handle(raw: View, fulfill: Remote) -> Response {
  match call(
    to: fulfill,
    method: "woken",
    send: Wake(key: 1),
    reply: Got,
    error: Refusal,
    within: 2000,
    once: raw
  ) {
    Ok(value) -> empty(status: 200)
    Err(error: Skew(reason)) -> buf() |> append(view: reason) |> respond(status: 403)
    Err(error) -> empty(status: 500)
  }
}
