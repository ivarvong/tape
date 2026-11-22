// ledger.tape: move money between accounts. The amount is a refined type, so an amount of zero never reaches
// the SQL; the debit only happens when the balance covers it; a transfer to no one is undone with `rollback`;
// every failure is a value with a status.

schema "CREATE TABLE IF NOT EXISTS accounts(name TEXT PRIMARY KEY, balance INTEGER NOT NULL)"
schema "INSERT OR IGNORE INTO accounts VALUES ('alice', 100), ('bob', 20)"

type Amount = Int where self >= 1 and self <= 1000000
type Transfer { Transfer(from: View, to: View, amount: Amount) }
type Account { Account(name: View, balance: Int) }

fn handle(raw: View, db: Sql) -> Buf {
  match request(raw) {
    Request(method: "POST", path: "/transfers", body) -> transfer(db, order: decode(json: body, as: Transfer))
    Request(method: "GET", path: "/accounts") -> accounts(out: append(buf: respond(status: 200), view: "["), rows: sql_all(db, row: Account, query: "SELECT name, balance FROM accounts ORDER BY name"), first: True)
    _ -> problem(status: 404, reason: "no such route")
  }
}

fn transfer(db: Sql, order: Result[Transfer, View]) -> Buf {
  match order {
    Ok(value: Transfer(from, to, amount)) -> debit(db, to, amount, taken: sql_exec(db, query: "UPDATE accounts SET balance = balance - :amount WHERE name = :from AND balance >= :amount", amount, from))
    Err(error) -> problem(status: 400, reason: error)
  }
}

fn debit(db: Sql, to: View, amount: Amount, taken: Int) -> Buf {
  match taken {
    1 -> credit(given: sql_exec(db, query: "UPDATE accounts SET balance = balance + :amount WHERE name = :to", amount, to))
    _ -> problem(status: 409, reason: "insufficient funds, or no such payer")
  }
}

// The debit has already been written. If there is no one to credit, undo it and say why.
fn credit(given: Int) -> Buf {
  match given {
    1 -> append(buf: respond(status: 200), view: "{\"moved\":true}")
    _ -> rollback(out: problem(status: 404, reason: "no such payee"))
  }
}

fn accounts(out: Buf, rows: Rows[Account], first: Bool) -> Buf {
  match next(rows) {
    Next(value, rest) if first -> accounts(out: write_json(out, value), rows: rest, first: False)
    Next(value, rest) -> accounts(out: write_json(out: push(buf: out, byte: 44), value), rows: rest, first: False)
    End -> push(buf: out, byte: 93)
  }
}

fn problem(status: Int, reason: View) -> Buf {
  append(buf: write_json_string(out: append(buf: respond(status), view: "{\"error\":"), text: reason), view: "}")
}
