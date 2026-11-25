// convert.tape: a Remote tool. Its one capability is `fx: Remote`, the program named fx in the same account; the
// runtime accepts the tool only if the account's policy lists fx. It asks fx for a rate (a read, so `ask`, with
// no key) and converts.

type Currency = View where len(self) == 3
type Cents = Int where self >= 0 and self <= 100000000000
type Amount { Amount(usd_cents: Cents, to: Currency) }
type Converted { Converted(amount: Int, currency: View, per_hundred: Int) }
type Pair { Pair(to: View) }
type Rate { Rate(per_hundred: Int) }
// what fx refuses with: the type fx.tape declares
type RateError { NoRate }
// why a conversion is refused: fx has no rate for the currency, or did not answer
type ConvertError {
  Unpriced(currency: View)
  NoAnswer
}

// Convert US cents to another currency's smallest unit at fx's current rate (rounded down).
export fn convert(fx: Remote, message: Amount) -> Result[Converted, ConvertError] {
  converted(
    message,
    reply: ask(
      to: fx,
      method: "rate",
      send: Pair(to: message.to),
      reply: Rate,
      error: RateError,
      within: 2000
    )
  )
}

fn converted(
  message: Amount,
  reply: Result[Rate, CallError[RateError]]
) -> Result[Converted, ConvertError] {
  match reply {
    Ok(value: Rate(per_hundred)) -> Ok(value: Converted(
      amount: message.usd_cents * per_hundred / 100,
      currency: message.to,
      per_hundred
    ))
    Err(error: Rejected(reason: NoRate)) -> Err(error: Unpriced(currency: message.to))
    Err(error) -> Err(error: NoAnswer)
  }
}
