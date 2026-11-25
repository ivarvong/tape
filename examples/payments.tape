// payments.tape: the payments object. `charge` and `refund` are methods other objects call, each a command sent
// with a key. GET /cards shows every balance, which is how a demo proves a card was charged once.

schema "CREATE TABLE IF NOT EXISTS cards(card TEXT PRIMARY KEY NOT NULL, balance INTEGER NOT NULL)"
schema "INSERT OR IGNORE INTO cards VALUES ('ann-4242', 300), ('bob-0001', 50)"

type Charge { Charge(card: View, amount: Int) }
type Charged { Charged(balance: Int) }
type Balance { Balance(balance: Int) }
type Refund { Refund(card: View, amount: Int) }
type Refunded { Refunded(balance: Int) }
type Card { Card(card: View, balance: Int) }
// why payments refuses: a charge the card cannot cover, or for a card it does not know (Insufficient); a refund to a
// card it does not know (NoSuchCard)
type PaymentError {
  Insufficient
  NoSuchCard
}

export fn charge(db: Sql, message: Charge) -> Result[Charged, PaymentError] {
  let Some(value: card) = sql_first(
    row: Balance,
    query: "UPDATE cards SET balance = balance - :amount WHERE card = :card \
        AND balance >= :amount RETURNING *",
    amount: message.amount,
    card: message.card
  ) else -> Err(error: Insufficient)
  Ok(value: Charged(balance: card.balance))
}

export fn refund(db: Sql, message: Refund) -> Result[Refunded, PaymentError] {
  let Some(value: card) = sql_first(
    row: Balance,
    query: "UPDATE cards SET balance = balance + :amount WHERE card = :card RETURNING *",
    amount: message.amount,
    card: message.card
  ) else -> Err(error: NoSuchCard)
  Ok(value: Refunded(balance: card.balance))
}

fn handle(raw: View, db: Sql) -> Response {
  match request(raw) {
    Request(method: Get, path: "/cards") -> buf()
      |> write_rows(rows: sql_all(row: Card, query: "SELECT * FROM cards ORDER BY card"))
      |> respond(status: 200)
    _ -> problem(status: 404, detail: "no such route")
  }
}

// What must hold after every commit. The second catches a refund sent twice: more would come back than was charged.
invariant "no card is below zero" {
  SELECT card, balance FROM cards WHERE balance < 0
}

invariant "no more is refunded than was charged" {
  SELECT card, balance FROM cards WHERE balance > CASE card WHEN 'ann-4242' THEN 300 WHEN 'bob-0001' THEN 50 ELSE 0 END
}
