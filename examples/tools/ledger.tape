// ledger.tape: asks for a capability the account does not grant. It names `payments: Remote`, and the policy
// allows Remote fx only, so the upload is refused before anything is stored.
//
// Were it granted, a charge that timed out may have happened: it answers that the outcome is unknown and that the
// same key is the way to find out, never "not charged" (an earlier version said so, and was wrong to). The
// once key is the caller's key for this payment; it was the amount, so two payments of one amount were one charge.

type Pay { Pay(key: Int, card: View, amount: Int) }
type Charge { Charge(card: View, amount: Int) }
type Payment { Payment(key: Int) }
type Charged { Charged(balance: Int) }
type Done { Done(balance: Int) }

// Charge a card, once per key.
export fn pay(payments: Remote, message: Pay) -> Result[Done, View] {
  paid(reply: call(
    to: payments,
    method: "charge",
    send: Charge(card: message.card, amount: message.amount),
    reply: Charged,
    within: 2000,
    once: Payment(key: message.key)
  ))
}

fn paid(reply: Result[Charged, CallError]) -> Result[Done, View] {
  match reply {
    Ok(value: Charged(balance)) -> Ok(value: Done(balance))
    Err(
      error: Timeout
    ) -> Err(error: "unknown: payments did not answer in time, so the charge may have happened; \
        send the same key again to learn which")
    Err(error: Rejected(reason)) -> Err(error: "not charged: " ++ reason)
    Err(error: Unreachable) -> Err(error: "not charged: payments is unreachable")
    Err(error: Skew(reason)) -> Err(error: "not charged: " ++ reason)
  }
}
