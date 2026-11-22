# The Tape language, version 0.1

This is the definition of Tape as it stands: what a program is made of, and the one way to do each job. It is
short on purpose. [The guide](docs/guide.md) teaches; this states. Where the two disagree, this file is right, and where this file
and the compiler disagree, that is a bug in one of them: `test/definition.ts` compiles every program in this file, makes
every edit it shows, and fails when the compiler does not say what the file says.

This is version 0.1. A form that is here has one meaning and one way to be written, and the tests hold the
compiler to it. Before 1.0 a form may still go: when one does, the old way is a compile error that says the new
one, and the last section says what went and when. A program is tied to the compiler it was built with; the
service runs the same compiler on every upload and keeps old versions as built.

## 1. What a program is

A program is one or more `.tape` files compiled together with `std/*.tape` into one Wasm module. It runs as one
Cloudflare Durable Object with one SQLite database. Requests run one at a time between calls: while a request
waits on a call, another may run. Three things hold for every program:

1. **Everything it does to the world is in a log.** SQL, calls to other programs, the clock, random numbers and
   timers are effects. Each is recorded, and a run can be repeated from its log.
2. **Memory is the request's.** Values are immutable. Nothing lives past the request except rows.
3. **What a call can do is visible where it is made.** A function reaches the database, another program, the clock
   or a timer only if it, and everything that calls it, declares that capability as a parameter.

## 2. Text

`//` starts a comment. Integers are decimal. Text literals are in double quotes, on one line, with the escapes
`\" \\ \/ \n \r \t \b \f`. `\(e)` in a literal is a hole: `"Hello, \(name) #\(n)"` is the text with the value
of each expression in its place, a View as it is and an Int in decimal. A hole holds one expression with no text
literal in it (L05); a value of any other type is refused (C19). Appended to a Buf, the text is written straight
into it. A newline ends a declaration or a step, except inside `( )` and `[ ]`, and
except before a line that starts with `|>`, which carries the step on. A backslash at the end of a line inside a
text literal carries the text on after the next line's indentation.

Reserved words: `fn export type schema migration flag match with let do if else and or not`. Words with a meaning
only where they stand: `interface machine invariant where contract settled private final read write`.

`tape fmt` rewrites a file in the one layout; `tape fmt --check` is part of the gate. A step that fits in 100
columns is one line, however it was typed. A wider one is broken in one way: before each `|>`; failing that, inside its widest brackets with one argument to a line;
failing that, a long text is carried over lines. Comments and the SQL of a migration are left as written.

## 3. Types

| Type | What it is |
|---|---|
| `Int` | a 64-bit signed integer. Overflow wraps; division by zero is a trap |
| `Bool` | `True` or `False` |
| `View` | read-only bytes (text is UTF-8 bytes) |
| `Buf` | bytes being written. It has one owner: a function that is handed a `Buf` uses it once (C25) |
| `Rows[T]` | the rows of a query, read with `next` |
| `Sql` `Remote` `Clock` `Entropy` `Timer` | capabilities: only ever parameters, never stored or returned |
| `type T { A(x: Int)  B }` | a sum of constructors, each with named fields. `type T[P] { … }` takes type parameters |
| `type Key = View where len(self) >= 1` | a refined type: a base type and a condition. A value has it only after a pattern or a decode proved the condition |
| `interface Git { read head(Ref) -> Head }` | what a capability bound by the host can be asked |

std defines `Option[T]` (`Some(value)`, `None`), `Result[T, E]` (`Ok(value)`, `Err(error)`), `Move[T]`
(`Moved(value)`, `Raced(now)`, `NoRow`), `CallError` (`Timeout`, `Unreachable`, `Rejected(reason)`,
`Skew(reason)`), `Map[T]`, `List[T]`, `Request`, `Wake`.

There are no floats, no null, no exceptions, no mutable variables and no loops.

## 4. Functions

```
fn name(param: Type, …) -> Type {
  step
  …
  expression
}
```

Arguments are named: `f(at: i)`. A variable named like the parameter is passed bare, `f(at)`; so is the only
argument of a one-parameter function. `a |> f(b: 1)` is `f(<first parameter>: a, b: 1)`.

A body is steps, then one expression that is its value. There are three steps:

| Step | Meaning |
|---|---|
| `let x = e` | name a value. `let Order(id, amount) = e` takes apart a value whose pattern cannot fail |
| `let P = e else { arms }` | go on with the case `P`; every other case leaves the function through an arm. `else -> e` takes all of them. `P` is any pattern: `let 1 = sql_exec(…) else -> …` goes on when one row changed |
| `do f(…)` | run a call for what it does. The call must return an `Int`, which is dropped |

Branching is `match`, as the last expression of a function or of an arm, never as an argument (C40):

```
match subject { Pattern if guard -> e  … }
match { condition -> e  …  else -> e }
```

A match covers every value of its subject or does not compile (C24). Repetition is a function calling itself; a
call in tail position does not grow the stack.

Capabilities are ambient by name: inside a function with a parameter `db: Sql`, `sql_first(…)` uses it without
naming it, and a function that calls one that needs `db` must declare `db` too (C72).

## 5. Patterns

A pattern can fail, and binds what it proves.

| Pattern | Matches |
|---|---|
| `Ctor(field, other: P)` | that constructor; a field named bare is bound, fields left out are not looked at |
| `"text"`, `42`, `True` | that value |
| `"prefix" ++ rest` | bytes that start so; `rest` is matched against what follows |
| `Key(k)` | a value for which the refined type's condition holds; `k` has the type |
| `decimal(n)` | any one-parameter function returning `Option[…]`, when it returns `Some` |
| `name = P` | `P`, and binds the whole value |
| `_` | anything |

A pattern on a row's machine column (section 7) may name only declared states (C81), and a match that names every
state needs no `_` arm.

## 6. Effects

| Call | Needs | Does |
|---|---|---|
| `sql_first(row: T, query: "… WHERE id = :id", id)` | `Sql` | the first row, as `Option[T]` |
| `sql_all(row: T, query: "…")` | `Sql` | `Rows[T]` |
| `sql_exec(query: "…")` | `Sql` | the number of rows changed |
| `sql_move(row: T, query: "UPDATE … WHERE … RETURNING *")` | `Sql` | a compare-and-set: `Moved(value)`, `Raced(now)` when another run moved the row first, `NoRow` |
| `call(to:, method:, send:, reply:, within:, once:)` | `Remote` | a command to another program: `Result[Reply, CallError]`. A repeat of a `once` key after the first run has finished gets its stored reply and runs nothing. Two sends of one key that overlap, to a method that itself calls, can both run: a known bug ([`STATUS.md`](STATUS.md#known-limitations)) |
| `ask(to:, method:, send:, reply:, within:)` | `Remote` | a read: the same, with no key |
| `wake(after: ms, key: n)` | `Timer` | asks for `export fn woken(…, message: Wake)` to run later with `Wake(key: n)`. A run cut short at a call runs again; a run that fails on a storage error is not retried, a known bug ([`STATUS.md`](STATUS.md#known-limitations)) |
| `now()` | `Clock` | milliseconds since 1970 |
| `random()` | `Entropy` | 53 random bits |
| `rollback(out)` | | answers `out` and undoes this request's writes since its last call; the effect log marks each write it undid `undone` (as it does for a trap), and so does the trace |

A query names each value it takes, `WHERE id = :id AND state = :from`, and the call passes each by that name: `id`
when a value of that name is at hand, `from: "new"` otherwise. A name used twice is one value. A name with no
argument is C13, an argument with no name in the query is C11, and a `?` is C32. The database is given the statement
with the names numbered in the order they first appear (`?1`, `?2`), and that is the form the effect log shows.

SQL is checked at compile time against the program's tables: names, the type of each value against where it is
used, and the row type's fields against the columns (`*` means the row type's fields, by name).

**A call is a commit point.** Writes made before a `call` or `ask` are durable when it is sent. The run may end
there (the object is reset, the reply is lost), so whatever must happen afterwards needs a timer set before the
call, in the same commit.

`export fn name(db: Sql, message: Record) -> Result[Reply, View]` is a method other programs call. `handle(raw:
View, …capabilities) -> Buf` serves requests. `woken` serves timers.

## 7. Declarations about rows

| Declaration | States |
|---|---|
| `migration 1 "name" { SQL }` | the tables. Migrations only add (C51); one marked `contract` may remove |
| `machine orders.state { "a" -> "b" }` | the moves a column may make. Every write of the column is checked against them, and the host installs triggers that refuse any other |
| `invariant "name" { SELECT … }` | rows that must not exist: the SELECT returns what is wrong. Checked after every commit by `tape sim`, and by `app.invariants()` in the host |
| `invariant "name" settled { … }` | the same, once nothing is in flight and every timer has run |
| `invariant "name" with other { … }` | reads another program's tables as `other.table`; only the simulator runs it |
| `flag name: Int = 1` | a value the host sets between requests; read as `flags.name` |

## 8. A whole program

Every idiom in section 9 is in this program. It compiles, it is in `tape fmt`'s layout, and `tape sim` finds
nothing wrong with it in 100 runs.

```tape
migration 1 "orders" {
  CREATE TABLE orders(
    id INTEGER PRIMARY KEY,
    client TEXT NOT NULL UNIQUE,
    amount INTEGER NOT NULL CHECK (amount > 0),
    state TEXT NOT NULL DEFAULT 'paying',
    note TEXT NOT NULL DEFAULT ''
  )
}

machine orders.state {
  "paying" -> "paid"
  "paying" -> "failed"
}

invariant "a paid order carries no failure note" {
  SELECT id, note FROM orders WHERE state = 'paid' AND note <> ''
}

invariant "no order is left paying" settled {
  SELECT id FROM orders WHERE state = 'paying'
}

type Key = View where len(self) >= 1 and len(self) <= 64
type Amount = Int where self >= 1 and self <= 1000000
type NewOrder { NewOrder(key: Key, amount: Amount) }
type Order { Order(id: Int, amount: Int, state: View, note: View) }
type Charge { Charge(amount: Int) }
type Charged { Charged(payment: Int) }
type ForOrder { ForOrder(order: Int) }

type Outcome {
  Shown(status: Int, order: Order)
  Problem(status: Int, reason: View)
}

fn handle(raw: View, db: Sql, payments: Remote, timer: Timer) -> Buf {
  match request(raw) {
    Request(method: "POST", path: "/orders", body) -> place(body) |> rendered
    Request(method: "GET", path: "/orders/" ++ decimal(id)) -> shown(status: 200, found: load(id))
      |> rendered
    Request(method: "GET", path: "/orders") -> respond(status: 200)
      |> write_rows(rows: sql_all(row: Order, query: "SELECT * FROM orders ORDER BY id"))
    _ -> rendered(outcome: Problem(status: 404, reason: "no such route"))
  }
}

export fn woken(db: Sql, payments: Remote, timer: Timer, message: Wake) -> Result[Order, View] {
  let Wake(key) = message
  let Some(value: order) = load(id: key) else -> Err(error: "no such order")
  match charge(order) {
    Shown(order: now) -> Ok(value: now)
    Problem(reason) -> Err(error: reason)
  }
}

fn place(body: View) -> Outcome {
  let Ok(value: NewOrder(key, amount)) = decode(json: body, as: NewOrder) else {
    Err(error) -> Problem(status: 400, reason: error)
  }
  let Some(value: order) = sql_first(
    row: Order,
    query: "INSERT INTO orders(client, amount) VALUES (:key, :amount) ON CONFLICT(client) \
        DO NOTHING RETURNING *",
    key,
    amount
  ) else {
    None -> shown(
      status: 200,
      found: sql_first(row: Order, query: "SELECT * FROM orders WHERE client = :key", key)
    )
  }
  do wake(after: 5000, key: order.id)
  charge(order)
}

fn charge(order: Order) -> Outcome {
  match order {
    Order(id, amount, state: "paying") -> {
      let Ok(value: Charged) = call(
        to: payments,
        method: "charge",
        send: Charge(amount),
        reply: Charged,
        within: 2000,
        once: ForOrder(order: id)
      ) else {
        Err(error: Rejected(reason)) -> moved(m: sql_move(
          row: Order,
          query: "UPDATE orders SET state = 'failed', note = :reason WHERE id = :id \
              AND state = 'paying' RETURNING *",
          reason,
          id
        ))
        Err(error) -> {
          do wake(after: 5000, key: id)
          shown(status: 202, found: load(id))
        }
      }
      moved(m: sql_move(
        row: Order,
        query: "UPDATE orders SET state = 'paid' WHERE id = :id AND state = 'paying' RETURNING *",
        id
      ))
    }
    _ -> Shown(status: 200, order)
  }
}

fn load(id: Int) -> Option[Order] {
  sql_first(row: Order, query: "SELECT * FROM orders WHERE id = :id", id)
}

fn moved(m: Move[Order]) -> Outcome {
  match m {
    Moved(value) -> Shown(status: 200, order: value)
    Raced(now) -> Shown(status: 200, order: now)
    NoRow -> Problem(status: 404, reason: "no such order")
  }
}

fn shown(status: Int, found: Option[Order]) -> Outcome {
  match found {
    Some(value) -> Shown(status, order: value)
    None -> Problem(status: 404, reason: "no such order")
  }
}

fn rendered(outcome: Outcome) -> Buf {
  match outcome {
    Shown(status, order) -> respond(status) |> write_json(value: order)
    Problem(status, reason) -> respond(status)
      |> append(view: "{\"error\":")
      |> write_json_string(text: reason)
      |> append(view: "}")
  }
}
```

## 9. One way to do each job

Each row is a job, the form for it, and what the compiler says to the other way. The edits below the table are
made to the program above by `test/definition.ts`; each must be refused with the code shown.

| Job | The form | Otherwise |
|---|---|---|
| Read a JSON body | `decode(json: body, as: T)`, then `let Ok(value: T(…)) = … else { Err(error) -> … }`. A body that may be one of several shapes is a type with several constructors. A field the type does not have is refused, and so is `null` for an `Option` field: it is there or it is not. An `Int` field takes a JSON number that is a whole number from -9007199254740991 to 9007199254740991 (±(2^53 - 1)), as `JSON.parse` reads it, so `1e3` is 1000; one outside that range is refused, with `Err("<field>: expected a whole number")`, never rounded: the host reads JSON with `JSON.parse`, whose numbers are doubles, and past 2^53 - 1 a double cannot hold every whole number exactly. Send such a value as text until exact large-integer JSON, the whole 64-bit range, comes (planned for 0.3) | C35 |
| Write a record, or the rows of a query | `write_json(value)`, `write_rows(rows)` | |
| Put values in text | a hole, `"\(n) of \(total)"`; `out |> append(view: …)` to grow a Buf piece by piece in a loop | C19 |
| Run something for what it does | `do f(…)` | C83-C85 |
| Go on with one case, leave with the rest | `let P = e else { … }` | |
| Make a row on a POST | the client's key in a `UNIQUE` column, `ON CONFLICT(key) DO NOTHING`, and the same key again answers with what the first made | C55 |
| Give a row a status | a `machine`, and `sql_move` whose WHERE names the state it moves from | C59, C63 |
| Change a number in a row | a compare-and-set, an op-id guard, or `repeat: True` on the call when every attempt should count | C54 |
| Pass a value to a query | `:name` in the query, and an argument of that name | C11, C13, C32 |
| Take from a quantity | `SET n = n - :qty WHERE … AND n >= :qty` | C73 |
| Command another program | `call` with `within:` and a `once:` key that names the row | C39, C41, C71 |
| Handle its answer | an arm for `Ok`, one for `Rejected` alone (the same key gets the same refusal), one for no answer | C24, C87 |
| Make sure it finishes | `do wake(after:, key: <the row's id>)` in the commit before the call, and `woken` carries the row on from its state | C77-C79 |
| Say what must hold | `invariant`, and `settled` for what must hold in the end | C86 |
| Answer | functions return a value (`Outcome`); one function turns it into bytes | |

```diff C83
-  do wake(after: 5000, key: order.id)
-  charge(order)
+  let set = wake(after: 5000, key: order.id)
+  charge(order)
```

```diff C55
-    client TEXT NOT NULL UNIQUE,
+    client TEXT NOT NULL,
-    query: "INSERT INTO orders(client, amount) VALUES (:key, :amount) ON CONFLICT(client) \
-        DO NOTHING RETURNING *",
+    query: "INSERT INTO orders(client, amount) VALUES (:key, :amount) RETURNING *",
```

```diff C24
-    NoRow -> Problem(status: 404, reason: "no such order")
+
```

```diff C59
-        query: "UPDATE orders SET state = 'paid' WHERE id = :id AND state = 'paying' RETURNING *",
+        query: "UPDATE orders SET state = 'refunded' WHERE id = :id AND state = 'paying' \
+            RETURNING *",
```

```diff C63
-        query: "UPDATE orders SET state = 'paid' WHERE id = :id AND state = 'paying' RETURNING *",
+        query: "UPDATE orders SET state = 'paid' WHERE id = :id RETURNING *",
```

```diff C87
-        Err(error: Rejected(reason)) -> moved(m: sql_move(
-          row: Order,
-          query: "UPDATE orders SET state = 'failed', note = :reason WHERE id = :id \
-              AND state = 'paying' RETURNING *",
-          reason,
-          id
-        ))
```

```diff C41
-        within: 2000,
-        once: ForOrder(order: id)
+        within: 2000
```

```diff C39
-        within: 2000,
```

```diff C81
-    Order(id, amount, state: "paying") -> {
+    Order(id, amount, state: "payin") -> {
```

```diff C86
-  SELECT id, note FROM orders WHERE state = 'paid' AND note <> ''
+  SELECT id, note FROM orders WHERE state = :state
```

```diff C72
-fn handle(raw: View, db: Sql, payments: Remote, timer: Timer) -> Buf {
+fn handle(raw: View, db: Sql, payments: Remote) -> Buf {
```

```diff C68
-  sql_first(row: Order, query: "SELECT * FROM orders WHERE id = :id", id)
+  sql_first(row: Order, query: "SELECT * FROM orders WHERE ident = :id", id)
```

```diff C40
-    Shown(status, order) -> respond(status) |> write_json(value: order)
+    Shown(status, order) -> respond(status) |> write_json(value: match order { _ -> order })
```

The pattern `json(T(…))` was the second way to read a body. It is refused:

```tape refused C35
type T { T(n: Int) }

fn handle(raw: View) -> Buf {
  match raw {
    json(T(n)) -> respond(status: 200)
    _ -> respond(status: 400)
  }
}
```

Take away the first timer, and a run cut short at the call would leave the order paying for ever. A request can
reach the write that moves an order out of `paying`, but only the request that has just made the order: none
comes back for it. That is not a way out, and the edit is refused:

```diff C77
-  do wake(after: 5000, key: order.id)
-  charge(order)
+  charge(order)
```

### What the compiler does not catch, and the simulator does

The rules read how a program is built. What it is for is in its invariants, and only a run can break one. Let a
refusal mark the order paid: every rule is satisfied, and `tape sim` finds an order that is paid and carries the
reason it was refused:

```diff sim safety: invariant "a paid order carries no failure note" does not hold
-          query: "UPDATE orders SET state = 'failed', note = :reason WHERE id = :id \
-              AND state = 'paying' RETURNING *",
+          query: "UPDATE orders SET state = 'paid', note = :reason WHERE id = :id AND state = 'paying' \
+              RETURNING *",
```

The simulator also sends a request that was answered again at once, and fails the run if that changes where the
rows end up (a write marked `repeat: True` is the exception). So the rules are not the whole check.
A program says what must hold, and what must hold in the end (`settled`), and is run under `tape sim`.

## 10. When a program stops

A trap ends the request, undoes its writes and is recorded: out of memory (64 MB), more than 50,000,000 steps, an
index out of bounds, a division by zero. Nothing else stops a program: every other failure is a value.

## 11. Not defined yet

- What a version built by an older compiler may rely on. Today: it keeps running as built, and nothing more.
- The order in which two requests' effects interleave beyond "a call is a commit point".
- Who is calling. A program is handed the request; identity is its own business.
- JSON for bytes, maps and floats; writing a record with an `Option` field.
- Numbers other than `Int`.

## 12. What went

| When | What | Now |
|---|---|---|
| 22 November 2026 | numbered placeholders, `WHERE id = ?1` with `p1: id` | names: `WHERE id = :id` with `id` (C32) |
| 22 November 2026 | a comment in the SQL to say a write is meant to repeat, or may go below a floor | `repeat: True`, `no_floor: True` on the call (C88 when it is not needed) |
| 22 November 2026 | a file laid out as it was typed | one layout: a step that fits is one line, a wider one is broken in one way (`tape fmt`) |
| 20 November 2026 | a function per step, each matching the last step's result (`placed(made: sql_first(…))`) | steps: `let P = e else { … }`, in every example with rows but `kv` |
| 20 November 2026 | `with { pattern <- e … -> result else -> fallback }` | `let pattern = e else -> fallback`, a step at a time (C35). No program used it |
| 19 November 2026 | the pattern `json(T(…))` | `decode(json:, as:)`, which also says why a body was refused (C35) |
| 18 November 2026 | a call bound to a name never read, passed to a parameter never read, or multiplied by 0, to run it | `do` (C83-C85) |
| 18 November 2026 | one arm for a refusal and for no answer, with a timer | an arm for `Rejected` alone (C87) |
| 15 November 2026 | an INSERT on a POST with no client key | a key (C55) |
