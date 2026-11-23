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
| RO outcome | J1 | a match over `CallError` names `Timeout` before a catch-all | not shipped |

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
  language. RO refused none of the 38, and its strict form flagged five correct arms.
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

## Soundness of the rules

The first prototype read SQL with regular expressions. The shipped rules read it with a SQL parser of their own
(`sql/`), checked against SQLite by a differential fuzz, and refuse what they cannot read (C60) instead of passing
it. Within what they read, the machine rules check that every UPDATE of a machine table names the state it expects,
that every (accepted state, written value) pair on every call path is a declared move, and that every INSERT
starts in the first state. Not checked: DELETE, and the statements of migrations (the service's upload check
refuses stored rows in an undeclared state). The triggers do not catch a write that leaves the column as it is,
which is why C58 exists.

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
  flip, or an `ask`'s reply. It follows a value a bounded number of steps, and it refuses two programs the tests
  hold up as correct, because a call counts as reading the clock when anything in the function called does. That
  imprecision is still there.

These are rules rather than a branded key type because `wake(after:, key: Int)` and `Wake(key: Int)` are std's
types, used by the timer runtime and every uploaded version; the facts a branded type would carry are already in
the program text.

## Easier to write, no less checked

Three workflow programs (an order, a billing run and an agent loop: `examples/fulfillment.tape` and
`testdata/compare/`), with the same classes of defect planted in each, found the compiler refusing most of them at
compile, and the programs long for their workflow logic. What followed was a set of forms that are each a reading of an existing one, so every check still
applies: steps (`let P = e else { … }`, a match), capabilities by name (an inferred parameter), `*` for a row
type's columns, mid-path text captures, `do` for a call run for what it does, holes in text, and named query
values. Each old form is now a compile error that names the new one ([`LANGUAGE.md` section 13](../LANGUAGE.md#13-what-went)).
