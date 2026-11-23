# The Tape service: API

`service/` is a Cloudflare Worker that compiles uploaded Tape source and runs each version as a Durable Object
with its own SQLite database. This page is for someone who calls the service. How to run your own copy is at the
end; how its behaviour is checked is in [`service/VERIFY.md`](../service/VERIFY.md) and
[`service/RUNTIME-SPEC.md`](../service/RUNTIME-SPEC.md).

## The public service

**Live.** A hosted MCP server and API: post a program, and it is compiled and run, and its results and OTLP traces
come back, at https://tape.ivar.workers.dev/mcp (and `POST /v1/compile`, `POST /v1/run`), with no token. It is
[`mcp/`](../mcp/), served in the `tape` Worker itself; [`docs/mcp.md`](mcp.md) says how to use it. The deployed service also serves the homepage (`/`) and the in-browser
playground (`/playground/`); every other route below needs its operator's token and answers 401 without it.

The rules for using it are in [`TERMS.md`](../TERMS.md): it is alpha software that can change at any time, what
you do on it is logged and used to improve it, and content that breaks the acceptable-use rules is deleted.

## Authentication

| Credential | Opens |
|---|---|
| The operator token, `authorization: Bearer <token>` | every route |
| An account's agent token (`GET /_agent/:account`, operator) | `/tools/:account…` and `/mcp/:account` only |
| A signed link (`/t/…?exp=…&sig=…`, `/otlp/…`) | one trace, without a token, for seven days |
| Nothing | a published name's public route, `/p/:account/:name/…` |

Account and name are 1 to 64 of `a-z 0-9 _ -`, starting with a letter or digit.

## Programs

```
POST   /:account/:name                     body: Tape source -> 201 {version, url, hash, …}; or the compiler's errors
GET    /:account/:name                     the versions; ?rules adds, for each, "passes" or what today's rules refuse
ANY    /:account/:name/v/:version/<path>   runs "METHOD /path?query LF body" through that version
GET    /:account/:name/log/:version/:id    a request's effect log (id from the tape-request-id header)
GET    /:account/:name/trace/:version/:id  its trace, made by replaying that log through the traced build
GET    /:account/:name/requests            recent requests, newest first, with signed trace links (?since, ?limit)
GET    /:account/:name/wakes               the timers set, the alarm, the latest woken runs
GET    /:account/:name/storage             bytes held by the name's data and its request log
DELETE /:account/:name/v/:version          retires a version
```

```sh
A="authorization: Bearer $TAPE_TOKEN"
curl -H "$A" --data-binary @examples/hello.tape $URL/me/hello        # 201, version 1
curl -i -H "$A" $URL/me/hello/v/1/hello/ada                          # 200 Hello, ada; tape-request-id: <id>
curl -H "$A" $URL/me/hello/trace/1/<id>
```

An upload is an immutable, numbered version. Every version of a name shares the name's tables. Migrations
(`migration n "…" { … }`) are applied before the first request after an upload; one that removes something must be
marked `contract` and waits until every older live version is retired. An upload whose migrations would break a
live version, or whose machine the stored rows do not satisfy, is refused with 409. A program's `Remote`
parameters reach the latest version of the program with that name in the same account.

Every response names its request (`tape-request-id`) and carries signed links to its trace as a page
(`tape-trace-url`) and as OTLP/JSON (`tape-otlp-url`). A storage failure at commit answers 503 with
`retry-after: 1` and says whether anything was kept (`applied`); a trap answers 500.

### What a program answers

A program answers `STATUS LF BODY` (`respond(status)`, served as `text/plain`) or `STATUS SP TYPE LF BODY`
(`respond_as(status, content: Html)`; `Json`, `Text`, `Css`, `Svg` and `Csv` too). The type is from a closed list; other
headers follow the status line, each after a carriage return (`header(name:, value:)`: `Location`, `cache-control`),
and the host refuses those it sets itself (content-type, set-cookie, the security headers) with a 500 that says why.
A first line that is neither form is all body. A program reads the request headers the host passes (accept,
content-type, if-match, if-none-match, idempotency-key and x-…, never cookie or authorization) with `header_of`.

### Public routes

After `PUT /_public/:account/:name {"published": true}` (operator), `/p/:account/:name/<path>` answers GET, HEAD and
POST (a body of at most 64 KB) from anyone, through the latest live version, without trace links. The program
sees who called: the request line ends in ` public`, and std/http's `Request(caller: Operator | Anyone)` says so.
For HTML forms, std/http has `form_field(body, name)` and `write_html(out, text)` (escaped). `apps/tickets/` is a
box office served this way.

## Tools for agents

A tool is a program made only of exported functions. The operator sets what an account's tools may use; an agent
uploads, lists and calls tools with the account's agent token.

```
PUT  /_policy/:account          {sql, clock, entropy, remote: [names]}            operator
POST /tools/:account/:name      body: Tape source -> 201 the manifest entries; 403 when a capability is not granted
GET  /tools/:account            every tool function, with JSON Schemas and capabilities
POST /tools/:account/:name/:fn  body: the JSON message -> {ok, output | error, trace_url, otlp_url}
POST /mcp/:account              MCP over streamable HTTP: initialize, tools/list, tools/call
```

A refined type becomes a JSON Schema bound (`Qty = Int where self >= 1 and self <= 100` is
`{"type":"integer","minimum":1,"maximum":100}`), and the tool itself refuses a message outside it.
`examples/tools/` has examples.

## A sharded key-value store

`POST /kv/:account/:cluster {"shards": N}` makes a cluster of N shards (1 to 64, fixed for its life). Each shard is
a Durable Object running `examples/kv.tape`; the router (`service/src/kv.ts`) sends key k to shard
`fnv1a32(k) mod N`, and each shard refuses a key that is not its own.

```sh
A="authorization: Bearer $TAPE_TOKEN"
curl -H "$A" -X POST $URL/kv/me/users -d '{"shards":16}'                      # 201; the same again 200, another N 409
T=$(date +%s000)                                                            # an op id is <t>_<id>, t in ms
curl -H "$A" -X PUT "$URL/kv/me/users/k/ada?op=${T}_c1-1" --data-binary 'Ada'  # 201 {"key":"ada","version":1}
curl -H "$A" -X PUT "$URL/kv/me/users/k/ada?if=1" --data-binary 'Ada L.'     # 200 version 2; 409 if the version moved
curl -H "$A" $URL/kv/me/users/k/ada                                          # {"key":"ada","value":"Ada L.","version":2}
curl -H "$A" -X DELETE "$URL/kv/me/users/k/ada?if=2"                        # 200 version 3 (a tombstone keeps it)
curl -H "$A" $URL/kv/me/users                                                # the cluster and each shard's counts
```

Keys are 1 to 256 bytes of `A-Z a-z 0-9 - . _ ~ : %`; values are UTF-8, at most 64 KiB. An unconditional write
must carry `?op=<id>` (428 without one): an op id names one write to one key, and the shard stores its reply with
the write, so the same op id again answers the same and writes nothing. A compare-and-set (`?if=`) needs none.
Every response names its shard (`kv-shard`), carries signed trace links and `server-timing`, and joins the
caller's trace when it sends a `traceparent`. `GET /kv/:account/:cluster/traces/:trace?key=` finds a request by
its trace id. Not supported: resharding, cross-key transactions, scans, backups.

## Limits

| What | Limit |
|---|---|
| A request's memory | 64 MB; past it the run traps |
| A request's steps | 50,000,000; past it the run traps |
| A public route's body | 64 KB |
| A version (source and builds) | about 7.5 MB |
| A signed trace link | seven days |
| Trace records kept per name | the newest 100,000 requests |
| KV: shards, key, value | 1 to 64; 1 to 256 bytes; 64 KiB |
| A timer's delay | 0 ms to 30 days |

## Running your own

The service deploys to your own Cloudflare account with the `cf` CLI (an npm dev dependency of `service/`;
`service/cloudflare.config.ts` is its configuration). It needs one secret, `TOKEN`, which is both the operator
token and the key that signs trace links; changing it invalidates every link issued.

```sh
cd service && npm install
npx vitest run          # the service's tests, in local workerd
npm run build           # the site (scripts/site.ts, into .site/) and the Worker, with the site as its static assets
npx cf deploy           # your own copy, straight to 100%
```

The homepage and the playground are the Worker's static assets: `scripts/site.ts` builds `apps/playground` into
`service/.site/` with a `robots.txt` and a `tape-version` header on every file, and `vite.config.ts` makes that
directory Vite's public directory. Every response names the commit it was built from (`tape-version`) and the Worker
version (`tape-worker-version`). The hosted service deploys only through `service/scripts/deploy.sh`: a 0% version,
a pinned smoke, a telemetry gate and a stepped ramp with automatic rollback (the script's header says how).

It uses Durable Objects with SQLite and the Worker Loader (Workers cannot compile Wasm at run time, so each
version's module is loaded as a Worker of its own).
