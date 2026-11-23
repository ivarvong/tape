# The Tape language, version 0.3

This is the definition of Tape as it stands: what a program is made of, and the one way to do each job. It is
short on purpose. [The guide](docs/guide.md) teaches; this states. Where the two disagree, this file is right, and where this file
and the compiler disagree, that is a bug in one of them: `test/definition.ts` compiles every program in this file, makes
every edit it shows, and fails when the compiler does not say what the file says.

This is version 0.3. A form that is here has one meaning and one way to be written, and the tests hold the
compiler to it. Before 1.0 a form may still go: when one does, the old way is a compile error that says the new
one, and the last section says what went and when. The service runs the same compiler on every upload, and a
version built by an older compiler is rebuilt from its source when it is next loaded.

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

`//` starts a comment. Integers are decimal, from `-9223372036854775808` to `9223372036854775807`: a `-` written
before the digits is part of the literal (`-7`, and in a pattern `-1 ->`), and a literal outside that range is
refused (P08). A Float literal ends in `f`: `1.5f`, `2f`, `1e-3f`, `6.02E23f`, at most 20 significant digits and
no larger than the largest Float (L06). A point or an exponent with no `f` is refused (L06): `1.5` is kept for an
exact decimal. Text literals are in double quotes, on one line, with the escapes
`\" \\ \/ \n \r \t \b \f`. `\(e)` in a literal is a hole: `"Hello, \(name) #\(n)"` is the text with the value
of each expression in its place, a View as it is, an Int in decimal, and a Float in the shortest digits that read
back as it (`0.1`, `5`, `1e+21`, as JavaScript's `String` writes a number). A hole holds one expression with no text
literal in it (L05); a value of any other type is refused (C19). Appended to a Buf, the text is written straight
into it. A newline ends a declaration or a step, except inside `( )` and `[ ]`, and
except before a line that starts with `|>`, which carries the step on. A backslash at the end of a line inside a
text literal carries the text on after the next line's indentation.

Reserved words: `fn export type schema migration flag match with let do if else and or not`. Words with a meaning
only where they stand: `interface machine invariant where contract settled private final read write`. A reserved
word can name a record's field, since a field is never a variable: `Event(type: View)`, `e.type`, and in a pattern
`Event(type: kind)`, which binds `kind` (a bare `Event(type)` would bind a variable named `type`, and is P01). So a
JSON key that is a reserved word is decoded and written like any other.

```tape gives
type Event {
  Event(type: Int, at: Int)
}

fn kind_at(at: Int) -> Int {
  let Event(type: kind) = Event(type: 7, at)
  kind * 100 + Event(type: kind, at).at
}

// kind_at(5) is 705
```

`tape fmt` rewrites a file in the one layout; `tape fmt --check` is part of the gate. A step that fits in 100
columns is one line, however it was typed. A wider one is broken in one way: before each `|>`; failing that, inside its widest brackets with one argument to a line;
failing that, a long text is carried over lines. Comments and the SQL of a migration are left as written.

## 3. Types

| Type | What it is |
|---|---|
| `Int` | a 64-bit signed integer. Arithmetic is exact or it traps (section 10): there is no wrapping |
| `Float` | a 64-bit IEEE 754 number that is never NaN and never infinite: an operation that would make one traps. For measurements, not for money, counts or keys |
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

There are no implicit conversions between numbers, and no null, no exceptions, no mutable variables and no loops.

On `Int`: `+ - *` and unary `-` give the exact result, and trap (integer overflow) when it does not fit in 64 bits.
`/` truncates toward zero and `%` has the sign of its left side; both trap on a zero divisor (division by zero),
and on the least Int by -1 (integer overflow: the quotient does not fit, so neither does the remainder). `& | ^`
work on the 64 bits. `a << n` and `a >> n` take a shift `n` from 0 to 63 and trap on any other; `<<` drops the
bits it moves out, `>>` copies the sign in. Where a hash or a checksum means arithmetic modulo 2^64, it says so:
`wrapping_add(a, b)`, `wrapping_sub(a, b)` and `wrapping_mul(a, b)` give the low 64 bits of the exact result.

On `Float`: `+ - * /` are IEEE 754's, rounded once to the nearest Float (a tie to the even one), the same bits in
every engine Wasm runs in; a result that would be infinite or not a number (`1f / 0f`, `0f / 0f`, `1e308f * 10f`)
traps (trap 8, float not finite), so every Float a program holds is finite. Unary `-` is exact. `== != < <= > >=`
compare values, and `-0f == 0f`. There is no `%` and no bitwise operator (C19), and an Int and a Float do not mix
(C14): `float(n)` is the Float nearest an Int, and `trunc(x)` the Int toward zero, trapping (integer overflow)
outside the Ints. `floor(x)`, `ceil(x)`, `abs(x)` and `sqrt(x)` are exactly as IEEE 754 defines them (`sqrt` of a
negative traps); `abs`, `min(a, b)` and `max(a, b)` take two Ints or two Floats. `sin(x)`, `cos(x)`,
`atan2(y:, x:)`, `exp(x)`, `log(x)` and `pow(x:, y:)` are musl's (fdlibm's, and Arm's), compiled into the module as
Wasm, so a result is the same bits in every engine and in a replay: within 1 ulp of the true value (atan2, 1.5 ulp),
and a trap where it would be infinite or not a number (`log(0f)`, `exp(1000f)`, `pow(x: -8f, y: 0.5f)`). A
Float is matched with a guard,
`x if x == 0f ->`, never a literal pattern (C19).

Operators, tightest first: unary `-`; `* / %`; `+ - ++`; `<< >>`; `&`; `^`; `|` and `|>`; the comparisons, which
do not chain; `not`; `and`; `or`. So `-x * y` is `(-x) * y`, and `-2 * 3` is `-6`.

## 4. Functions

```
fn name(param: Type, …) -> Type {
  step
  …
  expression
}
```

Arguments are named: `f(at: i)`. A variable named like the parameter is passed bare, `f(at)`; so is the only
argument of a one-parameter function, whatever expression it is: `fact(n - 1)`. Any other argument is named, so a
function of two parameters is called `pow(b, e: e - 1)` (C10). `a |> f(b: 1)` is `f(<first parameter>: a, b: 1)`.
Every function is checked, whether anything calls it or not: a type error in one nothing calls yet is the
program's error, at its line. A generic function is checked where it is called, for the types it is called with.

A body is steps, then one expression that is its value. There are three steps:

| Step | Meaning |
|---|---|
| `let x = e` | name a value. `let Order(id, amount) = e` takes apart a value whose pattern cannot fail |
| `let P = e else { arms }` | go on with the case `P`; every other case leaves the function through an arm. `else -> e` takes all of them. `P` is any pattern a match arm takes: `let 1 = sql_exec(…) else -> …` goes on when one row changed, `let key ++ "=" ++ value = pair else -> …` splits a text. An `=` outside brackets ends the pattern; `name = P` binds a whole value inside them |
| `do f(…)` | run a call for what it does. The call must return an `Int`, which is dropped |

```tape gives
fn version(n: Int) -> Int {
  let tag = match n {
    1 -> "v12"
    _ -> "12"
  }
  let "v" ++ decimal(v) = tag else -> -1
  v
}

// version(1) is 12
// version(2) is -1
```

Branching is `match`, and a match is an expression: a function's or an arm's value, a `let`'s value, an argument,
an operand, the left side of a pipe:

```
match subject { Pattern if guard -> e  … }
match { condition -> e  …  else -> e }
```

Every arm has the type the match is expected to have (a function's result, a parameter's type). Where nothing
expects one (`let x = match …`, an operand), the first arm's value gives it, without a refinement, and an arm that
cannot say its type there (`None` first) is refused (C21). A match covers every value of its subject or does not
compile (C24).

```tape gives
fn fee(amount: Int) -> Int {
  let base = match {
    amount > 1000 -> 0
    else -> 50
  }
  base + match amount % 2 {
    0 -> 0
    _ -> 1
  }
}

// fee(2000) is 0
// fee(7) is 51
```

Before 0.3 a match could only be a function's or an arm's last expression, so every decision used as a value
became a function of its own (three of the eight tasks of the usability benchmark of 22 November 2026 were refused
for it). One way to do each job still holds: `match` is the one way to branch, and it is now used wherever a branch
is wanted, as an `if` would be elsewhere. A decision used in more than one place is still a function.

Repetition is a function calling itself; a call in tail position does not grow the stack.

Capabilities are ambient by name: inside a function with a parameter `db: Sql`, `sql_first(…)` uses it without
naming it, and a function that calls one that needs `db` must declare `db` too (C72).

## 5. Patterns

A pattern can fail, and binds what it proves.

| Pattern | Matches |
|---|---|
| `Ctor(field, other: P)` | that constructor; a field named bare is bound, fields left out are not looked at. A field given a pattern binds its own name too, where the arm reads it and nothing else binds it: `Some(value: Account(balance: 0)) -> value.id` |
| `"text"`, `42`, `-1`, `True` | that value. A Float has no literal pattern (C19): bind it and compare in a guard |
| `"prefix" ++ rest` | bytes that start so; `rest` is matched against what follows |
| `Some("")`, `Some(decimal(n))` | a constructor of one field, with a pattern for that field: as its one argument is passed bare, its one pattern needs no name. A constructor of two or more fields names each (C10) |
| `Key(k)` | a value for which the refined type's condition holds; `k` has the type |
| `decimal(n)` | any one-parameter function returning `Option[…]`, when it returns `Some`. `decimal` is strict, for ids in a path (digits, no sign, no leading zero); `parse_int` takes a number as people write one (a sign, leading zeros) |
| `name = P` | `P`, and binds the whole value |
| `_` | anything |

A field given a pattern binding its name is what agents wrote, again and again, before 0.3 refused it (C16): the
name is read as the field the arm matched. A name the program binds itself always wins (a parameter, a `let`,
another arm's pattern around it), and where two fields of one name would both be in scope (`Some(value: …)` inside
another `Some(value: …)`), neither binds it and the read is C16, whose fix writes `value: name = Pattern`.

```tape gives
type Account {
  Account(id: Int, balance: Int)
}

fn emptied(id: Int, balance: Int) -> Int {
  match Some(value: Account(id, balance)) {
    Some(value: Account(balance: 0)) -> value.id
    _ -> -1
  }
}

// emptied(4, 0) is 4
// emptied(4, 1) is -1
```

A pattern on a row's machine column (section 7) may name only declared states (C81), and a match that names every
state needs no `_` arm.

## 6. Effects

| Call | Needs | Does |
|---|---|---|
| `sql_first(row: T, query: "… WHERE id = :id", id)` | `Sql` | the first row, as `Option[T]` |
| `sql_all(row: T, query: "…")` | `Sql` | `Rows[T]` |
| `sql_exec(query: "…")` | `Sql` | the number of rows changed |
| `sql_move(row: T, query: "UPDATE … WHERE … RETURNING *")` | `Sql` | a compare-and-set: `Moved(value)`, `Raced(now)` when another run moved the row first, `NoRow` |
| `call(to:, method:, send:, reply:, within:, once:)` | `Remote` | a command to another program: `Result[Reply, CallError]`. A repeat of a `once` key gets the first run's reply and runs nothing: its stored reply, or, sent while the first run waits on a call, that run's reply when it comes (`Unreachable` if it does not come within the budget: send it again) |
| `ask(to:, method:, send:, reply:, within:)` | `Remote` | a read: the same, with no key |
| `wake(after: ms, key: n)` | `Timer` | asks for `export fn woken(…, message: Wake)` to run later with `Wake(key: n)`. A run cut short at a call runs again, and so does a run that fails on a storage error, after a wait that doubles each time (1 s up to 15 min); a run that traps is not retried |
| `now()` | `Clock` | milliseconds since 1970 |
| `random()` | `Entropy` | 53 random bits |
| `rollback(out)` | | answers `out` and undoes this request's writes since its last call; the effect log marks each write and each timer it undid `undone` (as it does for a trap), and so does the trace |

A query names each value it takes, `WHERE id = :id AND state = :from`, and the call passes each by that name: `id`
when a value of that name is at hand, `from: "new"` otherwise. A name used twice is one value. A name with no
argument is C13, an argument with no name in the query is C11, and a `?` is C32. The database is given the statement
with the names numbered in the order they first appear (`?1`, `?2`), and that is the form the effect log shows.

SQL is checked at compile time against the program's tables: names, the type of each value against where it is
used, and the row type's fields against the columns (`*` means the row type's fields, by name). A Float is given
to a query as a number, which SQLite keeps as REAL, and a REAL column reads into a Float field (a cell that is
not a finite number stops the request). In JSON a Float is a number: decoded from one that is finite (text, and
`1e400`, are refused: `r: expected a number`), and written in the shortest digits that read back as it.

**A call is a commit point.** Writes made before a `call` or `ask` are durable when it is sent. The run may end
there (the object is reset, the reply is lost), so whatever must happen afterwards needs a timer set before the
call, in the same commit.

`export fn name(db: Sql, message: Record) -> Result[Reply, View]` is a method other programs call. `handle(raw:
View, …capabilities) -> Buf` serves requests. `woken` serves timers.

## 7. Declarations about rows

| Declaration | States |
|---|---|
| `migration 1 "name" { SQL }` | the tables. Migrations only add (C51); one marked `contract` may remove. A column read into a field that is not an `Option` is never NULL: declare it NOT NULL. SQLite lets a PRIMARY KEY column hold NULL too, unless it is an `INTEGER PRIMARY KEY` (the rowid; not `DESC`) or its table is `WITHOUT ROWID` or `STRICT`, so `id TEXT PRIMARY KEY NOT NULL` (C69) |
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
| Read a JSON body | `decode(json: body, as: T)`, then `let Ok(value: T(…)) = … else { Err(error) -> … }`. A body that may be one of several shapes is a type with several constructors. A key the type does not name is left unread (clients send more than a service reads); `null` for an `Option` field is refused: it is there or it is not. Of several constructors, decode takes the one that has all its fields among the keys and names the most of them. The module reads the JSON itself (std/json.tape), and reads a number exactly from its text. An `Int` field takes a JSON number whose value is a whole number from -9007199254740991 to 9007199254740991 (±(2^53 - 1)), so `1e3` is 1000 and `2.0` is 2, but `1.0000000000000000001` is not a whole number; one outside that range is refused, with `Err("<field>: expected a whole number")`, never rounded. Send a larger value as text until exact large-integer JSON, the whole 64-bit range, comes | C35 |
| Write a record, or the rows of a query | `write_json(value)`, `write_rows(rows)` | |
| Write a list of computed items | `out \|> write_json_list(list, by: fn(out: Buf, item: T) -> Buf { … })`: the Buf is handed from item to item, never kept in a record (C08); `fold` again for a total, `join(list, sep)` for text | C08 |
| Put values in text | a hole, `"\(n) of \(total)"`; `out |> append(view: …)` to grow a Buf piece by piece in a loop | C19 |
| Measure | `Float`, with `f` literals; `float(n)` from an Int, `trunc(x)` back | C14 |
| Run something for what it does | `do f(…)` | C83-C85 |
| Go on with one case, leave with the rest | `let P = e else { … }` | |
| Make a row on a POST | the client's key in a `UNIQUE` column, `ON CONFLICT(key) DO NOTHING`, and the same key again answers with what the first made | C55 |
| Give a row a status | a `machine`, and `sql_move` whose WHERE names the state it moves from | C59, C63 |
| Change a number in a row | a compare-and-set, an op-id guard, a write after a step that claims an op id (`let 1 = sql_exec(query: "INSERT … ON CONFLICT DO NOTHING") else …`: a second run inserts nothing and leaves; the write may be in a function every call of which comes after the claim), or `repeat: True` on the call when every attempt should count | C54 |
| Pass a value to a query | `:name` in the query, and an argument of that name | C11, C13, C32 |
| Take from a quantity | `SET n = n - :qty WHERE … AND n >= :qty` | C73 |
| Command another program | `call` with `within:` and a `once:` key that names the row | C39, C41, C71 |
| Handle its answer | an arm for `Ok`, one for `Rejected` alone (the same key gets the same refusal), one for no answer | C24, C87 |
| Make sure it finishes | `do wake(after:, key: <the row's id>)` in the commit before the call, and `woken` carries the row on from its state | C77-C79 |
| Say what must hold | `invariant`, and `settled` for what must hold in the end | C86 |
| Answer | functions return a value (`Outcome`); one function turns it into bytes: `respond(status)`, or `respond_as(status, content: Json)` for a type, then the body | |
| Set a response header | `respond(status: 302) \|> header(name: "location", value: url)`, anywhere before or after the body. A name is a token, a value has no CR, LF or NUL; the host refuses those it sets itself (content-type, set-cookie, the security headers) and answers 500 with the reason | |
| Read a request header | `header_of(request: r, name: "if-none-match")`, an `Option[View]`; the host passes only those it means a program to see | |

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

A request may take 50,000,000 steps. A step of that budget (not a step of a body, section 4) is one entry into a
recursive function, a function that can reach itself through the calls it makes: each time it is called, and each
time it calls itself again as its result. A call of any other function is free however much it computes, and so is a
built-in. The standard library's recursive functions count like the program's own: the byte scans behind
`request()`, `until`, `after` and `decimal` take a few steps per byte. So a request's steps depend on its bytes and
on the arms tried before the one that answers it, and a route's count can change while the route does not: an arm
added above it, or a function made recursive by a call added elsewhere. In a program with two `GET` arms and a 404
fallback, one more `GET` arm on top added 4 steps to every request below it, and a path 12 bytes longer cost 59
more. Steps are a count of reductions, as in Erlang, not a time. They are the cost measure all the same: on Workers
a program's clock moves only across I/O, so nothing inside a run (`now()`, a span's duration) can time its work.

A trap ends the request, undoes its writes and is recorded: out of memory (64 MB), more than 50,000,000 steps, an
index out of bounds, a division by zero (trap 4), an `Int` result that does not fit in 64 bits (trap 6, integer
overflow), a shift by less than 0 or more than 63 (trap 7), a Float operation whose result would be infinite or
not a number (trap 8, float not finite). Nothing else stops a program: every other failure is a
value. A request that traps is answered 500 with the reason, `trap 6: integer overflow`. Each line `// f(…) is v`
or `// f(…) traps: reason` below is a call `test/definition.ts` makes, compiled and in the reference interpreter:

```tape gives
fn fact(n: Int) -> Int {
  match {
    n <= 1 -> 1
    else -> n * fact(n - 1)
  }
}

fn pow(b: Int, e: Int) -> Int {
  match {
    e <= 0 -> 1
    else -> b * pow(b, e: e - 1)
  }
}

fn sign(n: Int) -> Int {
  match n {
    -1 -> -1
    0 -> 0
    _ -> 1
  }
}

// one step of 64-bit FNV-1a: from its offset basis and "a" (97), the published 0xaf63dc4c8601ec8c
fn hash(h: Int, byte: Int) -> Int {
  wrapping_mul(a: h ^ byte, b: 1099511628211)
}

fn mean(total: Float, n: Int) -> Float {
  total / float(n)
}

fn whole(x: Float) -> Int {
  trunc(x)
}

// fact(20) is 2432902008176640000
// fact(21) traps: integer overflow
// pow(-2, 63) is -9223372036854775808
// pow(2, 63) traps: integer overflow
// sign(-1) is -1
// hash(-3750763034362895579, 97) is -5808556873153909620
// mean(7.5f, 2) is 3.75f
// mean(1f, 0) traps: float not finite
// whole(-2.5f) is -2
// whole(1e19f) traps: integer overflow
```

## 11. Changes in 0.4

What 0.4 changed, from the 0.3 usability benchmark (48 agent runs) and its feedback, newest first. Section 13 has
what went before.

| When | Change |
|---|---|
| 23 November 2026 | a Float in JSON (a finite number in, the shortest digits out, in records and lists) and in SQL (bound as a number, kept REAL by SQLite; a REAL column reads into a Float field) |
| 23 November 2026 | `sin`, `cos`, `atan2`, `exp`, `log`, `pow` on Float: musl's libm ported to Wasm (compiler/math), only what a program calls goes into its module; never the host's `Math`, whose results differ between engines |
| 23 November 2026 | `Float`: a finite 64-bit IEEE 754 number for measurements. Literals end in `f` (`1.5f`; `1.5` is L06, kept for an exact decimal); `+ - * /` and comparisons; trap 8 (float not finite) where IEEE would give NaN or an infinity; `float(n)` and `trunc(x)` the only conversions; `floor`, `ceil`, `abs`, `sqrt`; `abs`, `min`, `max` built in for Int and Float (std's `min` and `max` of Ints, and `apps/trace`'s own, are gone); a hole writes the shortest digits, as JavaScript's `String` does (env.float_text) |
| 23 November 2026 | `decode` reads the JSON in the module (std/json.tape), once, and reads a number exactly from its text: `1e-400` and `1.0000000000000000001`, which JSON.parse rounds to 0 and 1, are no longer whole numbers. Modules no longer import `env.json` |
| 23 November 2026 | a version built by an older compiler is rebuilt from its source the first time it is loaded, once (a stored build is a cache; the source is the version). Its listing says `rebuilt_from` and `rebuilt_at`. A source this compiler cannot build answers 503 `rebuild_failed` with the diagnostics, and the old build is not run. Before, a version kept running as built, whatever compiler came after |
| 23 November 2026 | std `digits(v)` is gone: `decimal` reads an id (no sign, no leading zero), `parse_int` a number as people write one (a sign, leading zeros) |
| 23 November 2026 | `respond_as(status, content: Csv)` answers `text/csv` (the sales task, 3 of 3 Haiku runs) |
| 23 November 2026 | std: `isqrt(n)`, the square root rounded down (None below 0), exact up to the largest Int, for fixed point (feedback 20261123T015153.800Z-7782f1b2045b) |
| 23 November 2026 | `decode` leaves a key the type does not name unread, instead of refusing the body (7 reports: providers and clients send more than a service reads). Of several constructors it takes the one that has its fields and names the most of the body's keys. There is no strict mode |
| 23 November 2026 | C54 takes a write in a helper when every call of the helper comes after a claim of an op id (the webhook's credit, called once its delivery id is inserted). A helper also called where nothing was claimed is still refused |
| 23 November 2026 | the capabilities the compiler adds (`db` of a function that reads the database) are not written parameters: `load(order.id)` for `fn load(id: Int)` takes its argument bare, no refusal lists them, and C11 shows the call with the parameter's name |
| 23 November 2026 | `_ ->` in a match with no subject, and `else ->` in a match on a value, say which fallback arm that match takes |
| 23 November 2026 | the docs say nothing the compiler contradicts (headers, `is_alpha`, a sign in `parse_int`): `test/docs.ts` compiles every code block in them |

## 12. Not defined yet

- What a version built by an older compiler may rely on. Today: its source is built again by the current compiler (the rules not asked again), and it runs if that builds; it has no claim to what the old build did.
- The order in which two requests' effects interleave beyond "a call is a commit point".
- Who is calling. A program is handed the request; identity is its own business.
- JSON for bytes and maps; writing a record with an `Option` field.
- An exact decimal (`Dec`): a number with a point and no `f` is kept for it.

## 13. What went

| When | What | Now |
|---|---|---|
| 23 November 2026 | no response headers (a redirect had no Location) and no request headers | `header(name:, value:)` on an answer and `header_of(request:, name:)`; the status line carries them, `STATUS CR name: value LF BODY`, checked by the host (host.ts responseOf) |
| 23 November 2026 | a JSON list of computed items needed a Buf kept in a record (C08), and `Cons(head: 1, tail: Nil)` in a `let` could not tell its type (C21) | std: `write_json_list`, `write_each`, `join`; a constructor's later fields take the type parameters its earlier ones gave |
| 23 November 2026 | a debit after its transfer id was inserted (`ON CONFLICT DO NOTHING`, the row required by a step) was C54, and agents marked it `repeat: True` | the claim is an op-id guard: C54 takes a write that runs only once the claim inserted its row |
| 23 November 2026 | byte classes, a number with a sign or leading zeros, min and max written by hand in each program | std: `is_digit is_alpha is_alnum is_space is_lower is_upper`, `every_byte(v, keep)`, `parse_int(text)`, `min`, `max` |
| 23 November 2026 | `Some("")` as a pattern was P01 (a name expected), though `Some("")` builds one; parse errors named only the token | the one field of a constructor takes its pattern unnamed; a backtick, `;`, `&&`, `!`, a single quote, `if`, `return` and `let x: T` are each named for what they are, with what Tape writes instead |
| 23 November 2026 | a field given a pattern bound only what the pattern bound, so `Some(value: Account(…)) -> value` was C16 | the field's name is bound too, where the arm reads it and nothing else binds it |
| 23 November 2026 | a `let` whose pattern opened with a name (`let head ++ "&" ++ rest = q else …`) read as a plain `let` (P01) | every pattern a match arm takes stands there; a `STRICT` table's PRIMARY KEY is known NOT NULL (C69), and C69's fix is the declaration to write |
| 23 November 2026 | a reserved word could not name a field (P01), so a JSON key such as `"type"` could not be decoded | it can: `Event(type: View)`, `e.type`, `Event(type: kind)` |
| 23 November 2026 | `match` only as the last expression of a function or of an arm (refused elsewhere), so a decision in a `let`, an argument or an operand was a function of its own | a match is an expression wherever a value is (its code is retired) |
| 22 November 2026 | `Int` arithmetic that did not fit wrapped around (`fact(21)` answered `-4249290049419214848`), and so did a literal too large for an `Int` | a trap, integer overflow (trap 6; division by zero is trap 4 alone, a shift outside 0..63 is trap 7); `wrapping_add`, `wrapping_sub`, `wrapping_mul` where wrapping is meant; a literal out of range is P08 |
| 22 November 2026 | numbered placeholders, `WHERE id = ?1` with `p1: id` | names: `WHERE id = :id` with `id` (C32) |
| 22 November 2026 | a comment in the SQL to say a write is meant to repeat, or may go below a floor | `repeat: True`, `no_floor: True` on the call (C88 when it is not needed) |
| 22 November 2026 | a file laid out as it was typed | one layout: a step that fits is one line, a wider one is broken in one way (`tape fmt`) |
| 20 November 2026 | a function per step, each matching the last step's result (`placed(made: sql_first(…))`) | steps: `let P = e else { … }`, in every example with rows but `kv` |
| 20 November 2026 | `with { pattern <- e … -> result else -> fallback }` | `let pattern = e else -> fallback`, a step at a time (C35). No program used it |
| 19 November 2026 | the pattern `json(T(…))` | `decode(json:, as:)`, which also says why a body was refused (C35) |
| 18 November 2026 | a call bound to a name never read, passed to a parameter never read, or multiplied by 0, to run it | `do` (C83-C85) |
| 18 November 2026 | one arm for a refusal and for no answer, with a timer | an arm for `Rejected` alone (C87) |
| 15 November 2026 | an INSERT on a POST with no client key | a key (C55) |
