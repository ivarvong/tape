# Telemetry and profiling

How to see what the `tape` Worker does in production: one request's trace, CPU by version and route, and where the
CPU goes. Every number reported carries its version id (and trace id or profile file). Last checked 2026-11-23 against
tape dddd2c92 and 56539ce5 (profiles, traces).

All scripts are in `service/scripts/obs/`, run from `service/` with Node 25, and call the `cf` CLI (never wrangler) with
the OAuth login: they drop `CLOUDFLARE_API_TOKEN` and need `CLOUDFLARE_ACCOUNT_ID` in the environment (never in a file).
Reading profiles needs `go` (`go tool pprof`). A request is queryable ~10-30 s after it ends.

| I want to… | Run |
| --- | --- |
| see one request | `node scripts/obs/trace.ts <trace id>` or `--latest /v1/run` |
| CPU / wall by version and route | `node scripts/obs/cpu.ts --minutes 30 [--version 93abc6f8] [--route /v1/run] [--ua <prefix>]` |
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
1,000-row cap, and deduplicated by the whole `$metadata` (its `id` is not unique). `--json` writes the rows.

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
- **The profiled isolate serves real traffic too**: a few % of samples can come from other clients' calls.
- **~3-20 % of wall is sampled CPU**; compare profiles only under the same load. For A/B numbers use cpu.ts.
- `compile_ms` in the log reads 0: a Worker's clock does not move during compute. CPU per call is cpuTimeMs.

## Where hosted time goes (2026-11-23, tape dddd2c92)

14 cpu profiles (10 s each; files `service/profiles/dddd2c92-cpu-*`): compile is 81-96 % of the Worker's CPU on every
load; gc ~8 %; rendering, JSON and the runner RPC under 1 % together. Inside compile: lexer `opensSql` 19.8 % (it was
quadratic), `sha256` 11.9 % (its constants were recomputed per call), lex + parse ~31 %. A one-request run (line trace
by default) compiles twice. Fixed in ac74985 (opensSql, sha256); the next steps are one compile for both builds, std's
lex/parse cached per isolate, and a compile cache by content hash.
