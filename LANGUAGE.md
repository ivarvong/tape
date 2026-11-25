# The Tape language, version 0.3

This is the definition of Tape as it stands: what a program is made of, and the one way to do each job. It is
short on purpose. [The guide](docs/guide.md) teaches; this states. Where the two disagree, this file is right, and where this file
and the compiler disagree, that is a bug in one of them: `test/definition.ts` compiles every program in this file, makes
every edit it shows, and fails when the compiler does not say what the file says. Where this file says something is
refused, the code the compiler gives follows in brackets; [docs/diagnostics.md](docs/diagnostics.md) lists every code
with what it refuses.

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
3. **What a function can do is in its signature.** An entry point (`handle`, `woken`, an exported function)
   declares each capability as a parameter: the database, another program, the clock, random numbers, a timer, its
   secrets, the network. Every other function that reaches one, itself or through what it calls, says so with
   `uses`: `fn load(id: Int) -> Option[Order] uses db`. It uses the capability by its name without passing it; a
   capability no entry point declares is refused with the call path to its use (C72), and a signature that does not
   say what its function reaches is refused with the clause to write (C101, section 4).

## 2. Text

`//` starts a comment. An Int runs from `-9223372036854775808` to `9223372036854775807`. Written in digits, a `-`
before them is part of the literal (`-7`, and in a pattern `-1 ->`), and a literal outside that range is refused
(P08). A byte is that Int written as the byte: `'*'` is 42, `' '` is 32, `'\n'` is 10 and `'\''` is 39. It is one
printable ASCII character (32 to 126) other than `'` and `\`, or one escape (`\' \" \\ \/ \n \r \t \b \f`); empty,
two characters, a character past ASCII, a raw control character (a tab, a NUL), or an unknown escape is L07, and a byte
from 128 to 255, or a control byte with no escape, stays a decimal integer. Inside a text's `\( )` it is one token, so
`"\(')')"` holds the byte `)`. It is an
Int, so the compiled code is that integer's, and a `-` before it is part of the literal, as before digits
(`-'*'` is -42). A single quote inside a migration's SQL is that SQL's quote. A number with a point is an exact
decimal, a Dec whose scale is the digits written after the point:
`12.30` is a `Dec[2]`, `-0.5` a `Dec[1]`, at most 18 of them (L06). A Float literal ends in `f`: `1.5f`, `2f`,
`1e-3f`, `6.02E23f`, at most 20 significant digits and no larger than the largest Float (L06); an exponent with
no `f` is refused (L06). Text literals are in double quotes, on one line, with the escapes
`\" \\ \/ \n \r \t \b \f`. `\(e)` in a literal is a hole: `"Hello, \(name) #\(n)"` is the text with the value
of each expression in its place, a View as it is, an Int in decimal, a Dec with exactly its scale's digits after
the point (`12.30`, `-0.05`), and a Float in the shortest digits that read
back as it (`0.1`, `5`, `1e+21`, as JavaScript's `String` writes a number). A hole holds one expression with no text
literal in it (L05); a value of any other type is refused (C19). Appended to a Buf, the text is written straight
into it. A newline ends a declaration or a step, except inside `( )` and `[ ]`;
before a line that starts with `|>` or a binary operator (`and`, `or`, `++`, `+`, `*`, `/`, `%`, `==`, `!=`, `<`,
`<=`, `>`, `>=`, `&`, `|`, `^`, `<<`, `>>`), which carries the step on; and after a line that ends with an arm's or a
step's `->`, whose value may start on the next line. No statement starts with one of those operators, so a line that
does is the rest of the one before. `-` is not one of them, as it also starts a value (`-x`): `a - b` stays on one
line or in parentheses (P02 says so). The formatter breaks a line that is too long before each `|>`, then before each
`and` and `or`, and indents a carried line once more. A backslash at the end of a line inside a
text literal carries the text on after the next line's indentation. An expression or a pattern stands at most 500
deep, each bracket, call and operator it is inside counted once, each `|>` twice, and each match and lambda four
times (P09): a deeper one is named with `let` or moved into a function of its own.

```tape gives
fn mark(b: Int) -> Int {
  match b {
    '*' -> 1
    '`' -> 2
    _ -> 0
  }
}

fn punct(b: Int) -> Int {
  match {
    b == '*' or b == '`' -> 1
    else -> 0
  }
}

// mark(42) is 1
// mark(96) is 2
// mark(65) is 0
// punct(42) is 1
// punct(65) is 0
```

Reserved words: `fn export type schema migration match with let do if else and or not`. Words with a meaning
only where they stand: `interface flag machine invariant where contract settled private final read write uses` (`private` before `fn` or `type`, `uses` after a function's result type). A reserved
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
| `Dec[s]` | an exact number with s digits after the point, 0 ≤ s ≤ 18: an Int count of 10^-s (12.30 is 1230 hundredths), so arithmetic is exact or it traps, as an Int's. For money, and any quantity with a fixed number of decimals |
| `Float` | a 64-bit IEEE 754 number that is never NaN and never infinite: an operation that would make one traps. For measurements, not for money, counts or keys |
| `Bool` | `True` or `False` |
| `View` | read-only bytes (text is UTF-8 bytes) |
| `Buf` | bytes being written. It has one owner: a function that is handed a `Buf` uses it once (C25) |
| `Rows[T]` | the rows of a query, folded with `fold_rows`, or read one at a time with `next`. Not a `List`: no list of the rows is made |
| `Sql` `Remote` `Clock` `Entropy` `Timer` | capabilities: only ever parameters, never stored or returned |
| `type T { A(x: Int)  B }` | a sum of constructors, each with named fields. `type T[P] { … }` takes type parameters. A sum of two or more constructors, none with fields (`type EventState { Onsale PartlyRefunded }`; one constructor with none is a record with no fields, `{}` in JSON), is stored as text: each constructor as its name in snake_case (`Onsale` is `onsale`, `PartlyRefunded` is `partly_refunded`), in a column (section 7), in a query's value, and in JSON |
| `type Key = View where len(self) >= 1` | a refined type: a base type and a condition. A value has it only after a pattern or a decode proved the condition. It stands wherever its base type is asked, and so does an `Option`, `List` or `Result` of it (`Option[Delay]` where `Option[Int]` is asked); a function goes the other way in what it takes (`Fn[Int, X]` is an `Fn[Delay, X]`), and any other type of it is only itself. `… else "lowercase letters, digits and -"` is what decode's 400 says of a value for which the condition does not hold (section 6) |
| `interface Git { read head(Ref) -> Head }` | what a capability bound by the host can be asked |

std defines `Option[T]` (`Some(value)`, `None`), `Result[T, E]` (`Ok(value)`, `Err(error)`), `Rounding`
(`HalfEven`, `HalfUp`, `Down`, `Up`, `Floor`, `Ceiling`), `Move[T]`
(`Moved(value)`, `Raced(now)`, `NoRow`), `CallError[E]` (`Timeout`, `Unreachable`, `Rejected(reason: E)`,
`Skew(reason)`), `Map[T]`, `List[T]`, `Request`, `Wake`, and what a request and its answer are (std/http.tape):

| Type | What it is |
|---|---|
| `Request(method: Method, path: View, query: Option[View], body: View, caller: Caller, headers: View)` | a request, as `request(raw)` reads it |
| `Caller` | who is calling: `Operator` (the operator's token), `Anyone` (a published name's public route, no session), `Session(id)` (the name's own origin, with the session an answer of this program started there: section 12) |
| `Method` | `Get`, `Head`, `Post`, `Put`, `Patch`, `Delete`, `Options`, and `Other(name)` for any other token: a misspelt route is an unknown constructor (C20), not an arm no request matches. The service runs a HEAD request as the GET it stands for and sends no body, so the program sees `Get` |
| `Response(status: Int, content: Content, headers: List[Header], body: View)` | what `handle` answers: made by `respond`, `respond_as`, `json`, `empty` or `redirect`, never by writing bytes; `start_session(id:)` and `end_session()` start and end the client's session (section 12). The host writes the status and the headers from it, so no byte of a body can become either |
| `Content` | the body's type, a closed list: `Html`, `Json`, `Text`, `Css`, `Svg`, `Csv`, `Atom`, `Rss`, `Xml` |
| `Header(name: View, value: View)` | a response header, added with `header` |

`x == None` and `x != None` ask whether an Option `x` is `None`: they compare its constructor, not its value.
Nothing else compares an Option: not two Options, not `<` (C19). To use what it holds, take it apart (`let
Some(value) = x else -> …`, or `match`).

There are no implicit conversions between numbers, and no null, no exceptions, no mutable variables and no loops.

On `Int`: `+ - *` and unary `-` give the exact result, and trap (integer overflow) when it does not fit in 64 bits.
`/` truncates toward zero and `%` has the sign of its left side; both trap on a zero divisor (division by zero),
and on the least Int by -1 (integer overflow: the quotient does not fit, so neither does the remainder). `& | ^`
work on the 64 bits. `a << n` and `a >> n` take a shift `n` from 0 to 63 and trap on any other; `<<` drops the
bits it moves out, `>>` copies the sign in. Where a hash or a checksum means arithmetic modulo 2^64, it says so:
`wrapping_add(a: …, b: …)`, `wrapping_sub(a: …, b: …)` and `wrapping_mul(a: …, b: …)` give the low 64 bits of the exact result.

On `Dec[s]`: `+` and `-` take two Decs of one scale. Two scales are refused (C14), and the fix is the one way to
change a scale: `rescale(x: …, to: 3)` adds digits, exactly; `round(x: …, to: 2, rounding: HalfEven)` drops them as
the rounding says. A literal is a Dec at the scale it is written: `price + 0.5` with a `Dec[2]` price is refused,
and the fix is `0.50`; `5` is an Int, so a Dec of five is `5.00`. `a * b` is exact and adds the scales (a
`Dec[2]` times a `Dec[3]` is a `Dec[5]`, refused past 18); an Int is a count, so `price * qty` stays a `Dec[2]`.
`== != < <= > >=` compare values whatever the scales: `1.50 == 1.5`. There is no `/` or `%` (C19): `div(a: …,
by: …, scale: 2, rounding: HalfEven)` is the quotient at a scale, and `mul(a: …, by: …, scale: 2, rounding: HalfEven)` a
product with fewer digits than `*` keeps, each rounded once from the exact value: they compute through a 128-bit
intermediate, so a rate applied to an amount, or `a * b / c`, loses nothing before the one rounding, and traps
only when the result does not fit. `by` may be an Int. `dec(n: …, scale: 2)` is an Int as a Dec, `to_int(x: …,
rounding: Down)` a Dec as an Int, `float(x)` the Float nearest a Dec, and `to_dec(x, scale: 2, rounding:
HalfEven)` a Float's exact value, rounded (`2.675f` is a little below 2.675, so HalfUp gives 2.67). The scales
these take are numbers written in the call. `abs`, `min` and `max` take Decs of one scale. The roundings:
`HalfEven` sends a tie to the even neighbour (2.5 to 2, -2.5 to -2), `HalfUp` away from zero (2.5 to 3, -0.5 to
-1, which is not JavaScript's `Math.round`), `Down` goes toward zero, `Up` away from it, `Floor` toward minus
infinity and `Ceiling` toward plus infinity. A Dec is matched with a guard, `x if x == 0.00 ->`, never a literal
pattern (C19).

On `Float`: `+ - * /` are IEEE 754's, rounded once to the nearest Float (a tie to the even one), the same bits in
every engine Wasm runs in; a result that would be infinite or not a number (`1f / 0f`, `0f / 0f`, `1e308f * 10f`)
traps (trap 8, float not finite), so every Float a program holds is finite. Unary `-` is exact. `== != < <= > >=`
compare values, and `-0f == 0f`. `x % y` is the remainder of `x / y` truncated toward zero, `x - n * y` for that
whole n, with the sign of `x` as an Int's `%` has: exact (it is C's fmod, and JavaScript's `%`), so `7.5f % 2f` is
`1.5f` and `-7.5f % 2f` is `-1.5f`, and `x % 0f` traps (trap 8, float not finite) as `0f / 0f` does. There is no
bitwise operator (C19), and an Int and a Float do not mix
(C14): `float(n)` is the Float nearest an Int, and `trunc(x)` the Int toward zero, trapping (integer overflow)
outside the Ints. `floor(x)`, `ceil(x)`, `abs(x)` and `sqrt(x)` are exactly as IEEE 754 defines them (`sqrt` of a
negative traps); `abs`, `min(a: …, b: …)` and `max(a: …, b: …)` take two Ints or two Floats. `sin(x)`, `cos(x)`,
`tan(x)`, `asin(x)`, `acos(x)`, `atan2(y:, x:)`, `exp(x)`, `log(x)`, `pow(x:, y:)` and `%` are musl's (fdlibm's, and
Arm's), compiled into the module as Wasm, so a result is the same bits in every engine and in a replay: within 1 ulp
of the true value (atan2, 1.5 ulp), and a trap where it would be infinite or not a number (`log(0f)`, `exp(1000f)`,
`pow(x: -8f, y: 0.5f)`, `asin(x: 2f)`). std's `pi()` is the Float nearest pi. A
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
fn name(param: Type, …) -> Type uses db, clock {
  …
}
```

Arguments are named, `f(at: i)`, with two exceptions, one rule: a bare name that is one of the callee's parameters
passes that parameter (`f(at)` is `f(at: at)`), and any other first argument written without its name passes the
first parameter (`every_byte(self, keep: is_lower)`, `fact(n - 1)`, `pow(b * 2, e: e - 1)`). Every argument after
the first is named or such a name (C10, C11). `a |> f(b: 1)` is `f(<first parameter>: a, b: 1)`, so after a pipe
the first written argument is named too. `fmt` writes an argument as it was written.
Every function is checked, whether anything calls it or not: a type error in one nothing calls yet is the
program's error, at its line. A generic function is checked where it is called, for the types it is called with,
and a function value written in it may name its type parameters (`fn(out: Buf, value: T) -> Buf`).
A name is the first file's. Another file may define it again (C04 refuses a second definition in one file); that
one is `file.name`, and in that file the bare name is its own. `handle` is the entry the host calls, so the
first file that defines it serves requests and a later file's is `file.handle`.
`private fn name(…)` is called, passed as a function value or matched as a pattern only in its own file (C94),
as `private type` builds its values only there (C66). std's helpers are private: a program reaches what they do
through the public functions docs/std.md lists, and a function of its own of a helper's name is its own. The calls
the compiler writes itself (decode's decoders, `write_json`, the holes of a text) reach std's helpers all the same.

A body is steps, then one expression that is its value. There are three steps:

| Step | Meaning |
|---|---|
| `let x = e` | name a value. `let Order(id, amount) = e` takes apart a value whose pattern cannot fail |
| `let P = e else { arms }` | go on with the case `P`; every other case leaves the function through an arm. `else -> e` takes all of them. `P` is any pattern a match arm takes: `let 1 = sql_exec(…) else -> …` goes on when one row changed, `let key ++ "=" ++ value = pair else -> …` splits a text. An `=` outside brackets ends the pattern; `name = P` binds a whole value inside them |
| `do f(…)` | run a call for what it does. The call's value must be `Done` (std's `type Done { Done }`): `wake` gives it, and so does a function that only does something (`fn recount() -> Done`). A call with any other value says something and is read: `let 1 = sql_exec(…) else -> …` goes on when one row changed, `let _ = sql_exec(…)` drops the count on purpose (C82) |

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

Repetition is a function calling itself; a call in tail position does not grow the stack. Counting is `fold`
over `range(from:, to:)`, the Ints from `from` up to `to` and not `to` itself (none when `to` is not above
`from`): `range(from: 1, to: n + 1) |> fold(from: 1, by: …)` is a product, and with `from: out` and a function
that takes a Buf, each number is written into it. Folded, a range is a counting loop that makes no list (section
10); anything else (`map`, a `let`, a match) is handed the list.

```tape gives
fn factorial(n: Int) -> Int {
  range(from: 1, to: n + 1) |> fold(from: 1, by: fn(acc: Int, k: Int) -> Int { acc * k })
}

fn dots(n: Int) -> Int {
  let out = range(from: 0, to: n)
    |> fold(from: buf(), by: fn(o: Buf, k: Int) -> Buf { o |> push(byte: 46) })
  len(freeze(buf: out))
}

// factorial(20) is 2432902008176640000
// factorial(0) is 1
// dots(3) is 3
```

Capabilities are ambient by name. An entry point (`handle`, an exported function) declares each one it uses,
itself or through what it calls, as a parameter (C72 names the call path when it does not); every other function
uses it by that name without passing it: `sql_first(…)` in a helper uses handle's `db: Sql`, and `now()` its
`clock: Clock`. A built-in that needs one no entry point declares is C72 at the call.

What a function reaches is in its signature: after its result type, `uses` and the name of each capability it uses
by name, itself or through a function it calls, in alphabetical order (`-> Option[Order] uses clock, db`). A function
that reaches none writes no clause, and an entry point writes none (its capabilities are its parameters), nor does
a function for a capability it is given as a parameter. A clause missing, naming one the function does not reach,
or out of order is C101, whose fix is the clause to write; `tape fmt` writes it. The clause is checked, not
compiled: a function value cannot use a capability (C44), so a clause is never part of a type, and the code
is the same with it or without it. `uses` is a word only there.

## 5. Patterns

A pattern can fail, and binds what it proves.

| Pattern | Matches |
|---|---|
| `Ctor(field, other: P)` | that constructor; a field named bare is bound, fields left out are not looked at. A field given a pattern binds its own name too, where the arm reads it and nothing else binds it: `Some(value: Account(balance: 0)) -> value.id` |
| `"text"`, `42`, `'*'`, `-1`, `True` | that value. A byte literal is the Int it spells (`'*'` is 42). A Dec or a Float has no literal pattern (C19): bind it and compare in a guard |
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

A match on a machine's states (section 7), where they are told apart, names each state in an arm of its own: an arm
that takes the value whatever its state, `_`, a name, or a row pattern that leaves the state out, after or beside
arms that name states, is refused (C97), so a state added to the machine fails to compile at every match that
would otherwise take it without a word. A match that names too few is C24.

## 6. Effects

| Call | Needs | Does |
|---|---|---|
| `sql_first(row: T, query: "… WHERE id = :id", id)` | `Sql` | the first row, as `Option[T]` |
| `sql_all(row: T, query: "…")` | `Sql` | `Rows[T]` |
| `sql_exec(query: "…")` | `Sql` | the number of rows changed |
| `sql_move(row: T, query: "UPDATE … WHERE … RETURNING *")` | `Sql` | a compare-and-set: `Moved(value)`, `Raced(now)` when another run moved the row first, `NoRow` |
| `call(to:, method:, send:, reply:, error:, within:, once:)` | `Remote` | a command to another program: `Result[Reply, CallError[Error]]`, `error:` the callee's error type (C98 for a View). A repeat of a `once` key gets the first run's reply and runs nothing: its stored reply, or, sent while the first run waits on a call, that run's reply when it comes (`Unreachable` if it does not come within the budget: send it again) |
| `ask(to:, method:, send:, reply:, error:, within:)` | `Remote` | a read: the same, with no key |
| `fetch(to: http, method: Post, url:, headers:, body:, within:, key: Some(…))` | `Http` | an HTTP request to another service (std/http.tape): `Result[HttpReply, CallError[View]]`, `HttpReply(status, headers, body)` whatever its status, a redirect not followed. Every method but `Get` and `Head` writes `key: Some(…)`, sent as Idempotency-Key, so it can be sent again after a `Timeout` (C100). The log records the request with each secret the run read written `[secret <name>]`; a replay answers from the log. On the service only a host on the name's list is reached ([docs/service.md](docs/service.md#outbound-http)); any other is `Rejected` |
| `wake(after: ms, key: n)` | `Timer` | `Done`, run with `do`: asks for `export fn woken(…, message: Wake)` to run later with `Wake(key: n)`. A run cut short at a call runs again, and so does a run that fails on a storage error, after a wait that doubles each time (1 s up to 15 min); a run that traps is not retried |
| `now()` | `Clock` | milliseconds since 1970 |
| `random()` | `Entropy` | 53 random bits |
| `secret(from: secrets, name: "stripe")` | `Secrets` | the program's secret of that name, `Option[View]`: on the service, what the operator set with `PUT /_secrets/…` ([docs/service.md](docs/service.md#secrets)). The log records the name and the version read, never the value; a replay reads that version, and stops, saying so, when it is gone |
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

A Dec is given to a query as its count, an INTEGER (12.30 is 1230), and an INTEGER column reads into a Dec field
as a count at the field's scale; so the SQL sees counts, and `CHECK (amount > 0)` and `SUM(amount)` work on them.
A count beyond ±2^53 stops the request rather than reach the database rounded. In JSON a Dec is written as text,
`"12.30"`, exact for any reader, and decoded from a number or text that is exactly a Dec of the field's scale
(`12.3` and `"12.300"` for a `Dec[2]`, but not `12.345`: `amount: expected a number with at most 2 decimals`).
`parse_dec(text: …, scale: 2)` reads one from text the same way, as an `Option`.

In JSON a View is a string, escaped as `JSON.stringify` escapes one. A View is bytes, and bytes that are not UTF-8
have no JSON: `write_json` writes U+FFFD for each maximal part of them, as a WHATWG decoder (`TextDecoder`) reads
the same bytes, so what it writes is always JSON, and `decode` of it gives the text with those parts replaced. A
View that is UTF-8 comes back as it was.

A sum whose constructors have no fields is, in a query and in JSON, the text of its constructor (section 3): bound
to a query as that TEXT, read from a TEXT column (any other text in the column stops the request, as a NULL does
where the field is not an `Option`), written by `write_json` as the string (`"onsale"`, not `{"Onsale": {}}`),
and decoded from it: any other value is `state: expected one of "onsale", "canceled"`.

**Why decode refuses.** `decode`'s `Err` is one line, the same from every host, made to be sent back as a 400
as it is: `<path>: <problem>`. The path names the value from the top, a field by its name and an element by its
index: `key`, `venue.city`, `items[2].price`, `grid[1][0]`. The problem is one of four:

| Problem | When |
|---|---|
| `missing` | the key is absent and the field is not an `Option` |
| `null` | the value is `null` and the field is not an `Option` (an `Option` field that is `null` or absent is `None`) |
| `expected <what>` | the value is of another kind, or fails a refinement whose bounds it can say |
| `not a valid <Type>` | the value fails any other refinement |
| the type's own message | the value fails a refinement written `where … else "message"`: `slug: lowercase letters, digits and -` |

`<what>` is `text`, `true or false`, `an integer`, `a number`, `a number with at most 2 decimals` (a `Dec[2]`),
`an object`, `an array`, `text without lone surrogates`, or, for a refinement, its type and its bounds: `Key =
View where len(self) >= 1 and len(self) <= 64` is `expected Key, 1 to 64 bytes`; `char_count(v: self) <= 3` is
`at most 3 characters`; `Qty = Int where self >= 1 and self <= 9` is `expected Qty, 1 to 9`; `self > 0.00` is
`more than 0.00`. Only bounds on the length in bytes, in characters or on the value, each a literal, are said; any
other condition (a call such as `every_byte`, a bound that is a flag) is `not a valid Slug`: a 400 never shows the
program's source. An `else "…"` message is printed after the path, so it says what the value must be and does not
name its field: `else "lowercase letters, digits and -"`, not `else "url: …"`, which would print `url: url: …`. Of
the body as a whole the reasons are `empty`, `not JSON`, and `expected an object` (or
`expected an array` for `as: List[T]`). `as:` may also name a scalar, `Int`, `View`, `Bool`, `Float` or a
refinement of one: the body is then that one JSON value, read as an element of a list is, so its reasons are an
element's without the index (`null`, `expected an integer`, `expected Key, 1 to 64 bytes`); this reads what
`json_member` finds (`decode(json: raw, as: View)` for a string). The first problem is the reason: each field's kind is checked in order,
then each refinement, then what is inside its records and lists. So `{"key": "", "items": [{"sku": "a", "price":
"1.505"}]}` as an order is `key: expected Key, 1 to 64 bytes`, and with a right key, `items[0].price: expected a
number with at most 2 decimals`.

**A call is a commit point.** Writes made before a `call`, an `ask` or a `fetch` are durable when it is sent. The run may end
there (the object is reset, the reply is lost), so whatever must happen afterwards needs a timer set before the
call, in the same commit.

`export fn name(db: Sql, message: Record) -> Result[Reply, Error]` is a method other programs call. `Error` is a
type of the program's own whose constructors are what the method refuses for (`type ReserveError { OutOfStock(left:
Int)  NoSuchItem }`); a View is C98, with that fix. A caller declares the same type and names it, `call(…, reply:
Reserved, error: ReserveError, …)`, and its refusal is `Err(error: Rejected(reason: OutOfStock(left)))`, a value
matched like any other: a match on `Rejected(reason: …)` names each constructor, or C24 says which it leaves out. On
the wire the error is JSON, as write_json writes it (`"no_such_item"` for a type whose constructors have no fields),
and the two sides' fingerprints cover the message, the reply and the error, so a caller built against another error
type gets `Skew` and nothing runs; a refusal it cannot decode is `Skew` too, never a `Rejected` it cannot read.
**Adding a constructor to an error type is a breaking change**: every caller with a match that names each
constructor stops compiling until it says what the new one means, and a caller not rebuilt gets `Skew`, as for any
change of the message or the reply. Removing one breaks no match, and still changes the fingerprint. `woken`'s
error may be a View: the host logs it, and no program calls it. `handle(raw: View, …capabilities) -> Response`
serves requests (C14 for any other type: a `Buf` is the body being written, not an answer). `woken` serves timers.

**An answer is a value.** The body is written first and its status given last, `buf() |> append(view: …) |>
respond(status: 200)`; `respond_as(status:, content:)` names its type, `json(status:, value:)` answers a value as
JSON, `empty(status:)` answers no body, and `redirect(to:)` is a 303 to `to` (the status a browser follows with a GET
whatever the request was; another redirect is `empty(status: 308) |> header(name: "location", value: …)`). An error
is `problem(status: 404, detail: "no such order")`: application/problem+json (RFC 9457), `{"type":"about:blank",
"title":"Not Found","status":404,"detail":"no such order"}`, the shape the service answers its own errors in;
`problem_with(status:, detail:, members: R)` adds the fields of the record `R` after `detail`.
`header(out, name:, value:)` adds a header to a Response and copies nothing. The function the compiler generates
around `handle` gives the host the Response; the program writes no byte of the head. A status written as a literal
outside 200 to 599, or a 204, 205 or 304 given a body, or a problem's outside 400 to 599, is C96; one computed at run time, and a header the host
refuses (a name that is not a token, a value that is not printable ASCII, a name the host sets itself, more than 32),
are answered 500 with the reason.

## 7. Declarations about rows

| Declaration | States |
|---|---|
| `migration 1 "name" { SQL }` | the tables. Migrations only add (C51); one marked `contract` may remove. A column read into a field that is not an `Option` is never NULL: declare it NOT NULL. SQLite lets a PRIMARY KEY column hold NULL too, unless it is an `INTEGER PRIMARY KEY` (the rowid; not `DESC`) or its table is `WITHOUT ROWID` or `STRICT`, so `id TEXT PRIMARY KEY NOT NULL` (C69) |
| `machine orders.state: OrderState { Paying -> Paid }` | the moves a column may make, between the constructors of a sum whose constructors have no fields (`type OrderState { Paying Paid }`): each is a state, every one is named by a move, and the first named is where a row starts (C57). The column holds each state as its constructor's text (section 3: `'paying'`), so the SQL compares and sets those texts; a row type's field read from the column is that type, not `View` (C69). Every write of the column is checked against the moves, and the host installs triggers that refuse any other |
| a column read into a sum whose constructors have no fields | the text of one of them: any other text stops the request, as a NULL does where the field is not an `Option` |
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

type OrderState { Paying Paid Failed }

machine orders.state: OrderState {
  Paying -> Paid
  Paying -> Failed
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
type Order { Order(id: Int, amount: Int, state: OrderState, note: View) }
type Charge { Charge(order: Int, amount: Int) }
type Charged { Charged(payment: Int) }
// what payments refuses a charge with: the type its `export fn charge` returns in Err
type ChargeError { Declined(reason: View) }
type ForOrder { ForOrder(order: Int) }

type Outcome {
  Shown(status: Int, order: Order)
  Problem(status: Int, reason: View)
}

fn handle(raw: View, db: Sql, payments: Remote, timer: Timer) -> Response {
  match request(raw) {
    Request(method: Post, path: "/orders", body) -> place(body) |> rendered
    Request(method: Get, path: "/orders/" ++ decimal(id)) -> shown(status: 200, found: load(id))
      |> rendered
    Request(method: Get, path: "/orders") -> buf()
      |> write_rows(rows: sql_all(row: Order, query: "SELECT * FROM orders ORDER BY id"))
      |> respond_as(status: 200, content: Json)
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

fn place(body: View) -> Outcome uses db, payments, timer {
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

fn charge(order: Order) -> Outcome uses db, payments, timer {
  match order {
    Order(id, amount, state: Paying) -> {
      let Ok(value: Charged) = call(
        to: payments,
        method: "charge",
        send: Charge(order: id, amount),
        reply: Charged,
        error: ChargeError,
        within: 2000,
        once: ForOrder(order: id)
      ) else {
        Err(error: Rejected(reason: Declined(reason))) -> moved(m: sql_move(
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
    Order(state: Paid) -> Shown(status: 200, order)
    Order(state: Failed) -> Shown(status: 200, order)
  }
}

fn load(id: Int) -> Option[Order] uses db {
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

fn rendered(outcome: Outcome) -> Response {
  match outcome {
    Shown(status, order) -> json(status, value: order)
    Problem(status, reason) -> problem(status, detail: reason)
  }
}
```

## 9. One way to do each job

Each row is a job, the form for it, and what the compiler says to the other way. The edits below the table are
made to the program above by `test/definition.ts`; each must be refused with the code shown.

| Job | The form | Otherwise |
|---|---|---|
| Ask whether an Option holds a value | `title != None` (`let True = title != None or done != None else -> …` for a body with something in it); to use the value, `let Some(value: t) = title else -> …` | C19 for two Options compared or `<` |
| Read a JSON body | `decode(json: body, as: T)`, then `let Ok(value: T(…)) = … else { Err(error) -> … }`. A body that may be one of several shapes is a type with several constructors; a body that is an array is `as: List[T]`. A key the type does not name is left unread (clients send more than a service reads); an `Option` field that is absent or `null` is `None`. Its `Err` is `<path>: missing`, `null` or `expected <what>` (section 6), ready to send as a 400. Of several constructors, decode takes the one the body's only key names, `{"Sets": {…}}`, as `write_json` writes it; else the one that has all its fields among the keys and names the most of them. A type whose constructors have no fields is read from the text of one, `"paying"` (section 3), and refused with `<path>: expected one of "paying", "paid", "failed"`. The module reads the JSON itself (std/json.tape), and reads a number exactly from its text. An `Int` field takes a JSON number whose value is a whole number from -9007199254740991 to 9007199254740991 (±(2^53 - 1)), so `1e3` is 1000 and `2.0` is 2, but `1.0000000000000000001` is not a whole number; one outside that range is refused, with `Err("<field>: expected an integer")`, never rounded. Send a larger value as text until exact large-integer JSON, the whole 64-bit range, comes | C35 |
| Read JSON of any shape | `is_json(text: body)` says whether the bytes are JSON, building nothing; `json_member(json: body, key: "id")` is the JSON text of one top-level member's value (`Option[View]`, the first member of that key), to read with `decode(json: raw, as: View)`, `as: Int` or `as: T` | |
| Write JSON | `write_json(value: …)`: what `decode` reads back, so `decode(json: written, as: T)` is the value again. A record is an object in the order of its fields; an `Option` field that is `None` has no key, `Some(value)` is its value; a type with several constructors is `{"Constructor": {…}}`, and one whose constructors have no fields is the text of its constructor, `"paid"`; a `List` is an array. `write_rows(rows: …)` for the rows of a query | C09 |
| Write a list of computed items | `write_json(value: map(list, by: fn(item: T) -> Line { … }))`: a record type for the items, never a Buf kept in one (C08); `fold` again for a total, `join(list: …, sep: …)` for text | C08 |
| Put values in text | a hole, `"\(n) of \(total)"`; `out |> append(view: …)` to grow a Buf piece by piece in a loop | C19 |
| Hold money, or any number with a fixed count of decimals | `Dec[s]`, with literals at its scale (`12.30`) | C14 |
| Change a Dec's scale | `rescale(x: …, to: 3)` up, exactly; `round(x: …, to: 2, rounding: HalfEven)` down | C14 |
| Divide a Dec, or apply a rate | `div(a: …, by: …, scale: 2, rounding: HalfEven)`, `mul(a: …, by: rate, scale: 2, rounding: HalfEven)`: exact, then rounded once | C19 |
| Money in currencies of different places (USD 2, JPY 0) | one scale for all, `Dec[2]`; for a 0-place currency compute at scale 0 and rescale up, `rescale(x: mul(a: sub, by: rate, scale: 0, rounding: HalfUp), to: 2)`, rather than round a 2-place result (that rounds twice) | C14 |
| Measure | `Float`, with `f` literals; `float(n)` from an Int, `trunc(x)` back. sin, cos, tan, asin, acos, atan2, exp, log, pow and `%` are Float's, and `pi()` is std's: a Dec has none (`sin(x)` of a Dec is C14), so an exact kernel stays Int, with Dec at its edges | C14 |
| Run something for what it does | `do f(…)` for a call whose value is `Done` (`wake`, a function that returns `Done`); a write's count is read, `let 1 = sql_exec(…) else -> …` when the row must be there or the guard must hold, or dropped by name, `let _ = sql_exec(…)`, when it does not matter (an insert that always adds its row, a delete that prunes) | C82, C83-C85 |
| Count, or do something n times | `fold` over `range(from:, to:)` | |
| Write each item of a list | `fold(list, from: out, by: fn(out: Buf, item: T) -> Buf { … })` | |
| List the rows of a query | `sql_all(row: T, query: …) \|> fold_rows(from: out, by: fn(out: Buf, row: T) -> Buf { … })`, or a total in `from`; `write_rows(rows: …)` for JSON. A list of the rows is a fold into `Cons`, then `reverse` | |
| Go on with one case, leave with the rest | `let P = e else { … }` | |
| Make a row on a POST | the client's key in a `UNIQUE` column, `ON CONFLICT(key) DO NOTHING`, and the same key again answers with what the first made; a create meant to make a new row on each call (no client key) says so with `repeat: True` | C55 |
| Give a row a status | a type whose constructors are the states (`type OrderState { Paying Paid Failed }`), a `machine orders.state: OrderState` of the moves, the row's field of that type (`state: OrderState`), and `sql_move` whose WHERE names the state it moves from. A match on the state names each one, so a state added to the machine does not compile until every match says what it does | C57, C59, C63, C69, C97 |
| Change a number in a row | a compare-and-set, an op-id guard, a write after a step that claims an op id (`let 1 = sql_exec(query: "INSERT … ON CONFLICT DO NOTHING") else …`: a second run inserts nothing and leaves; the write may be in a function every call of which comes after the claim), or `repeat: True` on the call when every attempt should count | C54 |
| Pass a value to a query | `:name` in the query, and an argument of that name. A Bool is bound as 1 or 0 and read back from an INTEGER column (`done INTEGER NOT NULL DEFAULT 0`, `WHERE done = :done`); an Int is INTEGER, a View TEXT, a Float REAL, a constructor of a type whose constructors have no fields the TEXT it is stored as (`Paid` is 'paid', section 7); an `Option` of one is NULL for `None`
 | C11, C13, C32 |
| Filter by a value that may be absent | an `Option` argument, NULL for `None`, and the query says what None means: `WHERE (:region IS NULL OR region = :region)` for no filter, `WHERE region IS :region` for the rows whose region is NULL. An Option compared with `=` and never asked `IS NULL` is refused, since `= NULL` takes no row; into a NOT NULL column, too | C69 |
| Take from a quantity | `SET n = n - :qty WHERE … AND n >= :qty` | C73 |
| Take the next one (a lease, a free seat) | write the client's key into the row the claim takes (`SET lease = :key`), and before choosing, read the row that key already holds (`SELECT … WHERE lease = :key`) and answer with it | C95 |
| Command another program | `call` with `error:` (the callee's error type), `within:` and a `once:` key that names the command: the row's id (`ForOrder(order: id)`), or a key the client sent | C39, C41, C64, C65, C71 |
| Handle its answer | an arm for `Ok`, one for `Rejected` alone (the same key gets the same refusal), or one for each of the callee's reasons (`Rejected(reason: OutOfStock(left))`), one for no answer. An arm that takes both may only answer the client: a write, a call or a timer there acts on an outcome nobody knows | C24, C87 |
| Make sure it finishes | `do wake(after:, key: <the row's id>)` in the commit before the call, and `woken` carries the row on from its state | C77-C79 |
| Say what must hold | `invariant`, and `settled` for what must hold in the end | C86 |
| Answer | functions return a value (`Outcome`); one function turns it into a `Response`, the body written first and the status given last: `json(status: …, value: …)` for a value as JSON, `problem(status: …, detail: …)` for an error, `buf() \|> … \|> respond(status: …)` for text, `respond_as(status: …, content: Html)` for a type, `empty(status: 204)` for no body, `redirect(to: …)` for a 303. `handle` gives that Response, never bytes: the host writes the status and the headers from it, so no byte of a body can become one | C14, C96 |
| Set a response header | `json(status: 201, value: v) \|> header(name: "location", value: url)`: `header` takes and gives a Response, and copies nothing. A name is a token, a value printable ASCII; the host refuses those it sets itself (content-type, set-cookie, the security headers) and answers 500 with the reason | |
| Route a request | `match request(raw) { Request(method: Get, path: "/items/" ++ decimal(id)) -> … }`: the method is a `Method` (`Get`, `Post`, `Put`, `Patch`, `Delete`, `Options`, `Head`, `Other(name)`), so a misspelt one is an unknown constructor | C20 |
| Read a request header | `header_of(request: r, name: "if-none-match")`, an `Option[View]`; the host passes only those it means a program to see | |
| Write a date | `rfc3339(ms: now())` for JSON, a feed or a log (`2026-11-25T14:03:07.123Z`), `http_date(ms: …)` for a header (`Wed, 25 Nov 2026 14:03:07 GMT`), `civil(ms: …)` for the parts (`Civil(year, month, day, hour, minute, second, millisecond)`), all in UTC; the instant is an argument, so only the `now()` that reads it needs `Clock` | |
| Read a path segment | bind it in the route, and decode it there: `path: "/users/" ++ percent_decoded(name) ++ "/tickets"`. `path` is as sent, so the route matches the encoded path and a `%2F` stays inside its segment; `percent_decoded` is `None` for a bad escape or bytes that are not UTF-8, and leaves a `+` a `+` (a query is form-encoded: `form_field`) | |
| Check a signature | `hmac_sha256_verify(key:, data:, mac:)`, after `from_base64(text:)` or `from_base64url(text:)` of the mac sent: it reads every byte whatever they hold, where `mac == hmac_sha256(key:, data:)` stops at the first byte that differs and shows how many were right in its time and steps. `sha256(data:)` and `hmac_sha256(key:, data:)` are 32 raw bytes; `hex`, `base64` and `base64url` write bytes as text (std/crypto.tape) | |

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
-        Err(error: Rejected(reason: Declined(reason))) -> moved(m: sql_move(
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

```diff C97
-    Order(state: Paid) -> Shown(status: 200, order)
-    Order(state: Failed) -> Shown(status: 200, order)
+    _ -> Shown(status: 200, order)
```

```diff C86
-  SELECT id, note FROM orders WHERE state = 'paid' AND note <> ''
+  SELECT id, note FROM orders WHERE state = :state
```

```diff C72
-fn handle(raw: View, db: Sql, payments: Remote, timer: Timer) -> Response {
+fn handle(raw: View, db: Sql, payments: Remote) -> Response {
```

```diff C68
-  sql_first(row: Order, query: "SELECT * FROM orders WHERE id = :id", id)
+  sql_first(row: Order, query: "SELECT * FROM orders WHERE ident = :id", id)
```

The pattern `json(T(…))` was the second way to read a body. It is refused:

```tape refused C35
type T { T(n: Int) }

fn handle(raw: View) -> Response {
  match raw {
    json(T(n)) -> empty(status: 200)
    _ -> empty(status: 400)
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
built-in, except `scan(v:, at:, set:)` and `scan_plain(v:, at:)`, which cost one step per 16 bytes read, rounded
up. A read is every byte from `at` through the one it stops on, or from `at` to the end when none of the set is
there; `at` equal to `len(v)` reads nothing. `scan_plain(v:, at:)` is `scan(v:, at:, set:)` of the bytes that end
a JSON string's plain run (below 32, 128 or more, a quote or a backslash). The standard library's recursive
functions count like the program's own: the byte scans behind `request()`,
`until`, `after` and `decimal` take a few steps per byte. So a request's steps depend on its bytes and on the arms
tried before the one that answers it, and a route's count can change while the route does not: an arm added above it,
or a function made recursive by a call added elsewhere. In a program with two `GET` arms and a 404 fallback, one more
`GET` arm on top added 4 steps to every request below it, and a path 12 bytes longer cost 59 more. `fold` over
`range(from:, to:)` takes one step a number and one more, as over a list that long, and none to make the list, which
is never made: summing `range(from: 0, to: 1000)` takes 1001 steps and no memory, where the same fold of a list made
first takes 2002 and 24 bytes a number. `fold_rows` over a query's rows is the same: one step a row and one more,
and `write_rows` is that fold. Steps are a count of reductions, as in Erlang, not a time. They are the cost
measure all the same: on Workers a program's clock moves only across I/O, so nothing inside a run (`now()`, a span's
duration) can time its work.

This definition is step version 2. The compiler builds that number into every module and reports it beside every
step count (`step_version` on a run and in its log, `tape.step_version` on its span), so a count from one version is not read as a count from another. The number changes only when what a step
counts changes. `test/step-version.ts` holds each version's counts and fails when the compiler's are not the
current version's.

A request may also hold 80,000 units of recursion: a call of a recursive function holds, until it returns, 12 units
and one for each value its frame keeps (its parameters and the values it names, a record one for each of its
fields), unless the function only ever calls itself as its result and calls no other recursive function nor any
function value (a loop, which holds nothing), and a call made as a function's result gives the caller's units back
first, so a function of one `Int` that adds 1 to its own call goes 5,332 deep and one keeping 400 values 191, the
same on every engine and tier (the engine's own stack is not: 9,696 frames of the first on Workers, 11,263 to 41,527
in Node by tier), and past that the request stops: `trap 9: recursion too deep in depth (80010 units)`, naming the
function and the units held.

A trap ends the request, undoes its writes and is recorded: out of memory (64 MB), more than 50,000,000 steps, an
index out of bounds, a division by zero (trap 4), an `Int` or `Dec` result that does not fit in 64 bits (trap 6,
integer overflow), a shift by less than 0 or more than 63 (trap 7), a Float operation whose result would be infinite or
not a number (trap 8, float not finite), recursion past its budget (trap 9, recursion too deep). Nothing else stops a
program: every other failure is a
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

// a price times a quantity, and the tax on it at a rate of four decimals, rounded once to the cent
fn total(price: Dec[2], qty: Int, rate: Dec[4]) -> Dec[2] {
  let net = price * qty
  net + mul(a: net, by: rate, scale: 2, rounding: HalfEven)
}

fn share(total: Dec[2], n: Int) -> Dec[2] {
  div(a: total, by: n, scale: 2, rounding: Down)
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
// total(19.99, 3, 0.0825) is 64.92
// share(10.00, 3) is 3.33
// share(10.00, 0) traps: division by zero
// total(92233720368547758.07, 2, 0.0000) traps: integer overflow
```

## 11. Changes

What each release changed, and each form that went with the form that replaced it, are in
[docs/changes.md](docs/changes.md).

## 12. Not defined yet

- What a version built by an older compiler may rely on. Today: its source is built again by the current compiler (the rules not asked again), and it runs if that builds; it has no claim to what the old build did.
- The order in which two requests' effects interleave beyond "a call is a commit point".
- Who is calling, beyond what `Caller` says. std/http's `Request(caller: …)` is `Operator` when the request came with the operator's token, `Anyone` when it came through a published name's public route ([docs/service.md](docs/service.md#public-routes)), and `Session(id)` when it came on that name's own origin (`<name>--<account>.<PROGRAM_DOMAIN>`, [docs/service.md](docs/service.md#identity)) carrying the cookie an answer of this program's `start_session(id:)` set there: the host checked that the cookie is one it signed, with the service's key, for this account, this name and that id, and that it has not expired (30 days from its last use). So `Session(id)` means exactly: this client was given that session, with that id, by this program, on its own origin, and has used it in the last 30 days. It does not say who the client is, beyond what the program knew when it started the session (a password it checked, a link it mailed); a session is not ended on the server, so `end_session()` clears the client's cookie and a copy taken before is still good until it expires; there is no session on `/p/`, on the operator's route, or on a host with no origins of the programs' own, and those requests stay `Anyone` and `Operator`. Which person sent an `Anyone` request is not defined: a program that needs to know reads what the request carries and decides itself.
- JSON for bytes and maps.
- A Dec beyond ±2^53 units in the database; a Dec flag; functions generic over a Dec's scale.
