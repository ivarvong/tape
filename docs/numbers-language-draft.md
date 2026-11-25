# Draft: LANGUAGE.md changes for `Dec` and `Float` (0.3)

This is a draft. It goes with [`numbers-spec.md`](numbers-spec.md). The hunks are written against LANGUAGE.md as
it stands on `main` (0.1, 26b2841) and assume 0.2 has landed first: Int overflow traps, negative literals, and a
one-parameter function's argument passed positionally. Their context lines are approximate where 0.2 rewrites the
same sentences. Apply them by hand once 0.2 is merged, then let `test/definition.ts` check every program and edit
below. Rule codes C89 to C92 and L06 are provisional (spec Q12).

```diff
-# The Tape language, version 0.1
+# The Tape language, version 0.3
```

## §2 Text

```diff
-`//` starts a comment. Integers are decimal. Text literals are in double quotes, on one line, with the escapes
+`//` starts a comment. Numbers are decimal. `42` is an Int. `12.30` is an exact decimal, a `Dec[2]`: its scale
+is the number of digits after the point. `1.5f`, `2f` and `1e-3f` are Floats, and only a Float has an exponent
+(L06). A literal takes its type from where it stands, when it fits there exactly: `0` and `1.5` are `Dec[2]`
+where a `Dec[2]` is expected, and `1.5` is a Float where a Float is expected. `12.345` where a `Dec[2]` is
+expected is refused (C14). Text literals are in double quotes, on one line, with the escapes
 `\" \\ \/ \n \r \t \b \f`. `\(e)` in a literal is a hole: `"Hello, \(name) #\(n)"` is the text with the value
-of each expression in its place, a View as it is and an Int in decimal. A hole holds one expression with no text
+of each expression in its place: a View as it is, an Int in decimal, a Dec with exactly its scale's digits
+(`12.30`), a Float in the shortest digits that read back as it (`0.1`, `1e+21`). A hole holds one expression with no text
```

## §3 Types

```diff
 | `Int` | a 64-bit signed integer. Overflow is a trap; so is division by zero |
+| `Dec[s]` | an exact decimal with s digits after the point, 0 ≤ s ≤ 18: an Int count of 10^-s. `Dec[2]` is for cents. Overflow is a trap |
+| `Float` | a 64-bit IEEE 754 number, never NaN or infinite: an operation that would make one is a trap. For measurements, not for money, counts or keys |
 | `Bool` | `True` or `False` |
```

```diff
-std defines `Option[T]` (`Some(value)`, `None`), `Result[T, E]` (`Ok(value)`, `Err(error)`), `Move[T]`
+std defines `Option[T]` (`Some(value)`, `None`), `Result[T, E]` (`Ok(value)`, `Err(error)`), `Rounding`
+(`HalfEven`, `HalfUp`, `Down`, `Up`, `Floor`, `Ceiling`), `Move[T]`
 (`Moved(value)`, `Raced(now)`, `NoRow`), `CallError` (`Timeout`, `Unreachable`, `Rejected(reason)`,
 `Skew(reason)`), `Map[T]`, `List[T]`, `Request`, `Wake`.
 
-There are no floats, no null, no exceptions, no mutable variables and no loops.
+There are no implicit conversions between numbers, and no null, no exceptions, no mutable variables and no loops.
+
+### Numbers
+
+| Form | Types | Meaning |
+|---|---|---|
+| `a + b`, `a - b` | two `Dec[s]` of one scale; two Floats | exact for Dec. Two scales are refused (C14), and the message names the conversion |
+| `a * b` | `Dec[s] * Dec[t]` is `Dec[s+t]`; `Dec[s] * Int` is `Dec[s]`; Floats | exact for Dec |
+| `div(a, by: b, scale: 2, rounding: HalfEven)` | Dec | the quotient rounded once, as the rounding says. Dec has no `/` (C19) |
+| `rescale(x, to: 3)` | Dec, to a larger scale | exact |
+| `round(x, to: 2, rounding: HalfEven)` | Dec, to a smaller scale | rounded |
+| `==`, `<`, … | Dec of any scales; Floats | exact for Dec: `1.50 == 1.5` |
+| `to_dec(n, scale: 2)`, `to_dec(x, scale: 2, rounding: HalfEven)` | Int → Dec, Float → Dec | exact, or from the Float's exact value, rounded |
+| `to_int(x, rounding: Down)`, `to_float(x)` | Dec or Float → Int; Int or Dec → Float | rounded as said; to the nearest Float |
+| `parse_dec(text, scale: 2)`, `parse_float(text)` | View → `Option[…]` | JSON's number syntax. A Dec must be exact at its scale |
+| `abs`, `min`, `max` | Int, Dec, Float | |
+| `sqrt`, `floor`, `ceil`, `trunc`, `nearest` | Float | exactly as IEEE 754 defines them. `nearest` sends ties to even |
+
+The roundings: `HalfEven` sends a tie to the even neighbour (2.5 → 2, -2.5 → -2), `HalfUp` sends it away from
+zero (2.5 → 3, -0.5 → -1), `Down` goes toward zero, `Up` away from it, `Floor` toward -∞ and `Ceiling` toward +∞.
```

## §5 Patterns

```diff
-| `"text"`, `42`, `True` | that value |
+| `"text"`, `42`, `12.30`, `True` | that value. A Dec literal must fit the subject's scale. A Float is matched with a guard, not a literal (C19) |
```

## §6 Effects (after the SQL paragraph)

```diff
 SQL is checked at compile time against the program's tables: names, the type of each value against where it is
 used, and the row type's fields against the columns (`*` means the row type's fields, by name).
+
+A Dec is stored in an INTEGER column declared to hold it (section 7) as a count of its smallest unit: 12.30 as
+1230. That is what the SQL sees, so `CHECK (amount > 0)` and `SUM(amount)` work unchanged, and a literal such as
+`amount > 1000` means 10.00. A value beyond ±2^53 units stops the request instead of being rounded. A Float is
+never given to a statement (C89). A REAL value can be read into a Float field, such as `avg(score) AS mean`.
+
+JSON written from a Dec is a string, `"12.30"`. Decoding a Dec takes a number or a string and must be exact at
+its scale: `12.345` for a `Dec[2]` is refused with `amount: not a valid Dec[2]`. A Float is written as the shortest
+number that reads back as it.
```

## §7 Declarations about rows

```diff
 | `machine orders.state { "a" -> "b" }` | the moves a column may make. Every write of the column is checked against them, and the host installs triggers that refuse any other |
+| `column orders.amount: Dec[2]` | the column holds `Dec[2]` as INTEGER units. Every value bound to it or read from it is a `Dec[2]` (C92). Changing the scale is a `contract` migration |
 | `invariant "name" { SELECT … }` | rows that must not exist: the SELECT returns what is wrong. Checked after every commit by `tape sim`, and by `app.invariants()` in the host |
```

## §8 A whole program

```diff
     amount INTEGER NOT NULL CHECK (amount > 0),
@@
 machine orders.state {
   "paying" -> "paid"
   "paying" -> "failed"
 }
+
+column orders.amount: Dec[2]
@@
-type Amount = Int where self >= 1 and self <= 1000000
+type Amount = Dec[2] where self >= 0.01 and self <= 10000.00
 type NewOrder { NewOrder(key: Key, amount: Amount) }
-type Order { Order(id: Int, amount: Int, state: View, note: View) }
-type Charge { Charge(amount: Int) }
+type Order { Order(id: Int, amount: Dec[2], state: View, note: View) }
+type Charge { Charge(amount: Dec[2]) }
```

## §9 One way to do each job (rows added to the table)

```diff
 | Change a number in a row | a compare-and-set, an op-id guard, or `repeat: True` on the call when every attempt should count | C54 |
+| Hold money, or any exact quantity with a fraction | `Dec[s]` in an INTEGER column, `column t.c: Dec[s]` | C92 |
+| Divide money | `div(a, by: b, scale: 2, rounding: HalfEven)`; to split a total, `allocate(total, parts: n)` | C19 |
+| Change a Dec's scale | `rescale(x, to: 3)` up, `round(x, to: 2, rounding: …)` down | C14 |
+| Measure | `Float`, kept out of SQL, keys and guards: stored as `to_dec(x, scale:, rounding:)` | C89-C91 |
 | Pass a value to a query | `:name` in the query, and an argument of that name | C11, C13, C32 |
```

Edits to the §8 program that must be refused:

````diff
```diff C92
-column orders.amount: Dec[2]
+
```

```diff C14
-type Charge { Charge(amount: Dec[2]) }
+type Charge { Charge(amount: Dec[3]) }
```
````

(The C14 edit is refused at `send: Charge(amount)`, where `amount` is a `Dec[2]`: "field amount should be
Dec[3] but is Dec[2]: make the scales equal with `rescale(amount, to: 3)`".)

Programs refused whole:

````diff
+A Float is never given to the database. It would be stored, or compared, as a binary fraction:
+
+```tape refused C89
+migration 1 "m" {
+  CREATE TABLE m(id INTEGER PRIMARY KEY, reading REAL NOT NULL)
+}
+
+fn handle(raw: View, db: Sql) -> Buf {
+  let _ = sql_exec(query: "UPDATE m SET reading = :r WHERE id = 1", r: 21.5f, repeat: True)
+  respond(status: 200)
+}
+```
+
+A key is what names a command. A Float computed again on a retry may differ in its last digit, and the command
+would then run twice:
+
+```tape refused C90
+type Pay { Pay(order: Int, amount: Float) }
+type Done { Done(ok: Bool) }
+
+fn handle(raw: View, payments: Remote) -> Buf {
+  let Ok(value: Done) = call(
+    to: payments,
+    method: "pay",
+    send: Pay(order: 1, amount: 0.1f + 0.2f),
+    reply: Done,
+    within: 2000,
+    once: Pay(order: 1, amount: 0.1f + 0.2f)
+  ) else -> respond(status: 502)
+  respond(status: 200)
+}
+```
+
+A quantity taken from a REAL column can be stuck above its floor, with no take that fits:
+
+(C73 may also fire first on this program; the test asserts C91 is among the codes.)
+
+```tape refused C91
+migration 1 "stock" {
+  CREATE TABLE stock(item TEXT PRIMARY KEY, left REAL NOT NULL CHECK (left >= 0))
+}
+
+fn handle(raw: View, db: Sql) -> Buf {
+  let 1 = sql_exec(
+    query: "UPDATE stock SET left = left - 0.1 WHERE item = 'flour' AND left >= 0.1",
+    repeat: True
+  ) else -> respond(status: 409)
+  respond(status: 200)
+}
+```
````

## §10 When a program stops

```diff
-A trap ends the request, undoes its writes and is recorded: out of memory (64 MB), more than 50,000,000 steps, an
-index out of bounds, a division by zero. Nothing else stops a program: every other failure is a value.
+A trap ends the request, undoes its writes and is recorded: out of memory (64 MB), more than 50,000,000 steps, an
+index out of bounds, a division by zero, an Int or Dec that overflows, a Float operation whose result is not a
+finite number, and a Dec or Int given to the database beyond ±2^53 units. Nothing else stops a program: every
+other failure is a value.
```

## §11 Not defined yet

```diff
-- JSON for bytes, maps and floats; writing a record with an `Option` field.
-- Numbers other than `Int`.
+- JSON for bytes and maps; writing a record with an `Option` field.
+- A Dec beyond ±2^53 units in the database; functions generic over a Dec's scale; `pow`, `exp`, `log` and the
+  trigonometric functions on Float; a Dec or Float flag.
+- Which shortest digits text gets from a Float when two are equally short: every engine Tape runs on picks the
+  closest, which ECMAScript recommends but does not require.
```

## §12 What went

Nothing goes: the change is additive (`1.5` does not parse in 0.2). If spec Q9 is decided for "`f` everywhere",
nothing goes either, because the unsuffixed Float context never shipped.
