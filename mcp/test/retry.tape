// retry.tape: a program for mcp/test.ts that sends a charge again from a timer when the first send got no answer,
// with the same once key, as a program must when the outcome is unknown. Scripted ["timeout", {"payment": 9}], the
// request answers 202 and the timer's run gets the payment.
type Charge { Charge(order: Int) }
type Charged { Charged(payment: Int) }

fn handle(raw: View, payments: Remote, timer: Timer) -> Buf {
  match request(raw) {
    Request(method: "POST", path: "/pay/" ++ decimal(order)) -> paid(order, reply: charged(order))
    _ -> respond(status: 404)
  }
}

export fn woken(payments: Remote, timer: Timer, message: Wake) -> Result[Charged, View] {
  let Wake(key) = message
  match charged(order: key) {
    Ok(value) -> Ok(value)
    Err(error: Timeout) -> Err(error: "no answer again")
    Err(error) -> Err(error: "refused or unreachable")
  }
}

fn charged(order: Int) -> Result[Charged, CallError] {
  call(
    to: payments,
    method: "charge",
    send: Charge(order),
    reply: Charged,
    within: 1000,
    once: Charge(order)
  )
}

fn paid(order: Int, reply: Result[Charged, CallError]) -> Buf {
  match reply {
    Ok(value: Charged(payment)) -> respond(status: 201) |> write_int(value: payment)
    Err(error: Timeout) -> {
      do wake(after: 1000, key: order)
      respond(status: 202)
    }
    Err(error) -> respond(status: 503)
  }
}
