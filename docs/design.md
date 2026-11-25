# Design notes: why the rules are what they are

Tape's compiler refuses some programs that type-check: a write a retry would apply twice, a migration that would
break a live version, a status change its machine does not declare. This note says where those rules came from and
what was measured about them. It condenses the design record kept while the rules were built (14 to 18 November
2026). The defects it cites are in [`docs/defects.md`](defects.md); the rules themselves are in
[`LANGUAGE.md`](../LANGUAGE.md) and [the guide](guide.md#rules-writes-that-survive-a-retry-migrations-that-only-add).

## The method

No rule without a defect behind it. Each candidate rule was judged on four things:

1. which recorded defects it refuses, at the defect's own code;
2. what it refuses in correct programs;
3. what it costs in program text;
4. how it could be wrong.

Each rule also had to catch a mutation planted for it, so that a rule that never fires is not counted.

The constraints the design was held to: no macros; some verbosity is acceptable if the result stays simple; illegal
states should be unrepresentable; the language stays strictly functional; breaking changes are acceptable before
1.0.

## Where the defects were

Of the 38 defects of the first week, at most 10 were in code a language rule can read:

| Layer | n | Defects | Can a rule see it? |
|---|---|---|---|
| Tape program text | 6 | J2, J3, J4, R7, R11, P1 | yes |
| Upload and migration checks, over program text | 4 | M1 to M4 | yes, the text they judge |
| Host and runtime code: call path, records, OTLP | 12 | J1, J5, R2, R4, R5, R6, R9, R10, O1 to O4 | no |
| The KV router (`service/src/kv.ts`) | 3 | R1, R3, R8 | no |
| The compiler's own implementation | 9 | C1 to C9 | no |
| Checkers and harnesses | 2 | R12, T1 | no |
| Undetermined | 2 | U1, U2 | unknown |

That is the main limit on what a language can do here: most defects were in the runtime and the checks, and
those needed better checking ([`docs/defects.md`](defects.md)), not rules.

## The candidates

Seven rules were prototyped as a checker pass and run, each alone, on each defect's code before and after its fix
(regenerated from git), and on the 40 programs the repository had then.

| Rule | From | Requires | Became |
|---|---|---|---|
| RG migration grammar | M2 | a migration not marked `contract` only adds (an allow-list) | C51 |
| RQ qualified | M1 | a query over two or more tables qualifies every column | C52 |
| RS one schema | M3 | `schema` and migrations are not mixed | C53 |
| RI replay | J2, R7, R11 | a write reached from `handle` or `woken` is safe to run twice: a compare-and-set, an op-id guard or a unique key, or an explicit opt-out | C54 to C56; the opt-out is now `repeat: True` |
| RM machine | J2, J3 | `machine table.column { "a" -> "b" }`: every write names the state it expects and makes a declared move; SQLite triggers refuse any other | C57 to C61 |
| RP private | J1 | a `private type`'s constructors are made only in its file | C66 |
| RO outcome | J1 | a match over `CallError` names `Timeout` before a catch-all | not shipped as written; narrowed into C87 on 25 November 2026 (below) |

Results over the 38: 6 refused at the defect's own line as written (J2, J3, R7, M1, M2, M3); 2 after the code was
ported into Tape or into the form the rule asks for (J1, R11); R8 cannot be written in Tape at all (no isolate
memory); J4 by a rule added later (C62, a lost compare-and-set has its own outcome); M4 still compiles under every
rule; the other 27 are outside what a rule can read.

On the 40 programs, RI found 17 places where a retried request would apply a write twice, 4 of them already known,
with 3 false positives. Making three programs pass every rule cost 1.7 to 7.0 % more tokens. Sent twice with one
key after the rules shipped, every changed program did its work once; before, the box office sold twice, the
fulfillment workflow charged twice, the ledger moved money twice and the KV write applied twice.

## What did not pay

- **Typed call outcomes as a new rule (RO).** `CallError` already exists, and J1 was in the host, outside the
  language. RO refused none of the 38, and its strict form flagged five correct arms. It came back narrowed, as
  C87 (next section).
- **Machine triggers alone** would have missed J3: writing a note on a finished order is not a move. The static half
  of the machine rule is what catches it.
- **J4** (a wrong meaning given to a value) is not prevented by any rule tried; a type can make it conspicuous, not
  impossible. C62 later made the lost compare-and-set its own outcome.
- **R11 as written** is not seen: a rule over single statements cannot judge an op-id lookup made by a separate
  statement. The price of RI is that the guard must be in the statement.
- **Freshness types for time, durable-before-reply types, versioned messages, linear tokens for keys:** no
  defect called for them, so none was built.
- **Moving the KV router into Tape** would remove R8 only, would put a cluster's traffic through one Durable
  Object, and needs a Worker-side host that does not exist. The router stayed in TypeScript.
- **Top-level `const` and list literals `[a, b]`** (design memo of feedback 20261123T030026.990Z-e454772fe5c9,
  item 2), built and measured on 23 November 2026 (an unmerged commit, c996227) on that report's sunset program, with its
  183-term VSOP87 table rewritten as a `const List[Series]` (answers byte-identical): 1400 -> 1372 lines (the memo
  estimated ~75 fewer in the table; 24 came out), Wasm 45,809 -> 49,674 bytes (a term in the arena's layout is 40
  bytes of data against ~23 of code), steps of a year of sunsets 28,498 -> 151,258 (a fold is charged a step an
  item, a chain of calls nothing) and heap 17.8 KB -> 226 KB (closures), 8.73 -> 9.56 µs a sunset; about 250 lines
  of compiler. List literals deleted no line in the repository. Dropped; re-propose with a denser layout or new
  evidence. `range` and a fused `fold` (one step a number, no list) paid and stayed.

## A byte literal, and not a vector

Measured 24 November 2026 from a CommonMark renderer (`corpus/md.tape`: 1,574 lines, 114 functions) and locked in
`test/bytes.ts`. The renderer classifies bytes as decimal integers: 89 comparisons
`== n` with `n` in 0..255, 16 pattern arms that are a byte, and 14 `byte:` arguments. It never writes `"*"[0]`.
That form shows up as a pattern, where it is P01, because a pattern is a value and an index is an expression.

`'*'` is the spelling. A single quote started nothing else (it was L01, "Tape text is in double quotes"), so it
can open a literal without a prefix. `b"..."` is a name and then a text, which is why it parsed as P01, and a
hex digit would be a second way to write every Int. The literal is one source character of code 0 to 127, or one
of text's escapes plus `\'`. A character past ASCII is more than one byte of UTF-8, so it is not a byte, and
128 to 255 stay decimal. There is no `\x` and no `\v`: each would be a second spelling of an integer that
already has one. The lexer emits the Int. There is no new type and no new node, so the parser, the checker and
the code generator are the digits' own.

Replacing a constant in place leaves the module unchanged apart from the `build` section, which is a hash of
the source and stays 24 bytes. Under the default build, `{reuse: false}` and `{check: true}`:

| Program | Code | Data | Steps |
|---|---|---|---|
| `b == 42` and `b == '*'` | 143 bytes, the same | none added | 0, the same |
| `is_ws`, `is_punct`, the arms of `esc_from`, `hex_digit`'s `48` written `'0'`, `find`'s byte, and the highlighter's `single`, `escape` and `escaped` tables | the same section | the same | the same |
| `"*"[0]` against `42` | +36 bytes | +7 bytes | 0, the same |
| `'A' + n - 10` against `55 + n` | +24 bytes |  | the same answers |

`cost` counts a recursive entry and a fused fold. It counts neither a comparison nor the load `"*"[0]` does, so
the step counter stays 0 for all three and the cost that shows up for the index is code and a data segment. The
literal adds neither. `'A' + n - 10` is a different expression from `55 + n`, so `hex_digit` keeps `55 + n`.

The renderer's call sites, before and after. The vertical tab is 11, which has no escape:

```text
fn is_ws(b: Int) -> Bool {
  b == 32 or b == 9 or b == 10 or b == 13 or b == 12 or b == 11
}
fn is_ws(b: Int) -> Bool {
  b == ' ' or b == '\t' or b == '\n' or b == '\r' or b == '\f' or b == 11
}
```

```text
fn is_punct(b: Int) -> Bool {
  b >= 33 and b <= 47 or b >= 58 and b <= 64 or b >= 91 and b <= 96 or b >= 123 and b <= 126
}
fn is_punct(b: Int) -> Bool {
  b >= '!' and b <= '/' or b >= ':' and b <= '@' or b >= '[' and b <= '`' or b >= '{' and b <= '~'
}
```

`esc_from` matches 38, 60, 62 and 34, which are `'&'`, `'<'`, `'>'` and `'"'`. `hex_digit` is `48 + n` for a
digit, and that is `'0' + n`. `url_byte` scans a 19-byte View, `";/?:@=+$,-_.!~*'()#"`, with `find`.

A vector was not added. The same file uses `List` 81 times, `Cons` 64 and `Nil` 47, for the trees it walks
(inlines, blocks, delimiter runs), not for a random-access table of scalars. The one byte table is that
19-byte View. `let xs: Vec[Int] = [1, 2, 3]` is P01, "a `let` names a value without a type": the annotation is
refused before the name is read as a type. `fn f(xs: Vec[Int])` is C06, unknown type `Vec`, and the nearest
type offered is `Dec`. A `Vec` would be a second sequence beside `List`. List literals were measured on
23 November, in the note above, and dropped: more Wasm, more steps, more heap, and no line deleted in the
repository. Nothing in this renderer is a table that a vector would shorten and a `List` or a `View` does not
already hold. Whether a vector is worth a type of its own is left open; this program does not make the case.

The highlighter grew for a different reason. Its three tables compile to the same code as the digits. The
scanner that recognizes the literal is new, and that module went from 22,023 bytes to 23,601 (+1,578). That is
the tool learning the syntax, not a cost a program pays for writing `'*'`.

## Soundness of the rules

The first prototype read SQL with regular expressions. The shipped rules read it with a SQL parser of their own
(`sql/`), checked against SQLite by a differential fuzz, and refuse what they cannot read (C60) instead of passing
it. Within what they read, the machine rules check that every UPDATE of a machine table names the state it expects,
that every (accepted state, written value) pair on every call path is a declared move, and that every INSERT
starts in the first state. Not checked: DELETE, and the statements of migrations (the service's upload check
refuses stored rows in an undeclared state). The triggers do not catch a write that leaves the column as it is,
which is why C58 exists.

Keys of commands (2026-11-23). C65's check of a key made only of what its message carries was deleted: it judged a
key by where each value came from, was refused by keys that named their command correctly (15 refusals in three bench
rounds), and its own way out (`once:` the message) had the defect it refused. C65 keeps a key that is the same every
time; C71 requires a command built from a row, bound by a match arm or a `let`, to name that row in its key. Not
checked: a row held as a field (`order.amount` of `Some(value: order)`) and the payload of an exported method's
message; closing them would take a second mechanism, not a wider C71.

Arguments by position (2026-11-23). Only a call's first argument may go without its name. Replayed on five bench
rounds' C11 refusals, that accepts 13 of 28; letting every unnamed argument fill the unnamed parameters in order would
accept 27. It was not taken: names are what keep two values of one type from being swapped unseen, and under it
`f(x, a: 1)` puts x into b and `sub(b, a)` reads the opposite of its order. The refusals left get the exact call in
their fix.

## No answer is not a refusal: C87

J1 was a transport exception taken for a refusal. RO as first written, "a match over `CallError` names `Timeout`
before a catch-all", refuses the form LANGUAGE.md section 9 recommends: an arm for `Ok`, one for `Rejected` alone,
and one for no answer, which is a catch-all over the error. Run over every program in the repository on
25 November 2026 (the `.tape` files alone and in the groups deployed together, and every `tape` block of the
Markdown), it refused 27 arms in 15 programs, LANGUAGE.md's own among them, and every one was that form or a
catch-all that only answers.

The bug is narrower. It is an arm that takes a refusal and no answer together (`Err(error) -> …` or `_ -> …`, with
no `Rejected` arm above it, and `Timeout` or `Unreachable` still left to it) and acts on the outcome as if it knew it.
C87 already refused the timer case: such an arm that sets a timer asks for ever, since the same key gets the same
refusal. It now also refuses such an arm that writes to the database (an INSERT, UPDATE or DELETE) or makes another
call (`call`, or an interface method with a once key), itself or through what it calls. An `ask` there is a read,
and asking what happened is what an unknown outcome calls for. Answering the client is allowed: the client sends
again with the same key, and the second run learns what the first could not.

The arms that take both, whatever they do, are three in three programs (`mcp/test/retry.tape`,
`service/verify/bench-caller.tape`, `testdata/compare/billing.tape`), and each only answers: a 503, a 504, a 202
with the row. Narrowed to the arms that act, the rule refuses none of the repository's programs. J1's shape, a
refund sent on a catch-all that also takes `Timeout`, is refused, and so is a state of failure written there
(`test/no-answer.ts`, which failed eight of its checks on the rule before). It is one code and not a new one
because it is one mistake with one fix: give `Rejected` its own arm.

## Timers: C77 to C80

Jepsen runs against the box office in production (`apps/tickets`) found two bugs that every local test and compile
check had passed. Both had one shape: a row in a non-final state of a machine, with nothing left that would move it
on. A refund cut short left an order `refunding` for ever, because the sweep that runs again picks `confirmed`
orders. A hold declined while its expiry timer ran went back to `held` with no timer, so it never expired.

- **C77** asks of every non-final state: who comes back for the row? A client that was told the outcome is
  unknown, a timer set in the same commit, or a timer's run that reaches the row again. "A request can reach the
  way out" is not enough: in both bugs one could, and no client would. Planted back, both bugs are refused at their
  lines.
- **C78** checks that a timer's key names the row it is for, and that `woken` reads the row back by it. Eleven
  mutants of the box office that compiled under C77 are each refused at their line.
- **C79** reads every outcome of a timer's run that leaves the row where it was: each must move it out, set the
  timer again, or end at an outcome declared `final`.
- **C80** checks a `final` declaration: nothing on the way to the constructor reads the clock in a way that can
  flip, or an `ask`'s reply. Until 25 November 2026 a call counted as reading the clock when anything in the
  function called did, and a query's result when any value given to it was. That refused programs that are
  correct: `examples/timed/outbox.tape` with the time of each failed attempt stored in the UPDATE that counts it,
  or stamped by a helper that gives the count back, was refused at std's `backoff` and `retry_at`, though the
  count that decides is the stored one. C80 now follows the clock only where its value goes: into a function's
  value through what it returns and the decisions on the way there (a `do` that stamps a row decides nothing), into
  a part of a value by the path to it (a row's `tries` is not its `tried_at`), and into an UPDATE's outcome (Moved,
  Raced, NoRow, the count an exec gives) through its WHERE only; a SET's value reaches only the column it sets. An
  INSERT and a SELECT are still read whole. Within a function and into what it calls a value is followed however
  deep; up from a parameter to its callers, 8 steps. Every C80 fixture and round-3 mutant, and the 7 planted timer
  bugs of `experiments/c78/timed-mutants.ts`, are refused as before (`test/timers-keys.ts`); the repository's
  programs had no C80 before and have none after.

These are rules rather than a branded key type because `wake(after:, key: Int)` and `Wake(key: Int)` are std's
types, used by the timer runtime and every uploaded version; the facts a branded type would carry are already in
the program text.

## Easier to write, no less checked

Three workflow programs (an order, a billing run and an agent loop: `examples/fulfillment.tape` and
`testdata/compare/`), with the same classes of defect planted in each, found the compiler refusing most of them at
compile, and the programs long for their workflow logic. What followed was a set of forms that are each a reading of an existing one, so every check still
applies: steps (`let P = e else { … }`, a match), capabilities by name (an inferred parameter), `*` for a row
type's columns, mid-path text captures, `do` for a call run for what it does, holes in text, and named query
values. Each old form is now a compile error that names the new one ([what went](changes.md#what-went)).
