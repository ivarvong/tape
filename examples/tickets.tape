// tickets.tape: a box office. Seats are held in SQL, the card is charged by another object (payments) with a
// time budget and a key, the ticket code comes from Entropy and the sale time from the Clock. All of it is on
// the tape, so any request can be replayed and traced afterwards. A charge that timed out leaves the sale pending;
// POST /retry/<id> sends the same command again with the same key, so payments answers with the reply it stored
// and charges nothing twice.
//
// POST /buy carries the client's key, {"key":"b-1","section":"floor","qty":2,"card":"ann-4242"}. The same key
// again (a client that got no answer) is the same sale: pending, its charge is sent again with the same once key;
// paid, its ticket is answered again; declined, 402 again. The same key for another purchase is 422. Without a key
// a retried /buy would take the seats twice and make a second sale; the compiler refuses both unguarded writes
// (rules.ts, C54 and C55). The seats are taken only when no sale with this key exists, checked in the same
// statement, and the sale is written in the same request: a sale that cannot be written gives the seats back.

flag max_per_order: Int = 4

schema "CREATE TABLE IF NOT EXISTS sections(name TEXT PRIMARY KEY NOT NULL, price \
    INTEGER NOT NULL, seats INTEGER NOT NULL)"
schema "INSERT OR IGNORE INTO sections VALUES ('floor', 120, 3), ('balcony', 45, 10)"
schema "CREATE TABLE IF NOT EXISTS sales(id INTEGER PRIMARY KEY, section TEXT NOT NULL, qty \
    INTEGER NOT NULL, amount INTEGER NOT NULL, code INTEGER NOT NULL, at INTEGER NOT NULL, state \
    TEXT NOT NULL, card TEXT NOT NULL, client TEXT NOT NULL UNIQUE)"

// A sale is held as pending until the card is charged; the compiler checks every write of its state against these
// moves (each from the state its WHERE names), and the host installs SQLite triggers that refuse any other.
type SaleState { Pending Paid Declined }

machine sales.state: SaleState {
  Pending -> Paid
  Pending -> Declined
}

type Qty = Int where self >= 1 and self <= flags.max_per_order
type Key = View where len(self) >= 1 and len(self) <= 64
type ForSale { ForSale(sale: Int) }
type Buy { Buy(key: Key, section: View, qty: Qty, card: View) }
type Price { Price(price: Int) }
type Held { Held(id: Int, amount: Int) }
type Ticket { Ticket(id: Int, section: View, qty: Int, amount: Int, code: Int) }
type Unpaid { Unpaid(id: Int, section: View, qty: Int, amount: Int, card: View) }
type Line { Line(section: View, qty: Int, amount: Int) }
type Tally { Tally(seats: Int, revenue: Int) }
type Sale { Sale(id: Int, section: View, qty: Int, amount: Int, state: SaleState, card: View) }
type Earlier { Earlier(
  id: Int,
  section: View,
  qty: Int,
  amount: Int,
  state: SaleState,
  card: View,
  code: Int
) }
type Section { Section(name: View, price: Int, seats: Int) }

// the payments object's `charge` method: what is sent and what comes back
type Charge { Charge(card: View, amount: Int) }
type Charged { Charged(balance: Int) }

fn handle(raw: View, db: Sql, payments: Remote, clock: Clock, dice: Entropy) -> Response {
  match request(raw) {
    Request(method: Post, path: "/buy", body) -> buy(body)
    Request(method: Post, path: "/retry/" ++ decimal(id)) -> retry(sale: id)
    Request(method: Get, path: "/sales/" ++ decimal(id)) -> sale(id)
    Request(method: Get, path: "/sections") -> buf()
      |> write_rows(rows: sql_all(row: Section, query: "SELECT * FROM sections ORDER BY name"))
      |> respond(status: 200)
    Request(method: Get, path: "/sales") -> report(totals: tally(
      rows: sql_all(row: Line, query: "SELECT * FROM sales WHERE state = 'paid' ORDER BY id"),
      totals: Empty
    ))
    _ -> problem(status: 404, reason: "no such route")
  }
}

fn buy(body: View) -> Response {
  let Ok(value: Buy(key, section, qty, card)) = decode(json: body, as: Buy) else {
    Err(error) -> problem(status: 400, reason: error)
  }
  let Some(value: Price(price)) = sql_first(
    row: Price,
    query: "SELECT * FROM sections WHERE name = :section",
    section
  ) else -> problem(status: 404, reason: "no such section")
  // Take the seats, unless a sale with this key exists (then this is that sale again).
  let 1 = sql_exec(
    query: "UPDATE sections SET seats = seats - :qty WHERE name = :section AND seats >= :qty \
        AND NOT EXISTS (SELECT 1 FROM sales WHERE client = :key AND section = :section)",
    qty,
    section,
    key
  ) else -> earlier(
    found: sql_first(
      row: Earlier,
      query: "SELECT * FROM sales WHERE client = :key AND section = :section AND qty = :qty \
          AND card = :card",
      key,
      section,
      qty,
      card
    ),
    used: sql_first(row: Price, query: "SELECT 1 AS price FROM sales WHERE client = :key", key)
  )
  // The seats are taken. The sale is written, or (the key used for a sale in another section) nothing is kept.
  let Some(value: Held(id, amount)) = sql_first(
    row: Held,
    query: "INSERT INTO sales(client, section, qty, amount, code, at, state, card) \
        VALUES (:key, :section, :qty, :amount, :code, :at, 'pending', :card) ON CONFLICT(client) \
        DO NOTHING RETURNING *",
    key,
    section,
    qty,
    amount: price * qty,
    code: random(from: dice) % 1000000,
    at: now(clock),
    card
  ) else -> rollback(
    out: problem(status: 422, reason: "the key was already used for another purchase")
  )
  charge(id, section, qty, card, amount, within: 50)
}

// No seats were taken: a sale with this key exists (this request is a retry of it), the key belongs to another
// purchase, or the section has too few seats left.
fn earlier(found: Option[Earlier], used: Option[Price]) -> Response {
  match found {
    Some(
      value: Earlier(id, section, qty, amount, state: Pending, card)
    ) -> charge(id, section, qty, card, amount, within: 2000)
    Some(value: Earlier(id, section, qty, amount, state: Paid, code)) -> buf()
      |> write_json(value: Ticket(id, section, qty, amount, code))
      |> respond(status: 201)
    Some(
      value: Earlier(state: Declined)
    ) -> problem(status: 402, reason: "this purchase was declined")
    None -> unused(used)
  }
}

fn unused(used: Option[Price]) -> Response {
  match used {
    Some(value) -> problem(status: 422, reason: "the key was already used for another purchase")
    None -> problem(status: 409, reason: "not enough seats left in that section")
  }
}

// The same command as the first attempt (same key), with more time: payments repeats what it answered then.
fn retry(sale: Int) -> Response {
  let Some(
    value: Unpaid(id, section, qty, amount, card)
  ) = sql_first(
    row: Unpaid,
    query: "SELECT * FROM sales WHERE id = :sale AND state = 'pending'",
    sale
  ) else -> problem(status: 404, reason: "no such pending sale")
  charge(id, section, qty, card, amount, within: 2000)
}

// The hold is committed before the charge is sent: a call is a commit point. Each way the call can fail is an arm.
fn charge(id: Int, section: View, qty: Int, card: View, amount: Int, within: Int) -> Response {
  let Ok(value: Charged) = call(
    to: payments,
    method: "charge",
    send: Charge(card, amount),
    reply: Charged,
    within,
    once: ForSale(sale: id)
  ) else {
    Err(error: Rejected(reason)) -> declined(
      section,
      qty,
      reason,
      moved: sql_move(
        row: Held,
        query: "UPDATE sales SET state = 'declined' WHERE id = :id AND state = 'pending' \
            RETURNING *",
        id
      )
    )
    Err(error: Timeout) -> problem(
      status: 504,
      reason: "payments did not answer in time; the seats stay held"
    )
    Err(error: Unreachable) -> problem(
      status: 503,
      reason: "payments is unreachable; the seats stay held"
    )
    Err(error: Skew(reason)) -> problem(status: 502, reason)
  }
  ticket(moved: sql_move(
    row: Earlier,
    query: "UPDATE sales SET state = 'paid' WHERE id = :id AND state = 'pending' RETURNING *",
    id
  ))
}

// One sale, in any state: with GET /sections, what a checker reads to reconcile seats and money.
fn sale(id: Int) -> Response {
  let Some(value) = sql_first(
    row: Sale,
    query: "SELECT * FROM sales WHERE id = :id",
    id
  ) else -> problem(status: 404, reason: "no such sale")
  buf() |> write_json(value) |> respond(status: 200)
}

// The seats go back with the sale this request voided (Moved), and only then: two retries of one sale that both
// hear the refusal (it is stored, so both do) void it once, and the second finds it voided already (Raced).
fn declined(section: View, qty: Int, reason: View, moved: Move[Held]) -> Response {
  match moved {
    Moved(value) -> {
      let 1 = sql_exec(
        query: "UPDATE sections SET seats = seats + :qty WHERE name = :section",
        qty,
        section
      ) else -> rollback(
        out: problem(status: 500, reason: "the sale's section \(section) is gone")
      )
      problem(status: 402, reason)
    }
    Raced(now) -> problem(status: 402, reason)
    NoRow -> problem(status: 404, reason: "no such pending sale")
  }
}

// The sale this request paid, or, when a retry racing it paid it first (both heard the same stored charge), the
// sale as that request left it.
fn ticket(moved: Move[Earlier]) -> Response {
  match moved {
    Moved(value: Earlier(id, section, qty, amount, code)) -> buf()
      |> write_json(value: Ticket(id, section, qty, amount, code))
      |> respond(status: 201)
    Raced(now: Earlier(id, section, qty, amount, state: Paid, code)) -> buf()
      |> write_json(value: Ticket(id, section, qty, amount, code))
      |> respond(status: 201)
    Raced(now: Earlier(state: Pending)) -> problem(status: 409, reason: "this sale was pending")
    Raced(now: Earlier(state: Declined)) -> problem(status: 409, reason: "this sale was declined")
    NoRow -> problem(status: 404, reason: "no such pending sale")
  }
}

// Paid sales, summed per section into the immutable map (kept in key order).
fn tally(rows: Rows[Line], totals: Map[Tally]) -> Map[Tally] {
  match next(rows) {
    Next(value: Line(section, qty, amount), rest) -> tally(
      rows: rest,
      totals: put(
        map: totals,
        key: section,
        value: add(was: get(map: totals, key: section), qty, amount)
      )
    )
    End -> totals
  }
}

fn add(was: Option[Tally], qty: Int, amount: Int) -> Tally {
  match was {
    Some(value: Tally(seats, revenue)) -> Tally(seats: seats + qty, revenue: revenue + amount)
    None -> Tally(seats: qty, revenue: amount)
  }
}

fn report(totals: Map[Tally]) -> Response {
  push(buf: entries(out: push(buf: buf(), byte: 123), totals, first: True), byte: 125)
    |> respond(status: 200)
}

// In order: left subtree, this entry, right subtree. `first` is whether nothing has been written yet.
fn entries(out: Buf, totals: Map[Tally], first: Bool) -> Buf {
  match totals {
    Empty -> out
    Node(left, key, value, right) -> entries(
      out: entry(
        out: entries(out, totals: left, first),
        key,
        value,
        first: first and count(map: left) == 0
      ),
      totals: right,
      first: False
    )
  }
}

fn entry(out: Buf, key: View, value: Tally, first: Bool) -> Buf {
  match {
    first -> write_json(out: push(buf: write_json_string(out, text: key), byte: 58), value)
    else -> write_json(
      out: push(buf: write_json_string(out: push(buf: out, byte: 44), text: key), byte: 58),
      value
    )
  }
}

fn problem(status: Int, reason: View) -> Response {
  buf()
    |> append(view: "{\"error\":")
    |> write_json_string(text: reason)
    |> append(view: "}")
    |> respond(status)
}

// What must hold after every commit (checked by `tape sim` and by app.invariants() in the host).
invariant "a section's seats left and its seats held or sold add up to what it has" {
  SELECT s.name, s.seats FROM sections AS s WHERE s.seats + (SELECT coalesce(sum(x.qty), 0) FROM sales AS x WHERE x.section = s.name AND x.state IN ('pending', 'paid')) <> CASE s.name WHEN 'floor' THEN 3 WHEN 'balcony' THEN 10 ELSE 0 END
}

invariant "a sale costs its section's price for each seat" {
  SELECT x.id, x.amount FROM sales AS x JOIN sections AS s ON s.name = x.section WHERE x.amount <> s.price * x.qty
}

invariant "a sale is for no fewer than one seat" {
  SELECT id, qty FROM sales WHERE qty < 1
}
