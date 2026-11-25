// remote.tape: a program for mcp/test.ts that calls another, so run's scripted `remotes` can answer it: each
// outcome of the call is its own answer (201 with the reply's field, 402 with the refusal's reason, 409 with a
// skew's, 504, 503).
type Charge { Charge(order: Int) }
type Charged { Charged(payment: Int) }

fn handle(raw: View, payments: Remote) -> Response {
  match request(raw) {
    Request(method: Post, path: "/pay/" ++ decimal(order)) -> paid(reply: call(
      to: payments,
      method: "charge",
      send: Charge(order),
      reply: Charged,
      within: 1000,
      once: Charge(order)
    ))
    _ -> empty(status: 404)
  }
}

fn paid(reply: Result[Charged, CallError]) -> Response {
  match reply {
    Ok(value: Charged(payment)) -> buf() |> write_int(value: payment) |> respond(status: 201)
    Err(error: Rejected(reason)) -> buf() |> append(view: reason) |> respond(status: 402)
    Err(error: Skew(reason)) -> buf() |> append(view: reason) |> respond(status: 409)
    Err(error: Timeout) -> empty(status: 504)
    Err(error) -> empty(status: 503)
  }
}
