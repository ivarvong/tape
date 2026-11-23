# The hosted compiler and runner (MCP and HTTP)

**Live** at https://tape.ivar.workers.dev/mcp (MCP) and https://tape.ivar.workers.dev/v1/compile,
https://tape.ivar.workers.dev/v1/run (JSON), served by the `tape` Worker.
You can also run it yourself ([below](#running-it-yourself)).

`tape-mcp` compiles a Tape program you post and runs HTTP requests against it, and gives back what the compiler said,
each response, its effect log, whether a replay from that log matched, and its trace (a summary, or OTLP/JSON). It
is meant for AI agents that want to try Tape and check it for themselves, over MCP, and for anything that can POST
JSON. Compile and run keep nothing: every call compiles from scratch and runs on a fresh in-memory SQLite database that is gone when
the call returns. The third tool, [`feedback`](#feedback), stores the report you send for the maintainers.

Alpha: anything can change at any time. **Calls are logged** ([what is logged](#what-is-logged)); the rules for the
public service are in [`TERMS.md`](../TERMS.md).

## Validate in one call

Call `run` with no `files` (the program is then [`examples/hello.tape`](../examples/hello.tape)) and two requests:

```json
{ "requests": ["GET /hello/ada", "GET /hello/ada"] }
```

Expect `ok: true` and two results, both status 200: the first body `Hello, ada`, the second `Hello again, ada #2!`,
each with one `sql` effect (params `{":name": "ada"}`, rows `[[1]]` then `[[2]]`, `rows_written: 1` both times) and `replayed: true`. Then
`compile` hello.tape with the line `repeat: True,` taken out: `ok: false`, one diagnostic, C54 at line 11, and its
`fix` says what to write. The tool descriptions hold the program and these answers.

## Connecting

Claude Code:

```sh
claude mcp add --transport http tape https://tape.ivar.workers.dev/mcp
```

Cursor (`~/.cursor/mcp.json`, or `.cursor/mcp.json` in a project):

```json
{ "mcpServers": { "tape": { "url": "https://tape.ivar.workers.dev/mcp" } } }
```

Any other MCP client: streamable HTTP at `https://tape.ivar.workers.dev/mcp`, JSON responses (no event streams), no
authentication. Protocol versions 2025-06-18 and 2025-03-26.

curl, over MCP:

```sh
curl -s https://tape.ivar.workers.dev/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"run","arguments":{"requests":["GET /hello/ada","GET /hello/ada"]}}}'
```

or the same tools as plain JSON, with the arguments as the body:

```sh
curl -s https://tape.ivar.workers.dev/v1/run -H 'content-type: application/json' \
  -d '{"requests": ["GET /hello/ada", "GET /hello/ada"]}'
curl -s https://tape.ivar.workers.dev/v1/compile -H 'content-type: application/json' \
  -d '{"files": [{"name": "hello.tape", "text": "…"}]}'
```

## The tools

`compile` and `run` are below; [`feedback`](#feedback) sends what you found to the maintainers.
The descriptions of `compile` and `run` carry a cheat sheet of the language (the entry point, `Request`'s fields and
the query, `respond_as` and JSON out, `decode`, the SQL calls with `:name`) and link [the std reference](std.md)
and [the guide's worked REST service](guide.md#a-whole-rest-service-worked); each is about 1,100 (compile) and 1,300
(run) tokens.

Both take `files`, the program: at most 8 `{name, text}`, each name like `hello.tape` (letters, digits, `_`, `-`,
then `.tape`). The files are one program, as [`LANGUAGE.md`](../LANGUAGE.md) describes, with the standard library
before them. Leave `files` out and the program is [`examples/hello.tape`](../examples/hello.tape). An argument
the tool does not take is refused, so a misspelt one is not silently ignored.

### compile

```json
{ "ok": false,
  "diagnostics": [{ "file": "hello.tape", "line": 11, "code": "C54",
                    "message": "run twice (a retried request, a timer that fires again), this write applies twice: …",
                    "fix": "Make the second run a no-op: … If every attempt is meant to count, say so in the call: `repeat: True`." }],
  "wasm_bytes": null, "statements": null }
```

`ok` is true when the program compiles; then `diagnostics` is empty, `wasm_bytes` is the size of its module and
`statements` the number of SQL statements it can run. `fix` is what to write instead.

### run

Also takes `requests`: 1 to 20, each `METHOD SP TARGET`, then optionally a line feed and a body
(`"POST /links\n{\"url\":\"https://example.com\"}"`), or `{"request": "…", "at_ms": 61000}` to send it at a time of
the run's own clock (below). They run in order against one database, so the second `GET /hello/ada` sees the first
one's write. Two optional arguments say how much comes back: `trace` (`"summary"`, the default; `"full"`;
`"none"`) and `effects` (`"compact"`, the default; `"full"`).

```json
{ "ok": true, "diagnostics": [],
  "results": [{
    "request": "GET /hello/ada", "status": 200, "content_type": "text/plain; charset=utf-8",
    "body": "Hello again, ada #2!", "body_bytes": 20, "truncated": false, "error": null,
    "effects": [{ "kind": "sql",
                  "query": "INSERT INTO greeted(name, n) VALUES (:name, 1) ON CONFLICT(name) DO UPDATE SET n = n + 1 RETURNING n",
                  "params": { ":name": "ada" }, "rows_returned": 1, "rows": [[2]] }],
    "replayed": true, "steps": 77, "memory_bytes": 128,
    "trace": { "trace_id": "4bf9…", "spans": [{ "name": "GET /hello/ada", "status": "ok", "duration_us": 412, "events": 1 }] } }] }
```

- `headers` is the response headers the program set with std/http's `header` (a 302's `location`, say), as
  `[{"name": "location", "value": "/links/7"}]`, names in lower case, in the order set. A response that set none has
  no `headers` field (the example above). The host's own headers (content-type, which is `content_type`, and the
  security headers) are not in it.
- `effects` is the request's effect log: each SQL statement as the program wrote it (its `:name` placeholders),
  the value bound to each name, and what it did: `rows_written` for a statement that wrote, `rows_returned` and the
  `rows` themselves for one that returned rows (an INSERT, UPDATE or DELETE with `RETURNING` has both); calls to
  other programs (`kind: "call"`, which answer Unreachable here: one program runs at a time), clock reads (`now`),
  random draws and timers set (`wake`). A BLOB is `{"base64": …}`. With `effects: "compact"` (the default) a
  statement that returned more than 20 rows shows only `rows_returned`; `effects: "full"` shows every row (and no
  `rows_returned`).
- A write or a timer that the request's `rollback(out)` or a trap undid has `undone: true`: it did not stay. Its
  trace event has `tape.sql.undone` (or `tape.timer.undone`), and the span's `tape.sql.rows_written` leaves it out.
- `trace`: with `"summary"` (the default), each span of the request's trace in a few words: `name`, `status` (`ok`
  or `error`, and `error` with the message), `duration_us` and how many `events` it has, with the `trace_id`.
  `"full"` gives the trace as OTLP/JSON (`resourceSpans`), made by the same `otlp()` the service uses
  ([`service/src/view.ts`](../service/src/view.ts)) from the same log; the playground shows the same spans. `"none"`
  gives `trace: null`. A full trace is most of an answer's size: ask for it when you need the spans themselves.
- `replayed` is true when the service ran the request again from that log alone, through the same build, and got
  the same bytes back (or, for a trap, the same trap). `replay_error` says why when it did not.
- `steps` is the reductions the request used, out of Tape's 50,000,000.
- A request that traps (the step budget, the 64 MB arena, a division by zero) is status 500 with `error` set; its
  writes are rolled back and the next request runs on.
- `ok` is true when the program compiled and every request answered without a trap and replayed. If it does not
  compile, `ok` is false, `diagnostics` says why and nothing runs.

The same input gives the same output except trace ids and times. On purpose, `random(from: entropy)` is seeded
the same way on every call: an agent that sends the same program and requests again gets the same answer, so it can
check what changed.

#### The clock, and timers

`now()` is the real clock, unless a request carries `at_ms`. Then the whole call runs on a clock of its own:
`now()` is the run's start plus that request's `at_ms`, a request without one keeps the time of the request
before it (the first starts at 0), and `at_ms` may not go back (`bad_at_ms`). So a 60-second window is tested by
sending requests at `0`, `1000` and `61000`; nothing waits.

On that clock, timers run. Before each request, every timer due by its time (`wake(after: 5000, key: 7)` set at
1000 is due at 6000) runs the program's `woken` with `Wake(key)`, oldest first, and each is a result of its own
in the list, before the request: `"request": "woken {\"key\":7}"`, `"woken": {"key": 7, "due_ms": 6000}`, status 200
and the JSON of `Ok`, or 500 and the text of `Err`. A timer a `woken` sets that is already due runs too, up to 20
timer runs a call. A timer's run is not replayed (`replayed: null`: the host replays `handle` only) and does not
make `ok` false. To see a timer that is due after the last request, send one more request later (any route). The
answer then has `"timers": {"fired": 1, "pending": 0}`: how many ran, and how many are still set at the end. On the
real clock (no `at_ms`), timers are set but never run here.

### feedback

Report anything surprising, wrong, confusing or missing about Tape: the language, the compiler and its
diagnostics, or these tools. Send the smallest program that shows it.

```json
{ "text": "21! answers a negative number with status 200",
  "kind": "bug",
  "files": [{ "name": "fact.tape", "text": "…" }],
  "requests": ["GET /fact/21"],
  "expected": "a trap: the Int overflows",
  "actual": "200 -4249290049419214848" }
```

Only `text` is required (at most 8 KB; `expected` and `actual` too). `kind` is `bug`, `confusing`, `missing`,
`idea` or `praise`; `files` and `requests` are as `compile` and `run` take them. The answer is `{"ok": true, "id":
"20261122T224501.123Z-4f2a9c01b3de"}`. Also `POST /v1/feedback` with the same JSON. At most 5 reports a minute
from one address (`feedback_rate_limited`, 429).

What is stored, one object per report in a private R2 bucket with no public URL: the fields you send, the time, the
tape-mcp version, the daily salted hash of your address (below; never the address), your user agent, the
`mcp-protocol-version` header, and, when you send `files`, what the compiler says of them at that moment, so we
know which version it reproduced on. The maintainers read every report, to improve Tape. Reports are kept until we
delete them. Do not send secrets or personal data. The refusals besides the ones below: `bad_text`,
`text_too_large` (413), `bad_kind`, `bad_field`, `field_too_large` (413), `feedback_rate_limited` (429),
`feedback_unavailable` (503) and `store_failed` (503).

Reading them (maintainers): `node mcp/scripts/feedback.ts` lists the last 7 days' reports; `--show <id>` prints one
in full; the address's hash is left out unless `--ip`. A deploy's smoke report goes under `smoke/`
(`--smoke`, `--delete-smoke`).

## Limits

These are alpha limits and may change.

| What | Limit |
|---|---|
| files | 8, 64 KB of source together |
| requests | 20 a call; a first line of at most 2 KB, a body of at most 16 KB |
| each request | Tape's own budget: 50,000,000 steps, 64 MB of memory |
| a response body | given back up to 64 KB; past that it is cut and `truncated` is true (`body_bytes` is the whole size) |
| a result's effects and trace | 512 KB of JSON; past that both are left out and `omitted` says so |
| `at_ms` | 0 to 30 days, never less than the request before; 20 timer runs a call |
| a run call | 20 s of wall time; the Dynamic Worker running the program has 10 s of CPU and no network |
| a request body | 499,712 bytes (488 KB) |
| calls | 60 a minute per client address (its daily salted hash, below), per Cloudflare location |
| a JSON integer a program decodes | within ±(2^53 - 1) = ±9007199254740991; past that `decode` refuses it, `<field>: expected a whole number`, rather than round it (JSON is read with `JSON.parse`, whose numbers are doubles). Exact large integers are planned for 0.3; send them as text until then |

Every refusal is JSON, `{"ok": false, "error": "<code>", "reason": "<what to change>"}`, with an HTTP status: over
MCP it is a tool result with `isError: true` and the same JSON. The codes: `bad_arguments`, `unknown_argument`,
`bad_files`, `bad_file_name`, `too_many_files` (413), `source_too_large` (413), `bad_requests`, `bad_at_ms`,
`bad_request_line`, `too_many_requests` (413), `request_too_large` (413), `body_too_large` (413), `bad_json`,
`unsupported_media_type` (415), `method_not_allowed` (405), `origin_refused` (403), `not_found` (404),
`rate_limited` (429), `run_timeout` (504), `run_failed` (503), `disabled` (503: switched off for now),
`misconfigured` (503: the deployment has no `IP_SALT`).

Every answer is `application/json` with `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src
'none'; sandbox` and `Cache-Control: no-store`; what a program answers is a JSON string, never a page. There are no
CORS headers, and a request with an `Origin` header is refused: the clients are MCP clients and HTTP tools, not
browsers, so a web page cannot use its visitors as clients.

## What is logged

One line per call (feedback too) to Workers Observability, kept for 7 days (Workers Logs on the Workers Paid plan): the route and MCP method, the tool, whether it was ok or refused and
why, the HTTP status, the diagnostic codes, the number of files, the source's size in bytes, the number of
requests and their statuses, the steps used, the compile, run and total times, a hash of the client's address, the
user agent, and whether it was rate limited. Not the program's source, the requests' bodies or the responses. We
use it to improve Tape and the service ([`TERMS.md`](../TERMS.md)).

The address is never logged. Its hash is SHA-256 of the address, the UTC day and a secret salt, cut to 16 hex
digits: without the salt it cannot be reversed by trying every address, and one client's calls are linked for one
day at most. The rate limit keys on the same hash.

## How it works

[`mcp/`](../mcp/) is a library the `tape` Worker serves in-process at `/mcp`, `/v1/compile`, `/v1/run` and
`/v1/feedback` ([`service/src/index.ts`](../service/src/index.ts) calls `mcp/src/index.ts` with its own bindings,
before any token check). It uses no Durable Objects and one private R2 bucket, `tape-feedback`, which only the feedback
tool writes. (Until 2026-11-22 it was a Worker of its own, `tape-mcp`, behind a service binding; that Worker is
retired.) Every answer names the `tape` Worker version that gave it (`tape-mcp-version`, the same id as
`tape-worker-version`).

- `src/serve.ts`: the routes, the checks before a tool runs, the log line. MCP is the service's transport,
  [`service/src/mcp.ts`](../service/src/mcp.ts).
- `src/tools.ts`: the two tools as functions of their arguments. They compile with the repository's compiler.
- A Worker cannot compile Wasm at run time, so a build runs in a Dynamic Worker (the Worker Loader): it is given the
  program's module, sql.js's module, the host ([`host.ts`](../host.ts)) and `src/runner.ts`, with no network and a
  CPU limit, and is cached by the build's hash. The database is [sql.js](https://github.com/sql-js/sql.js) through
  the playground's adapter ([`apps/playground/src/sqlite.ts`](../apps/playground/src/sqlite.ts)), the one in-memory
  SQLite that runs in workerd (Durable Object SQLite would need a Durable Object; there is no `node:sqlite`).
- Its settings, bindings of the `tape` Worker ([`service/cloudflare.config.ts`](../service/cloudflare.config.ts)):
  `KILL_SWITCH` (`on` refuses every hosted call), `RATE` (the rate limit), `FEEDBACK` and `FEEDBACK_RATE`, and one
  secret, `IP_SALT`,
  which lives in Cloudflare, not in the repository. Without it every call is refused (503, `misconfigured`). Set
  it, or rotate it, with a long random value (rotating a secret uploads a new version of the Worker):

  ```sh
  env -u CLOUDFLARE_API_TOKEN npx cf workers secrets update IP_SALT --worker tape --text "$(openssl rand -hex 32)"
  ```

- Deploying: it ships with the `tape` Worker (`service/scripts/ship.sh`, CONTRIBUTING.md), whose pinned and prod
  smokes include [`service/scripts/mcp-smoke.ts`](../service/scripts/mcp-smoke.ts) and the parity check.

### Running it yourself

```sh
(cd service && npm ci) && (cd mcp && npm ci)
printf 'IP_SALT=dev-salt\nTOKEN=dev-token\n' > service/.dev.vars   # your own copy's secrets (.dev.vars is not tracked)
(cd service && npm run site && npx cf dev)   # the tape Worker; then POST to /mcp at the address it prints
node mcp/test.ts            # the tools and the HTTP face in Node; --plants plants 44 bugs, each caught
(cd mcp && npx vitest run)  # mcp/src in workerd, with the real Loader and rate limiter
```
