# Tape usability benchmark: 2026-11-22-9d503902c084

Run 2026-11-22T23:48:51.505Z against prod https://tape.ivar.workers.dev/mcp: `tape-version: 9d503902c084`, `tape-mcp-version: 02e07cb4-65af-4fea-9b2c-ea7ccde259c0`. Agent: `claude -p`, model `sonnet`, 1 run(s) per task, 4 at a time, budget $6 and 45 min per run. Bench at `9d503902c084`. Each agent had only the task spec, README.md, LANGUAGE.md, docs/guide.md and docs/mcp.md (local copies), and the MCP tools compile, run, feedback.

## Headline

- **Tasks fully accepted: 8 of 8.** Acceptance checks passed: 219 of 219 (100%).
- Compiled at all: 8 of 8; median time to first compile 0.7 min, median tool calls to it 9.
- Compile attempts 54, of which refused 38; feedback reports filed 8; calls rate-limited 0; schema probes (a stand-in text, not counted as attempts) 5.
- Cost $4.23 (CLI-reported list price), 146,671 output tokens.

## Per task

| task | accepted | checks | first compile (min) | calls to it | compile attempts (refused) | run calls | diagnostics | feedback | cost | wall (min) | graded from |
|---|---|---|---|---|---|---|---|---|---|---|---|
| todo | yes | 29/29 | 0.1 | 3 | 4 (2) | 4 | C14×1 P01×1 | 1 | $0.35 | 0.9 | solution/ |
| ledger | yes | 35/35 | 2.5 | 25 | 5 (4) | 5 | C69×4 C54×2 C11×1 C16×1 C14×1 | 1 | $0.70 | 2.7 | solution/ |
| ratelimit | yes | 29/29 | 1.0 | 9 | 4 (2) | 4 | C40×1 | 1 | $0.53 | 1.6 | solution/ |
| webhook | yes | 24/24 | 1.4 | 14 | 6 (5) | 6 | P01×2 L01×1 C40×1 C69×1 | 1 | $0.45 | 1.5 | solution/ |
| orders | yes | 23/23 | 0.9 | 7 | 2 (1) | 3 | C65×1 | 1 | $0.33 | 1.1 | solution/ |
| shortener | yes | 23/23 | 0.5 | 15 | 20 (17) | 5 | C22×10 C30×3 C11×2 C18×1 C10×1 | 1 | $0.57 | 2.1 | solution/ |
| sales | yes | 26/26 | 0.1 | 5 | 5 (2) | 5 | C14×1 C69×1 | 1 | $0.51 | 1.8 | solution/ |
| invoice | yes | 30/30 | 0.6 | 9 | 8 (5) | 8 | C14×1 C11×1 C08×1 C13×1 | 1 | $0.79 | 3.0 | solution/ |

Transcripts (not tracked): `<results dir>/<task>/transcript.jsonl`; solutions in `<task>/solution/`.

## Failed acceptance checks


## Friction ranking

Score = tasks affected × (minutes lost + feedback reports). Minutes lost: the time from each refused compile to the next attempt, shared among its codes; a feedback report that names the theme counts one minute, for time spent outside compiles. Ties go to more tasks, then more feedback, then more failed checks, then more evidence from before.

| # | theme | tasks | min lost | score | diagnostics | feedback | failed checks | change |
|---|---|---|---|---|---|---|---|---|
| 1 | std is not documented: respond_as(content: Json), Request.query, form_field exist but agents cannot find them | 8 | 1.3 | 74.7 | C11×4 C22×10 C18×1 C30×3 | 8 | 0 | a std reference (every public function and type, with a one-line example) in the docs, and the MCP tool descriptions name respond_as and Request's fields |
| 2 | Missing std helpers (text, lists, numbers) | 5 | 0.0 | 25.0 | — | 5 | 0 | std gets the helpers every task wrote by hand (min/max, character classes, split, int parsing and printing) |
| 3 | Docs and examples that disagree with the compiler, or do not cover the task | 4 | 0.0 | 16.0 | — | 4 | 0 | every snippet and fix string compiles in CI; the guide has a worked REST example with validation and lists |
| 4 | match is not an expression argument (C40), so every if is a function | 3 | 0.4 | 10.3 | C40×2 | 3 | 0 | allow `match` (or an `if` expression) as an argument or a let value |
| 5 | Reading JSON bodies: decode shapes, optional fields, wrong-type errors | 3 | 0.0 | 9.0 | — | 3 | 0 | decode takes the shapes real APIs send (optional fields, lists of records, nullable), and its refusal names the field and the fix |
| 6 | Writing JSON: lists, Options and nested records | 3 | 0.0 | 9.0 | — | 3 | 0 | write_json takes any record, Option fields and lists of records |
| 7 | MCP tooling: run answers carry full OTLP traces; programs re-sent in full each call; no clock control | 3 | 0.0 | 9.0 | — | 3 | 0 | run takes `trace: false` (and effects-only), a compile-and-run that keeps the last program by hash, and a fake clock (`now` per request) to test time windows |
| 8 | Type errors: refined types, Option of refined, holes (C14 C19 C20-C23) | 4 | 1.0 | 7.9 | C14×4 | 1 | 0 | a refined type is accepted where its base is asked, inside Option and List too; type errors show both types and where |
| 9 | The SQL checker: names, keywords, placeholders (C11 C13 C32 C67 C68 C75) | 3 | 0.3 | 6.9 | C13×1 | 2 | 0 | SQL refusals quote the clause and the table's columns, and keywords as names are allowed or named as such |
| 10 | C69: a TEXT PRIMARY KEY may be NULL in SQLite, so a View field cannot hold it | 3 | 0.9 | 5.7 | C69×6 | 1 | 0 | treat a PRIMARY KEY column as NOT NULL for row types (or say "add NOT NULL" as the whole fix, first); the docs say so where tables are made |
| 11 | Parse and lex errors that do not say what is wrong (P0x, L0x) | 2 | 0.6 | 5.3 | P01×1 L01×1 | 2 | 0 | parse errors name the token and the rule (a reserved word, one statement per line, a name std already has) and carry a fix |
| 12 | Binding inside patterns: `field: P` binds what P binds (C15 C16) | 2 | 0.3 | 4.7 | C16×1 | 2 | 0 | C16 says "write `value: name = Ctor(...)`" when a field given a pattern is used by name; C15 explains rebinding |
| 13 | Retry-safety rules on writes (C54 C55 C56 C73 C88) and their fix text | 2 | 0.2 | 4.5 | C54×2 | 2 | 0 | each retry rule fix shows the rewrite for the statement at hand (with :name placeholders); a way to say "this create is not idempotent" when the spec says so |
| 14 | Idempotency keys of calls (C65): what a once: key must contain | 1 | 0.3 | 1.3 | C65×1 | 1 | 0 | the call example in LANGUAGE.md shows a message that carries the id, and C65 writes the key to use |
| 15 | Every argument must be named (C10) | 1 | 0.2 | 1.2 | C10×1 | 1 | 0 | allow positional arguments where unambiguous (self-calls, one obvious parameter), or C10 fix text that shows the exact rewrite |
| 16 | Text patterns (`a ++ "x" ++ b`) only in match arms, not in let … else | 1 | 0.2 | 1.2 | P01×1 | 1 | 0 | let P = e else accepts every pattern a match arm does, as LANGUAGE.md section 4 says it should |
| 17 | Reserved words cannot be field names, so JSON keys like "type" cannot be decoded | 1 | 0.1 | 1.1 | P01×1 | 1 | 0 | allow reserved words as field names (or a key-rename on decode), and P01 says the word is reserved |
| 18 | No response headers (Location, content type) and no request headers | 1 | 0.0 | 1.0 | — | 1 | 0 | let a program set response headers (at least Location and Content-Type) and read request headers |
| 19 | No decimal numbers: money as strings, parsed and rounded by hand | 1 | 0.0 | 1.0 | — | 1 | 0 | a Decimal type (0.3), with parsing, exact arithmetic and rounding modes in std |
| 20 | Capabilities and do (C72, C83-C85) | 1 | 0.0 | 1.0 | — | 1 | 0 | C72 names the function chain that needs the capability and the parameter to add |
| 21 | Calls to other programs and timers (C39 C41 C71 C77-C79 C87) | 1 | 0.0 | 1.0 | — | 1 | 0 | a worked call-with-timer example in the guide, and fix text that writes the arms |
| 22 | C08: field out cannot have type Buf | 1 | 0.6 | 0.6 | C08×1 | 0 | 0 | (no theme yet: read the excerpts) |

### Evidence

1. **std is not documented: respond_as(content: Json), Request.query, form_field exist but agents cannot find them**. Tasks: todo, ledger, ratelimit, webhook, orders, shortener, sales, invoice.
   - diagnostic, ledger: C11 function valid_id has no parameter from
   - diagnostic, shortener: C22 unknown function header
   - diagnostic, shortener: C11 function respond has no parameter location
   - feedback, todo (20261122T234942.444Z-9fdba6019ca6): Worked well overall (decode with refined types, Option fields, write_rows, `repeat: True` on a keyless INSERT for a POST that clients don't retry). Friction: (1) responses are always content-type text/plain; I found no …
   - feedback, ledger (20261122T235126.664Z-1f9efa153db8): Friction building a ledger: (1) C54 rejects the standard `balance = balance - :amount WHERE id=:from AND balance >= :amount` even when the whole request is already deduplicated by a transfers(transfer_id) lookup/insert …
   - feedback, ratelimit (20261122T235021.040Z-e6ea2445572d): Worked end to end. Friction: (1) no std reference in docs, so I could not tell if there is a per-byte/char-class function; I validated key characters with SQL GLOB through sql_first, which is odd for a pure check. (2) A…
   - before: std/http.tape defines respond_as(status, content: Json) and Request(query: Option[View]); none of README, LANGUAGE.md, guide.md, mcp.md mentions either
2. **Missing std helpers (text, lists, numbers)**. Tasks: ratelimit, webhook, shortener, sales, invoice.
   - feedback, ratelimit (20261122T235021.040Z-e6ea2445572d): Worked end to end. Friction: (1) no std reference in docs, so I could not tell if there is a per-byte/char-class function; I validated key characters with SQL GLOB through sql_first, which is odd for a pure check. (2) A…
   - feedback, webhook (20261122T235018.043Z-2e8a1b1ca646): A JSON body with a key named `type` cannot be decoded into a record: `type` is reserved, so `type E { E(type: View) }` gives P01 "expected a name but found `type`". Common webhook field name. I worked around it by rewri…
   - feedback, shortener (20261122T235223.343Z-a8bad6ada990): I could not find any way to set a response header (needed: `Location` on a 302). `respond(status)` takes only `status` (C11: "function respond takes (status)"). I guessed header, add_header, set_header, write_header, wi…
   - before: apps/highlight/FRICTION.md #5, #6: two "not found" conventions; no is_alpha, min, max
3. **Docs and examples that disagree with the compiler, or do not cover the task**. Tasks: todo, orders, shortener, sales.
   - feedback, todo (20261122T234942.444Z-9fdba6019ca6): Worked well overall (decode with refined types, Option fields, write_rows, `repeat: True` on a keyless INSERT for a POST that clients don't retry). Friction: (1) responses are always content-type text/plain; I found no …
   - feedback, orders (20261122T235045.451Z-55490a9967fb): Worked well overall; LANGUAGE.md section 8 was nearly the whole answer. Friction: (1) C65 fired when I keyed `once:` by ForOrder(order: id) copied from the doc example while the message carried only id; the fix (once: s…
   - feedback, shortener (20261122T235223.343Z-a8bad6ada990): I could not find any way to set a response header (needed: `Location` on a 302). `respond(status)` takes only `status` (C11: "function respond takes (status)"). I guessed header, add_header, set_header, write_header, wi…
   - before: feedback 20261122T225732.543Z-67e1f8a9ede0: README and examples used retired syntax
4. **match is not an expression argument (C40), so every if is a function**. Tasks: ratelimit, webhook, sales.
   - diagnostic, ratelimit: C40 `match` can only be the last expression of a function or of a match arm
   - diagnostic, webhook: C40 `match` can only be the last expression of a function or of a match arm
   - feedback, ratelimit (20261122T235021.040Z-e6ea2445572d): Worked end to end. Friction: (1) no std reference in docs, so I could not tell if there is a per-byte/char-class function; I validated key characters with SQL GLOB through sql_first, which is odd for a pure check. (2) A…
   - feedback, webhook (20261122T235018.043Z-2e8a1b1ca646): A JSON body with a key named `type` cannot be decoded into a record: `type` is reserved, so `type E { E(type: View) }` gives P01 "expected a name but found `type`". Common webhook field name. I worked around it by rewri…
   - feedback, sales (20261122T235211.725Z-b6bc71eae37b): Docs never say how to read query-string params: I had to probe and found Request(path) excludes the query and Request(query) is Option[View]; I then hand-parsed it with recursive `head ++ "&" ++ rest` patterns. Also mis…
   - before: apps/trace/FRICTION.md #7: about 30 one-arm helpers
5. **Reading JSON bodies: decode shapes, optional fields, wrong-type errors**. Tasks: todo, webhook, shortener.
   - feedback, todo (20261122T234942.444Z-9fdba6019ca6): Worked well overall (decode with refined types, Option fields, write_rows, `repeat: True` on a keyless INSERT for a POST that clients don't retry). Friction: (1) responses are always content-type text/plain; I found no …
   - feedback, webhook (20261122T235018.043Z-2e8a1b1ca646): A JSON body with a key named `type` cannot be decoded into a record: `type` is reserved, so `type E { E(type: View) }` gives P01 "expected a name but found `type`". Common webhook field name. I worked around it by rewri…
   - feedback, shortener (20261122T235223.343Z-a8bad6ada990): I could not find any way to set a response header (needed: `Location` on a 302). `respond(status)` takes only `status` (C11: "function respond takes (status)"). I guessed header, add_header, set_header, write_header, wi…
   - before: apps/trace/FRICTION.md #1: decode refuses unknown keys, so OTLP needed a hand-written reader
   - before: feedback 20261122T232050.119Z-809602d0280e: decode cannot read JSON arrays (C09); 400 of 833 lines were a parser
   - before: apps/tickets/FRICTION.md 14:45: flat records only (since fixed: records in records, lists)
6. **Writing JSON: lists, Options and nested records**. Tasks: todo, shortener, invoice.
   - feedback, todo (20261122T234942.444Z-9fdba6019ca6): Worked well overall (decode with refined types, Option fields, write_rows, `repeat: True` on a keyless INSERT for a POST that clients don't retry). Friction: (1) responses are always content-type text/plain; I found no …
   - feedback, shortener (20261122T235223.343Z-a8bad6ada990): I could not find any way to set a response header (needed: `Location` on a 302). `respond(status)` takes only `status` (C11: "function respond takes (status)"). I guessed header, add_header, set_header, write_header, wi…
   - feedback, invoice (20261122T235344.922Z-48d99441df36): Money task: docs list no std/builtin reference. I had to guess the names (fold(list, from, by), buf(), freeze, write_json_string, write_int, len on View only). decimal(n) rejects leading zeros ("05"), so I wrote a digit…
   - before: LANGUAGE.md section 11: writing a record with an Option field is not defined
   - before: apps/tickets/FRICTION.md 15:15 (since fixed: write_rows)
7. **MCP tooling: run answers carry full OTLP traces; programs re-sent in full each call; no clock control**. Tasks: ledger, ratelimit, orders.
   - feedback, ledger (20261122T235126.664Z-1f9efa153db8): Friction building a ledger: (1) C54 rejects the standard `balance = balance - :amount WHERE id=:from AND balance >= :amount` even when the whole request is already deduplicated by a transfers(transfer_id) lookup/insert …
   - feedback, ratelimit (20261122T235021.040Z-e6ea2445572d): Worked end to end. Friction: (1) no std reference in docs, so I could not tell if there is a per-byte/char-class function; I validated key characters with SQL GLOB through sql_first, which is odd for a pure check. (2) A…
   - feedback, orders (20261122T235045.451Z-55490a9967fb): Worked well overall; LANGUAGE.md section 8 was nearly the whole answer. Friction: (1) C65 fired when I keyed `once:` by ForOrder(order: id) copied from the doc example while the message carried only id; the fix (once: s…
   - before: feedback 20261122T232059.296Z-5acdb5a4da77: run cannot report wall time; ask for a per-function step profile
8. **Type errors: refined types, Option of refined, holes (C14 C19 C20-C23)**. Tasks: todo, ledger, sales, invoice.
   - diagnostic, todo: C14 argument view should be View but is Option[View]
   - diagnostic, ledger: C14 argument out should be Buf but is Outcome
   - diagnostic, sales: C14 argument view should be View but is Option[View]
   - feedback, todo (20261122T234942.444Z-9fdba6019ca6): Worked well overall (decode with refined types, Option fields, write_rows, `repeat: True` on a keyless INSERT for a POST that clients don't retry). Friction: (1) responses are always content-type text/plain; I found no …
   - before: apps/queue/FRICTION.md #1: Option[Delay] is not Option[Int]
9. **The SQL checker: names, keywords, placeholders (C11 C13 C32 C67 C68 C75)**. Tasks: ratelimit, sales, invoice.
   - diagnostic, invoice: C13 function create is missing argument db
   - feedback, ratelimit (20261122T235021.040Z-e6ea2445572d): Worked end to end. Friction: (1) no std reference in docs, so I could not tell if there is a per-byte/char-class function; I validated key characters with SQL GLOB through sql_first, which is odd for a pure check. (2) A…
   - feedback, sales (20261122T235211.725Z-b6bc71eae37b): Docs never say how to read query-string params: I had to probe and found Request(path) excludes the query and Request(query) is Option[View]; I then hand-parsed it with recursive `head ++ "&" ++ rest` patterns. Also mis…
   - before: feedback 20261122T225741.180Z-f6b580f47e79: `AS from` gives C67
   - before: apps/tickets/FRICTION.md 14:54 (a column named `left`, fixed)
10. **C69: a TEXT PRIMARY KEY may be NULL in SQLite, so a View field cannot hold it**. Tasks: ledger, webhook, sales.
   - diagnostic, ledger: C69 column id may be NULL, and field id is View, which cannot hold it: reading such a row stops the request (accounts.id is a PRIMARY KEY, but SQLite let…
   - diagnostic, webhook: C69 column delivery_id may be NULL, and field delivery_id is View, which cannot hold it: reading such a row stops the request (events.delivery_id is a PR…
   - diagnostic, sales: C69 column sale_id may be NULL, and field sale_id is View, which cannot hold it: reading such a row stops the request (sales.sale_id is a PRIMARY KEY, bu…
   - feedback, sales (20261122T235211.725Z-b6bc71eae37b): Docs never say how to read query-string params: I had to probe and found Request(path) excludes the query and Request(query) is Option[View]; I then hand-parsed it with recursive `head ++ "&" ++ rest` patterns. Also mis…
11. **Parse and lex errors that do not say what is wrong (P0x, L0x)**. Tasks: todo, webhook.
   - diagnostic, todo: P01 expected a name but found a text literal
   - diagnostic, webhook: L01 unexpected character "`"
   - feedback, todo (20261122T234942.444Z-9fdba6019ca6): Worked well overall (decode with refined types, Option fields, write_rows, `repeat: True` on a keyless INSERT for a POST that clients don't retry). Friction: (1) responses are always content-type text/plain; I found no …
   - feedback, webhook (20261122T235018.043Z-2e8a1b1ca646): A JSON body with a key named `type` cannot be decoded into a record: `type` is reserved, so `type E { E(type: View) }` gives P01 "expected a name but found `type`". Common webhook field name. I worked around it by rewri…
   - before: feedback 20261122T232056.998Z-9d2e11f1f1d1: a parameter named `or` gives a generic P02; P02 for two statements on a line
   - before: feedback 20261122T225735.268Z-1cef52dbea41: a constructor named like std's (Malformed) gives P01 in the wrong file
   - before: apps/playground/FRICTION.md #6: errors inside holes and carried text point at the wrong line
12. **Binding inside patterns: `field: P` binds what P binds (C15 C16)**. Tasks: todo, ledger.
   - diagnostic, ledger: C16 unknown name value
   - feedback, todo (20261122T234942.444Z-9fdba6019ca6): Worked well overall (decode with refined types, Option fields, write_rows, `repeat: True` on a keyless INSERT for a POST that clients don't retry). Friction: (1) responses are always content-type text/plain; I found no …
   - feedback, ledger (20261122T235126.664Z-1f9efa153db8): Friction building a ledger: (1) C54 rejects the standard `balance = balance - :amount WHERE id=:from AND balance >= :amount` even when the whole request is already deduplicated by a transfers(transfer_id) lookup/insert …
   - before: apps/queue/FRICTION.md #3 and apps/tickets/FRICTION.md 14:53, 15:04: the same mistake three times
   - before: feedback 20261122T225741.180Z-f6b580f47e79: C16 with an empty fix
13. **Retry-safety rules on writes (C54 C55 C56 C73 C88) and their fix text**. Tasks: todo, ledger.
   - diagnostic, ledger: C54 run twice (a retried request, a timer that fires again), this write applies twice: balance = balance - :amount depends on the row it changes, and not…
   - feedback, todo (20261122T234942.444Z-9fdba6019ca6): Worked well overall (decode with refined types, Option fields, write_rows, `repeat: True` on a keyless INSERT for a POST that clients don't retry). Friction: (1) responses are always content-type text/plain; I found no …
   - feedback, ledger (20261122T235126.664Z-1f9efa153db8): Friction building a ledger: (1) C54 rejects the standard `balance = balance - :amount WHERE id=:from AND balance >= :amount` even when the whole request is already deduplicated by a transfers(transfer_id) lookup/insert …
   - before: feedback 20261122T225732.543Z-67e1f8a9ede0: C54 fix text suggests ?n placeholders the compiler rejects
   - before: feedback 20261122T225741.180Z-f6b580f47e79: a SQL error (C67) also raised a spurious C54
   - before: apps/queue/FRICTION.md #7: no rule for a non-idempotent claim
14. **Idempotency keys of calls (C65): what a once: key must contain**. Tasks: orders.
   - diagnostic, orders: C65 this command's key is made only of what its message carries (id), so two commands with the same message are one: the second is answered with the firs…
   - feedback, orders (20261122T235045.451Z-55490a9967fb): Worked well overall; LANGUAGE.md section 8 was nearly the whole answer. Friction: (1) C65 fired when I keyed `once:` by ForOrder(order: id) copied from the doc example while the message carried only id; the fix (once: s…
15. **Every argument must be named (C10)**. Tasks: shortener.
   - diagnostic, shortener: C10 arguments must be named
   - feedback, shortener (20261122T235223.343Z-a8bad6ada990): I could not find any way to set a response header (needed: `Location` on a 302). `respond(status)` takes only `status` (C11: "function respond takes (status)"). I guessed header, add_header, set_header, write_header, wi…
   - before: feedback-triage.md #3 (C10 in self-calls, by design)
16. **Text patterns (`a ++ "x" ++ b`) only in match arms, not in let … else**. Tasks: webhook.
   - diagnostic, webhook: P01 expected `=` but found `++`
   - feedback, webhook (20261122T235018.043Z-2e8a1b1ca646): A JSON body with a key named `type` cannot be decoded into a record: `type` is reserved, so `type E { E(type: View) }` gives P01 "expected a name but found `type`". Common webhook field name. I worked around it by rewri…
17. **Reserved words cannot be field names, so JSON keys like "type" cannot be decoded**. Tasks: webhook.
   - diagnostic, webhook: P01 expected a name but found `type`
   - feedback, webhook (20261122T235018.043Z-2e8a1b1ca646): A JSON body with a key named `type` cannot be decoded into a record: `type` is reserved, so `type E { E(type: View) }` gives P01 "expected a name but found `type`". Common webhook field name. I worked around it by rewri…
   - before: feedback 20261122T232056.998Z-9d2e11f1f1d1: a parameter named `or` gives a generic P02
18. **No response headers (Location, content type) and no request headers**. Tasks: shortener.
   - feedback, shortener (20261122T235223.343Z-a8bad6ada990): I could not find any way to set a response header (needed: `Location` on a 302). `respond(status)` takes only `status` (C11: "function respond takes (status)"). I guessed header, add_header, set_header, write_header, wi…
   - before: apps/tickets/FRICTION.md 14:40 and 15:04: no headers, so no redirect and no caller identity
19. **No decimal numbers: money as strings, parsed and rounded by hand**. Tasks: invoice.
   - feedback, invoice (20261122T235344.922Z-48d99441df36): Money task: docs list no std/builtin reference. I had to guess the names (fold(list, from, by), buf(), freeze, write_json_string, write_int, len on View only). decimal(n) rejects leading zeros ("05"), so I wrote a digit…
   - before: LANGUAGE.md section 11: numbers other than Int are not defined yet
20. **Capabilities and do (C72, C83-C85)**. Tasks: ledger.
   - feedback, ledger (20261122T235126.664Z-1f9efa153db8): Friction building a ledger: (1) C54 rejects the standard `balance = balance - :amount WHERE id=:from AND balance >= :amount` even when the whole request is already deduplicated by a transfers(transfer_id) lookup/insert …
21. **Calls to other programs and timers (C39 C41 C71 C77-C79 C87)**. Tasks: orders.
   - feedback, orders (20261122T235045.451Z-55490a9967fb): Worked well overall; LANGUAGE.md section 8 was nearly the whole answer. Friction: (1) C65 fired when I keyed `once:` by ForOrder(order: id) copied from the doc example while the message carried only id; the fix (once: s…
22. **C08: field out cannot have type Buf**. Tasks: invoice.
   - diagnostic, invoice: C08 field out cannot have type Buf

## Feedback filed this run

- todo, confusing, 20261122T234942.444Z-9fdba6019ca6: Worked well overall (decode with refined types, Option fields, write_rows, `repeat: True` on a keyless INSERT for a POST that clients don't retry). Friction: (1) responses are always content-type text/plain; I found no way in the docs to set application/json for a JSON API. (2) Request has a `query: Option[View]` field, but I only found it by guessing; LANGUAGE.md doesn't list Request's fields. (…
- ledger, confusing, 20261122T235126.664Z-1f9efa153db8: Friction building a ledger: (1) C54 rejects the standard `balance = balance - :amount WHERE id=:from AND balance >= :amount` even when the whole request is already deduplicated by a transfers(transfer_id) lookup/insert in the same transaction; I had to use `repeat: True`, which reads like "count every attempt" and is semantically misleading. A documented idiom for "debit once, keyed by a client i…
- ratelimit, confusing, 20261122T235021.040Z-e6ea2445572d: Worked end to end. Friction: (1) no std reference in docs, so I could not tell if there is a per-byte/char-class function; I validated key characters with SQL GLOB through sql_first, which is odd for a pure check. (2) A `let x = match ...` is C40; the fix hint was clear. (3) run responses are very large because every result carries the full OTLP trace; an option to omit traces would help. (4) Res…
- webhook, missing, 20261122T235018.043Z-2e8a1b1ca646: A JSON body with a key named `type` cannot be decoded into a record: `type` is reserved, so `type E { E(type: View) }` gives P01 "expected a name but found `type`". Common webhook field name. I worked around it by rewriting the key in the body text with a `before ++ "\"type\"" ++ after` match and decoding the key as `kind`. That is fragile. I would like a way to map a JSON key to a different fiel…
- orders, confusing, 20261122T235045.451Z-55490a9967fb: Worked well overall; LANGUAGE.md section 8 was nearly the whole answer. Friction: (1) C65 fired when I keyed `once:` by ForOrder(order: id) copied from the doc example while the message carried only id; the fix (once: same record as send) is in the diagnostic but the doc example's pattern differs when the message has the id plus the amount. (2) The run tool needs the whole file text inline on eve…
- shortener, missing, 20261122T235223.343Z-a8bad6ada990: I could not find any way to set a response header (needed: `Location` on a 302). `respond(status)` takes only `status` (C11: "function respond takes (status)"). I guessed header, add_header, set_header, write_header, with_header, location, redirect and respond_redirect, and each was C22 unknown function. The docs (LANGUAGE.md, guide.md) never say how to set headers or the content type. Responses …
- sales, missing, 20261122T235211.725Z-b6bc71eae37b: Docs never say how to read query-string params: I had to probe and found Request(path) excludes the query and Request(query) is Option[View]; I then hand-parsed it with recursive `head ++ "&" ++ rest` patterns. Also missing: no way found to set Content-Type (JSON answers are text/plain), no documented byte/char predicate (validated a-z0-9- via SQL GLOB), and `let x = match` is refused with no obv…
- invoice, missing, 20261122T235344.922Z-48d99441df36: Money task: docs list no std/builtin reference. I had to guess the names (fold(list, from, by), buf(), freeze, write_json_string, write_int, len on View only). decimal(n) rejects leading zeros ("05"), so I wrote a digit parser by hand over `"0" ++ rest` ... `"9" ++ rest`. Storing a Buf in a record gives C08 (clear message), but there is no documented way to build a List of rendered pieces, so I c…

## Re-running

After a release (prod answers a new `tape-version`): `node bench/usability/run.ts` (all tasks, once each; `--n 3` for variance, `--tasks a,b`, `--model`, `--parallel`, `--budget-usd`, `--timeout-min`). To see whether the old solutions still pass on the new release without new agents: `node bench/usability/run.ts --regrade <results dir>`. To grade one program by hand: `node bench/usability/grade.ts <task> <file.tape>...`. To rewrite this file: `node bench/usability/summary.ts <results dir>`.
