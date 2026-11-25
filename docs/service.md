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

An upload is an immutable, numbered version: its source, hash and migrations never change. Its builds are a cache of
its source, and that changes the promise this page used to make, that a version is kept as built: when the
deployed compiler is not the one that made a version's builds (each build records the compiler's hash, the
`tape-compiler` header; a build from before that is recorded counts as another compiler's), the version is built
again from its source the first time it is loaded, once, and the new builds are stored. The rules are not asked
again, so a version accepted once is not refused later for a rule that came after it. The listing shows
`rebuilt_from` (the old compiler's hash, or `unknown`) and `rebuilt_at`, and the log has a `tape.rebuilt` line. If
the current compiler cannot build the source, the version answers 503 `{"error": "rebuild_failed", "errors": […]}`
with the compiler's diagnostics (logged as `tape.rebuild_failed`, tried again only under another compiler) and its
old build is never run; the other versions are unaffected. When that version is the latest, its timers are kept and not run: the alarm is set again an hour later, with a `tape.timers_deferred` warning. Neither is logged as an error. So that no request pays for a rebuild (1.2-4 s), a deploy that changes the compiler is followed, once the new version has all traffic, by `POST /_rebuild` (operator; service/scripts/ship.sh calls it and records how many names were rebuilt and how long it took): every live version of every program of the listed accounts, a few names at a time. The accounts are those that uploaded a program since the list was kept, those with a published name, and any given as `{"accounts": [...]}`; a name it misses still rebuilds on its first request, as before. Its answer lists the published names (`published`), and ship.sh then sends each one request (service/scripts/warm.ts), so the first visitor after a deploy does not start the name's object. Every version of a name shares the name's tables. Migrations
(`migration n "…" { … }`) are applied before the first request after an upload; one that removes something must be
marked `contract` and waits until every older live version is retired. An upload whose migrations would break a
live version, or whose machine the stored rows do not satisfy, is refused with 409. A program's `Remote`
parameters reach the latest version of the program with that name in the same account.

Every answer from a program route names its request (`tape-request-id`), says what the request did
(`tape-outcome`), and carries a trace link (`traceparent`). A 401, and a public 404 for a name that is not
published, are answered before that route and carry none of the three. An operator's response also carries signed links to its trace as a page
(`tape-trace-url`) and as OTLP/JSON (`tape-otlp-url`). The operator's run of a version also carries `server-timing`, the host's entry first:
`tape-invoke;desc="wall time waiting on the program (not CPU)";dur=<ms>`. `<ms>` is the whole milliseconds this
Worker waited on the program's object, from the invoke span's begin to its done, which is after the body is
buffered. A negative reading is reported as 0. A `server-timing` the program set is kept after that entry: the
header is a list, and only `tape-invoke` is the host's. A request that never calls the object (a body over the
limit, answered before the call) has no `tape-invoke`. A published name's public route does not add it either:
the number is a 1 ms sample of the object's whole call, with no network jitter, and anyone can request that
route. What the number measures, and the precision it has on Workers, is in
[telemetry](telemetry_and_profiling.md#what-a-client-can-read-of-a-requests-cost). The run's span in the OTLP says
what the run used of the limits below, `tape.memory_bytes`, `tape.steps` and `tape.step_version` (the first entry
of its log holds the same, as `bytes`, `steps` and `step_version`, and the trace page shows them), whether it finished or stopped. A log
recorded before the tag has no `step_version`. A stored module is rebuilt with the compiler that is deployed before
it runs, so the module that runs carries the current accounting and the log keeps the version recorded with that
run. The `build` id is a hash of the source, so after the accounting changes the same program version and the same
build can count the same request differently, and `step_version` is what tells the two counts apart. A storage failure at commit answers 503
`not_applied` with `retry-after: 1`. A trap answers 500 `not_applied` with no `retry-after`.

### What a client should do

`tape-outcome` is one of four states. The body of a failure carries the same `outcome` and a `retry` line. `outcome`
and `retry` say whether sending the request again is safe. `transient` and `retry-after` say whether waiting and
sending it again may succeed. A `not_applied` with no `retry-after` (a trap, a retired version, a version the
compiler cannot build, a version whose contract migration is held) will not succeed by being sent again; sending
it again still cannot apply it twice. An answer with no `tape-outcome` is `unknown`: the strongest claim is never
the default.

The idempotency key is the program's own: a key it stores, or the `Idempotency-Key` header when the program reads
it. A program with no such key can send a `not_applied` request again as it stands. For `partly` and `unknown` the
client action is the same: read the resource back before another write. The difference between those two is
diagnostic (`partly` says which stretch was kept).

| `outcome` | What happened | What to do |
|---|---|---|
| `applied` | The request finished, and what it wrote was kept. A program that answers after rolling its own writes back is `not_applied`, or `partly` when an earlier call had committed. | Do not send it again: sending it again can apply it a second time. |
| `not_applied` | Nothing this request wrote was kept. The run rolled back, or it failed before its log began (a Durable Object storage reset: the log is written in the same transaction as the writes, so no log means nothing was kept). | Sending it again cannot apply it twice. When the answer has `retry-after`, wait that long and send the same request. |
| `partly` | The writes before the run's last call were kept. The rest was rolled back. | Read the resource back, or send it again only with the program's own idempotency key. There is no `retry-after`. |
| `unknown` | The object stopped after the run may have committed, and the service cannot see which. | The same as `partly`: read the resource back, or send it again only with the program's own idempotency key. There is no `retry-after`. |

The service does not retry a request itself. A storage reset fails the requests in flight on that object together, and an immediate retry hits the object while it is being reset. A GET is not a read: a program may write on any method, so the method is not a reason to retry. `not_applied` is the reason, and the client is the one that waits and sends the same key again.

### What a program answers

A program answers `STATUS LF BODY` (`respond(status)`, served as `text/plain`) or `STATUS SP TYPE LF BODY`
(`respond_as(status: …, content: Html)`; `Json`, `Text`, `Css`, `Svg`, `Csv`, `Atom`, `Rss` and `Xml` too). The type
is from a closed list; other headers follow the status line, each after a carriage return (`header(name:, value:)`:
`Location`, `cache-control`), and the host refuses those it sets itself (content-type, set-cookie, the security
headers) with a 500 that says why. A first line that is neither form is all body.

A program's HTML or SVG is served sandboxed (`content-security-policy`): no script runs, style is inline, a form
posts to the service's own origin, and an image is one of this origin's (another route of the program that answers
`Svg`: `<img src="chart">`) or a `data:` URL; nothing is loaded from another origin. Atom, RSS and XML
(`application/atom+xml`, `application/rss+xml`, `application/xml`, each with `charset=utf-8`) are documents, not
pages: they take the same policy as JSON. `application/xhtml+xml` is not a type a program can name.

A program reads the request headers the host passes with `header_of`. They are an allow-list: accept,
accept-language, content-type, if-match, if-none-match, if-modified-since, idempotency-key, user-agent, the Standard
Webhooks headers (webhook-id, webhook-timestamp, webhook-signature) and the client's own x-… headers (but not
x-forwarded-… or x-real-ip); never cookie, authorization, the client's address or anything Cloudflare adds. At most
32 are passed, each value cut at 1,024 characters. Before them the host puts one of its own, `tape-base`: the URL
the program's `/` is at, without the last slash (`https://tape.ivar.workers.dev/p/me/hello` on the public route,
`…/me/hello/v/3` on the operator's), so a program writes a link or a redirect to another of its pages as `tape-base`
and the path, wherever it is mounted. A client cannot set it, and a request that does not come through the service
(`tape`, `tape sim`, the hosted runner) has none.

### Public routes

After `PUT /_public/:account/:name {"published": true}` (operator), `/p/:account/:name/<path>` answers GET, HEAD and
POST (a body of at most 64 KB) from anyone, through the latest live version, without a signed trace link (that link
opens the run, and it is the operator's) and without the operator route's `tape-invoke` entry. A public answer still
carries `tape-request-id`, `traceparent` and `tape-outcome`, and a `server-timing` the program itself set. A name that
is not published is answered by the list of published names and never calls the program's object (that 404 has no
`tape-request-id`, `traceparent` or `tape-outcome`), and a request the
route refuses before that call (405, 413) has no `server-timing` from the host. A HEAD is run as the GET it stands
for (the program sees `GET`, and the body is not sent), on this route and every other. The program sees who called:
the request line ends in ` public`, and std/http's `Request(caller: Operator | Anyone)` says so.
For HTML forms, std/http has `form_field(body: …, name: …)` and `write_html(out: …, text: …)` (escaped). `apps/tickets/` is a
box office served this way.

`{"published": false}` takes effect at once: the name's own object checks that it is published in the same call that
runs each public request. The Worker keeps a name's "published" from the account-wide list for up to ten minutes per
isolate, which only saves that lookup; for those ten minutes an unpublished name's object is asked and answers 404 itself.

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
