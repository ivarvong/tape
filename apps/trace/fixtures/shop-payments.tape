// shop-payments.tape: the payments program the shop of LANGUAGE.md section 8 calls. `charge` records a payment
// and answers its id; an amount over 100000 is refused, which the shop records as a failed order.
schema "CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY, amount INTEGER NOT NULL)"

type Charge { Charge(amount: Int) }
type Charged { Charged(payment: Int) }
type Payment { Payment(id: Int, amount: Int) }
// why a charge is refused, as the shop declares it too
type ChargeError { Declined(reason: View) }

export fn charge(db: Sql, message: Charge) -> Result[Charged, ChargeError] {
  let Charge(amount) = message
  let Some(value: paid) = sql_first(
    row: Payment,
    query: "INSERT INTO payments(amount) SELECT :amount WHERE :amount <= 100000 RETURNING *",
    amount
  ) else -> Err(error: Declined(reason: "the amount is over the limit"))
  Ok(value: Charged(payment: paid.id))
}

fn handle(raw: View, db: Sql) -> Response {
  buf()
    |> write_rows(rows: sql_all(row: Payment, query: "SELECT * FROM payments ORDER BY id"))
    |> respond(status: 200)
}
