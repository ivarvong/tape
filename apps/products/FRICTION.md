# Friction log: five small products on the hosted service

Written 23 November 2026 while building `shortlinks`, `webhook-inbox`, `sunclock`, `csv2chart` and `ratelimit` (this
directory) against the service at commit 29a0939, from README.md, docs/guide.md, LANGUAGE.md, docs/service.md and
docs/std.md. Ranked by how much each hurt. "Fixed" names the commit in this branch; the service runs them once it
is deployed.

| # | What happened | Minimal repro | Class | Status |
|---|---|---|---|---|
| 1 | The trace page and the OTLP link of any request that loops over a large body answered Cloudflare's 1101. A replay records an event per arm tried: csv2chart's 60 KB CSV made 2,234,855 events, 124 MB of heap, against 128 MB an isolate has. Webhook-inbox's 64 KB box page the same. The same unbounded replay made `node tape.ts prog.tape 'POST /…'` with a 64 KB body run for minutes. The service's `traceLines` was also quadratic (a slice and a search per event). | POST 60 KB of `x` to a program whose `handle` counts bytes recursively; open `tape-trace-url` | bug (host, service) | fixed df1f42b: a replay keeps 100,000 line events and counts the rest; the page says where it stopped |
| 2 | `tape fmt` turned a file that compiled into one that did not: it carried a long text over lines at a space inside a hole, `\(two(n: secs \` / `% 60))`, L05. | a text literal over 100 columns whose last space is inside `\(f(a: x % 60))` | bug (fmt) | fixed 5462927 |
| 3 | `parse_float("")` was `Some(0)`; `" 1"`, `"0x10"`, `"﻿1"` were numbers too (the host's `float_of` was JavaScript's `Number`). sunclock read `?lat=&lon=` as the equator and answered 200. | `parse_float(text: "")` | wrong answer | fixed c45ec03 (host and interpreter); sunclock also checks the bytes itself until that is deployed |
| 4 | Every page answered HEAD with 404 or 400: the program is handed `HEAD`, and no product names it. Link previews and uptime checks send HEAD. | `curl -I …/p/demo/shortlinks/` | bug (service) | fixed 3f2b09d: HEAD runs as GET |
| 5 | `tape sim` could not send to a route whose path holds a refined type (`"/s/" ++ Slug(slug)`) or a split (`++ "/" ++`): "not read", and in 4 of 5 products it sent only `GET /`. | `Request(path: "/s/" ++ Slug(s))` | weak check (sim) | fixed 4a29b60: ratelimit went from 1 path to 3 of 3 answered 2xx |
| 6 | Steps cannot be seen on the deployed service: the OTLP has `tape.memory_bytes` but no step count, and the log has none. Only `POST /v1/run` reports `steps`, and it takes bodies of at most 16 KB, so a 60 KB request's steps are unmeasurable in production. | any request's `otlp_url` | missing feature | **open** |
| 7 | The host passes only `accept`, `content-type`, `if-*`, `idempotency-key` and `x-*` headers. Standard Webhooks (Svix and others) name a delivery `webhook-id`, so webhook-inbox cannot deduplicate those senders by header (it falls back to a body `id`). | `curl -H 'webhook-id: msg_1' …/in/box` twice: two deliveries | missing feature (policy) | **open**: pass `webhook-id`, `webhook-timestamp` (and perhaps `user-agent`) |
| 8 | A program does not know where it is mounted (`/p/demo/<name>/`), so a relative link breaks between `/` and `/s/x`, and every product hard-codes `/p/demo/<name>/`. | `<a href="stats">` on `/s/x` | missing feature | **open**: a request field or header with the base path |
| 9 | "Any JSON" has no public API: validating a body and reading a top-level `id` needed std internals (`json_tree`, `Json_Str`, `json_get`, all marked Internal). `json_tree` of a 64 KB body takes 886 KB (13.6 times the body); calling it twice (validate, then find the id) took 1.5 MB. | `decode` needs a type; there is no `is_json(text)` | missing std function | **open** |
| 10 | A doc example's expected value cannot hold a Float: `//   Some(value: 12.5f)` is C19 in the pattern, so a Float function is tested through `== None` or a whole record left out. | `> number(t: "12.5")` / `Some(value: 12.5f)` | doc tooling gap | **open** |
| 11 | `type Sky { Up(…) Down(…) }` is C03: std's `Rounding` owns `Up` and `Down`. The guide listed only Option, Result, Move, CallError and Wake as names a program cannot take. | `type T { Up }` | doc gap | fixed 1377e08 |
| 12 | fmt layouts that read badly, all in the gate's one layout: a call broken after a carried `\|>` puts its arguments and `)` left of the `\|>` (`std/json.tape` has the same); `let out = respond_as(status: match …) \|> header(…) \|> …` is broken inside brackets instead of before each `\|>`; a CSS literal is carried at its only spaces, leaving 700-column lines. | `out \|> append(view: "<a long text>") \|> …` inside an arm | fmt | **open**: fixing the first re-indents std and the examples |
| 13 | The trap answer is lost locally: `node tape.ts prog.tape 'POST /…'` stops the whole run with `Error: trap 8: float not finite` instead of printing the 500 the service answers. And only `\n` is unescaped in a request argument, so a header needs the shell's `$'\r'`. | csv2chart with `1,1e308` | CLI | **open** |
| 14 | No date formatting in std, and a program on the service is one file, so days-to-civil is written three times (shortlinks, webhook-inbox, sunclock). No `asin`, `acos`, `tan`, `pi` or Float `%` (written from `atan2`, `sqrt`, `sin/cos`, `floor`). | `"\(date(ms: now()))"` | missing std function | **open** |
| 15 | The SQL checker refuses SQLite's `json_valid()` in an invariant (C86, "does not know its type"). | `invariant "…" { SELECT seq FROM d WHERE json_valid(body) = 0 }` | SQL checker | **open** |
| 16 | A public page cannot show an image of its own: the route's CSP is `img-src data:`, so csv2chart's `<img src="demo">` was a broken image (seen in headless Chrome; every status check passed). The chart is now drawn into the page. Likewise an unquoted `rx=6/>` in HTML swallowed the slash and sunclock's bar showed only night: both found only by looking at a screenshot. | `<img src="demo">` on a `/p/…` page | service policy / doc gap | **open**: say so in docs/service.md, or allow `img-src 'self'` |
| 17 | A text literal inside a hole is refused (`"\(times(n, one: "time"))"`, L05). Documented; costs a `let` each time. | as shown | language | by design |

## What went well

- Four of the five programs compiled on the first or second try; ratelimit and csv2chart compiled the first time. The
  refusals that came were each a line with a code and a fix.
- Refined types with `else "…"` gave 400s worth sending as they are: `url: an https:// URL, 12 to 2000 bytes,
  without spaces, quotes or angle brackets`.
- The retry rules were right every time: a slug as the client's key, a delivery's id as `UNIQUE(box, key)`, and in
  ratelimit a count after an idempotency-key claim needed no `repeat: True` (C54 saw the claim) where the bare count
  did. Measured on production: 10 concurrent POSTs of one `x-delivery-id` stored one delivery; 20 concurrent hits
  with `limit=5` let exactly 5 through; 55 concurrent deliveries left 50 rows.
- Float math was exact enough to check against an ephemeris: sunclock's sunrise, sunset, noon, dawn and dusk at
  Greenwich, Sydney and Reykjavik are within the rounding minute of JPL DE440 (the ephem service).
- HTML escaping through `write_html` held: `<script>` in a webhook body, a CSV column name and a chart title all came
  out as text.

## Measurements (production, 23 November 2026)

From here a public request took 0.18 to 0.45 s end to end (a first POST after an upload up to 1.1 s); the Worker's
own `took_ms` was 62 to 100 ms, of which the Durable Object's facet call was about 41 ms for a page with no SQL.
Steps and memory per request, from `POST /v1/run` (bodies of at most 16 KB) and the service's `tape.memory_bytes`:

| Request | Steps | Memory |
|---|---|---|
| shortlinks `POST /links` / `GET /s/<slug>` / `GET /stats` | 255 / 245 / 219 | 992 B / 3.4 KB / 3.4 KB |
| webhook-inbox `POST /in/<box>` (110 B) / the box page (1 delivery) | 299 / 457 | 2.9 KB / 4.6 KB |
| webhook-inbox `POST /in/<box>`, 15 KB / 64 KB body | 23,938 / not measurable (#6) | 208 KB / 886 KB |
| webhook-inbox box page holding 64 KB, 60 KB and 60 KB bodies | not measurable (#6) | 625 KB (one 64 KB body, local) |
| sunclock `/api?…` / its page | 708 / 729 | 5.1 KB / 10.5 KB |
| csv2chart `/demo` / a 15 KB CSV / a 60 KB CSV (3,800 rows, 3 series) | 1,747 / 115,991 / not measurable (#6) | 24.7 KB / 729 KB / 2.75 MB |
| ratelimit `POST /hit/<key>` / `GET /peek/<key>` / the dashboard | 565 / 553 / 102 | 2.3 KB / 2.0 KB / 5.9 KB |
