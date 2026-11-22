// j1/transport.tape: the trusted edge, ported from host.mjs callOut. How the result of sending a call is read.
// Only this file can make a Refusal (rule RP: a private type's constructors build values only where it is
// declared), and it makes one only from the callee's own answer, which the callee's facet sends from inside its
// rolled-back transaction. Everyone else can match on a Refusal but not forge one.
private type Refusal { Refusal(reason: View) }

// what came back from the transport
type Transport {
  Answered(body: View)
  Refused(refusal: Refusal)
  Threw(message: View)
  OutOfTime
}

// what the caller may conclude
type Outcome {
  Committed(body: View)
  NotRun(refusal: Refusal)
  Unknown(why: View)
}

// the callee's reply as its facet sends it: first byte 0 for Ok, 1 for a refusal (its transaction rolled back)
fn read_reply(bytes: View) -> Transport {
  match {
    len(bytes) == 0 -> Threw(message: "the connection closed before a reply")
    bytes[0] == 1 -> Refused(refusal: Refusal(reason: slice(v: bytes, from: 1, to: len(bytes))))
    else -> Answered(body: slice(v: bytes, from: 1, to: len(bytes)))
  }
}

fn reason_of(refusal: Refusal) -> View {
  match refusal {
    Refusal(reason) -> reason
  }
}
