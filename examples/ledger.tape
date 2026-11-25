// ledger.tape: move money between accounts. The amount is a refined type, so an amount of zero never reaches
// the SQL; the debit only happens when the balance covers it; a transfer to no one is undone with `rollback`;
// every failure is a value with a status.
//
// Each transfer carries the client's key. The same key again (a client that got no answer, retrying) is the same
// transfer: it moves nothing and answers as the first did; the same key for another transfer is 422. Without keys a
// retried transfer moved the money twice; the compiler refuses such writes now (rules.ts, C54). Each balance
// update checks, in its own statement, that no transfer with this key has touched that account.

schema "CREATE TABLE IF NOT EXISTS accounts(name TEXT PRIMARY KEY NOT NULL, balance \
    INTEGER NOT NULL)"
schema "INSERT OR IGNORE INTO accounts VALUES ('alice', 100), ('bob', 20)"
schema "CREATE TABLE IF NOT EXISTS transfers(key TEXT PRIMARY KEY, payer TEXT NOT NULL, payee \
    TEXT NOT NULL, amount INTEGER NOT NULL)"

type Key = View where len(self) >= 1 and len(self) <= 64
type Amount = Int where self >= 1 and self <= 1000000
type Transfer { Transfer(key: Key, from: View, to: View, amount: Amount) }
type Account { Account(name: View, balance: Int) }
type Done { Done(payer: View, payee: View, amount: Int) }

fn handle(raw: View, db: Sql) -> Buf {
  match request(raw) {
    Request(method: "POST", path: "/transfers", body) -> transfer(body)
    Request(method: "GET", path: "/accounts") -> respond(status: 200)
      |> write_rows(rows: sql_all(row: Account, query: "SELECT * FROM accounts ORDER BY name"))
    _ -> problem(status: 404, reason: "no such route")
  }
}

fn transfer(body: View) -> Buf {
  let Ok(value: Transfer(key, from, to, amount)) = decode(json: body, as: Transfer) else {
    Err(error) -> problem(status: 400, reason: error)
  }
  // A key seen before is that transfer again: the same one answers as it did, another one is refused.
  let None = sql_first(row: Done, query: "SELECT * FROM transfers WHERE key = :key", key) else {
    Some(value: Done(payer, payee, amount: a)) if payer == from
      and payee == to
      and a == amount -> moved()
    Some(value) -> problem(status: 422, reason: "the key was already used for another transfer")
  }
  let 1 = sql_exec(
    query: "UPDATE accounts SET balance = balance - :amount WHERE name = :from \
        AND balance >= :amount AND NOT EXISTS (SELECT 1 FROM transfers WHERE key = :key \
        AND payer = :from)",
    amount,
    from,
    key
  ) else -> problem(status: 409, reason: "insufficient funds, or no such payer")
  // The debit has been written. If there is no one to credit, undo it and say why; otherwise record the transfer
  // under its key, in the same request as the two updates.
  let 1 = sql_exec(
    query: "UPDATE accounts SET balance = balance + :amount WHERE name = :to \
        AND NOT EXISTS (SELECT 1 FROM transfers WHERE key = :key AND payee = :to)",
    amount,
    to,
    key
  ) else -> rollback(
    out: problem(status: 404, reason: "no such payee")
  )
  let 1 = sql_exec(
    query: "INSERT INTO transfers(key, payer, payee, amount) VALUES (:key, :from, :to, :amount) \
        ON CONFLICT(key) DO NOTHING",
    key,
    from,
    to,
    amount
  ) else -> rollback(
    out: problem(status: 422, reason: "the key was already used for another transfer")
  )
  moved()
}

fn moved() -> Buf {
  respond(status: 200) |> append(view: "{\"moved\":true}")
}

fn problem(status: Int, reason: View) -> Buf {
  respond(status)
    |> append(view: "{\"error\":")
    |> write_json_string(text: reason)
    |> append(view: "}")
}

// What must hold after every commit (checked by `tape sim` and by app.invariants() in the host).
invariant "no balance is below zero" {
  SELECT name, balance FROM accounts WHERE balance < 0
}

invariant "each balance is its opening balance, moved by the transfers recorded" {
  SELECT a.name, a.balance FROM accounts AS a WHERE a.balance <> CASE a.name WHEN 'alice' THEN 100 WHEN 'bob' THEN 20 ELSE 0 END + (SELECT coalesce(sum(t.amount), 0) FROM transfers AS t WHERE t.payee = a.name) - (SELECT coalesce(sum(t.amount), 0) FROM transfers AS t WHERE t.payer = a.name)
}
