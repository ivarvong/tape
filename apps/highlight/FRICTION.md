# Friction log: writing a Tape syntax highlighter in Tape

Written while building `apps/highlight/highlight.tape` on 21 November 2026, from `LANGUAGE.md`,
`std/*.tape`, `examples/words.tape` and `examples/csv.tape`, with `compiler/lex.ts` as the definition of a token.
The program is a pure `handle(raw: View) -> Buf` of about 400 lines: a byte-at-a-time lexer that writes HTML.
The writer is an agent, not a newcomer, and it read the compiler's lexer first.

**It compiled, and passed `tape fmt --check`, on the first try.** There were no refusals to log. The entries below
are about what was awkward, what was missing, the limits found by measuring, and the tooling around the language.
No compiler or runtime bug was found: the program agrees with `compiler/lex.ts` on every one of the 158,141 spans
in 129 files, and on 6,000 generated sources (`test.ts`).

| # | What | Class | Resolution |
|---|---|---|---|
| 1 | No byte or character literals. Every comparison is against an ASCII code: `ch == 34` for `"`, `92` for `\`, `123` for `{`, and the operator table is 21 arms of numbers (`single`). There is no hex literal either (`192` for `0xC0`). This was the largest readability cost in the program, and the place a wrong digit would hide. | missing feature | numbers with comments where it mattered. **Open**: a byte literal (`'"'`, or `b"\""`) would remove most of the magic numbers |
| 2 | A Buf can be at most half of memory. With 64 MB, the output Buf grows by doubling, so the largest output that fits is 32 MB: the highlighter handles 5,657,152 bytes of source (33,553,302 bytes out, 24.8 M steps: half the step budget) and traps with "out of memory" at 5,658,160 bytes. The memory limit binds long before the step limit. | limit (runtime) | measured with `test.ts --max`; recorded. A program that knows its output size cannot ask for it up front (no `buf(capacity)`) |
| 3 | A stack is costly. lex.ts keeps a stack of open brackets (a `)` or `]` on top means a line break is not a token). A `List[Int]` would allocate, and any allocation after the output Buf stops it growing in place (`compiler/gen/runtime.ts`: only the last thing in the arena grows where it is), so growing it would mean copying it (not measured: a List version was not built). | workaround | the stack is one `Int`, a bit per bracket, plus a depth. **Deliberate difference**: past 63 open brackets the oldest bits are lost; no file in the repository comes close |
| 4 | A match condition cannot bind what it computed. `ch == 47 and next == 47 -> scan(at: find(…), out: span(…, to: find(…)))` calls `find` twice; `keyword_at` calls `upper_end` three times. A block arm (`-> { let end = … }`) can bind for the result, but not for the condition. | missing feature (mild) | recomputed; the highlighter costs 4.4 steps per byte on the corpus; how much of that is recomputation is not measured. A guard that binds (`decimal(n)`-style patterns do this for one-parameter functions) would fix it |
| 5 | `std/text.tape`'s `find` gives `len(v)` when the byte is absent; `std/core.tape`'s `find_text` gives `-1`. Two conventions for "not found". | inconsistency (std) | read both before using either |
| 6 | No `is_alpha`, `is_upper`, `is_space` or `min`/`max` in std (only `is_digit` and `is_hex`). | missing (std) | `letter`, `word_byte`, `upper` written here; `words.tape` has its own `letter` too |
| 7 | The step count is not reachable from the host's documented API. It is the exported global `cost` (`compiler/gen/assemble.ts`), read as `app.exports.cost.value`; found by reading the compiler. | missing (host) | read the global; `test.ts` and the page report it |
| 8 | lex.ts's tokens carry a line, not an offset or a column, so "same token boundaries" cannot be checked by position. | tooling | `test.ts` compares the token sequence (kind, value and line, in order) and checks that every byte outside a span is white space |
| 9 | The old playground could not be built any more: it pasted `compiler.ts` into a function body, and since the compiler was split into `compiler/*.ts` the page it wrote had `import` lines and TypeScript annotations inside that function, which no browser runs. | bug (playground) | superseded: `apps/playground` replaced it. `serve.ts` here serves the tree's `.ts` files with `node:module`'s `stripTypeScriptTypes`, so the browser loads `compiler.ts` and follows its imports: no bundle, nothing generated |
| 10 | Whether a `{` starts SQL depends on the last few tokens (lex.ts `opensSql`: `migration` among the last four, or an `invariant "name"` that began the line at most nine tokens back, counting line-break tokens). That is context a highlighter has to replay exactly. | language (lexical context) | replayed in `Scan` (`mig`, `inv`, `last`). Planting an off-by-one (`mig <= 2`) is caught by the lexer-agreement gate alone. LANGUAGE.md section 2 does not say this rule |

## Deliberate differences from compiler/lex.ts

- Comments are spans (`c`); lex.ts drops them. The test checks each is `//` to the end of its line.
- The ten contextual words (from LANGUAGE.md, read by the test) are class `w` wherever they stand; lex.ts makes
  them plain names. A variable called `read` is coloured as the word.
- A text literal that starts like a statement (`SELECT `, `INSERT `, …) is `s q`, with `sk` spans on capitalised
  words inside. It is still one `s` token.
- After an error lex.ts stops; the highlighter marks it (`x`, `s x`, `e x`, `q x`) and goes on. For a source
  lex.ts refuses, the test checks that the first marked span is the kind refused (L01 to L06; a refused number is `n x`), on the line lex.ts
  reports.
- The bracket stack past 63 levels (entry 3).

## What went well

- Text patterns in `match` made the word tables trivial: `match w { "fn" -> True … _ -> False }`.
- Tail calls held up: a 1 MB comment and a 1 MB text literal (one token each) run in 3 and 2 steps per byte,
  with no stack growth.
- The program is fast where it runs: 4 MB of source in about 70 ms in Node, the 14 KB highlighter itself in
  0.5 ms in Chrome.
- The compiler ran unchanged in a browser from its own source files. Compiling the highlighter with std takes
  about 30 ms there.

## 22 November 2026: brought up to the current lexer (the language at 0.1)

On the tree just before 0.1, two gates failed: `tape fmt --check` (the new 100-column layout) and lexer agreement (782 problems), all
from two additions to the language: a backslash at the end of a line carries a text literal on to the next line, and
a hole, `"Hello, \(name)"`, puts an expression inside a text. Then 0.1 named SQL placeholders (`:id`).

- Text literals: `text_end` steps over `\` + line break; the backslash is an `e` span, the line break and the next
  line's indentation stay inside the literal's span (they are inside the token).
- Holes: `hole_end` balances parentheses from `\(` and stops, as lex.ts does, at a line break, a double quote or the
  end (refused: L05, marked `h x`). The inside is scanned by `scan` as a program of its own, over a slice, with a
  fresh state (lex.ts lexes it with a fresh `lex()`); the output is `<span class="h">`, the two delimiters `hd`, and
  the expression's own spans between them. A literal with a hole is not a `str` token, so it does not count as the
  name of an `invariant "…"` for the SQL rule (`literal_kind`).
- `|>` at the start of a line: lex.ts takes the line break token back (`sc.toks.pop()`). The highlighter did not, so
  its count of tokens since `migration` was one too many after such a line (`migration x` / `|> y {` is SQL to lex.ts,
  was not to the highlighter). `Scan` now keeps `held`, what `inv` was before the line break, and `piped` restores
  it. No file in the corpus hit this; the fuzz could (`'\n|> '` is a fragment now).
- `:name` placeholders get their own class, `sp`, in SQL blocks and in statement texts: a colon and a name, not after
  a word byte or another colon (so `a:b` and `::` are not placeholders), outside quoted SQL text in blocks.
- test.ts: the oracle reads `interp` tokens (text parts compared with the decoded literal split at the `h` spans;
  each hole's spans compared with the tokens lex.ts made of it, recursively), takes a text literal's line from its
  last byte (lex.ts gives it the line it ends on), and maps L05 to `h`. Six edge cases and six plants added.

Results at 0.1: all 6 gates pass (132 files, 864,610 bytes, 170,320 spans, fuzz 6,000 sources); all 13 plants
caught, each by the gate it is meant for. The 1 MB text literal costs 3.00 steps a byte, up from 2.00: `holed` scans
a literal a second time to decide its token kind (it could be folded into `text_end`; not done).

| # | What | Class | Resolution |
|---|---|---|---|
| 11 | lex.ts gives a text literal carried over lines the line it ends on, and an L01 inside a hole the line 1 (the hole is lexed as a source of its own, and its error is not moved to the hole's line). | bug (compiler, lines in messages) | the gate follows lex.ts for the first and keeps refused bytes out of holes in the fuzz for the second. Not fixed (outside) |
| 12 | Nothing in LANGUAGE.md section 2 says that a line starting with `|>` takes back the line break before it, at the token level; it matters to any tool that counts tokens (the SQL rule does). | language (lexical context) | replayed in `Scan.held` |
