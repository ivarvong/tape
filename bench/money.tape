// money.tape: a cart priced exactly, for bench/money.ts. Prices are Dec[2] (JSON text or numbers), a line is
// price times quantity, the tax is the subtotal times a rate of five decimals rounded once to the cent, half to
// even, and every amount is answered as text with its two digits. Same answers as bench/money-baseline.ts.
type Line {
  Line(price: Dec[2], qty: Int)
}

type Cart {
  Cart(lines: List[Line], rate: Dec[5])
}

type Priced {
  Priced(subtotal: Dec[2], tax: Dec[2], total: Dec[2])
}

fn handle(raw: View) -> Response {
  let Ok(value: Cart(lines, rate)) = decode(json: raw, as: Cart) else {
    Err(error) -> problem(status: 400, detail: error)
  }
  let subtotal = fold(
    list: lines,
    from: 0.00,
    by: fn(sum: Dec[2], line: Line) -> Dec[2] { sum + line.price * line.qty }
  )
  let tax = mul(a: subtotal, by: rate, scale: 2, rounding: HalfEven)
  json(status: 200, value: Priced(subtotal, tax, total: subtotal + tax))
}
