# Friction log: writing an OTLP trace renderer in Tape

Written while building `apps/trace/trace.tape` on 22 November 2026. Work started on the tree just before the
language's 0.1, and everything below was re-checked at 0.1. The program is a pure `handle(raw: View) -> Buf` of
about 1,800 lines. It reads OTLP/JSON by hand, builds the span tree and writes an SVG. The writer is an agent
that read LANGUAGE.md, std and `apps/highlight/` first.

**The first full draft compiled on the first try.** The planted-bug gates and the random
gate found the bugs. Five of them were integer overflow, which wraps without a word (entries 5 and 6).

| # | What | Class | Resolution |
|---|---|---|---|
| 1 | **`decode(json:, as:)` cannot read OTLP.** It needs an object's keys to be exactly a constructor's fields, so a key the type does not name (`"scope"`, `"flags"`, `"droppedAttributesCount"`, `"traceState"`) refuses the whole document: `resourceSpans[0]: scopeSpans[0]: unknown key "scope"`. LANGUAGE.md 0.1 says this is intended ("A field the type does not have is refused"). OTLP producers add fields freely, and `doubleValue` is a float, which no type can hold. Two smaller points: decode runs in the host (`JSON.parse` in `host/memory.ts`), so its work is not counted in steps, and a browser host has to supply it. Nested lists and a sum type for the attribute union (`S(stringValue) I(intValue) B(boolValue)`) did decode fine. | language (by design) | **A hand-written reader.** `checked` validates the JSON (RFC 8259) in one pass, with an explicit stack of open containers. `members`/`pick` then read only the fields wanted, the last of a repeated key first, as `JSON.parse` does. It is built on std's `json_text`, `json_ws` and `number_end`. **Fixed** since: `decode` leaves a key the type does not name unread, instead of refusing the body (docs/changes.md, 23 November 2026; LANGUAGE.md section 9), and reads the JSON in the module (std/json.tape), counted in steps. Re-checked 25 November 2026 at cd94d8c: a body with an unknown key at the top and inside a list item decodes |
| 2 | **std `json_value` runs out of call stack on nesting.** `array_end` → `element` → `json_value` recurses once per level, so `[[[…]]]` 4,000 deep (8 KB) ends the request with `RangeError: Maximum call stack size exceeded`. 2,000 deep works. That is a trap on small, valid input, and LANGUAGE.md section 10 does not list stack exhaustion among the ways a program stops. Repro: `fn handle(raw: View) -> Buf { match json_value(v: raw, at: 0) { JsonValue(next) -> buf() |> append(view: "ok \(next)")  BadValue -> buf() |> append(view: "bad") } }`, fed 4,000 `[` then 4,000 `]`. `json_first`/`json_next` go through the same `object_end`/`array_end`. | bug (std, and an undocumented trap) | not fixed (out of scope). trace.tape skips values with a depth counter (`nested_end`). The gate renders a fixture with a value 200,000 arrays deep under an unread key, and the output must be byte-identical to the render without it |
| 3 | **`tape fmt` writes a program the compiler refuses.** When it carries a long text over lines, it can break inside a `\( )` hole: `"…d=\"M\(px) \(top + \` / `36 * row + 32)V…"`. The result is L05 ("a \( hole … is not closed"). Repro: `fn f(out: Buf, px: Int, top: Int, y: Int, row: Int) -> Buf { out |> append(view: "<svg x=\"4%\" overflow=\"visible\"><path class=\"guide\" d=\"M\(px) \(top + 36 * row + 32)V\(y + 11)H\(px + 7)\"/></svg>") }`. Run `tape fmt` on it, then compile. Reproduced just before 0.1 and at 0.1. | bug (fmt) | worked around: the text is split into two `append`s and the long sum is bound with `let` |
| 4 | **No record update.** Changing one field of a 6-field record (the reader's `Acc`) means taking it apart and building it again: `let Acc(spans, n, colors, services, color) = acc` then `Acc(spans, n, colors, services, service: name, color)`. A 14-field `Span` is built once, from a list of the object's members, so as not to rebuild it once per member. | missing feature (mild) | destructure and rebuild. Leaving out fields in `let Acc(...)` made this bearable |
| 5 | **Overflow wraps silently, and the gates found it five times.** (a) `mant * pow * 10 >= d` overflows for a trace about 292 years long (times are i64 ns). The tick step became 1 ns, the tick loop allocated until "out of memory". (b) `(d + 9) / 10` has the same problem. (c) Rounding as `(d + unit / 2) / unit` overflows near i64 max. (d) `t0 + d` for clamping an event. (e) The tick loop's `k * step > d`. Each was found by the random gate (inputs with `"9223372036854775807"`) and showed up as a trap or as wrong text. Integer-only geometry is fine. Silent wrap is what makes it hard. | language (by design: "Overflow wraps") | rewritten as division and remainder (`rounded`, `tenth_up`, offsets kept relative to t0). An add-with-overflow check, or a trap on overflow, would have found these at once |
| 6 | **A runaway loop is reported by what it ran out of first.** Bug 5a ended in `trap 1: out of memory`, and the `step_of` loop with a negative bound ended in `trap 2: reduction budget exceeded`. Neither says where it was. | tooling | found by bisecting the input. A trap that named the function it was in would have saved the bisecting |
| 7 | **`match` cannot be an argument (C40).** So every `if` becomes a function: `max`, `min`, `plural`, `odd`, `anchor`, `error_class`, `mark_class`, `lower`, `tenths`, `span_of` and more, about 30 one-arm helpers. std still has no `min`/`max` (highlight FRICTION #6). | language | helpers. Short, but they spread a picture's layout rules across many small functions |
| 8 | **Text literals have no `\u` escape.** U+FFFD had to be typed as the character itself (`"�"`). There are no byte literals either (highlight #1): the JSON reader compares against 34, 44, 58, 91, 93, 123, 125. | missing feature | literal character, comments, numbers |
| 9 | **`Map` keys are text only.** Telling the span tree "seen" for a span number means `decimal_text(value: idx)`, a small allocation per lookup and insert. | missing (std) | as described; the tree costs about 7% of the steps |
| 10 | **The step counter is `exports.cost`**, found in the highlighter's notes (highlight #7). | missing (host) | read the global |
| 11 | **`tape fmt` (0.1) folds a call back onto one line once it fits.** Not a problem, but re-running fmt after the 0.1 change rewrote 87 lines of trace.tape. A program in "the one layout" is only that for one compiler version. | tooling | re-ran fmt; the fmt gate catches drift |

## Second round (22 November 2026, same day): the one-pass reader and µs timing

| # | What | Class | Resolution |
|---|---|---|---|
| 12 | **The step counter counts entries into recursive functions, a loop's turns among them.** It does not count bytes or calls of non-recursive functions. std's `json_text` reads a string one turn of `text_end` per character, and the `json_char` call inside is free. So a faster string scan with the same number of turns (a byte-level fast path) changed the step count by exactly 0 while the time fell. Only fewer turns (four plain bytes a turn) moved it. Fair enough as fuel, but "steps a byte" is a measure of loop turns, not of work. | tooling (measure) | the README says what the counter counts. Both steps and ms are reported |
| 13 | **No record update, again, at 14 fields.** The one-pass reader folds a span's members into a `Span` one at a time. Each field needs a rebuild: `with_text`/`with_int` take the span apart and build it again, with one field replaced. | missing feature | setters selected by a field number, about 60 lines. A `Span { ..s, name: x }` would remove them |
| 14 | **A fold that returns a value and a position needs a function per step.** Each reader returns `Got[T](value, next)`. The loop that consumes it can't bind both and recurse in one expression (no `match` as an argument, and a `let` of a record field is a step), so every member kind has a little `*_read` function: `span_text`, `resources_read`, `scope_read` and others, about 20 in all. | language | as described. A generic record (`type Got[T]`) worked first time |
| 15 | **Folding validation into the reader was possible but not worth it.** Invalid JSON anywhere must outrank any OTLP problem, so a folded reader would still scan to the end. Each of about 60 reader functions would need an error arm. And the unrolled separate validator is 1.0 step a byte. | design | kept separate (README "Numbers") |

## Third round (22 November 2026): the redesign

| # | What | Class | Resolution |
|---|---|---|---|
| 16 | **`tape fmt` broke inside a hole again** (entry 3): `y2=\"\(top - \` / `1).5\"`, then L05. Same bug, new line. | bug (fmt) | the sum bound with `let rule = top - 1` |
| 17 | **No bitwise or that reads safely next to `|>`.** I wanted `kinds | bit` for a set of event kinds and was not sure `|` parses beside the pipe, so it is `with_bit` (an `&` test and an add). | missing / unclear | a helper |
| 18 | **`Option` in a record field just worked**: `Frame(…, pair: Option[Span])`, matched with `Some(value)`/`None`; nested patterns `Cons(head: k, tail: Nil)` in a guard arm too. | went well | |

## Decisions that are not Tape's friction

- **Layout in percentages.** Positions across the page are basis points of the width (`x="12.34%"`). Down the
  page they are pixels. Tree guides are drawn in a nested `<svg x="4%">` so they can be in pixels from the
  track's edge. The same SVG then fills 375 px and 1280 px with no horizontal scroll, and the text stays the
  same size. The price: the root `<svg>` has `width="100%"` and no intrinsic width. Embed it inline or in a
  sized box, not as a bare `<img>` with no width.
- **One row per span, two columns** (redesign): the label column is its own nested `<svg>` per row, so a long
  name is clipped at the column edge rather than budgeted in characters. The split is fixed (32% / 65.5%):
  Chrome ignores CSS `x`/`width` on a nested `<svg>` (checked over CDP), so a media query cannot move it.
- **Zero-length spans are common in real Tape traces.** A run cannot time itself (see `UNMEASURED` in
  service/src/view.ts), so most callee spans are 0 ns and every event of a run sits at its start. Bars have a
  least width of 0.30%, and coincident events overlap.

## What went well

- Tail calls carried everything: the validator, the reader, the depth-first walk (an explicit stack, so 300- or
  20,000-deep trees cost no Wasm stack) and the writer. No loop needed a workaround.
- Patterns on text made the enum tables trivial (`"SPAN_KIND_CLIENT" -> 3`). Holes in `append` keep the SVG
  writer readable (`"<rect … y=\"\(y + 20)\" …"`).
- std's JSON pieces (`json_text` with its UTF-8 and surrogate checks, `number_end`) were exactly the right
  grain to build a different reader on.
