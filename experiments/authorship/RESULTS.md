# Authorship experiment 1: results

Scored once on the 74 hidden requests, as pre-registered. The submissions, the hidden suite, the reference and the
scorer are not kept in this repository; `SPEC.md` is the task as the agents were given it.

| Arm | Hidden requests right | Harness runs | Compile errors on the way | Lines | Agent tokens | Wall time |
| --- | --- | --- | --- | --- | --- | --- |
| TypeScript 1 | 74 / 74 | 1 | n/a | 138 | 69,059 | 67 s |
| TypeScript 2 | 74 / 74 | 1 | n/a | 126 | 69,626 | 66 s |
| Tape 1 | 73 / 74 | 3 | 1 | 167 | 99,106 | 99 s |
| Tape 2 | 73 / 74 | 2 | 1 | 161 | 89,788 | 89 s |

**By the pre-registered rule:** Tape holds up (mean 73 against 74, within 3). It does not win.

**The one miss, the same in both Tape runs:** `GET /accounts?` should be 400 and got 200. The standard library's
`request()` gives an empty query for both "no query" and "empty query", so the program cannot tell them apart.
Both agents reported this before scoring. It is a library defect, not an authoring error.

**Cost.** Tape took about 1.4 times the tokens and wall time, one extra harness run or two, and about 25% more lines.
Neither Tape agent had seen the language before; both read the examples first.

**What the Tape authors found hard (their words, summarised).**
- A `Buf` has one owner and every match arm must hand over the same Bufs (error C28). Both hit this as their only
  compile error and restructured to build the response after all lookups.
- `match` only as the last expression makes each decision its own small function.
- `decimal()` rejects leading zeros and more than 16 digits; both wrote their own digit parser.
- `write_json` writes one flat record, so nested output is stitched by hand.

**What worked (their words).** `json(…)` patterns with refined types did all body validation in one arm; prefix
patterns did routing; the compiler's hints fixed the one error directly.

**What this does and does not show.** Two runs per arm; one task chosen by the language's author within what Tape
can do; TypeScript scored perfectly, so the task cannot show Tape ahead on correctness. It shows a fresh agent can
write a correct 160-line Tape service from the examples in under two minutes, at a cost premium, and it found one
library defect. It says nothing about maintenance, larger programs, or debugging with traces, which is where the
language is meant to pay.
