# Tape

Tape is a small language for durable services, compiled to WebAssembly. It runs in the browser, in Node, and on
Cloudflare Workers, where each program gets its own Durable Object and SQLite database. The compiler refuses mistakes
that lose or double data when a request is retried (each a rule with a code), and every effect is recorded, so each
request can be replayed and traced; the program contains no tracing code. It has one way to do each job.

**Status: alpha.** The language is at version 0.1 and still changes; the service and its API can change at any
time. It is not published as a package. What is checked, and what is known to be broken, is in
[`STATUS.md`](STATUS.md).

**Try it** with nothing to install: the [playground](https://tape.ivar.workers.dev/playground/) compiles and runs
programs in your browser, and shows each request's effect log and trace. Ten small programs written in Tape
(a pastebin, polls, a ledger, a rate limiter…) run on the hosted service; [`apps/products/`](apps/products/README.md)
lists them, each with its page and its one file of source.

This is a whole program, `examples/hello.tape`:

```tape
// hello.tape: greet someone, and count how many times each name has been greeted. A repeated request is
// another greeting, so the count says so (`repeat: True`: rule C54).
schema "CREATE TABLE IF NOT EXISTS greeted(name TEXT PRIMARY KEY, n INTEGER NOT NULL)"

type Count { Count(n: Int) }

fn handle(raw: View, db: Sql) -> Buf {
  match request(raw) {
    Request(method: "GET", path: "/hello/" ++ name) if len(name) > 0 -> greet(
      name,
      seen: sql_first(
        row: Count,
        repeat: True,
        query: "INSERT INTO greeted(name, n) VALUES (:name, 1) ON CONFLICT(name) \
            DO UPDATE SET n = n + 1 RETURNING n",
        name
      )
    )
    _ -> respond(status: 404) |> append(view: "no such route")
  }
}

fn greet(name: View, seen: Option[Count]) -> Buf {
  match seen {
    Some(value: Count(n)) if n == 1 -> respond(status: 200) |> append(view: "Hello, \(name)")
    Some(value: Count(n)) -> respond(status: 200) |> append(view: "Hello again, \(name) #\(n)!")
    None -> respond(status: 500)
  }
}

invariant "a name greeted has been greeted at least once" {
  SELECT name, n FROM greeted WHERE n < 1
}
```

Run it twice (Node 25, nothing to install). This is the second request's part of the output, long lines cut. The
log is what the host recorded, and the trace is computed from that log:

```
$ node tape.ts examples/hello.tape 'GET /hello/ada' 'GET /hello/ada'
…
→ GET /hello/ada
← 200 ⏎ Hello again, ada #2!

  effect log
    start   build 8d6b763df1c9705e  flags {}  128 bytes of memory, 92 steps
    sql     INSERT INTO greeted(name, n) VALUES (?1, 1) ON CONFLICT(name) DO UPDATE SET n = n + 1 RETURNING n  …

  trace, from that log
  handle
    ✓   9  Request(method: "GET", path: "/hello/" ++ name) if len(name) > 0 -> greet(
        sql ["ada"] -> [[2]]
  greet
    ✗  25  Some(value: Count(n)) if n == 1 -> respond(status: 200) |> append(view: "Hello, \(name)")
    ✓  26  Some(value: Count(n)) -> respond(status: 200) |> append(view: "Hello again, \(name) #\(n)!")
```

(The query names its value, `:name`. The database is given the names numbered, and the log shows what the database
was given: `?1`.)

Take the line `repeat: True,` out and the program no longer compiles:

```
hello.tape:11: C54 run twice (a retried request, a timer that fires again), this write applies twice: n = n + 1
  depends on the row it changes, and nothing at the top level of its WHERE stops a second run
```

`repeat: True` is right there because a greeting repeated is another greeting: the count is meant to grow on every
attempt. That is the rare case. A write meant to happen once per request, such as a debit, takes no flag: the
request claims its id first, and a second run stops at the claim (with the claim, `repeat: True` is refused, C88):

```tape
migration 1 "accounts" {
  CREATE TABLE accounts(id TEXT PRIMARY KEY NOT NULL, balance INTEGER NOT NULL CHECK (balance >= 0));
  CREATE TABLE debits(id TEXT PRIMARY KEY NOT NULL)
}

fn handle(raw: View, db: Sql) -> Buf {
  match request(raw) {
    Request(method: "POST", path: "/debit/" ++ id) -> debited(id)
    _ -> respond(status: 404)
  }
}

// once per debit id: a second run finds the claim and stops there, so the debit needs no `repeat: True`
fn debited(id: View) -> Buf {
  let 1 = sql_exec(
    query: "INSERT INTO debits(id) VALUES (:id) ON CONFLICT(id) DO NOTHING",
    id
  ) else -> respond(status: 200)
  let 1 = sql_exec(
    query: "UPDATE accounts SET balance = balance - 5 WHERE id = 'ada' AND balance >= 5"
  ) else -> rollback(
    out: respond(status: 409)
  )
  respond(status: 201)
}
```

What that shows of the design:

- **One way to do things.** A request is matched, an effect is a call that takes a capability (`db: Sql`), and a
  response is built with pipes, with values put into text by holes: `"Hello, \(name)"`.
  [`LANGUAGE.md`](LANGUAGE.md) is the whole definition; `node tape.ts fmt` gives the one layout.
- **Mistakes refused at compile time.** A write that a retry would apply twice is refused, and so are a migration
  that breaks a live version and a status change its machine does not declare. The rules catch the defects they
  were written for, not every defect: [`STATUS.md`](STATUS.md) says how each claim is checked and where it is not.
- **Instrumented without code.** The effect log above is what the host wrote; the trace is computed from it. On
  the service every request has a signed trace page and OTLP/JSON spans.
- **Built for Workers.** One arena per request, state in Durable Object SQLite, calls between programs with a time
  budget and a key that makes a retry run once, even while the first send is still running. `service/` runs
  programs on Workers; its tests run in workerd.
- **Errors that say what to change**, as C54 does. A tool is an exported function with a JSON Schema and a
  capability policy, served over MCP (`examples/tools/`).

## Try it

You need Node 25 or newer (`node --version`; every entry point stops early with the version it found). There is
nothing to install and nothing to build: Node runs the TypeScript as it is.

```
git clone https://github.com/ivarvong/tape && cd tape
node tape.ts examples/hello.tape 'GET /hello/ada' 'GET /hello/ada'
```

Copy `examples/hello.tape`, change it, and run requests against it; one in-memory SQLite database lasts for the
run. A request is `METHOD SP TARGET LF BODY`; write the line feed as `\n` in the argument, as in
`'POST /links\n{"url":"https://example.com"}'`. The response is the status, a line feed, then the body. The effect
log is everything the request read from outside itself; the trace is made afterwards by replaying that log through
a build compiled with `{ trace: true }`. ✓ is an arm taken, ✗ one tried that did not match.

```
node tape.ts fmt --check examples/hello.tape        # the one layout; without --check it rewrites the file
node tape.ts test                                   # the examples written in comments, in std/ and examples/
node tape.ts sim apps/tickets/tickets.tape apps/tickets/pay.tape   # the simulator: faults, timers, retries
```

Then read [`LANGUAGE.md`](LANGUAGE.md), [the guide](docs/guide.md) (it starts with a whole REST service), [the std
reference](docs/std.md) and `examples/`.

## A taste

From `examples/orders.tape`: an order is in SQLite before stock in another object is asked for, and every way the
call can fail is an arm the compiler requires.

```
fn reserve(order: Order) -> Buf {
  let Order(id, item) = order
  let Ok(value: Reserved) = call(
    to: stock,
    method: "reserve",
    send: Reserve(item),
    reply: Reserved,
    within: flags.stock_budget_ms,
    once: ForOrder(order: id)
  ) else {
    Err(error: Rejected(reason)) -> refused(
      reason,
      moved: sql_move(
        row: Order,
        query: "UPDATE orders SET state = 'refused' WHERE id = :id AND state = 'pending' \
            RETURNING *",
        id
      )
    )
    Err(error: Timeout) -> problem(
      status: 504,
      reason: "stock did not answer in time; the order stays pending"
    )
    Err(error: Skew(reason)) -> problem(status: 502, reason)
    Err(error: Unreachable) -> problem(
      status: 503,
      reason: "stock is unreachable; the order stays pending"
    )
  }
  // confirmed by this request or, when a retry racing it moved the order first (both heard the same stored reply),
  // by that one
  match sql_move(
    row: Order,
    query: "UPDATE orders SET state = 'confirmed' WHERE id = :id AND state = 'pending' RETURNING *",
    id
  ) {
    Moved(value) -> shown(status: 201, order: value)
    Raced(now) -> shown(status: 201, order: now)
    NoRow -> problem(status: 500, reason: "the order vanished")
  }
}
```

The steps read down the page: take the order apart, make the call and go on only with `Ok`, then move the order.
A time budget is required; the `once` key makes the command safe to send again (stock answers what it answered the
first time); a callee built from a different definition of the method answers `Skew` and runs nothing; and each
`sql_move` names the state it moves from, so two requests racing on one order cannot both move it.

The `once` key is what makes a retry safe, whether it comes after the first send's answer or while the first send is
still running: the callee claims the key when the method starts, and a send that finds the claim waits for that
run's reply instead of running the method again.

## The playground

[`apps/playground/`](apps/playground/) is a homepage and a playground that run Tape in the browser, with nothing
on a server. The page loads the repository's own compiler, host, simulator and formatter, and the service's OTLP
view, unchanged; SQLite is [sql.js](https://github.com/sql-js/sql.js), vendored. The homepage (`/`) runs
`examples/hello.tape` twice, shows its effect log and trace, and shows what the compiler says when the
`repeat: True` line is taken out. The playground (`/playground/`) edits a program, sends it requests, shows each
response with its effect log, trace, spans, OTLP/JSON and tables, and runs `tape sim` in a worker.

```sh
node apps/playground/serve.ts 8080          # then open http://127.0.0.1:8080/ or /playground/
node apps/playground/build.ts out           # the site as static files in out/
node apps/playground/test.ts                # its logic and build, without a browser
```

`serve.ts` builds the site from the tree on each load. `build.ts` writes plain files: the two pages, `_headers`,
and every other file named by the hash of its content, which `_headers` marks immutable. Its design is in
[`apps/playground/DESIGN.md`](apps/playground/DESIGN.md), and what had to be worked around is in
[`apps/playground/FRICTION.md`](apps/playground/FRICTION.md).

The syntax highlighting and the trace waterfalls are programs in Tape too, compiled to Wasm when the site is built:
[`apps/highlight/`](apps/highlight/) (`highlight.tape`, Tape source in and HTML out, with the token boundaries of
`compiler/lex.ts`) and [`apps/trace/`](apps/trace/) (`trace.tape`, OTLP/JSON in and an SVG waterfall out). Each
has a `test.ts` whose oracles are not the program under test, and a friction log.

## The public service

**Live.** A hosted MCP server and API at https://tape.ivar.workers.dev/mcp: post a program, and it is compiled and
run, and its results and OTLP traces come back. Four tools, `compile`, `run`, `test` (the examples in its comments) and `feedback` (tell the maintainers
what you found; it is stored and read), over MCP (`claude mcp add
--transport http tape https://tape.ivar.workers.dev/mcp`) or as JSON (`POST /v1/compile`, `POST /v1/run`, `POST /v1/test`, `POST /v1/feedback`); how to
connect, the limits and what is logged are in [`docs/mcp.md`](docs/mcp.md), and the Worker is [`mcp/`](mcp/).
How it works:

- Tape is alpha-quality software. Anything (the language, the API, the service, its limits) can change at any
  time, without notice.
- **Each call is logged, as metadata**: the tool, sizes, counts, error codes, statuses, timings, step counts, a
  daily-salted hash of your IP and your user agent; not your program's source, request bodies or responses. We
  use it to improve the platform.
- Content that breaks the acceptable-use rules (phishing, malware, illegal content, abuse of other services,
  attempts to break isolation or limits, spam, cryptomining) is deleted, at our discretion.

The full rules are in [`TERMS.md`](TERMS.md). Past the MCP server, the homepage and the playground, the deployed
service takes only its operator's token. Its API,
and how to run your own copy, are in [`docs/service.md`](docs/service.md).

## Speed

Measured on one machine (a 16-core laptop, Node 25.2.1, 22 November 2026); each benchmark first checks that both
sides give the same answers.

| Benchmark | Tape | JavaScript beside it |
|---|---|---|
| `node bench/csv.ts`: 1 MB of CSV parsed and summed, in the program | 7.4 ms | 13.4 ms |
| `node bench/cart.ts`: a JSON body of 10 lines decoded and checked | 15.6 µs | 4.2 µs (`JSON.parse` and a validator) |
| `node bench/hello.ts`: a request with one SQLite statement | 11.2 µs (10.7 with the effect log off) | 4.8 µs by hand |

Where the program does the work, it is ahead. Where the host does, it is behind: a JSON decode crosses to the host
and back for each record. Times vary by machine: an earlier run on another machine gave 12 ms against 27 for the
CSV and 26 µs against 10 for the request.

Production speed is not measured beyond one cut-short comparison on a free account
([`docs/history.md`](docs/history.md#production-benchmark-on-durable-objects-12-november-2026)).

## Documentation

| Document | What |
|---|---|
| [`LANGUAGE.md`](LANGUAGE.md) | The definition, version 0.1. `test/definition.ts` holds the compiler to it. |
| [`docs/guide.md`](docs/guide.md) | A quickstart: a whole service in one file, worked and tested; then the language one feature at a time: patterns, steps, JSON, rules, machines, invariants, timers, migrations. |
| [`docs/std.md`](docs/std.md) | The standard library and the built-ins: every function meant to be called, with its signature, comment and examples, and common tasks (JSON responses, query parameters, numbers, bodies, lists); the helpers they call are in the source. Generated from `std/`. |
| [`docs/changes.md`](docs/changes.md) | What each release changed, and each form that went with what replaced it. |
| [`docs/sim.md`](docs/sim.md) | `tape sim`: programs run together under every order of events a deployment may give them. |
| [`STATUS.md`](STATUS.md) | Each claim and the check that fails when it breaks; known limitations; what is on trust. |
| [`docs/mcp.md`](docs/mcp.md) | The hosted compiler and runner (live): connecting over MCP or HTTP, the two tools, limits, logging. |
| [`docs/service.md`](docs/service.md) | The service's API, authentication and limits; running your own. |
| [`TERMS.md`](TERMS.md) | Rules for the public service. |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Running the checks, and what they check. |
| [`SECURITY.md`](SECURITY.md) | Reporting a vulnerability. |
| [`docs/design.md`](docs/design.md) | Why the rules are what they are, from the defects behind them. |
| [`docs/defects.md`](docs/defects.md) | Every defect found while building it, and what each says about the checks. |
| [`docs/history.md`](docs/history.md) | What each pass over the checks found, and the measurements made along the way. |
| [`service/VERIFY.md`](service/VERIFY.md), [`service/RUNTIME-SPEC.md`](service/RUNTIME-SPEC.md) | The checks of the service, and the properties they enforce. |

## What is here

| Path | What |
| --- | --- |
| `compiler.ts`, `compiler/` | The compiler: source text to a Wasm module. No dependencies; runs in Node, workerd and the browser. |
| `rules.ts`, `rules/`, `sql.ts`, `sql/` | The rules a program must pass (C51 and up), and the SQL reader they and the compiler share. |
| `std/`, `std.ts` | The standard library, written in Tape (text, JSON, HTTP, retry, `List`, `Map`). |
| `fmt.ts`, `doctest.ts` | The formatter, and the runner for examples in comments. |
| `host.ts`, `host/` | The host: SQL, JSON, calls with time budgets, timers, exported methods, replay, tracing, spans. |
| `nodesql.ts`, `check.ts` | SQLite in Node for the host, and a check of every SQL statement against the schema with SQLite itself. |
| `interp.ts`, `interp/` | A reference interpreter that every compiled build is checked against. |
| `tape.ts`, `cli/` | The command line: run requests, `fmt`, `test`, `sim`. |
| `sim.ts`, `sim/` | The simulator behind `tape sim`. |
| `service/` | Tape as a service on Workers, with its tests, fault harnesses and protocol models. |
| `mcp/` | the hosted compiler and runner, served by the `tape` Worker at `/mcp`, `/v1/compile`, `/v1/run`, `/v1/test`, `/v1/feedback`. |
| `adapters/` | Host-side adapters; `ply.ts` makes a git repository a `Git` capability using [ply](https://github.com/ivarvong/ply). |
| `examples/`, `apps/` | Example programs, and applications written as a user would, each with its friction log; `apps/playground/` is the homepage and playground. |
| `test/`, `proof/` | The tests, one file per subject, and the checks that are more than a test; `proof/all.ts` runs everything. |
| `bench/`, `experiments/` | Benchmarks, and the experiments behind the rules, kept as they were run. |
| `testdata/` | Programs the checks read that are not examples: odd formatting, failing doc examples, and two workflow programs (billing, an agent loop) with planted bugs. |

## License

MIT, see [`LICENSE`](LICENSE).

`apps/playground/vendor/sql.js-1.10.3/` is [sql.js](https://github.com/sql-js/sql.js) 1.10.3, MIT, with its
licence beside it ([`LICENSE`](apps/playground/vendor/sql.js-1.10.3/LICENSE)); the SQLite inside it is in the
public domain.
