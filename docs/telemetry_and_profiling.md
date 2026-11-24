# Telemetry and profiling

How to see what the `tape` Worker does in production: one request's trace, CPU by version and route, and where the
CPU goes. Every number reported carries its version id (and trace id or profile file). Last checked 2026-11-23 against
tape dddd2c92 and 56539ce5 (profiles, traces), and 2026-11-24 against 0936bbf2 (public requests).

All scripts are in `service/scripts/obs/`, run from `service/` with Node 25, and call the `cf` CLI (never wrangler) with
the OAuth login: they drop `CLOUDFLARE_API_TOKEN` and need `CLOUDFLARE_ACCOUNT_ID` in the environment (never in a file).
Reading profiles needs `go` (`go tool pprof`). A request is queryable ~10-30 s after it ends.

| I want to… | Run |
| --- | --- |
| see one request | `node scripts/obs/trace.ts <trace id>` or `--latest /v1/run` |
| CPU / wall by version and route | `node scripts/obs/cpu.ts --minutes 30 [--version 93abc6f8] [--route /v1/run] [--ua <prefix>]` |
| where a public request's time goes, cold and warm | `node scripts/obs/public.ts --minutes 30 [--path /p/demo/] [--version 0936bbf2] [--rows]` |
| where the CPU goes | `node scripts/obs/profile.ts <full version uuid> --load fulfillment --runs 3` |
| summarize profiles taken already | `node scripts/obs/profile.ts --read profiles/*.sym.pb` |

## Traces

`observability.traces` is on with `headSamplingRate: 1` (service/cloudflare.config.ts). **Observability is a script
setting, not a version's**: a versions upload plus a ramp (deploy.sh, ship.sh) does not apply it. After abd7729 shipped
that way, `cf workers get tape` still said `traces.enabled: false` and no request had spans (2026-11-23). It takes a
full deploy or a script-settings edit (the full deploy of 6e8031e8 turned traces on), and then applies to every version
at once. `node scripts/observability.ts` compares the live settings with the config's, and ship.sh runs it first: it
stops before uploading when they differ. A full deploy builds with `cf build`, which hangs without
`WRANGLER_DOCKER_BIN=/usr/bin/false` in the environment (ship.sh and deploy.sh set it). The runtime makes the spans: the request (`url.full`, the query, method, status,
`http.request.body.size`, a few request headers, user agent, geo), each `fetch`, R2 and Durable Object call, and each
`jsRpcSession` / `jsRpcCall` (the method name, not its arguments). **A trace carries no request or response body**, so a
posted program is not in it; a program's own route (`/<account>/<name>/…`) and its query string are, as they already
were in the invocation logs. `observability.redactQueryString` would drop query strings from both.

A hosted `/v1/run` on 56539ce5 (trace 207b7a77a8e65871a636da15d885bc57) has four spans: the request (107 ms), its
`jsRpcSession`, the `jsRpcCall` to the program's Dynamic Worker (`jsrpc.method=run`, 106 ms: the run's wall, the only
view of it), and `ratelimit_run` (0 ms). The invocation's cpuTimeMs (279 ms) is the compile; the Dynamic Worker's CPU
is not in it.

`trace.ts` prints the invocation (version, status, cpuTimeMs, wallTimeMs, outcome), the span tree from parent ids, and
the request's log lines (a hosted call's `tape-mcp.call`). Without spans (a version before traces) it says so.

## CPU by version (cpu.ts)

From the `events` view: one row per invocation, grouped by (route, version, status), with CPU and wall p50/p90/p99 and
the CPU sum. Routes: `/`, `/mcp`, `/v1/{compile,run,test,feedback}`, `/playground`, `/mcp/:account`, `/p/:account/…`,
`/t/:account/…`, `/:account/:program…`, and a Durable Object as `DO Name.<methods>`. Each hosted call is joined to its
log line by request id, so `/mcp` is split by tool (`/mcp run`) and `--ua` picks one client (profile.ts's load says
`tape-obs-profile/<load>`). Windows are read in 5-minute slices, split again while a slice comes back at the view's
1,000-row cap, and deduplicated by the whole `$metadata` (its `id` is not unique). `--json` writes the rows. A
call answered from the compile cache (its log line's `cached: true`) is its own route, `/v1/run cached`: the rows of a
route with and without it give the hit rate and what a hit costs. Every hosted call's log line also says its
`isolate` (a random id per isolate) and that isolate's `cache_entries` and `cache_bytes` (counted, bound 8 MiB):
the cache's real occupancy on prod.

## Public requests, cold and warm (public.ts)

A public request is the Worker's invocation and, under it, up to three Durable Object calls: `isPublished` on the
list of published names (not made while the isolate remembers a yes), `invokePublished` on the name's object, which
calls its data (a `fetch` span whose body is the request), and `routed`, after the answer has left (the invocation's
wall time includes it, so wall is not what the client waited: `answer` is). public.ts reads each request's trace and
prints p50 and p95 of each part by Worker version, cold and warm. Cold means the name's object was a new instance
(its trace holds the `CREATE TABLE IF NOT EXISTS _tape_versions` an instance runs once). **An idle object does not
stay warm**: one idle for 30, 50, 75, 100, 140 or 200 s was started again by the next request, one idle for 15 s was
not (tape 0936bbf2, 24 November 2026), and the list's object and the data's loaded code go with it. So at low
traffic most requests are cold ones, and a deploy only makes every name cold at once.

**A Durable Object's span times do not show its CPU.** Its clock stands still while code runs, so spans inside an
object are stamped as if compute took no time: a cold `invokePublished` whose spans covered 206 ms had `wallTimeMs`
401 and `cpuTimeMs` 201 (trace 3c6a86317d551b3de60a380d2cb4902c). Read CPU from the object's invocation
(`cpuTimeMs`), and durations from the caller's side (the Worker's `jsRpcCall`).

Where a cold request's time went on tape 0936bbf2 (207 requests to /p/demo/*, 05:47 to 06:25 UTC, 24 November
2026: 82 cold, 122 warm; p50 / p95 in ms). Cold: answer 476 / 808; the list 15 / 158 (it is cold too when
everything has been idle); reaching the object's first line 128 / 188 (no code of ours runs: the platform starts
the object, and the Worker's module is evaluated if the isolate is new, which the upload measured as "Worker Startup
Time: 65 ms"); the object's CPU 172 / 358 (1 ms warm); its call to its data 105 / 211, of which fetching the builds
was 47 / 122 (the 67 requests that fetched them). Warm: answer 35 / 59, of which the call to the data 19 / 26 (the
run and its log made durable), the two hops to the object and back about 13, the list 0 / 17, and 1 to 2 ms of
clock timers (spans.ts `fresh`).

What was cut after that measurement, each to be measured again on the version that ships it: the module no longer
decodes sql.js's Wasm when it starts (53 to 19 ms of top-level evaluation in Node 25); the object reads its builds
from its own rows instead of fetching each (the 47 / 122 ms); it keeps the machines of its live versions instead of
parsing every live version's source (most of the 172 / 358 ms of CPU: 88 to 198 with one live version, 176 to 459
with four); and the Worker remembers "published" for ten minutes, not 30 s. The same four in local workerd (`vite
preview` of the built Worker, a new process for each start, so the name's object and its data's code are cold; the
module's start is not in it; n=15 starts each, first request p50 / p95): csv2chart with four live versions 424 / 587
ms on 1e318ed and 67 / 174 ms after; with one live version 149 / 285 and 52 / 68; the request after it 15 ms on
both. What is left of a cold start is the platform's start of two objects, the Loader's start of the data's code
(about 35 ms and 10 more per live version, both builds of each: retiring old versions is what shortens it) and the
same durable log write a warm request waits for.

## Profiles (profile.ts)

`cf workers versions profile <uuid> --worker-id tape --profile-type cpu|heap --duration-ms N` returns raw pprof. It
needs an isolate executing when the capture lands (`No recent executions` otherwise), so profile.ts starts its load 4 s
early, keeps it going through the capture, and retries 4 times. The load is 0.7 requests/s, under the hosted routes'
60 a minute per client (back-to-back runs above that see 429s). Loads: `hello`, `hello-lines` (the default line trace),
`hello50` (50 requests), `fulfillment`, `kv`, `compile-hello`, `compile-kv`, `compile-fulfillment`. Pass the full
version uuid so a concurrent deploy can't move the capture to another build.

Files go to `service/profiles/` (gitignored): `<v8>-<type>-<load>-<time>.pb`, `.sym.pb` and `.load.txt` (status, the
version that answered, time per request). Then it prints `go tool pprof -top` and the hosted buckets (pprof.ts
`bucketOf`): compile, the traced build's compile, sha256 inside either, line trace / OTLP / effects / result rendering,
JSON, the runner RPC, gc, runtime.

```sh
go tool pprof -top -cum -nodecount=40 profiles/<file>.sym.pb
go tool pprof -peek 'opensSql' profiles/<file>.sym.pb     # callers and callees
go tool pprof -http=: profiles/<file>.sym.pb              # flame graph
```

- **Names.** The bundle keeps function names, and Cloudflare applies the uploaded source map, so frames read
  `compileFn ../compiler/function.ts:61` (paths relative to service/). An arrow function has no name; its line is its
  definition line, so `.sym.pb` names it from the source there (`ownership.at.<anon>`).
- **What a profile cannot see: a program's run.** Programs run in a Dynamic Worker (LOADER, mcp/src/index.ts), another
  isolate with no telemetry of its own: no events under any service name, nothing in this profile, and not in the tape
  invocation's cpuTimeMs (50 requests cost the same CPU as one). Its Wasm keeps a name section (compiler/gen/assemble.ts
  `nameSection`), so a local Node profile of the runner names Tape functions. Its wall is the log line's `run_ms`.
  What we report of it ourselves: its tail (`RunTail`, mcp/src/tail.ts, attached with `tails` on LOADER.get) logs one
  `{"event": "tape-mcp.run", run_id, method, outcome, cpu_ms, wall_ms, exceptions}` line per invocation, and the
  call's own line has the same `run_id` and the Wasm memories its isolate held at the end (`program_bytes`,
  `sqlite_bytes`; the platform reports no memory for it), and `inflight`, the hosted calls its isolate was serving
  when it began. No tail line appeared in the local workerd suite (mcp/test), so the tail is checked on prod.
- **The profiled isolate serves real traffic too**: a few % of samples can come from other clients' calls.
- **~3-20 % of wall is sampled CPU**; compare profiles only under the same load. For A/B numbers use cpu.ts.
- `compile_ms` in the log reads 0: a Worker's clock does not move during compute. CPU per call is cpuTimeMs.

## What a client can read of a request's cost

True CPU time is not measurable in the request that is still running. `Date.now` and `performance.now` advance only
across I/O, so a duration taken inside the isolate that is doing the compute reads 0. `scheduler.wait(0)` does not
refresh that clock: a 0 ms timer renewed nothing in production, and a 1 ms timer (`fresh` in service/src/spans.ts)
renewed some starts and not others. The platform's CPU time (`cpuTimeMs` on an invocation, `cpu_ms` on a Dynamic
Worker's tail) is delivered after the response has been sent, so it cannot be written on that response. A profile
of the isolate, and CPU on the spans, are follow-ups; neither is on the response.

What a client gets is the caller's wait, in whole milliseconds. It is a wall-clock reading. The child's CPU is
inside that wait, because the caller is suspended on the RPC, and so is everything else the caller waited for.
A difference of 1 ms is the resolution, not a measured change in the program. A 0 is a wait under 1 ms.

- `POST /v1/run` and the MCP `run` tool put `invoke_wall_ms` on the JSON (mcp/src/index.ts measures it, mcp/src/tools.ts
  checks it is a whole number). It is `Date.now` immediately before the Dynamic Worker RPC minus `Date.now` when that
  RPC returns, after the loader calls, so a compile that happened earlier is not in it. The invocation runs every
  request in the call, then each replay, then a line trace when one was made, so the number is one for the call and
  not one per request. `steps` on each result stays the per-request measure, and it is deterministic. The log line's
  `run_ms` is a wider window: it starts before the loader calls, and on Workers it can include earlier CPU during
  which the clock was stuck. In Node, where the tools run the program in process and the clock does advance during
  compute, `invoke_wall_ms` is that process's wait. A fraction from a caller is dropped rather than shown.
- A program's HTTP response, the operator's `/:account/:name/v/:version/…` and a published name's `/p/:account/:name/…`,
  carries `server-timing: tape-invoke;desc="caller-wall-ms-not-cpu";dur=<ms>` (service/src/programs.ts `programTiming`).
  `<ms>` is the router's `invoke` span, from `begin` to `done`, and `done` is after the body has been buffered, so
  the number is the wait for the Durable Object call and its body: the object's CPU, its SQLite, the RPC, and the
  object's work before it replies. A 404 from the list of published names never calls the object and has no header.
  The same span can read high when the isolate's clock was stale at `begin` and the 1 ms refresh did not catch up
  (two calls that arrived 13 ms apart at a busy shard both read a start 140 ms before either was sent).

Neither number is `cpuTimeMs`. `invoke_wall_ms` is already the whole call, so a sum of it across that call's results counts the wait once per result.

## Where hosted time goes (2026-11-23, tape dddd2c92)

14 cpu profiles (10 s each; files `service/profiles/dddd2c92-cpu-*`): compile is 81-96 % of the Worker's CPU on every
load; gc ~8 %; rendering, JSON and the runner RPC under 1 % together. Inside compile: lexer `opensSql` 19.8 % (it was
quadratic), `sha256` 11.9 % (its constants were recomputed per call), lex + parse ~31 %. A one-request run (line trace
by default) compiles twice. What came of it, the same 14 loads on 56539ce5 (opensSql, sha256, one compile for both
builds) against dddd2c92, cpuTimeMs p50: hello-lines 262 → 118 ms, fulfillment 401 → 253, compile-kv 360 → 177, hello
133 → 85, hello50 164 → 92, compile-hello 100 → 90. Since then: std's tokens kept per isolate, a compile cache by
content (8 MiB counted per isolate; in its first 90 minutes on prod one client's calls spread over 10 isolates and
14% of compiles hit), and allocation per compile cut 11-13% (the inliner, the build name's hash).

Memory (Node 25; measured 2026-11-23): an isolate holds ~15 MB at rest, 1.8 MB of std's tokens and at most 8 MiB of
kept builds; one compile needs ~2-16 MB live beyond that (the smallest old space a compile completes in: hello 15 MB,
tickets.tape with its traced build 31 MB) and allocates 66-190 MB, most of it collected young. A program's Dynamic
Worker holds sql.js's 16 MiB heap (its minimum: sql.js keeps a 5 MB stack, so it cannot start under ~5.1 MB without
being built again; started at 6 MiB it grew to 6-9 MiB on the bench's SQL loads, but cost 12-38% more CPU on crud and
ledger, so it stays) and the program's memory (2 pages, 128 KiB, on every run so far).
