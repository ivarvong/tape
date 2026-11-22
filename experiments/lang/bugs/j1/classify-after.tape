// j1/classify-after.tape: as fixed in c0f807b. No reply is an unknown outcome; only the callee refuses.
fn classify(t: Transport) -> Outcome {
  match t {
    Answered(body) -> Committed(body)
    Refused(refusal) -> NotRun(refusal)
    Threw(message) -> Unknown(why: message)
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
