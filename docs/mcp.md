# The hosted compiler and runner (MCP and HTTP)

**Not live yet.** This is how it will work once it is deployed at https://tape.ivar.workers.dev. Until then you can
run it yourself ([below](#running-it-yourself)).

`tape-mcp` compiles a Tape program you post and runs HTTP requests against it, and gives back what the compiler said,
each response, its effect log, whether a replay from that log matched, and its OTLP/JSON trace. It is meant for
AI agents that want to try Tape and check it for themselves, over MCP, and for anything that can POST JSON. It keeps
nothing: every call compiles from scratch and runs on a fresh in-memory SQLite database that is gone when the call
returns.

Alpha: anything can change at any time. **Calls are logged** ([what is logged](#what-is-logged)); the rules for the
public service are in [`TERMS.md`](../TERMS.md).

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

## The two tools

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
(`"POST /links\n{\"url\":\"https://example.com\"}"`). They run in order against one database, so the second
`GET /hello/ada` sees the first one's write.

```json
{ "ok": true, "diagnostics": [],
  "results": [{
    "request": "GET /hello/ada", "status": 200, "content_type": "text/plain; charset=utf-8",
    "body": "Hello again, ada #2!", "body_bytes": 20, "truncated": false, "error": null,
    "effects": [{ "kind": "sql",
                  "query": "INSERT INTO greeted(name, n) VALUES (:name, 1) ON CONFLICT(name) DO UPDATE SET n = n + 1 RETURNING n",
                  "params": { ":name": "ada" }, "rows": [[2]] }],
    "replayed": true, "steps": 77, "memory_bytes": 128,
    "trace": { "resourceSpans": [ … ] } }] }
```

- `effects` is the request's effect log: each SQL statement as the program wrote it (its `:name` placeholders),
  the value bound to each name, and the rows returned or `rows_written`; calls to other programs (`kind: "call"`,
  which answer Unreachable here: one program runs at a time), clock reads (`now`), random draws and timers set
  (`wake`). A BLOB is `{"base64": …}`.
- `replayed` is true when the service ran the request again from that log alone, through the same build, and got
  the same bytes back (or, for a trap, the same trap). `replay_error` says why when it did not.
- `trace` is OTLP/JSON, made by the same `otlp()` the service uses ([`service/src/view.ts`](../service/src/view.ts))
  from the same log; the playground shows the same spans.
- `steps` is the reductions the request used, out of Tape's 50,000,000.
- A request that traps (the step budget, the 64 MB arena, a division by zero) is status 500 with `error` set; its
  writes are rolled back and the next request runs on.
- `ok` is true when the program compiled and every request answered without a trap and replayed. If it does not
  compile, `ok` is false, `diagnostics` says why and nothing runs.

The same input gives the same output except trace ids and times: `random()` is seeded the same way on every call.
`now()` is the real clock.

### Check it in one call

The tool descriptions hold `examples/hello.tape` and what it gives. `run` with
`{"requests": ["GET /hello/ada", "GET /hello/ada"]}` gives 200 `Hello, ada`, then 200 `Hello again, ada #2!`,
one `sql` effect each with params `{":name": "ada"}` and rows `[[1]]` then `[[2]]`, both `replayed: true`.
`compile` with the line `repeat: True,` taken out of hello.tape gives `ok: false` and C54 at line 11.

## Limits

| What | Limit |
|---|---|
| files | 8, 64 KB of source together |
| requests | 20 a call; a first line of at most 2 KB, a body of at most 16 KB |
| each request | Tape's own budget: 50,000,000 steps, 64 MB of memory |
| a response body | given back up to 64 KB; past that it is cut and `truncated` is true (`body_bytes` is the whole size) |
| a result's effects and trace | 512 KB of JSON; past that both are left out and `omitted` says so |
| a run call | 20 s of wall time; the Dynamic Worker running the program has 10 s of CPU and no network |
| a request body | 499,712 bytes (488 KB) |
| calls | 60 a minute per client address (a hash of it), per Cloudflare location |

Every refusal is JSON, `{"ok": false, "error": "<code>", "reason": "<what to change>"}`, with an HTTP status: over
MCP it is a tool result with `isError: true` and the same JSON. The codes: `bad_arguments`, `unknown_argument`,
`bad_files`, `bad_file_name`, `too_many_files` (413), `source_too_large` (413), `bad_requests`,
`bad_request_line`, `too_many_requests` (413), `request_too_large` (413), `body_too_large` (413), `bad_json`,
`unsupported_media_type` (415), `method_not_allowed` (405), `origin_refused` (403), `not_found` (404),
`rate_limited` (429), `run_timeout` (504), `run_failed` (503), `disabled` (503: switched off for now).

Every answer is `application/json` with `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src
'none'; sandbox` and `Cache-Control: no-store`; what a program answers is a JSON string, never a page. There are no
CORS headers, and a request with an `Origin` header is refused: the clients are MCP clients and HTTP tools, not
browsers, so a web page cannot use its visitors as clients.

## What is logged

One line per call to Workers Observability: the route and MCP method, the tool, whether it was ok or refused and
why, the HTTP status, the diagnostic codes, the number of files, the source's size in bytes, the number of
requests and their statuses, the steps used, the compile, run and total times, a hash of the client's address, the
user agent, and whether it was rate limited. Not the source, the requests' bodies or the responses. We use it to
improve Tape and the service ([`TERMS.md`](../TERMS.md)).

## How it works

[`mcp/`](../mcp/) is a Worker of its own, `tape-mcp`, with no Durable Objects, no storage and no secrets. It is
meant to be reached through the `tape` Worker at `/mcp` and `/v1/*` (a service binding), and works on its own too.

- `src/serve.ts`: the routes, the checks before a tool runs, the log line. MCP is the service's transport,
  [`service/src/mcp.ts`](../service/src/mcp.ts).
- `src/tools.ts`: the two tools as functions of their arguments. They compile with the repository's compiler.
- A Worker cannot compile Wasm at run time, so a build runs in a Dynamic Worker (the Worker Loader): it is given the
  program's module, sql.js's module, the host ([`host.ts`](../host.ts)) and `src/runner.ts`, with no network and a
  CPU limit, and is cached by the build's hash. The database is [sql.js](https://github.com/sql-js/sql.js) through
  the playground's adapter ([`apps/playground/src/sqlite.ts`](../apps/playground/src/sqlite.ts)), the one in-memory
  SQLite that runs in workerd (Durable Object SQLite would need a Durable Object; there is no `node:sqlite`).
- `KILL_SWITCH` (`on` refuses every call) and `RATE` (the rate limit) are its only settings.

### Running it yourself

```sh
cd mcp && npm ci
npx cf dev                  # then POST to /mcp at the address it prints
node test.ts                # the tools and the HTTP face in Node; --plants plants 28 bugs, each caught
npx vitest run              # the Worker in workerd, with the real Loader and rate limiter
```
