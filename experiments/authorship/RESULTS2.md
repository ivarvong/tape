# Authorship experiment 2: results

Scored once on the 140 hidden requests, as pre-registered. The submissions, suite and reference are not kept in this
repository; `CHANGE.md` is the change as the agents were given it.

| Arm | Hidden requests right | Harness runs | Compile errors | Lines after (before) | Diff lines | Agent tokens | Wall time |
| --- | --- | --- | --- | --- | --- | --- | --- |
| TypeScript 1 | 140 / 140 | 1 | n/a | 173 (138) | 59 | 69,291 | 38 s |
| TypeScript 2 | 140 / 140 | 1 | n/a | 171 (138) | 53 | 69,916 | 39 s |
| Tape 1 | 140 / 140 | 1 | 0 | 211 (167) | 74 | 86,161 | 60 s |
| Tape 2 | 140 / 140 | 1 | 0 | 201 (167) | 66 | 83,780 | 57 s |

**By the pre-registered rule:** Tape holds up (140 against 140). It does not win; both arms were perfect.

**Cost.** Tape took about 1.2 times the tokens and 1.5 times the wall time, down from 1.4 times both when writing
from scratch in experiment 1. Both Tape agents compiled and passed their own checks on the first run this time.

**What the Tape maintainers reported.**
- Constructor patterns name fields, so adding a fourth field to `Account` broke none of the existing patterns.
- `Bool` worked end to end: SQLite column, SQL parameter, JSON `true`/`false`, pattern.
- The build-time SQL check would have caught a column list they forgot to update. The TypeScript maintainers
  named exactly that as their silent-failure risk: a missed `SELECT` would have rendered `frozen` wrongly.
- Costs: `match` only as the last expression means each added check is a new small function, and a name clash
  between two `frozen` bindings needed a renamed parameter.

**What this does and does not show.** A fresh agent can change 170 lines of someone else's Tape correctly on the
first try, at a modest cost premium. TypeScript was perfect on both experiments, so neither task was hard enough
to separate the languages on correctness. Still untested: larger programs, debugging from traces, and anything
where a silent mistake is likely. n = 2 per arm, one task, one author of spec and reference.
