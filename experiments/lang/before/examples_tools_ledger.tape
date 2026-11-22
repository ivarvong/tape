// ledger.tape: asks for a capability the account does not grant. It names `payments: Remote`, and the policy
// allows Remote fx only, so the upload is refused before anything is stored.

type Pay { Pay(card: View, amount: Int) }
type Charge { Charge(card: View, amount: Int) }
type Charged { Charged(balance: Int) }
type Done { Done(balance: Int) }

// Charge a card.
export fn pay(payments: Remote, message: Pay) -> Result[Done, View] {
  paid(reply: call(to: payments, method: "charge", send: Charge(card: message.card, amount: message.amount), reply: Charged, within: 2000, once: message.amount))
}

fn paid(reply: Result[Charged, CallError]) -> Result[Done, View] {
  match reply {
    Ok(value: Charged(balance)) -> Ok(value: Done(balance))
    Err(error) -> Err(error: "not charged")
  }
}
