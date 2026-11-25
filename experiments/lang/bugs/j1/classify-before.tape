// j1/classify-before.tape: host.mjs callOut before c0f807b, in tape. A transport exception became a refusal.
fn classify(t: Transport) -> Outcome {
  match t {
    Answered(body) -> Committed(body)
    Refused(refusal) -> NotRun(refusal)
    Threw(message) -> NotRun(refusal: Refusal(reason: message))
    OutOfTime -> Unknown(why: "the time budget ran out")
  }
}

fn handle(raw: View) -> Response {
  match classify(t: read_reply(bytes: raw)) {
    Committed(body) -> append(buf: buf(), view: body) |> respond(status: 200)
    NotRun(refusal) -> append(buf: buf(), view: reason_of(refusal)) |> respond(status: 402)
    Unknown(why) -> append(buf: buf(), view: why) |> respond(status: 503)
  }
}
