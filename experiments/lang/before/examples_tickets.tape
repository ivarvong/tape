// tickets.tape: a box office. Seats are held in SQL, the card is charged by another object (payments) with a
// time budget and a key, the ticket code comes from Entropy and the sale time from the Clock. All of it is on
// the tape, so any request can be replayed and traced afterwards. A charge that timed out leaves the sale pending;
// POST /retry/<id> sends the same command again with the same key, so payments answers with the reply it stored
// and charges nothing twice.

flag max_per_order: Int = 4

schema "CREATE TABLE IF NOT EXISTS sections(name TEXT PRIMARY KEY, price INTEGER NOT NULL, seats INTEGER NOT NULL)"
schema "INSERT OR IGNORE INTO sections VALUES ('floor', 120, 3), ('balcony', 45, 10)"
schema "CREATE TABLE IF NOT EXISTS sales(id INTEGER PRIMARY KEY, section TEXT NOT NULL, qty INTEGER NOT NULL, amount INTEGER NOT NULL, code INTEGER NOT NULL, at INTEGER NOT NULL, state TEXT NOT NULL, card TEXT NOT NULL)"

type Qty = Int where self >= 1 and self <= flags.max_per_order
type Buy { Buy(section: View, qty: Qty, card: View) }
type Price { Price(price: Int) }
type Held { Held(id: Int, amount: Int) }
type Ticket { Ticket(id: Int, section: View, qty: Int, amount: Int, code: Int) }
type Pending { Pending(id: Int, section: View, qty: Int, amount: Int, card: View) }
type Line { Line(section: View, qty: Int, amount: Int) }
type Tally { Tally(seats: Int, revenue: Int) }
type Sale { Sale(id: Int, section: View, qty: Int, amount: Int, state: View, card: View) }
type Section { Section(name: View, price: Int, seats: Int) }

// the payments object's `charge` method: what is sent and what comes back
type Charge { Charge(card: View, amount: Int) }
type Charged { Charged(balance: Int) }

fn handle(raw: View, db: Sql, payments: Remote, clock: Clock, dice: Entropy) -> Buf {
  match request(raw) {
    Request(method: "POST", path: "/buy", body) -> buy(db, payments, clock, dice, order: decode(json: body, as: Buy))
    Request(method: "POST", path: "/retry/" ++ decimal(id)) -> retry(db, payments, found: sql_first(db, row: Pending, query: "SELECT id, section, qty, amount, card FROM sales WHERE id = :id AND state = 'pending'", id))
    Request(method: "GET", path: "/sales/" ++ decimal(id)) -> sale(found: sql_first(db, row: Sale, query: "SELECT id, section, qty, amount, state, card FROM sales WHERE id = :id", id))
    Request(method: "GET", path: "/sections") -> sections(out: push(buf: respond(status: 200), byte: 91), rows: sql_all(db, row: Section, query: "SELECT name, price, seats FROM sections ORDER BY name"), first: True)
    Request(method: "GET", path: "/sales") -> report(totals: tally(rows: sql_all(db, row: Line, query: "SELECT section, qty, amount FROM sales WHERE state = 'paid' ORDER BY id"), totals: Empty))
    _ -> problem(status: 404, reason: "no such route")
  }
}

fn buy(db: Sql, payments: Remote, clock: Clock, dice: Entropy, order: Result[Buy, View]) -> Buf {
  match order {
    Ok(value: Buy(section, qty, card)) -> hold(db, payments, clock, dice, section, qty, card)
    Err(error) -> problem(status: 400, reason: error)
  }
}

// Take the seats, then record a pending sale. Either step can fail; the first failure takes `else`.
fn hold(db: Sql, payments: Remote, clock: Clock, dice: Entropy, section: View, qty: Qty, card: View) -> Buf {
  with {
    Some(value: Price(price)) <- sql_first(db, row: Price, query: "UPDATE sections SET seats = seats - :qty WHERE name = :section AND seats >= :qty RETURNING price", qty, section)
    Some(value: Held(id, amount)) <- sql_first(db, row: Held, query: "INSERT INTO sales(section, qty, amount, code, at, state, card) VALUES (:section, :qty, :amount, :code, :at, 'pending', :card) RETURNING id, amount", section, qty, amount: price * qty, code: random(from: dice) % 1000000, at: now(clock), card)
    -> settle(db, id, section, qty, reply: call(to: payments, method: "charge", send: Charge(card, amount), reply: Charged, within: 50, once: id))
    else -> problem(status: 409, reason: "not enough seats left in that section")
  }
}

// The same command as the first attempt (same key), with more time: payments repeats what it answered then.
fn retry(db: Sql, payments: Remote, found: Option[Pending]) -> Buf {
  match found {
    Some(value: Pending(id, section, qty, amount, card)) -> settle(db, id, section, qty, reply: call(to: payments, method: "charge", send: Charge(card, amount), reply: Charged, within: 2000, once: id))
    None -> problem(status: 404, reason: "no such pending sale")
  }
}

// The hold above is committed before the charge is sent: a call is a commit point.
fn settle(db: Sql, id: Int, section: View, qty: Int, reply: Result[Charged, CallError]) -> Buf {
  match reply {
    Ok(value) -> ticket(found: sql_first(db, row: Ticket, query: "UPDATE sales SET state = 'paid' WHERE id = :id RETURNING id, section, qty, amount, code", id))
    Err(error: Rejected(reason)) -> declined(reason, freed: free(db, section, qty, voided: sql_exec(db, query: "UPDATE sales SET state = 'declined' WHERE id = :id AND state = 'pending'", id)))
    Err(error: Timeout) -> problem(status: 504, reason: "payments did not answer in time; the seats stay held")
    Err(error: Unreachable) -> problem(status: 503, reason: "payments is unreachable; the seats stay held")
    Err(error: Skew(reason)) -> problem(status: 502, reason)
  }
}

// One sale, in any state, and the seats left in each section: what a checker reads to reconcile seats and money.
fn sale(found: Option[Sale]) -> Buf {
  match found {
    Some(value) -> write_json(out: respond(status: 200), value)
    None -> problem(status: 404, reason: "no such sale")
  }
}
fn sections(out: Buf, rows: Rows[Section], first: Bool) -> Buf {
  match next(rows) {
    Next(value, rest) if first -> sections(out: write_json(out, value), rows: rest, first: False)
    Next(value, rest) -> sections(out: write_json(out: push(buf: out, byte: 44), value), rows: rest, first: False)
    End -> push(buf: out, byte: 93)
  }
}
// The seats go back with the sale this request voided, and only then: two retries of one sale that both hear the
// refusal (it is stored, so both do) void it once and free its seats once.
fn free(db: Sql, section: View, qty: Int, voided: Int) -> Int {
  sql_exec(db, query: "UPDATE sections SET seats = seats + :qty WHERE name = :section AND :voided = 1", qty, section, voided)
}
fn declined(reason: View, freed: Int) -> Buf {
  problem(status: 402, reason)
}

fn ticket(found: Option[Ticket]) -> Buf {
  match found {
    Some(value) -> write_json(out: respond(status: 201), value)
    None -> problem(status: 500, reason: "the sale vanished")
  }
}

// Paid sales, summed per section into the immutable map (kept in key order).
fn tally(rows: Rows[Line], totals: Map[Tally]) -> Map[Tally] {
  match next(rows) {
    Next(value: Line(section, qty, amount), rest) -> tally(rows: rest, totals: put(map: totals, key: section, value: add(was: get(map: totals, key: section), qty, amount)))
    End -> totals
  }
}

fn add(was: Option[Tally], qty: Int, amount: Int) -> Tally {
  match was {
    Some(value: Tally(seats, revenue)) -> Tally(seats: seats + qty, revenue: revenue + amount)
    None -> Tally(seats: qty, revenue: amount)
  }
}

fn report(totals: Map[Tally]) -> Buf {
  push(buf: entries(out: push(buf: respond(status: 200), byte: 123), totals, first: True), byte: 125)
}

// In order: left subtree, this entry, right subtree. `first` is whether nothing has been written yet.
fn entries(out: Buf, totals: Map[Tally], first: Bool) -> Buf {
  match totals {
    Empty -> out
    Node(left, key, value, right) -> entries(out: entry(out: entries(out, totals: left, first), key, value, first: first and count(map: left) == 0), totals: right, first: False)
  }
}

fn entry(out: Buf, key: View, value: Tally, first: Bool) -> Buf {
  match {
    first -> write_json(out: push(buf: write_json_string(out, text: key), byte: 58), value)
    else -> write_json(out: push(buf: write_json_string(out: push(buf: out, byte: 44), text: key), byte: 58), value)
  }
}

fn problem(status: Int, reason: View) -> Buf {
  append(buf: write_json_string(out: append(buf: respond(status), view: "{\"error\":"), text: reason), view: "}")
}
