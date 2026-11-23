# Tape against JavaScript: where it loses, and why

Measurement and attribution only; compiler, host and std are unchanged. Commit `9d50390` (main, 2026-11-22), plus
the new files in `bench/suite/`. Machine: Apple M3 Max (16 cores, 48 GB), macOS (Darwin 25.5), Node 25.2.1
(V8 14.1.146.11-node.14); SQLite in memory through `node:sqlite` (`nodesql.ts`, the same stand-in on both sides);
workerd 2026-11-13 for the workerd rows. The machine was shared with other agents' test suites (load average 7–12
during the main run). To keep that load off the ratios, the three ways take turns request by request inside one
process (`one.ts all`), so a burst lands on all of them alike. Expect single times to move ±10%; ratios moved
about ±0.05 between runs.

Each number is per request, at sizes where one request costs 1–100 ms of JS. The `hello` and `cart` numbers are a
footnote at the end.

## Summary

- **Tape beats JS on 2 of 6 workloads at full tier:** csv (0.57×, 1.8× faster) and the OTLP→SVG trace (0.86×).
  Both are pure Wasm, with no host crossings per item.
- **It loses on the three SQL APIs, 1.33–1.79×,** and the loss is almost all host boundary, not Wasm. In webhook, the
  host's JSON decode is 31 ms against JS's 4.3 ms `JSON.parse`, and SQL marshalling costs 0.9–1.3 µs per statement
  on top of SQLite's own 1.8–2.7 µs. Wasm is only 5–9% of those requests.
- **It loses on words, 3.35×, in its own code:** 47% of the time is std/map's byte-at-a-time key compare.
- **Low tiers widen every gap.** With `--liftoff-only`, csv goes 0.57→2.12×, trace 0.86→3.23× and words
  3.35→13.75×. A cold first request in Node and in workerd already tiers up within the request (csv cold 0.59×,
  workerd first request 0.61×), but a prod isolate is unmeasured.
- **There are hard limits JS doesn't have.** The 10,000-span trace runs out of Tape's 64 MB (about 16 bytes of arena
  per input byte; some 5,000-span traces trap too), and the 50,000,000-step budget stops csv at about 7.8 MB and
  words at about 3.6 MB.

## The table

tape/js per request. Medians of 30 requests after 10 warm-up; cold is the median of 10 fresh processes. The first
ratio is Tape with the log on (as shipped); the one in brackets is log off. Run at commit 9d50390, Node 25.2.1, M3
Max.

| workload | js ms (opt) | opt | maglev | liftoff | baseline | 1thread | cold |
|---|---|---|---|---|---|---|---|
| crud (2,000 items) | 8.30 | **1.33** (1.29) | 1.46 (1.40) | 1.48 (1.44) | 1.97 (1.96) | 1.35 (1.30) | 1.78 (1.70) |
| ledger (2,000 transfers) | 16.8 | **1.68** (1.60) | 1.81 (1.69) | 1.81 (1.72) | 2.16 (2.01) | 1.64 (1.62) | 1.87 (1.72) |
| webhook (10,000 events, 2 MB) | 51.4 | **1.79** (1.70) | 1.92 (1.81) | 2.07 (1.99) | 2.31 (2.21) | 1.77 (1.67) | 1.88 (1.76) |
| trace (big.json, 2,000 spans) | 13.1 | **0.86** (0.87) | 0.82 (0.82) | 3.23 (3.21) | 2.36 (2.36) | 0.79 (0.78) | 1.42 (1.42) |
| csv (2 MB) | 25.4 | **0.57** (0.56) | 0.48 (0.48) | 2.12 (2.13) | 1.31 (1.30) | 0.56 (0.56) | 0.59 (0.58) |
| words (2 MB) | 29.0 | **3.35** (3.34) | 3.28 (3.27) | 13.75 (14.74) | 9.92 (9.96) | 3.64 (3.64) | 2.68 (2.67) |

Cold, broken down as compile + instantiate + request (Tape, log on): crud 0.12 + 0.85 + 19.3 ms; ledger
0.11 + 1.23 + 38.7; webhook 0.12 + 0.93 + 110; trace 0.25 + 0.33 + 31.0; csv 0.12 + 0.37 + 19.1; words
0.12 + 0.36 + 105. Module compile and instantiation (which runs the schema) are ≤1.5 ms everywhere. At these sizes
the fixed per-request setup does not matter. Cold is the warm ratio plus first-run JIT on both sides.

**Size sweep** (opt tier, medians of 15). The ratio is flat from 1 ms to 100 ms of JS. Fixed costs stop mattering
by about 1 ms, and what remains is per item.

| workload | request | js ms | tape ms | tape/js (log off) |
|---|---|---|---|---|
| crud ×0.1 | 200 items, 14 KB | 0.91 | 1.28 | 1.42 (1.34) |
| crud ×1 | 2,000 items, 145 KB | 8.20 | 10.8 | 1.32 (1.30) |
| crud ×10 | 20,000 items, 1.5 MB | 84.6 | 115 | 1.36 (1.30) |
| csv ×0.05 | 100 KB | 1.35 | 0.78 | 0.58 (0.56) |
| csv ×0.5 | 1 MB | 13.8 | 7.44 | 0.54 (0.54) |
| csv ×3 | 6 MB | 91.0 | 43.0 | 0.47 (0.48) |
| trace ×0.25 | 500 spans, 316 KB | 3.48 | 2.93 | 0.84 (0.82) |
| trace ×1 | 2,000 spans, 1.26 MB | 13.4 | 11.7 | 0.87 (0.88) |
| trace ×2.5 | 5,000 spans, 3.2 MB | 34.1 | trap: out of memory | – |
| trace ×5 | 10,000 spans, 6.3 MB | 133 | trap: out of memory | – |

csv at 8 MB and above, and words at 4 MB and above, trap with "reduction budget exceeded": the 50,000,000-step
limit. Measured with `limit`-style single runs: csv 6 MB takes 38.5 M steps, words 2 MB takes 28.7 M.

**workerd** (local, `node bench/suite/workerd.ts`). Pure workloads only. Times are fetch round trips minus an
empty fetch, because the clock does not move inside workerd. warm = the median of 30 after 10; first = the first
request in a fresh workerd process, median of 5.

| workload | warm js | warm tape | tape/js | first js | first tape | tape/js |
|---|---|---|---|---|---|---|
| csv | 27.9 ms | 17.6 ms | 0.63 | 34.1 | 20.8 | 0.61 |
| words | 31.2 | 107.8 | 3.46 | 33.3 | 114.1 | 3.43 |
| trace | 8.82 | 13.0 | 1.48 | 18.7 | 32.1 | 1.72 |

A second run after the lint pass, with the machine more loaded, gave the same picture: csv 0.53 (first 0.57), words 3.15 (3.22), trace 1.52 (1.57).

trace is a win in Node (0.86×) and a loss in workerd (1.48×). The JS port is faster in workerd (8.8 vs 13.1 ms,
mostly its TextEncoder of the 1.6 MB output); Tape is about the same (13.0 vs 11.3). The SQL workloads were not run
in workerd, because that needs Durable Object SQLite: `ctx.storage.sql` costs are not measured here.

## The suite

`node bench/suite/check.ts` checks for the same answers. `node bench/suite/run.ts` prints the table (about 6 min;
`--quick` takes about 2). Six workloads, each a Tape program and an idiomatic JS twin doing the same work over the
same kind of database. Answers are checked byte for byte on ≥100 generated inputs each: valid, invalid, repeated
keys, unicode, edge cases.

| workload | Tape | JS twin | one request (scale 1) | same answers |
|---|---|---|---|---|
| crud | `bench/suite/crud.tape` | `crud-js.ts` | POST of 2,000 items (145 KB): decode and validate each, INSERT each (dedupe by key), SELECT the totals and the 2,000 rows, encode them (104 KB) | 110 inputs, 0 differ |
| ledger | `ledger.tape` | `ledger-js.ts` | POST of 2,000 transfers (136 KB): for each, a key lookup, a payee check, a guarded debit and credit (CAS) and an insert; 4.6 statements each | 102, 0 differ |
| webhook | `webhook.tape` | `webhook-js.ts` | POST of 10,000 events (2.0 MB): decode and validate, dedupe by id (`INSERT … ON CONFLICT DO NOTHING`), route by kind to 0–2 more statements | 102, 0 differ |
| trace | `apps/trace/trace.tape` | `trace-js.ts` (a faithful port, 1,000 lines) | `apps/trace/fixtures/big.json` (1.26 MB, 2,000 spans; `trace-gen.ts` reproduces it byte for byte at k = 0) → a 1.6 MB SVG | 108 (8 fixtures + 100 generated), 0 differ; the port was also checked on 6,352 mutated or malformed inputs, 0 differ |
| csv | `examples/csv.tape` | `bench/csv-baseline.ts` | 2 MB of CSV aggregated by country | 124, 0 differ |
| words | `examples/words.tape` | `wordsJs` in `pure.ts` (regex + Map + sort) | 2 MB of prose → word counts in byte order | 107, 0 differ |

**Ways:**
- **js:** the twin, in a transaction.
- **tape:** log on (`runLogged`), as the service runs it.
- **tape-nolog:** `{ log: false }` (`handleIn`).

**Tiers** (V8 flags; each measurement runs in its own process):
- **opt:** V8's defaults.
- **maglev:** `--max-opt=2`.
- **liftoff:** `--liftoff-only`.
- **baseline:** `--max-opt=1 --liftoff-only`, i.e. Sparkplug JS and Liftoff Wasm, what a young isolate runs.
- **1thread:** `--single-threaded`.

**cold:** the first request of a fresh process, median of 10 processes. For Tape that is `new WebAssembly.Module`
from the stored bytes, instantiation, the schema, then the request. For JS it is the schema, then the request.

Other tools:
- `attribute.ts`: buckets and counts.
- `profile.ts`: V8 CPU profile of the timed requests, by bucket and function.
- `variants.ts`: builds with the compiler's existing `reductions: false` option.
- `workerd.ts`: csv, words and trace in workerd. Run it with `--bin` pointing at a directory holding `workerd` and
  `esbuild`.

## Attribution: where Tape's extra time goes, per item

`node bench/suite/attribute.ts <workload>` wraps the module's imports as it is instantiated (WebAssembly.Instance is
replaced in that process; host/ is not touched), the database's `exec`, and JSON.parse/stringify (charged to the env
call they run inside). The wrappers cost 5–10% (instrumented vs plain, both shown). `node bench/suite/profile.ts
<workload> <way>` takes a V8 CPU profile (50 µs sampling, the timed requests only) and sums self time by bucket.
Numbers: opt tier, scale 1, medians of 20 requests, commit 9d50390.

### crud: 2,000 items per request. JS 8.2 ms, Tape 11.2 ms (log on), 10.5 ms (log off)

| bucket (Tape, log on) | ms | share | calls | per item |
|---|---|---|---|---|
| env.sql: the database itself (db.exec) | 5.32 | 43% | 2,002 | 2.7 µs |
| env.sql: params, rows, log entry (host marshalling) | 2.63 | 21% | 2,002 | 1.3 µs |
| env.sql: JSON.stringify of params for the log | 0.29 | 2% | 2,002 | 0.15 µs |
| env.json: shape check + copy into memory | 1.97 | 16% | 2,001 | 1.0 µs |
| env.json: JSON.parse (body, then each element again) | 1.03 | 8% | 2,001 | 0.5 µs |
| env.json: JSON.stringify (each element handed on) | 0.22 | 2% | 2,000 | 0.1 µs |
| Wasm (validate, loop, write_rows encode of 2,000 rows) | 0.99 | 8% | | 0.5 µs |

JS twin: database 5.05 ms (61%), JSON.parse 0.39, JSON.stringify 0.82, the rest 2.07. Host crossings per item: 2
(one env.json for the element, one env.sql for the INSERT), plus 3 per request. The database costs both sides the
same (5.3 vs 5.1 ms). Tape's extra ≈ 3 ms is all host boundary: JSON decode (3.2 ms vs JS's 0.4 ms parse + its
validation) and SQL marshalling (2.9 ms). Wasm is 9%: Tape's encode of 2,000 rows inside Wasm (in the 0.99 ms) is
cheaper than JS's JSON.stringify (0.82 ms) plus row objects.

### ledger: 2,000 transfers per request (9,257 statements). JS 16.5 ms, Tape 29.0 ms (log on), 25.4 ms (log off)

| bucket (Tape, log on) | ms | share | calls | per statement |
|---|---|---|---|---|
| env.sql: the database (db.exec) | 17.2 | 53% | 9,257 | 1.86 µs |
| env.sql: params, rows, log entry | 9.57 | 30% | 9,257 | 1.03 µs |
| env.sql: JSON.stringify of params (log) | 0.95 | 3% | 9,257 | 0.10 µs |
| env.json (all) | 2.98 | 9% | 2,001 | 1.5 µs per transfer |
| Wasm | 1.64 | 5% | | |

JS: database 15.5 ms (87%), JSON 0.7, the rest 1.7. Profile (tape-log): `readParams` alone is 8.6% of the request's
self time, plus TextDecoder (`decode`, `decodeUTF8`) for every text parameter (each transfer binds key, from, to
3–4 times). Log on vs off: +3.6 ms (+14%), i.e. 0.39 µs per statement.

### webhook: 10,000 events per request (2.0 MB, 23,550 statements). JS 49 ms, Tape 93.7 ms (log on), 84.1 ms (log off)

| bucket (Tape, log on) | ms | share | calls | per event |
|---|---|---|---|---|
| env.sql: the database (db.exec) | 41.4 | 39% | 23,550 | |
| env.sql: params, rows, log entry | 21.4 | 20% | 23,550 | 0.91 µs per statement |
| env.sql: JSON.stringify of params (log) | 3.4 | 3% | 23,550 | |
| env.json: shape check + copy into memory | 17.5 | 16% | 10,001 | 1.75 µs |
| env.json: JSON.parse (2 MB body, then each element again) | 10.2 | 10% | 10,001 | 1.0 µs |
| env.json: JSON.stringify of each element, to hand it on | 3.7 | 3% | 10,000 | 0.37 µs |
| Wasm (splitting the handed-on elements at `\n`, routing, results) | 9.8 | 9% | | 1.0 µs |

JS: database 35.8 ms (68%), JSON.parse 4.3 ms (8%), JSON.stringify 1.1, the rest 11.6. So: Tape's JSON decode is
31.4 ms against JS's 4.3 ms of JSON.parse (plus a few ms of its validation): 7×. How it works today (host/memory.ts
decodeJson, std/json.tape wire_each): JSON.parse of the whole body; for a list field each element is
JSON.stringify'd back to text, joined with `\n` and copied into memory; Wasm splits that text at `\n` (profile:
`find_text` + `same_from` 6% of the request) and calls env.json again for each element, which runs TextDecoder and
JSON.parse on it a second time and writes its fields. Every element byte is UTF-8-decoded twice, parsed twice,
serialised once and copied twice. The database is 41 vs 36 ms (Tape runs `q.run`, with `CAST(?n AS INTEGER)`, and
reads `raw()` rows; about +15%).

### words: 2 MB of text. JS 27 ms, Tape 92 ms (3.3×); --liftoff-only 13.75×

Pure Wasm (99% of samples). Profile: `before_from` 47% (std/map.tape: key comparison one byte per recursive call),
`put` 13%, `node` 10%, `height` 8%, `balance` 6%, `word_end` 6%, `get` 5%. Each word does a `get` and a `put`,
each comparing twice per tree level (`before(key, k)` then `before(k, key)`), ~12 levels for 5,000 distinct words,
and `put` rebuilds the path even when the key is already there. JS uses a hash Map. Step metering is 3.5% here.

### trace: big.json (1.26 MB, 2,000 spans). JS 12.5 ms, Tape 11.5 ms (0.92×) in Node; workerd 1.48×

Pure Wasm (92%). JSON is read byte by byte in Wasm (`json_ws` 14%, `string_valid` 7.8%, `plain_end` 3.5%,
`chars` 1.5%: about 30% of the request, ≈3.4 ms for 1.26 MB ≈ 2.7 ms/MB, against JSON.parse's 1.4 ms/MB in the
twin), `before_from` 13.9% (the span-id Map), `write_xml` 4.6%. Step metering is 12%. Memory: 20 MB of arena for a
1.26 MB trace (16 bytes per input byte); 5,000 spans (3.2 MB) needs 54 MB and 6,000 trap at the 64 MB limit, so the
10,000-span trace Ivar asked for cannot run at all.

### csv: 2 MB. Tape 0.53× (wins), but 2.0× under --liftoff-only

Step metering is 13%. The CSV row loop is the tightest code in the suite and the most sensitive to Wasm tier:
Liftoff makes it 3.8× slower. The 50,000,000-step budget stops it at ~7.8 MB (8 MB traps).

## The top 5 optimisations, ranked by expected gain

Each estimate is "the measured bucket minus what replaces it", at the scale-1 sizes, opt tier, commit 9d50390.

### 1. Decode JSON once, inside Wasm (or in one host pass)

**Expected gain:** webhook −25 to −30 ms of 92 (1.79× → about 1.25×); crud −2.5 ms of 11 (1.33× → about 1.05×);
ledger −2.3 ms of 28 (1.68× → about 1.55×).

**Evidence:**
- env.json costs 31.4 ms in webhook, against 4.3 ms of `JSON.parse` for the JS twin. It is 3.2 ms in crud and 3.0
  ms in ledger.
- The cost has four parts: the body parsed and UTF-8 decoded twice, each element re-stringified (3.7 ms), shape
  check plus copy (17.5 ms), and the Wasm-side `\n` split (`find_text` + `same_from`, 6% of the profile).
- What replaces it: trace.tape already parses JSON byte by byte in Wasm at about 2.7 ms/MB, about 2× JSON.parse's
  1.4 ms/MB. That would be about 5.5 ms for webhook's 2 MB, with no second decode, no re-stringify and no copy.
- The cheaper interim fix is a host decode that writes a list's elements straight into memory in one pass. That
  removes the re-stringify, the second parse and the split, about 18 ms in webhook.

**Serves 0.3 (exact JSON numbers): yes, and it is the route that does.** A decoder in Wasm reads a number from its
source text, as trace.tape already does for i64 times (up to 2^63 − 1, kept exact). The host's JSON.parse path
rounds anything past 2^53 and cannot tell `2.0` from `2`.

### 2. Cheaper SQL host calls (parameters, rows and the log entry)

**Expected gain, measured:** ledger −11.6% (log on) and −6.5% (log off); webhook −7.7% / −3.0%; crud −4.1% /
−0.6%. Fixing more of the 0.9–1.3 µs per statement should give more.

**Evidence:**
- Host marshalling costs 1.03 µs per statement in ledger (9.6 ms of 28) and 0.91 µs in webhook (21.4 ms). SQLite
  itself costs 1.86 µs.
- In the ledger profile, `readParams` is 8.6% of self time. Most of the rest is TextDecoder (`decode`,
  `decodeUTF8`): every text parameter goes through a fatal TextDecoder on a fresh subarray. A new DataView is made
  per call (`view()`, 1.9%), and `JSON.stringify(p)` runs eagerly for the log's replay comparison.
- The measurement comes from a scratch copy of host/ (scratchpad, not committed), A/B per request against the real
  one, with the same answers. The patch:
  - reads ASCII text parameters of ≤64 bytes directly;
  - caches the DataView and the Uint8Array;
  - makes the log's `JSON.stringify(p)` lazy.
- Next steps: write the rows without `cellText` sizing, and pass all parameters as one block.
- This bucket also contains the effect log's cost. Log on vs off is +7% crud, +14% ledger and +11% webhook (0.36–0.39
  µs per statement), and the lazy stringify removed most of it.

**Serves 0.3: partly.** `readParams` and `int()` refuse anything outside ±2^53 today. Exact numbers need an i64
(BigInt or two-word) path here, and the rewrite is the moment to add it.

### 3. std Map: one three-way byte compare per tree level, done as an intrinsic

**Expected gain:** words −35 to −45% (97 → about 55 ms; 3.35× → about 1.9×); trace −10%.

**Evidence:**
- In the words profile, `before_from` (std/map.tape, one byte per recursive call) is 47% of self time. `put` is
  13%, `node` 10%, `height` 8% and `balance` 6%.
- `get` and `put` call `before` twice per level, `before(key, k)` and then `before(k, key)`. That is about 24
  compares per word at 5,000 distinct words. `put` also rebuilds the path when the key is already there, which is
  the common case for word counts.
- A compare that returns −1/0/1 over bytes, done as a loop over 8-byte words or a builtin, halves the compares and
  removes the per-byte calls.
- In trace, `before_from` is 13.9% (the span-id Map).
- Matching JS's hash Map would need a hash map in std; that is not estimated here.

**Serves 0.3:** no.

### 4. Meter steps per loop, not per function entry

**Expected gain, measured as the bound:** csv −13%, trace −12%, words −3.5%, SQL workloads −1 to −2%.

**Evidence:**
- `variants.ts` builds each program with the compiler's existing `reductions: false` option and alternates the two
  builds per request in one process.
- Every function entry adds to and compares a global (compiler/function.ts:37). Counting at tail-call back-edges
  and loop heads, or in bulk per straight-line function, keeps the budget's meaning and recovers most of this.
- Related capability limits:
  - The same budget (50 M steps) stops csv at about 7.8 MB and words at about 3.6 MB.
  - Trace uses 16 bytes of arena per input byte, so the 10,000-span trace exceeds 64 MB.
  - A JS handler has neither limit. Raising the step budget for proportional-cost programs, and making the trace
    arena smaller, are what let those requests run at all.

**Serves 0.3:** no.

### 5. Get Wasm out of Liftoff sooner (measure in prod first)

**Expected gain:** unknown until prod data exists. The bound is large: csv 2.12× vs 0.57×, trace 3.23× vs 0.86×,
words 13.75× vs 3.35×.

**Evidence:**
- Under `--liftoff-only`, Tape loses every workload. JS at its baseline tier loses only 1.2–1.7× of its own speed,
  while Tape's Wasm loses 3.7–4.4×.
- Locally this does not bite. Dynamic tier-up happens inside the first 2 MB request: csv cold is 0.59× in Node and
  0.61× in workerd.
- On short-lived prod isolates it might: the mpl-web notes (lab_notebook/2026-11-06-mpl-web-deploy.md) show young
  isolates running hot code in low tiers.
- Next step: read `cf o11y` CPU time per request for a Tape program on prod and compare it with these local numbers.
  If it is closer to the liftoff column, look at eager tier-up for hot functions: compile hints, or warming the
  module at isolate start, which mpl-web tried and found slower end to end.

**Serves 0.3:** no.

**Not in the top 5:** module compile and instantiation (≤1.5 ms, under 3% at these sizes), the request copy-in and
answer copy-out (under 1%), and the Wasm compute of the SQL workloads (5–9%).

## Footnote: the small benchmarks (same commit and machine, re-measured)

- `bench/cart.ts`: 1 line 5.34×, 10 lines 3.97×, 100 lines 2.89× (110.7 vs 38.3 µs). This is the fixed cost of a
  sub-ms request plus the env.json path above.
- `bench/hello.ts`: 2.42× by hand (11.5 vs 4.8 µs; log on 2.44×).
- `bench/csv.ts`: 0.51–0.57× (1 MB: 7.6 vs 15.0 ms).
