# Small products

Ten programs written as a user would, each one file, served on the hosted service under the `demo` account and published
at `https://tape.ivar.workers.dev/p/demo/<name>/`. What got in the way while writing them is in
[`FRICTION.md`](FRICTION.md).

| Product | What it is | Shows |
|---|---|---|
| [`shortlinks/`](shortlinks/shortlinks.tape) | Short names for https links; each link shows its destination before you follow it, counts visits, and has a stats page. | refined `Url`/`Slug` with `else "…"` 400 messages, the slug as the client's key (`ON CONFLICT DO NOTHING`, 200 on a retry, 409 on a clash), a counter with `repeat: True`, dates from the clock |
| [`webhook-inbox/`](webhook-inbox/webhook-inbox.tape) | POST any JSON (up to 64 KB) to `/in/<box>`; `/box/<box>` lists the last 50 pretty-printed and escaped, `/api/<box>` as JSON. | dedup by `idempotency-key`/`x-delivery-id`/`x-webhook-id`/`x-request-id` or a top-level `id` (`UNIQUE(box, key)`), a byte-loop JSON pretty-printer that holds no stack, pruning to 50 rows, `Entropy` for `/new` |
| [`sunclock/`](sunclock/sunclock.tape) | Sunrise, sunset, civil twilight and day length for `?lat=&lon=` (and `date=`, `tz=`), as a page with an SVG day bar and as JSON. | NOAA's solar equations in `Float` (sin, cos, atan2, sqrt, floor), polar day and night, dates both ways; within a minute of JPL DE440 at Greenwich, Sydney and Reykjavik |
| [`csv2chart/`](csv2chart/csv2chart.tape) | POST a CSV, get an SVG line chart (axes, nice ticks, legend, gaps); `GET /demo` draws a sample. | a quoted-field CSV reader, 1-2-5 tick steps written exactly from Ints, labels through `write_html`, content type `Svg` |
| [`ratelimit/`](ratelimit/ratelimit.tape) | Fixed-window rate limiting as a service: `POST /hit/<key>?limit=&window=`, `X-RateLimit-*` headers, 429 with `Retry-After`, a refreshing dashboard. | `repeat: True` for a count meant to grow, an idempotency-key claim before the count (no flag needed after it), an invariant that a window never counts past its limit |

| [`pastebin/`](pastebin/pastebin.tape) | Post text, get a short id and an escaped HTML page; deleted by a timer after 24 hours (or `?minutes=N`). | a timer set in the same commit, content-hash ids |
| [`poll/`](poll/poll.tape) | JSON-made polls, one vote per voter key, results as bars or JSON, a vote form that posts and redirects. | a claim-first vote, rollback on a bad option, 303 redirects |
| [`countdown/`](countdown/countdown.tape) | A countdown page computed from `now()` at each load. | a Float ring (sin, cos), a Dec of days left, dates parsed in Tape |
| [`ledger/`](ledger/ledger.tape) | Double-entry play money: transfers keyed by client id, balances with a floor, CSV exports. | `Dec[2]`, rollback on a short balance, invariants, CSV-injection-safe cells |
| [`status/`](status/status.tape) | Components and incidents, an HTML page, `status.json` and a JSON Feed; only the operator writes. | machines moved by `sql_move`, a maintenance window ended by a timer |
