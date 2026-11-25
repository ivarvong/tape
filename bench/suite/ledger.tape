// ledger.tape: a batch of transfers per request, each a compare-and-set in SQL, as examples/ledger.tape does one.
// POST /transfers with {"transfers": [{key, from, to, amount}, …]}. Each transfer carries its client key: a key seen
// before with the same transfer answers 200 and moves nothing; with another transfer, 422. The debit happens only
// when the balance covers it (409 otherwise), and only when the payee exists (404 otherwise). The answer is each
// transfer's status in order and then every balance. Same behaviour as ledger-js.ts.
schema "CREATE TABLE IF NOT EXISTS accounts(name TEXT PRIMARY KEY NOT NULL, balance \
    INTEGER NOT NULL)"
schema "CREATE TABLE IF NOT EXISTS transfers(key TEXT PRIMARY KEY, payer TEXT NOT NULL, payee \
    TEXT NOT NULL, amount INTEGER NOT NULL)"

type Key = View where len(self) >= 1 and len(self) <= 64
type Amount = Int where self >= 1 and self <= 1000000
type Transfer { Transfer(key: Key, from: View, to: View, amount: Amount) }
type Batch { Batch(transfers: List[Transfer]) }
type Account { Account(name: View, balance: Int) }
type Done { Done(payer: View, payee: View, amount: Int) }
type Named { Named(name: View) }

fn handle(raw: View, db: Sql) -> Response {
  match request(raw) {
    Request(method: Post, path: "/transfers", body) -> batch(body)
    _ -> problem(status: 404, detail: "no such route")
  }
}

fn batch(body: View) -> Response {
  let Ok(value: Batch(transfers)) = decode(json: body, as: Batch) else {
    Err(error) -> problem(status: 400, detail: error)
  }
  let out = buf() |> append(view: "{\"results\":[")
  each(transfers, out, first: True)
    |> append(view: "],\"accounts\":")
    |> write_rows(rows: sql_all(row: Account, query: "SELECT * FROM accounts ORDER BY name"))
    |> append(view: "}")
    |> respond(status: 200)
}

fn each(transfers: List[Transfer], out: Buf, first: Bool) -> Buf {
  match transfers {
    Cons(head, tail) if first -> each(
      transfers: tail,
      out: out |> push(byte: 91) |> result(t: head),
      first: False
    )
    Cons(head, tail) -> each(
      transfers: tail,
      out: out |> append(view: ",[") |> result(t: head),
      first: False
    )
    Nil -> out
  }
}

// [the key, the status]
fn result(out: Buf, t: Transfer) -> Buf {
  out
    |> write_json_string(text: t.key)
    |> push(byte: 44)
    |> write_int(value: transfer(t))
    |> push(byte: 93)
}

fn transfer(t: Transfer) -> Int {
  let Transfer(key, from, to, amount) = t
  // A key seen before is that transfer again: the same one answers as it did, another one is refused.
  let None = sql_first(
    row: Done,
    query: "SELECT payer, payee, amount FROM transfers WHERE key = :key",
    key
  ) else {
    Some(value: Done(payer, payee, amount: a)) if payer == from
      and payee == to
      and a == amount -> 200
    Some(value) -> 422
  }
  let Some(value: Named(name)) = sql_first(
    row: Named,
    query: "SELECT name FROM accounts WHERE name = :to",
    to
  ) else {
    None -> 404
  }
  let 1 = sql_exec(
    query: "UPDATE accounts SET balance = balance - :amount WHERE name = :from \
        AND balance >= :amount AND NOT EXISTS (SELECT 1 FROM transfers WHERE key = :key \
        AND payer = :from)",
    amount,
    from,
    key
  ) else -> 409
  let 1 = sql_exec(
    query: "UPDATE accounts SET balance = balance + :amount WHERE name = :to \
        AND NOT EXISTS (SELECT 1 FROM transfers WHERE key = :key AND payee = :to)",
    amount,
    to,
    key
  ) else -> 500
  let 1 = sql_exec(
    query: "INSERT INTO transfers(key, payer, payee, amount) VALUES (:key, :from, :to, :amount) \
        ON CONFLICT(key) DO NOTHING",
    key,
    from,
    to,
    amount
  ) else -> 422
  200
}
