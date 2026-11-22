// stamp.tape: asks for the Clock, which the account does not grant.

type Ask { Ask(label: View) }
type Stamped { Stamped(label: View, at_ms: Int) }

// Stamp a label with the time.
export fn stamp(clock: Clock, message: Ask) -> Result[Stamped, View] {
  Ok(value: Stamped(label: message.label, at_ms: now(clock)))
}
