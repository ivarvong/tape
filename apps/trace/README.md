# trace: OTLP traces as SVG waterfalls, written in Tape

`trace.tape` is a pure Tape program. It takes OTLP/JSON, in the form `otlp()` in `service/src/view.ts` produces
(`{resourceSpans:[{resource, scopeSpans:[{spans:[…]}]}]}`, one resource per program), and returns a standalone
`<svg>` waterfall:

```
fn handle(raw: View) -> Buf
```

Tape's own compiler compiles it to Wasm, with std. It runs anywhere the host runs: Node, workerd, the browser.

What the picture shows (Honeycomb/Jaeger-style: one row per span, label column left, time track right):

- A header that leads with what happened: the first row's name and how it answered (its
  `http.response.status_code`, else OK/Error; 4xx amber, 5xx or an error status red); then the trace's
  duration, spans, services, errors and a short trace id (full id in its tooltip; "N traces" when there are
  several); then an inline legend: a swatch, short name and span count per service, and a key to the event
  marks the rows actually use.
- One 26 px row per span, ordered as a tree (each parent, then its children by start time). The label column
  (the first 32%) holds 1 px elbow guides, 14 px a level to twelve levels (deeper rows show their depth), a
  service swatch, the name, and the service when it changes from the row above. Long names are cut at the
  column's edge; the full name is in the tooltip.
- **A call is one row.** A client span whose only child is a server span is drawn with it: the client span as a
  pale envelope in the caller's colour, the server span solid inside it in the callee's, so the visible ends of
  the envelope are the network and queue time. The row's label names the call and the callee's service; the
  server span's children hang from that row; the server bar has its own tooltip. (Chosen over a tight nested row
  because it halves the rows, removes the repeated name, and makes the caller-vs-callee gap something you see
  rather than compute.)
- Service names lose the prefix they all share (`demo/`, `playground/`), up to its last `/`.
- **Idle gaps are compressed.** Where no span is running for a fifth of the trace or more, the gap gets 8% of the
  track, a shaded band, a break mark on the axis and a vertical "1.12 s idle" label. Ticks (1, 2 or 5 × 10ⁿ, at
  least 11% of the track apart) are times since t0 in the first stretch, and "+0.5 ms" since the stretch's
  start after a gap.
- Durations everywhere to three significant digits without trailing zeros (812 ns, 60 µs, 1.12 ms, 2 s), with
  tabular numerals; beside the bar, or inside it when it is wide and there is no room, never running into a
  gap's band.
- Event marks by kind: a tick for SQL (`db.*`), a ring for `tape.timer.set`, a red diamond for an error event
  (`tape.span.missing`, `tape.run.rolled_back`, `tape.check.problem`, `db.prepare.failed`, `exception`), a dot
  for anything else. An event whose time lies outside its span is drawn faint (class `out`) and its tooltip
  says so.
- Errors: a red accent at the row's left edge, a red bar and a red duration, plus the status message in the
  tooltip. Orphans (parent not in the trace) are tagged "orphan" with a dashed bar; spans whose parents form a
  cycle come last, tagged "cycle".
- Rows are focusable (`tabindex="0"`) and highlight on hover and keyboard focus across both columns; `<title>`
  tooltips on every row (name, service, kind, times, ids, status, up to 24 attributes), every callee bar and
  every event mark.
- Theming: colours come from the CSS custom properties `--tr-bg --tr-fg --tr-muted --tr-grid --tr-row-hover
  --tr-error --tr-s1..--tr-s8 --tr-font --tr-mono`, read with fallbacks, so a page that sets them (on any
  ancestor or on the svg) wins. The defaults are light, or dark under `prefers-color-scheme: dark` unless an
  ancestor says `data-theme="light"`, or whenever an ancestor (or the svg) says `data-theme="dark"`. Default
  service colours are chosen to carry white text at AA contrast in light mode and to stay apart for the common
  colour-vision deficiencies; red is reserved for errors.
- Below 560 px: every other tick, ticks after a gap, the gap label, the trace id, legend counts and the event
  key are hidden.
- Input it cannot read gives an SVG that says so: "This is not JSON." (with the byte offset and the text around
  it), "This is not an OTLP trace.", or "This trace has no spans." It never traps on bad input.

The precise rules are in the comments of `trace.tape`; `test.ts` checks every one of them.

How it reads: `checked` validates the whole input as JSON (RFC 8259) in one pass, with an explicit stack of
open containers; it alone decides "This is not JSON." and the byte offset. Then one reader descends straight
into the OTLP shape: a reader per object kind (top, resource, scope, span, status, attribute, AnyValue,
event) takes the members it wants as it passes, recurses into their values, and returns where each value ends;
anything else is skipped once. A repeated key replaces what the earlier one gave, as JSON.parse does.

Geometry: across the page, each row is two nested `<svg>`s, the label column (`width="32%"`, so it clips) and
the track (`x="33%" width="65.5%"`). Inside the track, positions are integer basis points of the track, written
as percentages. Down the page and inside a row, pixels. The root has `width="100%"` and no intrinsic width, so
embed it inline, or in an `<object>`/`<iframe>` with a width. (CSS cannot move the columns at narrow widths:
Chrome ignores CSS `x`/`width` on a nested `<svg>`, checked; so the split is fixed.)

## Running it

Node 25 (`PATH=~/.asdf/installs/nodejs/25.2.1/bin:$PATH`, and `NODE_NO_WARNINGS=1` to hide the SQLite notice):

```
node apps/trace/test.ts             # every gate; exit 1 if one fails (about 2 s)
node apps/trace/test.ts --plants    # 30 planted bugs, each must fail its gate (about 15 s)
node apps/trace/test.ts --max       # the largest synthetic trace within the budget
node apps/trace/fixtures/make.ts    # regenerate fixtures/*.json
node tape.ts fmt --check apps/trace/trace.tape
```

## The gates (test.ts)

The oracle is independent of the renderer. `JSON.parse` reads the input, with the source text of every scalar
(a reviver's `context.source`), so a number is read as it was written. BigInt arithmetic computes, by the rules
above, every row's order, depth, indent, classes, bar x and width, event x, name text, tooltip lines, duration
label, the header and the axis ticks. The SVG is read back by a strict XML reader in the test: XML 1.0
characters, references, quoting, nesting.

| Gate | What it checks |
|---|---|
| compile | `compile()` with std, rules on: no refusal |
| fmt | `format(text) === text` (`tape fmt --check`) |
| fixtures | every fixture, fully: rows equal the TS tree order, with calls paired into one row; exactly one bar per span, x and width within 7 basis points of the track of the exact value under the gap-compressed mapping; `data-depth`, indent, swatch, colour, error and mark classes; every event mark: its kind, its x, and `out` exactly when its time is outside its span; label text with the shared prefix cut; tooltips (the row's and a callee bar's); durations; header title, numbers and legend; axis tick labels and positions; gap bands and their labels |
| event-in-span | every event in every fixture (made by `service/src/view.ts` `otlp()` from real runs) has a time within its span. `TRACE_EVENTS_FROM=<dir>` runs it on other OTLP files (the playground's presets) |
| edges | hand-written cases (cycles, a self-parent, an orphan, repeated ids, equal starts, times past i64, unreadable times, a zero-length trace, 11 services, 20 levels, nesting 2,000 deep, every OTLP key repeated at every level), plus a value 200,000 arrays deep that must leave the picture byte-identical |
| random | 2,000 seeded random documents, each fully checked as above. They include malformed JSON (truncated, inserted bytes, invalid UTF-8, a BOM, trailing bytes, lone surrogate escapes), missing and mistyped fields, zero-length spans, end before start, cycles, repeated ids and keys, raw numbers, control characters, U+FFFE/U+FFFF, emoji and combining marks. In the last run: 1,202 traces (19,641 spans, 3,224 orphans, 1,234 cycle starts) and 798 problem SVGs |
| budget | `big.json` (2,000 spans) costs at most 4 steps a byte of input |

`--plants` applies 37 one-line bugs to a scratch copy of `trace.tape`, one at a time, and checks that the gate
named for each fails. All 37 are caught (7 are for the redesign: a call not paired, gaps not compressed, a gap
the wrong width, the service prefix kept, an event after its span not flagged, SQL marked as any event,
trailing zeros). 22 were written against the first reader: a type error, layout, bars
shifted 0.1%, no least width, an unstable sort, depth counted twice, indent off by one, the wrong colour, an
error class on OK spans, misplaced events, a raw `<`, the wrong `'` reference, control characters let through,
truncation one character late, too many ticks, two-digit durations, time overflow, trailing bytes accepted,
quotes not skipped inside nested values, orphans unmarked, cycles dropped, and a quadratic walk. 8 are for the
one-pass reader: whitespace after a comma not skipped, a repeated `spans` or `resourceSpans` added to instead of
replaced, the second scope dropping the first, the first of a repeated AnyValue kind kept, a plain string read
with its quote, the fourth byte of an unrolled string run not checked, and a resource with no name not called
unknown.

## Fixtures (fixtures/, made by make.ts)

The real fixtures are made by the repository's own code. Each program is compiled by `compiler.ts`, run by the
host (`instantiate`, `runLogged`, `serve`, `wake`) on node SQLite, and makes real calls with real clocks. Each
run is joined with what its callees ran, into the service's `Joined` shape, and turned into OTLP by
`service/src/view.ts` `otlp()` itself. `make.ts` documents the three things it does in place of a Durable Object
(joining calls, and recording a failed callee or a failed request, both as `program.ts` does).

| File | What |
|---|---|
| `hello.json` | `examples/hello.tape`, `GET /hello/ada`: one span with its SQL event |
| `clock.json` | `examples/ratelimit.tape`, three requests: a program that reads `now()`, whose events are timed by it |
| `orders.json` | `examples/orders.tape` → `examples/stock.tape`: client span, callee server span |
| `fulfillment.json` | `examples/fulfillment.tape` → inventory, payments, shipping. Shipping is missing at first: a `tape.span.missing` event, an error and a `tape.timer.set`. 1.1 s later the timer's `woken` run (a consumer span) ships the order |
| `shop.json` | the shop in LANGUAGE.md section 8 → `shop-payments.tape`: one paid order, one refused (error), and the timer run |
| `failure.json` | a callee that traps (`broken-stock.tape`, call refused, run rolled back), a request that traps (`examples/trap.tape`, `tape.run.rolled_back`), and a call to a program that is not there (`tape.span.missing`): three traces in one document |
| `big.json`, `deep.json` | seeded synthetic data: 2,000 spans across 6 services; a chain 300 deep |

Regenerating gives new span ids and times (real clocks), so the files change but their shapes do not. The host
logs times to the microsecond (`at_us`, `took_us`, `sent_us` beside the millisecond fields; host/log.ts
`clockUs`), and `otlp()` uses them when they are there, so the spans have real durations (tens of µs to a
few ms in these fixtures). Every child span lies inside its parent's time, except the timer runs, which come
after, and every event lies inside its span's (the event-in-span gate). In a Worker
the fine clock moves only across I/O, as Date.now() does there, so a run with no I/O still reads 0.

## Numbers

All numbers are on the language at 0.1 with the host's µs span timing, Node 25.2.1,
on the machine this was written on. Times are the best of 20 runs. The step counter (`exports.cost`) counts
entries into recursive functions, a loop's turns among them.

| | first reader | one-pass reader |
|---|---|---|
| Wasm | 68,296 B (22,491 gzip -9) | 78,756 B (24,982 gzip -9) |
| `hello.json` (3,110 B) | 35,374 steps, 11.37 a byte, 0.09 ms | 8,162 steps, 2.62 a byte, 0.06 ms |
| `shop.json` (22,357 B) | 261,015 steps, 11.67 a byte, 0.42 ms | 58,951 steps, 2.64 a byte, 0.21 ms |
| `fulfillment.json` (29,569 B) | 356,985 steps, 12.07 a byte, 0.56 ms | 81,189 steps, 2.75 a byte, 0.25 ms |
| `big.json` (1,261,275 B, 2,000 spans) | 14,413,810 steps, 11.43 a byte, 25.5 ms | 4,459,649 steps, 3.54 a byte, 11.3 ms |
| JSON.parse alone, for reference | | hello 0.01 ms, shop 0.04, fulfillment 0.05, big 1.9 ms |
| largest within the budget | 7,531 spans: traps on the 50 M step limit | 13,000 spans (6.4 MB of OTLP), 28.5 M steps: at 13,031 it runs out of memory first |

Where the steps go on `big.json` now: validation 1.23 M, reading 1.56 M, the tree 0.85 M, writing the
SVG 0.81 M. The first reader spent 11.0 M reading: it found each object's members by scanning their values, and
every level scanned the bytes below it again.

Two changes made up the gain. One pass: each byte is read once by the reader. Scanning strings four bytes a
turn where all four are plain (in the validator, and in the reader's skip and its no-escape fast path): this
cuts loop turns, so both steps and time. The validator is kept as a separate pass, though folding it in would
save about another step a byte, because:
- it alone decides "This is not JSON." and its offset, and invalid JSON anywhere outranks every OTLP problem,
  so a folded reader would still have to scan to the end;
- each of the reader's ~60 functions would need an error arm;
- after the two changes above, the input is already at 3.54 steps a byte, under the target of 4.

The redesign (one row per call, gap compression, the header and legend, event kinds) costs, on `big.json`:
4,597,856 steps (3.65 a byte, was 3.54; the budget is 4), 1,602,984 bytes of SVG (was 1,314,899), and 98,621 B
of Wasm (was 78,756). The extra steps are the sort for the gaps and the legend's scans; the extra bytes are the
two nested `<svg>`s per row. `fulfillment.json`: 81,301 steps, 2.75 a byte (was 81,189).

Screenshots of the fixtures, at 375 and 1280 px, light and dark, in headless Chrome over the raw DevTools
protocol, were looked at by hand (not committed). Timing in a browser has not been measured.
