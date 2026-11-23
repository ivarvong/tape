# Changes

What each release of the language changed, newest first, and the forms that went. [LANGUAGE.md](../LANGUAGE.md)
is the language as it is; this is how it came to be so, kept apart from it so that an agent learning the language
reads the definition once.

## Changes in 0.4

What 0.4 changed, from the 0.3 usability benchmark (48 agent runs) and its feedback, newest first. [What
went](#what-went), below, has the forms each replaced.

| When | Change |
|---|---|
| 23 November 2026 | a refinement refused says its type and only bounds it can put plainly, `key: expected Key, 1 to 64 bytes`, `name: expected Name, at most 40 characters`; any other condition is `not a valid Slug`. It had echoed the program's source (`expected a InvoiceId: char_count(v: self) >= 1 and … len(self: self)`: 28 of 48 runs on the 2026-11-23g bench complained) |
| 23 November 2026 | decode's reasons, breaking: one path, `items[2].price`, where it was `items[2]: price`; `missing` where it was `missing key "price"`; `null` its own reason, and `null` for an `Option` field is `None` (it was refused); `expected an integer` for `expected a whole number`, `expected a number with at most 2 decimals` for `not a Dec[2]`, and a refinement's condition (`expected 1 to 64 bytes`) for `not a valid Key`; the format is in section 6 |
| 23 November 2026 | a query takes an `Option` of an Int, Dec, Float, Bool or View, bound as NULL for `None` (sql_exec, sql_first, sql_all, sql_move); the checker reads it as a value that may be NULL: C69 into a NOT NULL column, and C69 when it is compared with `=` (or `!=`, `<`, …) and nothing in the statement asks `IS NULL`, `IS`, `coalesce` or `ifnull` of it |
| 23 November 2026 | std `compare(a, b)`: -1, 0 or 1, byte by byte. `Map`'s `get` and `put` compare the keys once at each node, where they asked `before` twice; the same maps and answers in fewer steps (words.tape on 2 MB: 28,710,918 steps, now 21,149,058) |
| 23 November 2026 | std `range(from:, to:)` (design memo of feedback 20261123T030026.990Z-e454772fe5c9, item 4): `fold` over it is a counting loop that makes no list (compiler/fuse.ts, in the build and the interpreter alike: n + 1 steps and no memory, where the list made first takes 2n + 2 steps and 24 bytes a number). No loop construct |
| 23 November 2026 | `Dec[s]`: an exact number with s digits after the point (0 to 18), an Int count of 10^-s. `12.30` is a `Dec[2]` (a point and no `f`, which was L06); `+ -` of one scale, `*` adding the scales, comparisons exact across scales, overflow a trap; `rescale` up and `round` down, the one way each; `mul` and `div` rounded once from an exact 128-bit intermediate (compiler/math/dec.ts), with std's `Rounding` (`HalfEven`, `HalfUp`, `Down`, `Up`, `Floor`, `Ceiling`); `dec(n, scale:)`, `to_int`, `float(d)` and `to_dec(x, scale:, rounding:)` the only conversions; `abs`, `min`, `max` |
| 23 November 2026 | a Dec at the edges: a hole and `write_dec` write its digits; `parse_dec(text, scale:)`; JSON in from a number or text, exact at the field's scale (`amount: not a Dec[2]` otherwise), out as text; SQL as its count, an INTEGER, within ±2^53. apps/tickets and apps/trace write cents and basis points as Decs (`"$\(0.01 * cents)"`) instead of by hand |
| 23 November 2026 | `write_json` writes what `decode` reads (feedback 20261123T030026.990Z-e454772fe5c9: a 5-constructor result was 30 lines of hand JSON): an `Option` field (`None` has no key), a type with several constructors (`{"Sets": {…}}`, which decode now reads back as that constructor), a `List` on its own and `Int`, `Bool`, `View`; `decode(json:, as: List[T])` reads an array. C09 no longer refuses an `Option` field, several constructors or a list on its own |
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

## What went

| When | What | Now |
|---|---|---|
| 23 November 2026 | decode's reasons `items[2]: price: not a Dec[2]`, `missing key "qty"`, `not a valid Key`, and `null` for an `Option` field refused | `items[2].price: expected a number with at most 2 decimals`, `qty: missing`, `key: expected 1 to 64 bytes` (section 6); `null` for an `Option` is `None` |
| 23 November 2026 | a value that may be absent passed to a query with a flag beside it (`WHERE (:all = 1 OR region = :only)`, `all: True, only: ""`): a query's values were never `Option` (C14) | an `Option` argument, NULL for `None`: `WHERE (:region IS NULL OR region = :region)` |
| 23 November 2026 | C65 on a key made only of what its message carries: it refused right keys (a row's id the message also carried, found in a pattern, a field, a parameter, an Option, a path: every such refusal in three bench rounds was a right key), and its way out, the message itself as the key, had the defect it refused | gone; C65 keeps only a key that is the same every time, and C71 that a command built from a row names it |
| 23 November 2026 | a long condition or sum wrapped onto a line starting with `and`, `+`, … (P02), and an arm's value on the line after its `->` (P02) | a line that starts with a binary operator carries the expression on, as `|>` does, and an arm's or step's value may start on the line after `->` |
| 23 November 2026 | a `once:` key of the row's id was C65 when the message carried that id too (a payment API asks for it), and C65's fix said to key by that id; C71 asks for the id | C65 takes a key that names the row by its primary key; a key made only of other values the message carries (the amount) is still C65 |
| 23 November 2026 | std `write_each(out, list, by)`, a second fold for a Buf | `fold(list, from: out, by)`: a Buf is handed from item to item as any accumulator is |
| 23 November 2026 | `write_json_list(list, by:)`, and JSON written by hand for an `Option` field, a type with several constructors or a list on its own (C09 refused them) | `write_json(value)` of the value itself, which `decode` reads back; computed items are `map`ped into a record type |
| 23 November 2026 | no response headers (a redirect had no Location) and no request headers | `header(name:, value:)` on an answer and `header_of(request:, name:)`; the status line carries them, `STATUS CR name: value LF BODY`, checked by the host (host.ts responseOf) |
| 23 November 2026 | a JSON list of computed items needed a Buf kept in a record (C08), and `Cons(head: 1, tail: Nil)` in a `let` could not tell its type (C21) | std: `write_json_list`, `write_each`, `join`; a constructor's later fields take the type parameters its earlier ones gave |
| 23 November 2026 | a debit after its transfer id was inserted (`ON CONFLICT DO NOTHING`, the row required by a step) was C54, and agents marked it `repeat: True` | the claim is an op-id guard: C54 takes a write that runs only once the claim inserted its row |
| 23 November 2026 | byte classes, a number with a sign or leading zeros, min and max written by hand in each program | std: `is_digit is_alpha is_alnum is_space is_lower is_upper`, `every_byte(v: …, keep: …)`, `parse_int(text: …)`, `min`, `max` |
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
