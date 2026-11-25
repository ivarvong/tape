// webhook.tape: a batch of webhook events per request: decode, route by kind, dedupe by event id.
// POST /hooks with {"source": name, "events": [{id, kind, account, amount, note}, …]}. An event id seen before is a
// duplicate and does nothing. charge.succeeded and refund.created are recorded in payments (a refund negative) and
// move the account's total; customer.updated sets the account's note; any other kind is ignored. The answer is
// [id, outcome] for each event in order, then the number of customers and their total. Same behaviour as
// webhook-js.ts.
schema "CREATE TABLE IF NOT EXISTS seen(id TEXT PRIMARY KEY NOT NULL, source TEXT NOT NULL)"
schema "CREATE TABLE IF NOT EXISTS payments(id TEXT PRIMARY KEY NOT NULL, account \
    TEXT NOT NULL, amount INTEGER NOT NULL)"
schema "CREATE TABLE IF NOT EXISTS customers(account TEXT PRIMARY KEY NOT NULL, total \
    INTEGER NOT NULL, note TEXT NOT NULL)"

type Id = View where len(self) >= 1 and len(self) <= 64
type Account = View where len(self) >= 1 and len(self) <= 64
type Amount = Int where self >= 0 and self <= 100000000
type Event { Event(id: Id, kind: View, account: Account, amount: Amount, note: View) }
type Delivery { Delivery(source: View, events: List[Event]) }
type Total { Total(customers: Int, total: Int) }

fn handle(raw: View, db: Sql) -> Response {
  match request(raw) {
    Request(method: Post, path: "/hooks", body) -> deliver(body)
    _ -> problem(status: 404, detail: "no such route")
  }
}

fn deliver(body: View) -> Response uses db {
  let Ok(value: Delivery(source, events)) = decode(json: body, as: Delivery) else {
    Err(error) -> problem(status: 400, detail: error)
  }
  let out = route_all(source, events, out: buf() |> append(view: "{\"results\":["), first: True)
  let Some(
    value: Total(customers, total)
  ) = sql_first(
    row: Total,
    query: "SELECT count(*) AS customers, coalesce(sum(total), 0) AS total FROM customers"
  ) else -> out
    |> append(view: "]}")
    |> respond(status: 200)
  out |> append(view: "],\"customers\":\(customers),\"total\":\(total)}") |> respond(status: 200)
}

fn route_all(source: View, events: List[Event], out: Buf, first: Bool) -> Buf uses db {
  match events {
    Cons(head, tail) if first -> route_all(
      source,
      events: tail,
      out: out |> push(byte: 91) |> route(source, e: head),
      first: False
    )
    Cons(head, tail) -> route_all(
      source,
      events: tail,
      out: out |> append(view: ",[") |> route(source, e: head),
      first: False
    )
    Nil -> out
  }
}

// [the id, what was done]
fn route(out: Buf, source: View, e: Event) -> Buf uses db {
  out
    |> write_json_string(text: e.id)
    |> append(view: ",\"")
    |> append(view: outcome(source, e))
    |> append(view: "\"]")
}

fn outcome(source: View, e: Event) -> View uses db {
  let Event(id, kind, account, amount, note) = e
  let 1 = sql_exec(
    query: "INSERT INTO seen(id, source) VALUES (:id, :source) ON CONFLICT(id) DO NOTHING",
    id,
    source
  ) else -> "duplicate"
  match kind {
    "charge.succeeded" -> paid(n: pay(id, account, amount), what: "charged")
    "refund.created" -> paid(n: pay(id, account, amount: 0 - amount), what: "refunded")
    "customer.updated" -> paid(
      n: sql_exec(
        query: "INSERT INTO customers(account, total, note) VALUES (:account, 0, :note) \
            ON CONFLICT(account) DO UPDATE SET note = excluded.note",
        account,
        note
      ),
      what: "updated"
    )
    _ -> "ignored"
  }
}

fn paid(n: Int, what: View) -> View {
  match n {
    1 -> what
    _ -> "failed"
  }
}
// A payment recorded under the event's id, and the account's total moved by it; 1.
fn pay(id: Id, account: Account, amount: Int) -> Int uses db {
  let 1 = sql_exec(
    query: "INSERT INTO payments(id, account, amount) VALUES (:id, :account, :amount) \
        ON CONFLICT(id) DO NOTHING",
    id,
    account,
    amount
  ) else -> 0
  sql_exec(
    query: "INSERT INTO customers(account, total, note) VALUES (:account, :amount, '') \
        ON CONFLICT(account) DO UPDATE SET total = total + excluded.total",
    account,
    amount
  )
}
