// price.tape: a pure tool. It takes no capabilities, so its module imports nothing from the host but JSON: it
// cannot read or write storage, call another program, or read the clock or random numbers.

type Qty = Int where self >= 1 and self <= 100
type Cents = Int where self >= 0 and self <= 100000000
type Percent = Int where self >= 0 and self <= 100
type Basket { Basket(
  unit_cents: Cents,
  qty: Qty,
  discount_percent: Option[Percent],
  tax_percent: Percent
) }
type Price { Price(subtotal_cents: Int, discount_cents: Int, tax_cents: Int, total_cents: Int) }

// Price a basket: unit price times quantity, less an optional discount, plus tax on what is left (rounded down).
export fn quote(message: Basket) -> Result[Price, View] {
  priced(
    subtotal: message.unit_cents * message.qty,
    off: percent_of(message.discount_percent),
    tax: message.tax_percent
  )
}

fn percent_of(p: Option[Percent]) -> Int {
  match p {
    Some(value) -> value
    None -> 0
  }
}

fn priced(subtotal: Int, off: Int, tax: Int) -> Result[Price, View] {
  taxed(subtotal, discount: subtotal * off / 100, tax)
}

fn taxed(subtotal: Int, discount: Int, tax: Int) -> Result[Price, View] {
  Ok(value: Price(
    subtotal_cents: subtotal,
    discount_cents: discount,
    tax_cents: (subtotal - discount) * tax / 100,
    total_cents: subtotal - discount + (subtotal - discount) * tax / 100
  ))
}
