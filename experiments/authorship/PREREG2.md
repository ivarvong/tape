# Authorship experiment 2: changing someone else's code (pre-registered before any agent ran)

**Question.** Does a fresh agent change an existing Tape service as reliably as an existing TypeScript one?

**Task.** CHANGE.md: add a field to every account, three routes, a new refusal rule with a place in the order of
checks, and two query forms. It touches the schema, every response and most handlers.

**Starting code.** Experiment 1's submissions (not kept in this repository): the first Tape one (with three lines adapted to the new
optional query in std, after which it passes all 74 of experiment 1's requests) and the first TypeScript one (74/74).
Neither agent wrote the code it is given.

**Arms.** Two fresh agents per language, same model, same documents, same harness, no hidden suite, no feedback.

**Hidden suite.** 140 requests in 6 sequences: experiment 1's 74 as regression (with the new account shape) and
66 for the change. Fixed before launch; sha256 of suite + reference begins `2e9583e79d5f0ef4`. Before the change, both
starting services score 0 of the regression requests that return an account, by construction.

**Primary measure.** Requests right out of 140 on the one submitted file.

**Secondary.** Harness runs, lines changed, tokens, time, what was hard.

**What would count.** Tape holds up if its mean is within 5 requests of TypeScript's; it wins only if higher in
both pairings.

**Known weaknesses.** n = 2 per arm; one task; the same author wrote the spec, the change and the reference; a
160-line service is small, so this says little about maintaining large programs.
