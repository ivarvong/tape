// tickets.tape: an event box office. Events have tiers with a capacity; a buyer holds seats for a few minutes,
// checks out with a card (the `pay` program, called with a once key), and gets one ticket per seat. Holds that are
// not paid in time expire by a timer, and their seats go to the waitlist. Tickets can be transferred; an order can
// be refunded; an admin can cancel an event, which refunds every order.
//
//   GET  /events                         every event with its tiers and seats left
//   GET  /events/<id>
//   POST /events                         {"key","name","starts","tiers"?: [{"key","name","price","capacity"}]}   (admin)
//   POST /events/<id>/tiers              {"key","name","price","capacity"}             (admin)
//   POST /events/<id>/cancel                                                            (admin)
//   POST /holds                          {"key","tier","buyer","qty","seconds"?}       201 held | 409 sold out
//   GET  /holds/<id>
//   POST /holds/<id>/checkout            {"card"}        200 confirmed | 402 declined | 202 outcome unknown
//   POST /holds/<id>/release
//   POST /holds/<id>/refund
//   POST /waitlist                       {"key","tier","buyer","qty"}
//   GET  /users/<buyer>/tickets
//   POST /tickets/<id>/transfer          {"from","to"}
//   GET  /audit                          every tier, hold, ticket and waitlist row, for a checker   (admin)
//
// The pages (HTML, server-rendered, plain forms; every link is relative, so they work under /p/:account/:name/ and
// /:account/:name/v/:version/ alike):
//
//   GET  /                               events, tiers, a form to hold seats or join the waitlist
//   GET  /hold?id=<id>                   one hold: pay for it, release it, or see its tickets
//   GET  /me?buyer=<buyer>               a buyer's holds and tickets, with a form to transfer each ticket
//   POST /buy  /wait  /pay?id=  /release?id=  /give?id=     the forms; each answers the page it leads to
//
// Admin routes answer only the operator (std/http: caller Operator); through the public route they are 403.
// A buyer is a name in the request: the service passes no headers, so there are no sessions or cookies.

migration 1 "box office" {
  CREATE TABLE events(
    id INTEGER PRIMARY KEY,
    client TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    starts TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'onsale' CHECK (state IN ('onsale', 'canceled'))
  );
  CREATE TABLE tiers(
    id INTEGER PRIMARY KEY,
    client TEXT NOT NULL UNIQUE,
    event INTEGER NOT NULL,
    name TEXT NOT NULL,
    price INTEGER NOT NULL CHECK (price >= 0),
    capacity INTEGER NOT NULL CHECK (capacity >= 0),
    left INTEGER NOT NULL CHECK (left >= 0 AND left <= capacity)
  );
  CREATE TABLE holds(
    id INTEGER PRIMARY KEY,
    client TEXT NOT NULL UNIQUE,
    tier INTEGER NOT NULL,
    buyer TEXT NOT NULL,
    qty INTEGER NOT NULL CHECK (qty >= 1),
    amount INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'held',
    card TEXT NOT NULL DEFAULT '',
    attempt INTEGER NOT NULL DEFAULT 0,
    expires INTEGER NOT NULL,
    note TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE tickets(
    id INTEGER PRIMARY KEY,
    hold INTEGER NOT NULL,
    seat INTEGER NOT NULL,
    owner TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'valid',
    UNIQUE (hold, seat)
  );
  CREATE TABLE waitlist(
    id INTEGER PRIMARY KEY,
    client TEXT NOT NULL UNIQUE,
    tier INTEGER NOT NULL,
    buyer TEXT NOT NULL,
    qty INTEGER NOT NULL CHECK (qty >= 1),
    state TEXT NOT NULL DEFAULT 'waiting',
    hold INTEGER NOT NULL DEFAULT 0
  )
}

migration 2 "demo events" {
  INSERT INTO events(id, client, name, starts) VALUES (1, 'demo-1', 'Tape Live: The Retry Tour', '2026-12-05T20:00'), (2, 'demo-2', 'Idempotency Unplugged', '2026-12-12T19:30');
  INSERT INTO tiers(client, event, name, price, capacity, left) VALUES ('demo-1-floor', 1, 'floor', 8500, 20, 20), ('demo-1-balcony', 1, 'balcony', 4500, 50, 50), ('demo-2-front', 2, 'front row', 12000, 4, 4), ('demo-2-general', 2, 'general', 3000, 100, 100)
}

// How many times in a row a paying hold's charge came back unknown. Before it, a charge that never answered was
// asked about every 5 s for ever (jepsen-tix-c1: about 17,000 timers a day for days).
migration 3 "payment asks" {
  ALTER TABLE holds ADD COLUMN tries INTEGER NOT NULL DEFAULT 0
}

// How many times in a row a canceled event's sweep found a charge or refund still out and waited. Before it, the
// sweep re-armed a 5 s timer for as long as one was out. (holds.tries counts a refund's unknown answers too.)
migration 4 "sweep waits" {
  ALTER TABLE events ADD COLUMN waits INTEGER NOT NULL DEFAULT 0
}

machine events.state {
  "onsale" -> "canceled"
}

machine holds.state {
  "held" -> "paying"
  "held" -> "expired"
  "held" -> "released"
  "paying" -> "held"
  "paying" -> "confirmed"
  "paying" -> "unresolved"
  "confirmed" -> "refunding"
  "refunding" -> "refunded"
  "refunding" -> "refund_failed"
  "refunding" -> "refund_unresolved"
}

machine tickets.state {
  "valid" -> "refunded"
}

machine waitlist.state {
  "waiting" -> "offered"
  "waiting" -> "dropped"
}

flag hold_seconds: Int = 300
flag max_per_hold: Int = 8

type Key = View where len(self) >= 1 and len(self) <= 64
type Name = View where len(self) >= 1 and len(self) <= 120
type Buyer = View where len(self) >= 1 and len(self) <= 40
type Qty = Int where self >= 1 and self <= flags.max_per_hold
type Seconds = Int where self >= 2 and self <= 900
type Money = Int where self >= 0 and self <= 10000000
type Seats = Int where self >= 0 and self <= 100000

type NewTier { NewTier(key: Key, name: Name, price: Money, capacity: Seats) }
type NewEvent { NewEvent(key: Key, name: Name, starts: Name, tiers: Option[List[NewTier]]) }
type HoldReq { HoldReq(key: Key, tier: Int, buyer: Buyer, qty: Qty, seconds: Option[Seconds]) }
type Checkout { Checkout(card: Key) }
type WaitReq { WaitReq(key: Key, tier: Int, buyer: Buyer, qty: Qty) }
type Transfer { Transfer(from: Buyer, to: Buyer) }

type Event { Event(id: Int, name: View, starts: View, state: View) }
type Tier { Tier(id: Int, event: Int, name: View, price: Int, capacity: Int, left: Int) }
type Hold { Hold(
  id: Int,
  tier: Int,
  buyer: View,
  qty: Int,
  amount: Int,
  state: View,
  card: View,
  attempt: Int,
  expires: Int,
  note: View
) }
type Ticket { Ticket(id: Int, hold: Int, seat: Int, owner: View, state: View) }
type Wait { Wait(id: Int, tier: Int, buyer: View, qty: Int, state: View, hold: Int) }
type Price { Price(price: Int) }
type Count { Count(n: Int) }
type Id { Id(id: Int) }
type Failed { Failed(error: View) }
type Finished { Finished(done: View) }

// the pay program's methods
type Charge { Charge(card: View, amount: Int, ref: View) }
type Charged { Charged(payment: Int) }
type Refund { Refund(card: View, amount: Int, ref: View) }
type Refunded { Refunded(payment: Int) }
// A charge's once key is the hold and the attempt: a declined card is a finished command, so paying again with
// another card is a new one (the same key with another message would be answered skew, an unknown outcome).
type PayFor { PayFor(hold: Int, attempt: Int) }
type RefundFor { RefundFor(hold: Int) }

// What a request or a timer ends with; handle renders it, woken returns it.
type Outcome {
  ShowEvent(status: Int, event: Event)
  ShowHold(status: Int, hold: Hold)
  ShowTicket(status: Int, ticket: Ticket)
  ShowWait(status: Int, wait: Wait)
  ShowTier(status: Int, tier: Tier)
  Problem(status: Int, reason: View)
  Done(status: Int, what: View)
  // the request's writes are undone, and it answers this
  Undo(status: Int, reason: View)
}

fn handle(raw: View, db: Sql, pay: Remote, clock: Clock, timer: Timer, dice: Entropy) -> Buf {
  match request(raw) {
    Request(method: "GET", path: "/events") -> events(
      out: push(buf: respond_as(status: 200, content: Json), byte: 91),
      rows: sql_all(row: Event, query: "SELECT * FROM events ORDER BY id"),
      first: True
    )
    Request(method: "GET", path: "/events/" ++ decimal(id)) -> event_page(
      found: sql_first(row: Event, query: "SELECT * FROM events WHERE id = :id", id)
    )
    Request(
      method: "GET",
      path: "/users/" ++ buyer ++ "/tickets"
    ) -> respond_as(status: 200, content: Json)
      |> write_rows(rows: sql_all(
        row: Ticket,
        query: "SELECT * FROM tickets WHERE owner = :buyer ORDER BY id",
        buyer
      ))
    Request(
      method: "GET",
      path: "/holds/" ++ decimal(id)
    ) -> rendered(outcome: shown_hold(found: load_hold(id)))
    Request(method: "GET", path: "/audit", caller: Operator) -> audit(out: json_head(status: 200))
    Request(method: "GET", path: "/") -> home(out: page_top(status: 200, title: "Box office"))
    Request(method: "GET", path: "/hold", query: Some(value: q)) -> hold_page(
      status: 200,
      found: load_hold(id: number(field: form_field(body: q, name: "id")))
    )
    Request(method: "GET", path: "/me", query: Some(value: q)) -> me_page(
      status: 200,
      buyer: text_of(field: form_field(body: q, name: "buyer"))
    )
    Request(
      method: "POST",
      path: "/" ++ form,
      query,
      body
    ) if is_form(form) -> form_post(form, query: text_of(field: query), body)
    Request(method, path, body, caller) -> rendered(outcome: routed(method, path, body, caller))
  }
}

fn routed(method: View, path: View, body: View, caller: Caller) -> Outcome {
  match method {
    "POST" -> posted(path, body, caller)
    _ -> Problem(status: 404, reason: "no such route")
  }
}

// The admin routes are reached only on the Operator arm; a public caller's request goes to buyer_post, where they
// are 403. (Arguments are evaluated before a call, so the check is this match, not a helper taking the outcome.)
fn posted(path: View, body: View, caller: Caller) -> Outcome {
  match caller {
    Operator -> operator_post(path, body)
    Anyone -> buyer_post(path, body)
  }
}

fn operator_post(path: View, body: View) -> Outcome {
  match path {
    "/events" -> new_event(body)
    "/events/" ++ decimal(id) ++ "/tiers" -> new_tier(event: id, body)
    "/events/" ++ decimal(id) ++ "/cancel" -> cancel_event(id)
    "/holds/" ++ decimal(id) ++ "/refund" -> refund(id)
    _ -> buyer_post(path, body)
  }
}

fn buyer_post(path: View, body: View) -> Outcome {
  match path {
    "/holds" -> new_hold(body)
    "/holds/" ++ decimal(id) ++ "/checkout" -> checkout(id, body)
    "/holds/" ++ decimal(id) ++ "/release" -> release(id)
    "/waitlist" -> join_waitlist(body)
    "/tickets/" ++ decimal(id) ++ "/transfer" -> transfer(id, body)
    "/events" ++ _ -> Problem(status: 403, reason: "events are made and canceled by the operator")
    "/holds/" ++ decimal(id) ++ "/refund" -> Problem(
      status: 403,
      reason: "refunds are the operator's"
    )
    _ -> Problem(status: 404, reason: "no such route")
  }
}

// ---- events and tiers

fn new_event(body: View) -> Outcome {
  let Ok(value: NewEvent(key, name, starts, tiers)) = decode(json: body, as: NewEvent) else {
    Err(error) -> Problem(status: 400, reason: error)
  }
  let Some(value: event) = sql_first(
    row: Event,
    query: "INSERT INTO events(client, name, starts) VALUES (:key, :name, :starts) \
        ON CONFLICT(client) DO NOTHING RETURNING *",
    key,
    name,
    starts
  ) else {
    None -> event_again(
      found: sql_first(row: Event, query: "SELECT * FROM events WHERE client = :key", key)
    )
  }
  do add_tiers(event: event.id, tiers: listed(tiers))
  ShowEvent(status: 201, event)
}

fn listed(tiers: Option[List[NewTier]]) -> List[NewTier] {
  match tiers {
    Some(value) -> value
    None -> Nil
  }
}

// The tiers sent with a new event, in the event's own transaction: all of them, or (the event's key seen before)
// none again.
fn add_tiers(event: Int, tiers: List[NewTier]) -> Int {
  match tiers {
    Cons(head: NewTier(key, name, price, capacity), tail) -> {
      do sql_exec(
        query: "INSERT INTO tiers(client, event, name, price, capacity, left) \
            SELECT :key, id, :name, :price, :capacity, :capacity FROM events WHERE id = :event \
            AND state = 'onsale' ON CONFLICT(client) DO NOTHING",
        key,
        name,
        price,
        capacity,
        event
      )
      add_tiers(event, tiers: tail)
    }
    Nil -> 0
  }
}

fn event_again(found: Option[Event]) -> Outcome {
  let Some(value: event) = found else -> Problem(status: 500, reason: "the event vanished")
  ShowEvent(status: 200, event)
}

fn new_tier(event: Int, body: View) -> Outcome {
  let Ok(value: NewTier(key, name, price, capacity)) = decode(json: body, as: NewTier) else {
    Err(error) -> Problem(status: 400, reason: error)
  }
  let Some(value: tier) = sql_first(
    row: Tier,
    query: "INSERT INTO tiers(client, event, name, price, capacity, left) \
        SELECT :key, id, :name, :price, :capacity, :capacity FROM events WHERE id = :event \
        AND state = 'onsale' ON CONFLICT(client) DO NOTHING RETURNING *",
    key,
    name,
    price,
    capacity,
    event
  ) else {
    None -> tier_again(
      found: sql_first(row: Tier, query: "SELECT * FROM tiers WHERE client = :key", key)
    )
  }
  ShowTier(status: 201, tier)
}

fn tier_again(found: Option[Tier]) -> Outcome {
  let Some(value: tier) = found else -> Problem(status: 404, reason: "no such event on sale")
  ShowTier(status: 200, tier)
}

// ---- holds

// Take the seats and write the hold in one transaction (no call in between). A retry with the same key finds
// the hold it made and takes nothing.
fn new_hold(body: View) -> Outcome {
  let Ok(value: HoldReq(key, tier, buyer, qty, seconds)) = decode(json: body, as: HoldReq) else {
    Err(error) -> Problem(status: 400, reason: error)
  }
  let Some(value: Price(price)) = sql_first(
    row: Price,
    query: "UPDATE tiers SET left = left - :qty WHERE id = :tier AND left >= :qty \
        AND NOT EXISTS (SELECT 1 FROM holds WHERE client = :key AND tier = :tier) \
        AND (SELECT state FROM events WHERE events.id = tiers.event) = 'onsale' RETURNING price",
    qty,
    tier,
    key
  ) else {
    None -> hold_again(
      found: sql_first(row: Hold, query: "SELECT * FROM holds WHERE client = :key", key)
    )
  }
  let ms = 1000 * secs(seconds)
  let Some(value: hold) = sql_first(
    row: Hold,
    query: "INSERT INTO holds(client, tier, buyer, qty, amount, expires) \
        VALUES (:key, :tier, :buyer, :qty, :amount, :expires) ON CONFLICT(client) \
        DO NOTHING RETURNING *",
    key,
    tier,
    buyer,
    qty,
    amount: price * qty,
    expires: now() + ms
  ) else {
    None -> Undo(status: 409, reason: "this key was used for a hold on another tier")
  }
  do wake(after: ms, key: hold.id)
  ShowHold(status: 201, hold)
}

fn secs(seconds: Option[Seconds]) -> Int {
  match seconds {
    Some(value) -> value
    None -> flags.hold_seconds
  }
}

fn hold_again(found: Option[Hold]) -> Outcome {
  match found {
    Some(value: hold) -> ShowHold(status: 200, hold)
    None -> Problem(
      status: 409,
      reason: "not enough seats left in that tier, or the event is not on sale; \
          POST /waitlist to wait for one"
    )
  }
}

fn load_hold(id: Int) -> Option[Hold] {
  sql_first(row: Hold, query: "SELECT * FROM holds WHERE id = :id", id)
}

fn shown_hold(found: Option[Hold]) -> Outcome {
  let Some(value: hold) = found else -> Problem(status: 404, reason: "no such hold")
  ShowHold(status: 200, hold)
}

// ---- checkout
// The hold moves to paying (with the card) before the charge goes out: a call is a commit point, and a hold that
// is paying is never expired. The charge is keyed by the hold, so a retry, a second click or the expiry timer
// that sends it again learns the first outcome instead of charging twice.
fn checkout(id: Int, body: View) -> Outcome {
  let Ok(value: Checkout(card)) = decode(json: body, as: Checkout) else {
    Err(error) -> Problem(status: 400, reason: error)
  }
  let Some(value: hold) = load_hold(id) else -> Problem(status: 404, reason: "no such hold")
  match hold {
    Hold(state: "held", expires) if expires <= now() -> Problem(
      status: 410,
      reason: "this hold has expired"
    )
    Hold(state: "held") -> paying(moved: sql_move(
      row: Hold,
      query: "UPDATE holds SET state = 'paying', card = :card, attempt = attempt + 1, tries = 0 \
          WHERE id = :id AND state = 'held' RETURNING *",
      card,
      id
    ))
    Hold(state: "paying") -> charge(hold)
    Hold(state: "confirmed") -> ShowHold(status: 200, hold)
    Hold(state) -> Problem(status: 409, reason: "this hold is " ++ state)
  }
}

fn paying(moved: Move[Hold]) -> Outcome {
  match moved {
    Moved(value) -> charge(hold: value)
    Raced(now: hold = Hold(state: "paying")) -> charge(hold)
    Raced(now) -> ShowHold(status: 409, hold: now)
    NoRow -> Problem(status: 404, reason: "no such hold")
  }
}

fn charge(hold: Hold) -> Outcome {
  let Hold(id, card, amount, attempt) = hold
  charged(
    id,
    tries: tries_of(id),
    reply: call(
      to: pay,
      method: "charge",
      send: Charge(card, amount, ref: "hold-\(id)"),
      reply: Charged,
      within: 2000,
      once: PayFor(hold: id, attempt)
    )
  )
}

fn charged(id: Int, tries: Int, reply: Result[Charged, CallError]) -> Outcome {
  match reply {
    Ok(value) -> confirmed(moved: sql_move(
      row: Hold,
      query: "UPDATE holds SET state = 'confirmed', note = '' WHERE id = :id \
          AND state = 'paying' RETURNING *",
      id
    ))
    Err(error: Rejected(reason)) -> declined(
      reason,
      moved: sql_move(
        row: Hold,
        query: "UPDATE holds SET state = 'held', note = :reason WHERE id = :id \
            AND state = 'paying' RETURNING *",
        reason,
        id
      )
    )
    Err(error) -> unknown(id, n: tries)
  }
}

// An unknown outcome: the charge may have been made. The timer asks pay again with the same once key, waiting
// longer each time (std/retry backoff: 5 s, doubling, at most 10 min); after `tries` unknown answers in a row the
// hold rests in unresolved, its seats still taken, for a person to settle with pay (its last timer then finds it
// so and sets none). The count moves by compare-and-set from the count read before the ask (tries_of), so a run
// woken twice, or a checkout sent twice at once, counts once (refund_unknown found it first).
fn pay_retry() -> Backoff {
  Backoff(first: 5000, factor: 2, most: 600000, tries: 10)
}

fn unknown(id: Int, n: Int) -> Outcome {
  // first the shortest wait, so no way out of this run leaves the hold without a timer; ask_again moves it later
  do wake(after: 5000, key: id)
  match sql_move(
    row: Count,
    query: "UPDATE holds SET tries = :n + 1, note = 'payment outcome unknown; it is asked again' \
        WHERE id = :id AND state = 'paying' AND tries = :n RETURNING tries AS n",
    n,
    id
  ) {
    Moved(value: Count(n: asks)) -> ask_again(
      id,
      decided: backoff(policy: pay_retry(), failed: asks)
    )
    // another run counted first, or the hold left paying: decide from its count (a timer for a hold no longer
    // paying finds it settled; giving up moves nothing)
    Raced(now: Count(n: seen)) -> ask_again(id, decided: backoff(policy: pay_retry(), failed: seen))
    NoRow -> Problem(status: 404, reason: "no such hold")
  }
}

fn ask_again(id: Int, decided: Retry) -> Outcome {
  match decided {
    RetryIn(after) -> {
      do wake(after, key: id)
      asked(found: load_hold(id))
    }
    GaveUp(tries) -> gave_up(moved: sql_move(
      row: Hold,
      query: "UPDATE holds SET state = 'unresolved', note = 'payment outcome still unknown after \
          ' || :tries || ' asks; settle it with pay' WHERE id = :id AND state = 'paying' \
          RETURNING *",
      tries,
      id
    ))
  }
}

fn asked(found: Option[Hold]) -> Outcome {
  let Some(value: hold) = found else -> Problem(status: 404, reason: "no such hold")
  ShowHold(status: 202, hold)
}

fn gave_up(moved: Move[Hold]) -> Outcome {
  match moved {
    Moved(value) -> ShowHold(status: 202, hold: value)
    Raced(now) -> ShowHold(status: 200, hold: now)
    NoRow -> Problem(status: 404, reason: "no such hold")
  }
}

// Paid: one ticket per seat. INSERT OR IGNORE on (hold, seat), so two requests that both heard the charge's
// stored reply write the tickets once.
fn confirmed(moved: Move[Hold]) -> Outcome {
  match moved {
    Moved(value: hold = Hold(id, buyer, qty)) -> {
      do issue(hold: id, buyer, seat: 1, qty)
      ShowHold(status: 200, hold)
    }
    Raced(now) -> ShowHold(status: 200, hold: now)
    NoRow -> Problem(status: 404, reason: "no such hold")
  }
}

fn issue(hold: Int, buyer: View, seat: Int, qty: Int) -> Int {
  match {
    seat > qty -> qty
    else -> {
      do sql_exec(
        query: "INSERT INTO tickets(hold, seat, owner) VALUES (:hold, :seat, :buyer) \
            ON CONFLICT(hold, seat) DO NOTHING",
        hold,
        seat,
        buyer
      )
      issue(hold, buyer, seat: seat + 1, qty)
    }
  }
}

fn declined(reason: View, moved: Move[Hold]) -> Outcome {
  match moved {
    Moved(value: Hold(id)) -> {
      do wake(after: 0, key: id)
      held_again(reason)
    }
    Raced(now) -> ShowHold(status: 409, hold: now)
    NoRow -> Problem(status: 404, reason: "no such hold")
  }
}

// Back to held: its expiry timer may have fired while it was paying (and asked pay itself), so a timer is set in the
// same commit; `due` expires it if its time is up, or sets the timer for its expiry. Without it, a hold declined
// after its time was up stayed held for ever with its seats: found by the prod Jepsen run (jepsen-tix-d6).
fn held_again(reason: View) -> Outcome {
  Problem(
    status: 402,
    reason: "card declined: " ++ reason ++ "; the seats stay held until the hold expires"
  )
}

// ---- release, expiry, waitlist

fn release(id: Int) -> Outcome {
  ended(moved: sql_move(
    row: Hold,
    query: "UPDATE holds SET state = 'released' WHERE id = :id AND state = 'held' RETURNING *",
    id
  ))
}

// A hold that ended (released or expired) gives its seats back, then the waitlist is offered them.
fn ended(moved: Move[Hold]) -> Outcome {
  match moved {
    Moved(value: hold = Hold(tier, qty)) -> {
      do sql_exec(query: "UPDATE tiers SET left = left + :qty WHERE id = :tier", qty, tier)
      do promote(tier)
      ShowHold(status: 200, hold)
    }
    Raced(now) -> ShowHold(status: 409, hold: now)
    NoRow -> Problem(status: 404, reason: "no such hold")
  }
}

// The oldest waiting entry whose seats fit gets a hold of its own, with its own timer. One per seats returned is
// enough to keep the line moving: every ended hold promotes again.
fn promote(tier: Int) -> Int {
  let Some(
    value: Wait(id, buyer, qty)
  ) = sql_first(
    row: Wait,
    query: "SELECT w.* FROM waitlist AS w JOIN tiers AS t ON t.id = w.tier WHERE w.tier = :tier \
        AND w.state = 'waiting' AND w.qty <= t.left AND (SELECT state FROM events \
        WHERE events.id = t.event) = 'onsale' ORDER BY w.id LIMIT 1",
    tier
  ) else {
    None -> 0
  }
  let key = "waitlist-\(id)"
  let Some(value: Price(price)) = sql_first(
    row: Price,
    query: "UPDATE tiers SET left = left - :qty WHERE id = :tier AND left >= :qty \
        AND NOT EXISTS (SELECT 1 FROM holds WHERE client = :key AND tier = :tier) RETURNING price",
    qty,
    tier,
    key
  ) else {
    None -> 0
  }
  let ms = 1000 * flags.hold_seconds
  let Some(value: hold) = sql_first(
    row: Hold,
    query: "INSERT INTO holds(client, tier, buyer, qty, amount, expires, note) \
        VALUES (:key, :tier, :buyer, :qty, :amount, :expires, 'offered from the waitlist') \
        ON CONFLICT(client) DO NOTHING RETURNING *",
    key,
    tier,
    buyer,
    qty,
    amount: price * qty,
    expires: now() + ms
  ) else {
    None -> 0
  }
  // read and moved in one transaction, so it is Moved; the other outcomes are typed all the same
  match sql_move(
    row: Wait,
    query: "UPDATE waitlist SET state = 'offered', hold = :hold WHERE id = :id \
        AND state = 'waiting' RETURNING *",
    hold: hold.id,
    id
  ) {
    Moved -> {
      do wake(after: ms, key: hold.id)
      hold.id
    }
    Raced(now) -> 0
    NoRow -> 0
  }
}

fn join_waitlist(body: View) -> Outcome {
  let Ok(value: WaitReq(key, tier, buyer, qty)) = decode(json: body, as: WaitReq) else {
    Err(error) -> Problem(status: 400, reason: error)
  }
  let Some(value: wait) = sql_first(
    row: Wait,
    query: "INSERT INTO waitlist(client, tier, buyer, qty) SELECT :key, id, :buyer, :qty \
        FROM tiers WHERE id = :tier AND (SELECT state FROM events \
        WHERE events.id = tiers.event) = 'onsale' ON CONFLICT(client) DO NOTHING RETURNING *",
    key,
    buyer,
    qty,
    tier
  ) else {
    None -> wait_again(
      found: sql_first(row: Wait, query: "SELECT * FROM waitlist WHERE client = :key", key)
    )
  }
  do promote(tier)
  ShowWait(status: 201, wait)
}

fn wait_again(found: Option[Wait]) -> Outcome {
  let Some(value: wait) = found else -> Problem(status: 404, reason: "no such tier on sale")
  ShowWait(status: 200, wait)
}

// A timer: key > 0 is a hold (expire it, or ask again about its charge); key < 0 is a canceled event to refund.
export fn woken(
  db: Sql,
  pay: Remote,
  clock: Clock,
  timer: Timer,
  message: Wake
) -> Result[Woke, View] {
  let Wake(key) = message
  match {
    key < 0 -> Ok(value: summary(outcome: sweep(event: 0 - key)))
    else -> Ok(value: summary(outcome: due(found: load_hold(id: key))))
  }
}

// What a timer's run answers (its log shows it): a reply must be a flat record.
type Woke { Woke(status: Int, what: View) }

fn summary(outcome: Outcome) -> Woke {
  match outcome {
    ShowHold(status, hold: Hold(id, state)) -> Woke(status, what: "hold \(id) \(state)")
    Problem(status, reason) -> Woke(status, what: reason)
    Done(status, what) -> Woke(status, what)
    ShowEvent(status) -> Woke(status, what: "event")
    _ -> Woke(status: 200, what: "")
  }
}

fn due(found: Option[Hold]) -> Outcome {
  let Some(value: hold) = found else -> Problem(status: 404, reason: "no such hold")
  match hold {
    Hold(id, state: "held", expires) if expires <= now() -> ended(moved: sql_move(
      row: Hold,
      query: "UPDATE holds SET state = 'expired' WHERE id = :id AND state = 'held' RETURNING *",
      id
    ))
    Hold(id, state: "held", expires) -> {
      do wake(after: expires - now(), key: id)
      ShowHold(status: 200, hold)
    }
    Hold(state: "paying") -> charge(hold)
    Hold(state: "refunding") -> refund_hold(hold)
    // every state is named: a state added to the machine does not compile until the timer's run says what it does
    Hold(state: "confirmed") -> ShowHold(status: 200, hold)
    Hold(state: "expired") -> ShowHold(status: 200, hold)
    Hold(state: "released") -> ShowHold(status: 200, hold)
    Hold(state: "refunded") -> ShowHold(status: 200, hold)
    Hold(state: "refund_failed") -> ShowHold(status: 200, hold)
    Hold(state: "unresolved") -> ShowHold(status: 200, hold)
    Hold(state: "refund_unresolved") -> ShowHold(status: 200, hold)
  }
}

// ---- refunds and cancel

// The timer is set in the same commit as the move to refunding, before the call: a run cut short while the
// refund is out (its object reset) leaves the hold refunding, and the timer's run (due) asks again with the same
// once key. Without it nothing comes back for the hold: found by the prod Jepsen run, seed 1.
fn refund(id: Int) -> Outcome {
  match sql_move(
    row: Hold,
    query: "UPDATE holds SET state = 'refunding', tries = 0 WHERE id = :id \
        AND state = 'confirmed' RETURNING *",
    id
  ) {
    Moved(value) -> {
      do wake(after: 5000, key: id)
      refund_hold(hold: value)
    }
    Raced(now) -> refund_again(found: Some(value: now))
    NoRow -> Problem(status: 404, reason: "no such hold")
  }
}

fn refund_again(found: Option[Hold]) -> Outcome {
  match found {
    Some(value: hold = Hold(state: "refunding")) -> refund_hold(hold)
    Some(value: hold = Hold(state: "refunded")) -> ShowHold(status: 200, hold)
    Some(value: Hold(state)) -> Problem(
      status: 409,
      reason: "only a confirmed order can be refunded; this one is " ++ state
    )
    None -> Problem(status: 404, reason: "no such hold")
  }
}

fn refund_hold(hold: Hold) -> Outcome {
  let Hold(id, card, amount) = hold
  refunded(
    id,
    tries: tries_of(id),
    reply: call(
      to: pay,
      method: "refund",
      send: Refund(card, amount, ref: "hold-\(id)"),
      reply: Refunded,
      within: 2000,
      once: RefundFor(hold: id)
    )
  )
}

// The count of unknown answers as it was before an ask (refund_unknown moves it on from there).
fn tries_of(id: Int) -> Int {
  match sql_first(row: Count, query: "SELECT tries AS n FROM holds WHERE id = :id", id) {
    Some(value: Count(n)) -> n
    None -> 0
  }
}

fn refund_refused(moved: Move[Hold]) -> Outcome {
  match moved {
    Moved(value) -> ShowHold(status: 200, hold: value)
    Raced(now) -> ShowHold(status: 200, hold: now)
    NoRow -> Problem(status: 404, reason: "no such hold")
  }
}

fn refunded(id: Int, tries: Int, reply: Result[Refunded, CallError]) -> Outcome {
  match reply {
    Ok(value) -> settled(moved: sql_move(
      row: Hold,
      query: "UPDATE holds SET state = 'refunded', note = '' WHERE id = :id \
          AND state = 'refunding' RETURNING *",
      id
    ))
    // A refund the payment service refuses will be refused again (the key gets the reply it got): the hold rests in
    // refund_failed with the reason, its tickets still valid and its seats still taken, for a person to settle.
    // Found by `tape sim` standing in for pay: before this arm the timer asked again for ever.
    Err(error: Rejected(reason)) -> refund_refused(moved: sql_move(
      row: Hold,
      query: "UPDATE holds SET state = 'refund_failed', note = :reason WHERE id = :id \
          AND state = 'refunding' RETURNING *",
      reason,
      id
    ))
    Err(error) -> refund_unknown(id, n: tries)
  }
}

// A refund with an unknown outcome, as unknown() for a charge: the timer asks pay again with the same once key,
// waiting pay_retry()'s backoff, and after its tries unknown answers in a row the hold rests in refund_unresolved
// (tickets still valid, seats still taken, the money refunded or not) for a person to settle with pay. Before it the
// timer asked again every 5 s for ever. `n` is the count read before the ask, so two asks out at once (a request sent
// twice) count once: the second's compare-and-set loses and takes the first's count (`tape sim` found a duplicate
// request counting twice when the count was read after the call).
fn refund_unknown(id: Int, n: Int) -> Outcome {
  do wake(after: 5000, key: id)
  match sql_move(
    row: Count,
    query: "UPDATE holds SET tries = :n + 1, note = 'refund outcome unknown; it is asked again' \
        WHERE id = :id AND state = 'refunding' AND tries = :n RETURNING tries AS n",
    n,
    id
  ) {
    Moved(value: Count(n: asks)) -> refund_ask_again(
      id,
      decided: backoff(policy: pay_retry(), failed: asks)
    )
    Raced(now: Count(n: seen)) -> refund_ask_again(
      id,
      decided: backoff(policy: pay_retry(), failed: seen)
    )
    NoRow -> Problem(status: 404, reason: "no such hold")
  }
}

fn refund_ask_again(id: Int, decided: Retry) -> Outcome {
  match decided {
    RetryIn(after) -> {
      do wake(after, key: id)
      shown_hold(found: load_hold(id))
    }
    GaveUp(tries) -> refund_refused(moved: sql_move(
      row: Hold,
      query: "UPDATE holds SET state = 'refund_unresolved', note = 'refund outcome still unknown \
          after ' || :tries || ' asks; settle it with pay' WHERE id = :id \
          AND state = 'refunding' RETURNING *",
      tries,
      id
    ))
  }
}

fn settled(moved: Move[Hold]) -> Outcome {
  match moved {
    Moved(value: hold = Hold(id, tier, qty)) -> {
      do sql_exec(
        query: "UPDATE tickets SET state = 'refunded' WHERE hold = :id AND state = 'valid'",
        id
      )
      do sql_exec(query: "UPDATE tiers SET left = left + :qty WHERE id = :tier", qty, tier)
      do promote(tier)
      ShowHold(status: 200, hold)
    }
    Raced(now) -> ShowHold(status: 200, hold: now)
    NoRow -> Problem(status: 404, reason: "no such hold")
  }
}

fn cancel_event(id: Int) -> Outcome {
  match sql_move(
    row: Event,
    query: "UPDATE events SET state = 'canceled' WHERE id = :id AND state = 'onsale' RETURNING *",
    id
  ) {
    Moved(value) -> {
      do wake(after: 0, key: 0 - id)
      ShowEvent(status: 202, event: value)
    }
    Raced(now) -> resumed(event: now)
    NoRow -> Problem(status: 404, reason: "no such event")
  }
}

// Canceling a canceled event again: a sweep that gave up waiting (sweep_retry) starts again from no waits.
fn resumed(event: Event) -> Outcome {
  let Event(id) = event
  let Some(value: Count(n)) = sql_first(
    row: Count,
    query: "SELECT waits AS n FROM events WHERE id = :id",
    id
  ) else -> Problem(status: 404, reason: "no such event")
  match {
    n >= sweep_tries() -> restarted(
      event,
      moved: sql_move(
        row: Count,
        query: "UPDATE events SET waits = 0 WHERE id = :id AND state = 'canceled' AND waits = :n \
            RETURNING waits AS n",
        n,
        id
      )
    )
    else -> ShowEvent(status: 200, event)
  }
}

fn restarted(event: Event, moved: Move[Count]) -> Outcome {
  let Event(id) = event
  match moved {
    Moved -> {
      do wake(after: 0, key: 0 - id)
      ShowEvent(status: 202, event)
    }
    _ -> ShowEvent(status: 200, event)
  }
}

// One step of refunding a canceled event: end its open holds, drop its waitlist, then refund one confirmed order
// and come back for the next. A charge still out (paying) is waited for: its own timer settles it, and it is
// refunded on a later sweep.
fn sweep(event: Int) -> Outcome {
  do sql_exec(
    query: "UPDATE holds SET state = 'released' WHERE state = 'held' AND tier IN (SELECT id \
        FROM tiers WHERE event = :event)",
    event
  )
  // the released seats are counted back from the holds that still take some (a set, so a second sweep is the same)
  do sql_exec(
    query: "UPDATE tiers SET left = capacity - (SELECT coalesce(sum(qty), 0) FROM holds \
        WHERE holds.tier = tiers.id AND holds.state IN ('held', 'paying', 'confirmed', \
        'refunding', 'refund_failed', 'unresolved', 'refund_unresolved')) WHERE event = :event",
    event
  )
  do sql_exec(
    query: "UPDATE waitlist SET state = 'dropped' WHERE state = 'waiting' AND tier IN (SELECT id \
        FROM tiers WHERE event = :event)",
    event
  )
  let Some(value: Count(n: waits)) = sql_first(
    row: Count,
    query: "SELECT waits AS n FROM events WHERE id = :event",
    event
  ) else -> Problem(status: 404, reason: "no such event")
  let Some(value: Id(id)) = sql_first(
    row: Id,
    query: "SELECT h.id AS id FROM holds AS h JOIN tiers AS t ON t.id = h.tier \
        WHERE t.event = :event AND h.state = 'confirmed' ORDER BY h.id LIMIT 1",
    event
  ) else {
    None -> swept(
      event,
      waits,
      open: sql_first(
        row: Count,
        query: "SELECT count(*) AS n FROM holds AS h JOIN tiers AS t ON t.id = h.tier \
            WHERE t.event = :event AND h.state IN ('paying', 'refunding')",
        event
      )
    )
  }
  // a refund begun is the sweep moving on: its waits count again from none
  do moved_on(moved: sql_move(
    row: Count,
    query: "UPDATE events SET waits = 0 WHERE id = :event AND state = 'canceled' \
        AND waits = :waits RETURNING waits AS n",
    event,
    waits
  ))
  do wake(after: 0, key: 0 - event)
  refund(id)
}

// Whether the reset was this run's or another's, the count is none or was just counted again: nothing more to do.
fn moved_on(moved: Move[Count]) -> Int {
  match moved {
    Moved -> 1
    _ -> 0
  }
}

// While a charge or refund is out the sweep waits for it, longer each time (5 s doubling to 10 min). Each hold's own
// timer settles it within pay_retry()'s tries (at most about 31 min of waits), so 20 waits in a row (about 2 h 10
// min) means something else is wrong: the sweep stops, the event keeps its count, and canceling it again resumes it.
fn sweep_tries() -> Int {
  20
}

fn sweep_retry() -> Backoff {
  Backoff(first: 5000, factor: 2, most: 600000, tries: sweep_tries())
}

// The count moves by compare-and-set, as a hold's tries do, so a sweep woken twice counts once.
fn swept(event: Int, waits: Int, open: Option[Count]) -> Outcome {
  match open {
    Some(value: Count(n)) if n > 0 -> waited(
      event,
      moved: sql_move(
        row: Count,
        query: "UPDATE events SET waits = :waits + 1 WHERE id = :event AND state = 'canceled' \
            AND waits = :waits RETURNING waits AS n",
        waits,
        event
      )
    )
    _ -> Done(status: 200, what: "every order of this event is refunded")
  }
}

fn waited(event: Int, moved: Move[Count]) -> Outcome {
  match moved {
    Moved(value: Count(n)) -> wait_more(event, decided: backoff(policy: sweep_retry(), failed: n))
    Raced(now: Count(n)) -> wait_more(event, decided: backoff(policy: sweep_retry(), failed: n))
    NoRow -> Problem(status: 404, reason: "no such event")
  }
}

fn wait_more(event: Int, decided: Retry) -> Outcome {
  match decided {
    RetryIn(after) -> {
      do wake(after, key: 0 - event)
      Done(status: 202, what: "waiting for charges still out")
    }
    GaveUp(tries) -> Done(
      status: 202,
      what: "gave up waiting for charges still out after \(tries) waits; cancel the event again \
          to resume"
    )
  }
}

// ---- tickets

fn transfer(id: Int, body: View) -> Outcome {
  let Ok(value: Transfer(from, to)) = decode(json: body, as: Transfer) else {
    Err(error) -> Problem(status: 400, reason: error)
  }
  match sql_move(
    row: Ticket,
    query: "UPDATE tickets SET owner = :to WHERE id = :id AND owner = :from AND state = 'valid' \
        RETURNING *",
    to,
    id,
    from
  ) {
    Moved(value) -> ShowTicket(status: 200, ticket: value)
    Raced(now) -> Problem(status: 409, reason: "this ticket is not a valid ticket of " ++ from)
    NoRow -> Problem(status: 404, reason: "no such ticket")
  }
}

// ---- rendering (JSON)

fn rendered(outcome: Outcome) -> Buf {
  match outcome {
    ShowEvent(status, event) -> event_json(out: json_head(status), event)
    ShowHold(status, hold) -> write_json(out: json_head(status), value: hold)
    ShowTicket(status, ticket) -> write_json(out: json_head(status), value: ticket)
    ShowWait(status, wait) -> write_json(out: json_head(status), value: wait)
    ShowTier(status, tier) -> write_json(out: json_head(status), value: tier)
    Problem(status, reason) -> write_json(out: json_head(status), value: Failed(error: reason))
    Done(status, what) -> write_json(out: json_head(status), value: Finished(done: what))
    Undo(status, reason) -> rollback(
      out: write_json(out: json_head(status), value: Failed(error: reason))
    )
  }
}

fn event_page(found: Option[Event]) -> Buf {
  match found {
    Some(value: event) -> event_json(out: json_head(status: 200), event)
    None -> rendered(outcome: Problem(status: 404, reason: "no such event"))
  }
}

// An event with its tiers: {"id":…,…,"tiers":[…]}. write_json writes a flat record, so the tiers are spliced in
// before its closing brace.
fn event_json(out: Buf, event: Event) -> Buf {
  let Event(id, name, starts, state) = event
  out
    |> append(view: "{\"id\":\(id),\"name\":")
    |> write_json_string(text: name)
    |> append(view: ",\"starts\":")
    |> write_json_string(text: starts)
    |> append(view: ",\"state\":")
    |> write_json_string(text: state)
    |> append(view: ",\"tiers\":")
    |> write_rows(
      rows: sql_all(row: Tier, query: "SELECT * FROM tiers WHERE event = :id ORDER BY id", id)
    )
    |> append(view: "}")
}

fn events(out: Buf, rows: Rows[Event], first: Bool) -> Buf {
  match next(rows) {
    Next(value, rest) if first -> events(
      out: event_json(out, event: value),
      rows: rest,
      first: False
    )
    Next(value, rest) -> events(
      out: event_json(out: push(buf: out, byte: 44), event: value),
      rows: rest,
      first: False
    )
    End -> push(buf: out, byte: 93)
  }
}

fn json_head(status: Int) -> Buf {
  respond_as(status, content: Json)
}

// ---- pages (HTML)
// Forms post application/x-www-form-urlencoded; each form is turned into the JSON body its API route takes, so
// the checks (refined types, the key) are the API's. A hold form carries a key made when the page was drawn, so
// posting it twice (a double click, a reload of the answer) holds once.

fn number(field: Option[View]) -> Int {
  match field {
    Some(value: decimal(n)) -> n
    _ -> 0
  }
}

fn text_of(field: Option[View]) -> View {
  match field {
    Some(value) -> value
    None -> ""
  }
}

fn is_form(form: View) -> Bool {
  form == "buy" or form == "wait" or form == "pay" or form == "release" or form == "give"
}

fn form_post(form: View, query: View, body: View) -> Buf {
  let id = number(field: form_field(body: query, name: "id"))
  match form {
    "buy" -> held_page(outcome: new_hold(body: hold_json(form: body)))
    "wait" -> waited_page(outcome: join_waitlist(body: hold_json(form: body)))
    "pay" -> after_page(outcome: checkout(
      id,
      body: freeze(buf: buf() |> append(view: "{\"card\":") |> write_json_string(
        text: text_of(field: form_field(body, name: "card"))
      ) |> append(view: "}"))
    ))
    "release" -> after_page(outcome: release(id))
    "give" -> given_page(outcome: transfer(
      id,
      body: freeze(buf: buf() |> append(view: "{\"from\":") |> write_json_string(
        text: text_of(field: form_field(body, name: "from"))
      ) |> append(view: ",\"to\":") |> write_json_string(
        text: text_of(field: form_field(body, name: "to"))
      ) |> append(view: "}"))
    ))
    _ -> message_page(
      status: 404,
      title: "No such form",
      text: "There is no form here by that name."
    )
  }
}

// {"key","tier","buyer","qty"} from the form's fields; a field that is not a number is sent as 0, which the
// refined types refuse
fn hold_json(form: View) -> View {
  freeze(buf: buf() |> append(view: "{\"key\":") |> write_json_string(
    text: text_of(field: form_field(body: form, name: "key"))
  ) |> append(view: ",\"tier\":") |> write_int(
    value: number(field: form_field(body: form, name: "tier"))
  ) |> append(view: ",\"buyer\":") |> write_json_string(
    text: text_of(field: form_field(body: form, name: "buyer"))
  ) |> append(view: ",\"qty\":") |> write_int(
    value: number(field: form_field(body: form, name: "qty"))
  ) |> append(view: "}"))
}

fn held_page(outcome: Outcome) -> Buf {
  match outcome {
    ShowHold(status, hold) -> hold_page(status, found: Some(value: hold))
    Problem(status, reason) -> message_page(status, title: "No hold", text: reason)
    Undo(status, reason) -> rollback(out: message_page(status, title: "No hold", text: reason))
    _ -> message_page(status: 500, title: "No hold", text: "unexpected")
  }
}

fn waited_page(outcome: Outcome) -> Buf {
  match outcome {
    ShowWait(
      status,
      wait: Wait(state: "offered", hold)
    ) -> hold_page(status, found: load_hold(id: hold))
    ShowWait(status, wait: Wait(buyer)) -> page_top(status, title: "On the waitlist")
      |> append(view: "<p>You are on the waitlist. When seats come back, the first in line gets a \
          hold of their own: look for it on ")
      |> me_link(buyer)
      |> append(view: ".</p>")
      |> page_end
    Problem(status, reason) -> message_page(status, title: "Not on the waitlist", text: reason)
    _ -> message_page(status: 500, title: "Not on the waitlist", text: "unexpected")
  }
}

fn after_page(outcome: Outcome) -> Buf {
  match outcome {
    ShowHold(status, hold) -> hold_page(status, found: Some(value: hold))
    Problem(status, reason) -> message_page(status, title: "Not done", text: reason)
    Undo(status, reason) -> rollback(out: message_page(status, title: "Not done", text: reason))
    _ -> message_page(status: 500, title: "Not done", text: "unexpected")
  }
}

fn given_page(outcome: Outcome) -> Buf {
  match outcome {
    ShowTicket(status, ticket: Ticket(owner)) -> me_page(status, buyer: owner)
    Problem(status, reason) -> message_page(status, title: "Not transferred", text: reason)
    _ -> message_page(status: 500, title: "Not transferred", text: "unexpected")
  }
}

fn page_top(status: Int, title: View) -> Buf {
  respond_as(status, content: Html)
    |> append(view: "<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport \
        content=\"width=device-width,initial-scale=1\"><title>")
    |> write_html(text: title)
    |> append(view: "</title><style>body{font:16px/1.45 \
        system-ui,sans-serif;max-width:46rem;margin:1.5rem auto;padding:0 \
        1rem;color:#1d1d1f}h1{font-size:1.6rem}h2{font-size:1.2rem;margin-top:1.6rem}table{border-collapse:collapse;width:100%}td,th{padding:.35rem .5rem;border-bottom:1px solid #ddd;text-align:left}form{display:inline}input,select,button{font:inherit;padding:.2rem .4rem}input[type=number]{width:3.5rem}input[name=buyer],input[name=to]{width:7rem}.note{color:#666}.bad{color:#b00020}nav{margin-bottom:1rem}</style></head><body><nav><a href=\"./\">Events</a> &middot; <form method=get action=\"me\"><input name=buyer placeholder=\"your name\" required> <button>My tickets</button></form></nav><h1>")
    |> write_html(text: title)
    |> append(view: "</h1>")
}

fn page_end(out: Buf) -> Buf {
  append(
    buf: out,
    view: "<p class=note>Served by a tape program. Every request is a transaction with an effect \
        log; holds expire by a timer; payment goes to another program with a once \
        key.</p></body></html>"
  )
}

fn message_page(status: Int, title: View, text: View) -> Buf {
  page_top(status, title)
    |> append(view: "<p class=bad>")
    |> write_html(text)
    |> append(view: "</p><p><a href=\"./\">Back to the events</a></p>")
    |> page_end
}

fn money(out: Buf, cents: Int) -> Buf {
  out |> append(view: "$\(0.01 * cents)")
}

fn me_link(out: Buf, buyer: View) -> Buf {
  out
    |> append(view: "<a href=\"me?buyer=")
    |> write_html(text: buyer)
    |> append(view: "\">")
    |> write_html(text: buyer)
    |> append(view: "'s tickets</a>")
}

fn home(out: Buf) -> Buf {
  page_events(out, rows: sql_all(row: Event, query: "SELECT * FROM events ORDER BY id")) |> page_end
}

fn page_events(out: Buf, rows: Rows[Event]) -> Buf {
  match next(rows) {
    Next(value: Event(id, name, starts, state), rest) -> page_events(
      out: out
        |> append(view: "<h2>")
        |> write_html(text: name)
        |> append(view: "</h2><p class=note>")
        |> write_html(text: starts)
        |> append(view: " &middot; \
            \(event_state(state))</p><table><tr><th>Tier</th><th>Price</th><th>Left</th><th></th></tr>")
        |> page_tiers(
          rows: sql_all(row: Tier, query: "SELECT * FROM tiers WHERE event = :id ORDER BY id", id),
          open: state == "onsale"
        )
        |> append(view: "</table>"),
      rows: rest
    )
    End -> out
  }
}

fn event_state(state: View) -> View {
  match state {
    "onsale" -> "on sale"
    _ -> "<span class=bad>canceled: every order is refunded</span>"
  }
}

fn page_tiers(out: Buf, rows: Rows[Tier], open: Bool) -> Buf {
  match next(rows) {
    Next(value: Tier(id, name, price, capacity, left), rest) -> page_tiers(
      out: out
        |> append(view: "<tr><td>")
        |> write_html(text: name)
        |> append(view: "</td><td>")
        |> money(cents: price)
        |> append(view: "</td><td>\(left) of \(capacity)</td><td>")
        |> tier_form(tier: id, left, open)
        |> append(view: "</td></tr>"),
      rows: rest,
      open
    )
    End -> out
  }
}

// The key is drawn with the page: the same form posted again is the same hold.
fn tier_form(out: Buf, tier: Int, left: Int, open: Bool) -> Buf {
  match {
    not open -> out
    left > 0 -> out
      |> append(view: "<form method=post action=\"buy\"><input type=hidden name=key \
          value=\"f\(random(from: dice) % 1000000000000)\"><input type=hidden name=tier \
          value=\"\(tier)\"><input name=buyer placeholder=\"your name\" required maxlength=40> \
          <input type=number name=qty value=1 min=1 max=\(flags.max_per_hold)> <button>Hold \
          seats</button></form>")
    else -> out
      |> append(view: "<form method=post action=\"wait\"><input type=hidden name=key \
          value=\"w\(random(from: dice) % 1000000000000)\"><input type=hidden name=tier \
          value=\"\(tier)\"><input name=buyer placeholder=\"your name\" required maxlength=40> \
          <input type=number name=qty value=1 min=1 max=\(flags.max_per_hold)> <button>Sold out: \
          join the waitlist</button></form>")
  }
}

fn hold_page(status: Int, found: Option[Hold]) -> Buf {
  let Some(
    value: hold = Hold(id, tier, buyer, qty, amount, state, expires, note)
  ) = found else -> message_page(
    status: 404,
    title: "No such hold",
    text: "There is no hold with that id."
  )
  page_top(status, title: "Hold \(id)")
    |> append(view: "<p>\(qty) seat(s) for ")
    |> write_html(text: buyer)
    |> append(view: ", ")
    |> money(cents: amount)
    |> append(view: ". State: <b>")
    |> write_html(text: state)
    |> append(view: "</b>.</p>")
    |> hold_note(note)
    |> hold_actions(hold)
    |> append(view: "<p>")
    |> me_link(buyer)
    |> append(view: "</p>")
    |> page_end
}

fn hold_note(out: Buf, note: View) -> Buf {
  match note {
    "" -> out
    _ -> out |> append(view: "<p class=note>") |> write_html(text: note) |> append(view: "</p>")
  }
}

fn hold_actions(out: Buf, hold: Hold) -> Buf {
  let Hold(id, state, expires) = hold
  match state {
    "held" -> out
      |> append(view: "<p>Held for \((expires - now()) / 1000) more seconds.</p><form method=post \
          action=\"pay?id=\(id)\"><select name=card><option value=visa-4242>visa-4242 (has \
          funds)</option><option value=amex-0005>amex-0005 (has funds)</option><option \
          value=poor-0002>poor-0002 (declines)</option></select> <button>Pay</button></form> \
          <form method=post action=\"release?id=\(id)\"><button>Release</button></form>")
    "paying" -> out
      |> append(view: "<p>The payment is being confirmed. <a href=\"hold?id=\(id)\">Reload</a> to \
          see how it ended.</p>")
    "confirmed" -> out
      |> append(view: "<p>Paid. Your tickets are below.</p>")
      |> ticket_rows(rows: sql_all(
        row: Ticket,
        query: "SELECT * FROM tickets WHERE hold = :id ORDER BY seat",
        id
      ))
    _ -> out
  }
}

fn ticket_rows(out: Buf, rows: Rows[Ticket]) -> Buf {
  match next(rows) {
    Next(value: Ticket(id, seat, owner, state), rest) -> ticket_rows(
      out: out
        |> append(view: "<p>Ticket \(id), seat \(seat), held by ")
        |> write_html(text: owner)
        |> append(view: " (")
        |> write_html(text: state)
        |> append(view: ")</p>"),
      rows: rest
    )
    End -> out
  }
}

type Mine { Mine(id: Int, seat: Int, state: View, event: View, tier: View) }
type MyHold { MyHold(id: Int, qty: Int, state: View, tier: View) }

fn me_page(status: Int, buyer: View) -> Buf {
  page_top(status, title: "Tickets of " ++ buyer)
    |> append(
      view: "<table><tr><th>Ticket</th><th>Event</th><th>Tier</th><th>Seat</th><th></th></tr>"
    )
    |> my_tickets(
      buyer,
      rows: sql_all(
        row: Mine,
        query: "SELECT k.id AS id, k.seat AS seat, k.state AS state, e.name AS event, t.name \
            AS tier FROM tickets AS k JOIN holds AS h ON h.id = k.hold JOIN tiers AS t \
            ON t.id = h.tier JOIN events AS e ON e.id = t.event WHERE k.owner = :buyer \
            ORDER BY k.id",
        buyer
      )
    )
    |> append(view: "</table><h2>Holds</h2>")
    |> my_holds(rows: sql_all(
      row: MyHold,
      query: "SELECT h.id AS id, h.qty AS qty, h.state AS state, t.name AS tier FROM holds AS h \
          JOIN tiers AS t ON t.id = h.tier WHERE h.buyer = :buyer ORDER BY h.id DESC LIMIT 20",
      buyer
    ))
    |> page_end
}

fn my_tickets(out: Buf, buyer: View, rows: Rows[Mine]) -> Buf {
  match next(rows) {
    Next(value: Mine(id, seat, state, event, tier), rest) -> my_tickets(
      out: out
        |> append(view: "<tr><td>\(id)</td><td>")
        |> write_html(text: event)
        |> append(view: "</td><td>")
        |> write_html(text: tier)
        |> append(view: "</td><td>\(seat)</td><td>")
        |> give_form(id, buyer, state)
        |> append(view: "</td></tr>"),
      buyer,
      rows: rest
    )
    End -> out
  }
}

fn give_form(out: Buf, id: Int, buyer: View, state: View) -> Buf {
  match state {
    "valid" -> out
      |> append(
        view: "<form method=post action=\"give?id=\(id)\"><input type=hidden name=from value=\""
      )
      |> write_html(text: buyer)
      |> append(view: "\"><input name=to placeholder=\"give to\" required maxlength=40> \
          <button>Transfer</button></form>")
    _ -> out
      |> append(view: "<span class=note>")
      |> write_html(text: state)
      |> append(view: "</span>")
  }
}

fn my_holds(out: Buf, rows: Rows[MyHold]) -> Buf {
  match next(rows) {
    Next(value: MyHold(id, qty, state, tier), rest) -> my_holds(
      out: out
        |> append(view: "<p><a href=\"hold?id=\(id)\">Hold \(id)</a>: \(qty) &times; ")
        |> write_html(text: tier)
        |> append(view: ", ")
        |> write_html(text: state)
        |> append(view: "</p>"),
      rows: rest
    )
    End -> out
  }
}

// ---- audit (the operator's): every row a checker needs, as {"tiers":[…],"holds":[…],"tickets":[…],"waitlist":[…]}
type TierRow { TierRow(id: Int, event: Int, capacity: Int, left: Int) }
type HoldRow { HoldRow(
  id: Int,
  client: View,
  tier: Int,
  buyer: View,
  qty: Int,
  amount: Int,
  state: View,
  card: View,
  attempt: Int,
  expires: Int,
  note: View
) }

fn audit(out: Buf) -> Buf {
  out
    |> append(view: "{\"tiers\":")
    |> write_rows(rows: sql_all(row: TierRow, query: "SELECT * FROM tiers ORDER BY id"))
    |> append(view: ",\"holds\":")
    |> write_rows(rows: sql_all(row: HoldRow, query: "SELECT * FROM holds ORDER BY id"))
    |> append(view: ",\"tickets\":")
    |> write_rows(rows: sql_all(row: Ticket, query: "SELECT * FROM tickets ORDER BY id"))
    |> append(view: ",\"waitlist\":")
    |> write_rows(rows: sql_all(row: Wait, query: "SELECT * FROM waitlist ORDER BY id"))
    |> append(view: "}")
}

// ---- what must hold of the rows
// The rows a SELECT returns are what is wrong. The first four hold after every commit; the `settled` ones once
// nothing is in flight and no timer is set. sim.mjs checks them at every step of every script; host.mjs's
// invariants() runs them on any database.

invariant "a tier's seats left and seats held add up to its capacity" {
  SELECT t.id, t.left, t.capacity FROM tiers AS t WHERE t.left + (SELECT coalesce(sum(h.qty), 0) FROM holds AS h WHERE h.tier = t.id AND h.state IN ('held', 'paying', 'confirmed', 'refunding', 'refund_failed', 'unresolved', 'refund_unresolved')) <> t.capacity
}

invariant "a tier has no fewer than no seats left, and no more than it holds" {
  SELECT id, left, capacity FROM tiers WHERE left < 0 OR left > capacity
}

invariant "only a paid hold has tickets" {
  SELECT k.id, h.state FROM tickets AS k JOIN holds AS h ON h.id = k.hold WHERE h.state NOT IN ('confirmed', 'refunding', 'refunded', 'refund_failed', 'refund_unresolved')
}

invariant "a confirmed hold has one valid ticket for each seat" {
  SELECT h.id, h.qty FROM holds AS h WHERE h.state = 'confirmed' AND (SELECT count(*) FROM tickets AS k WHERE k.hold = h.id AND k.state = 'valid') <> h.qty
}

invariant "no hold is left held, paying or refunding" settled {
  SELECT id, state, note FROM holds WHERE state IN ('held', 'paying', 'refunding')
}

// A paying hold is asked about at most pay_retry()'s tries times before it rests in unresolved: no timer re-arms
// for ever (jepsen-tix-c1, before the cap).
invariant "no hold is asked about its payment more often than the retry policy allows" {
  SELECT id, state, tries FROM holds WHERE tries > 10 OR (state LIKE '%unresolved' AND tries <> 10)
}

// A canceled event's sweep waits at most sweep_tries() times in a row before it stops (before the cap it waited every
// 5 s for as long as a charge was out).
invariant "no sweep waits more often than its retry policy allows" {
  SELECT id, state, waits FROM events WHERE waits > 20 OR (waits > 0 AND state <> 'canceled')
}

invariant "a canceled event has no paid hold and nobody waiting" settled {
  SELECT t.id AS tier FROM tiers AS t JOIN events AS e ON e.id = t.event WHERE e.state = 'canceled' AND (EXISTS (SELECT 1 FROM holds AS h WHERE h.tier = t.id AND h.state = 'confirmed') OR EXISTS (SELECT 1 FROM waitlist AS w WHERE w.tier = t.id AND w.state = 'waiting'))
}

// Across two programs: what pay's ledger holds for a hold, against the hold. Only the simulator has both programs'
// rows, so only it runs this one (`tape sim tickets.tape pay.tape`).
invariant "a hold is charged its amount once it is confirmed, and nothing when it is not" settled with pay {
  SELECT h.id, h.state, h.amount, (SELECT coalesce(sum(l.amount), 0) FROM pay.ledger AS l WHERE l.ref = 'hold-' || h.id) AS charged FROM holds AS h WHERE (SELECT coalesce(sum(l.amount), 0) FROM pay.ledger AS l WHERE l.ref = 'hold-' || h.id) <> CASE WHEN h.state IN ('confirmed', 'refund_failed') THEN h.amount WHEN h.state IN ('unresolved', 'refund_unresolved') AND (SELECT coalesce(sum(l.amount), 0) FROM pay.ledger AS l WHERE l.ref = 'hold-' || h.id) = h.amount THEN h.amount ELSE 0 END
}
