// j1/classify-before.tape: host.mjs callOut before c0f807b, in tape. A transport exception became a refusal.
fn classify(t: Transport) -> Outcome {
  match t {
    Answered(body) -> Committed(body)
    Refused(refusal) -> NotRun(refusal)
    Threw(message) -> NotRun(refusal: Refusal(reason: message))
    OutOfTime -> Unknown(why: "the time budget ran out")
  }
}

fn handle(raw: View) -> Buf {
  match classify(t: read_reply(bytes: raw)) {
    Committed(body) -> append(buf: respond(status: 200), view: body)
    NotRun(refusal) -> append(buf: respond(status: 402), view: reason_of(refusal))
    Unknown(why) -> append(buf: respond(status: 503), view: why)
  }
}
