// cart.tape: price a cart. No database: a JSON body in, checked field by field as it is decoded, and a JSON
// answer out. Same behaviour as bench/cart-baseline.ts.
type Sku = View where len(self) >= 1 and len(self) <= 32

type Qty = Int where self >= 1 and self <= 1000

type Cents = Int where self >= 0 and self <= 100000000

type Line { Line(sku: Sku, qty: Qty, cents: Cents) }

type Cart { Cart(customer: View, lines: List[Line], coupon: Option[View]) }

type Priced { Priced(
  customer: View,
  lines: Int,
  items: Int,
  subtotal: Int,
  discount: Int,
  total: Int
) }

fn handle(raw: View) -> Response {
  let Ok(value: Cart(customer, lines, coupon)) = decode(json: raw, as: Cart) else {
    Err(error) -> problem(status: 400, detail: "not a cart")
  }
  let subtotal = fold(
    list: lines,
    from: 0,
    by: fn(sum: Int, line: Line) -> Int { sum + line.qty * line.cents }
  )
  let discount = off(coupon, subtotal)
  json(
    status: 200,
    value: Priced(
      customer,
      lines: length(list: lines),
      items: fold(list: lines, from: 0, by: fn(sum: Int, line: Line) -> Int { sum + line.qty }),
      subtotal,
      discount,
      total: subtotal - discount
    )
  )
}

// What a coupon takes off: a tenth with TEN, five dollars with FIVE on fifty or more, nothing otherwise.
//
//   > off(coupon: Some(value: "TEN"), subtotal: 1999)
//   199
//   > off(coupon: Some(value: "FIVE"), subtotal: 4999)
//   0
//   > off(coupon: None, subtotal: 5000)
//   0
fn off(coupon: Option[View], subtotal: Int) -> Int {
  match coupon {
    Some(value: "TEN") -> subtotal / 10
    Some(value: "FIVE") if subtotal >= 5000 -> 500
    _ -> 0
  }
}
