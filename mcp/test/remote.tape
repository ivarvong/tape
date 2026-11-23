// remote.tape: a program for mcp/test.ts that calls another, so run's scripted `remotes` can answer it: each
// outcome of the call is its own answer (201 with the reply's field, 402 with the refusal's reason, 504, 503).
type Charge { Charge(order: Int) }
type Charged { Charged(payment: Int) }

fn handle(raw: View, payments: Remote) -> Buf {
  match request(raw) {
    Request(method: "POST", path: "/pay/" ++ decimal(order)) -> paid(reply: call(
      to: payments,
      method: "charge",
      send: Charge(order),
      reply: Charged,
      within: 1000,
      once: Charge(order)
    ))
    _ -> respond(status: 404)
  }
}

fn paid(reply: Result[Charged, CallError]) -> Buf {
  match reply {
    Ok(value: Charged(payment)) -> respond(status: 201) |> write_int(value: payment)
    Err(error: Rejected(reason)) -> respond(status: 402) |> append(view: reason)
    Err(error: Timeout) -> respond(status: 504)
    Err(error) -> respond(status: 503)
  }
}
