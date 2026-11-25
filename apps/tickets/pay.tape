// pay.tape: a fake card processor for tickets.tape. `charge` and `refund` are called with a once key, so the host
// answers a repeated key from the reply it stored. GET /cards shows every balance; GET /ledger every movement.

migration 1 "cards" {
  CREATE TABLE cards(
    card TEXT PRIMARY KEY NOT NULL,
    balance INTEGER NOT NULL CHECK (balance >= 0)
  );
  CREATE TABLE ledger(
    id INTEGER PRIMARY KEY,
    card TEXT NOT NULL,
    amount INTEGER NOT NULL,
    what TEXT NOT NULL,
    ref TEXT NOT NULL
  );
  INSERT INTO cards(card, balance) VALUES ('visa-4242', 1000000000), ('amex-0005', 1000000000), ('poor-0002', 500)
}

// ref names what is paid for ("hold-12"), so the ledger can be checked against the orders
type Charge { Charge(card: View, amount: Int, ref: View) }
type Charged { Charged(payment: Int) }
type Refund { Refund(card: View, amount: Int, ref: View) }
type Refunded { Refunded(payment: Int) }
type Balance { Balance(balance: Int) }
type Card { Card(card: View, balance: Int) }
type Entry { Entry(id: Int, card: View, amount: Int, what: View, ref: View) }
type Made { Made(id: Int) }
// why pay refuses: a charge the card cannot cover (or a card it does not know), a refund to a card it does not know,
// and a movement it made and could not write in its ledger
type PayError {
  Declined
  NoSuchCard
  Unrecorded
}

export fn charge(db: Sql, message: Charge) -> Result[Charged, PayError] {
  let Charge(card, amount, ref) = message
  let Some(value: Balance) = sql_first(
    row: Balance,
    query: "UPDATE cards SET balance = balance - :amount WHERE card = :card \
        AND balance >= :amount RETURNING balance",
    amount,
    card
  ) else {
    None -> Err(error: Declined)
  }
  let Some(value: Made(id)) = sql_first(
    row: Made,
    query: "INSERT INTO ledger(card, amount, what, ref) VALUES (:card, :amount, 'charge', :ref) \
        RETURNING id",
    card,
    amount,
    ref
  ) else {
    None -> Err(error: Unrecorded)
  }
  Ok(value: Charged(payment: id))
}

export fn refund(db: Sql, message: Refund) -> Result[Refunded, PayError] {
  let Refund(card, amount, ref) = message
  let Some(value: Balance) = sql_first(
    row: Balance,
    query: "UPDATE cards SET balance = balance + :amount WHERE card = :card RETURNING balance",
    amount,
    card
  ) else {
    None -> Err(error: NoSuchCard)
  }
  let Some(value: Made(id)) = sql_first(
    row: Made,
    query: "INSERT INTO ledger(card, amount, what, ref) VALUES (:card, :amount, 'refund', :ref) \
        RETURNING id",
    card,
    amount: 0 - amount,
    ref
  ) else {
    None -> Err(error: Unrecorded)
  }
  Ok(value: Refunded(payment: id))
}

fn handle(raw: View, db: Sql) -> Response {
  match request(raw) {
    Request(method: Get, path: "/cards") -> write_rows(
      out: buf(),
      rows: sql_all(row: Card, query: "SELECT * FROM cards ORDER BY card")
    )
      |> respond_as(status: 200, content: Json)
    Request(method: Get, path: "/ledger") -> write_rows(
      out: buf(),
      rows: sql_all(row: Entry, query: "SELECT * FROM ledger ORDER BY id")
    )
      |> respond_as(status: 200, content: Json)
    _ -> problem(status: 404, detail: "no such route")
  }
}

// What must hold after every commit (checked by `tape sim` and by app.invariants() in the host).
invariant "a card's balance is its opening balance less what the ledger took" {
  SELECT c.card, c.balance FROM cards AS c WHERE c.balance <> CASE c.card WHEN 'poor-0002' THEN 500 ELSE 1000000000 END - (SELECT coalesce(sum(l.amount), 0) FROM ledger AS l WHERE l.card = c.card)
}

invariant "a charge takes and a refund gives" {
  SELECT id, what, amount FROM ledger WHERE (what = 'charge' AND amount < 0) OR (what = 'refund' AND amount > 0) OR what NOT IN ('charge', 'refund')
}
