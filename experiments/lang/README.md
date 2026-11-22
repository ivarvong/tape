# experiments/lang

The experiments behind [`docs/design.md`](../../docs/design.md), run on 14 November 2026 against a prototype compiler
on a branch that is not part of this repository's history. Most of their scripts are not kept. What is:

- `bugs/`: the program-text defects J2, J3 and J4 as fixtures, before and after their fix (J4 also ported into the
  form a later rule reads); `test/machines.ts` judges them.
- `before/`: the repository's programs as they were before the rules. `test/rules-retries.ts` requires each to be
  refused, and its fixed form accepted. They use forms the language has since removed, which is why
  `proof/same-output.ts` stops on them.
- `port-keys.ts`: moves code written before structured call keys to them, so the tests can judge these fixtures.
- `results.md`: what the experiment printed then: the bug × rule matrix, the rules' self-tests, their findings on
  the 40 programs of the time, and what passing them cost.
