# Authorship experiment 1 (pre-registered before any agent ran)

**Question.** Does a fresh agent that has never seen Tape write a correct service in Tape as reliably as in TypeScript?

**Task.** SPEC.md in this directory: accounts and transfers over SQLite, 5 routes.

**Arms.** Two fresh agents write `service.tape`; two write `service.ts`. Same model, same spec, same three public
examples, same `try.ts` harness (runs their requests, prints responses, no expected answers). The Tape arm also
gets the language as it stands: README, compiler, standard library and the twelve example programs. No agent sees
the hidden suite or this conversation.

**Hidden suite.** 74 requests in 3 sequences, expected answers from a reference implementation written from the
spec. Fixed before launch; sha256 of suite + reference begins `7c1e61220d3d1230`.

**Primary measure.** Requests answered exactly right, out of 74, on the one submitted file. No feedback, no retry.

**Secondary.** Harness runs used; source lines; what each agent reports as hard.

**What would count.** Tape "holds up" if its mean score is within 3 requests of TypeScript's. It "wins" only if
it is higher in both pairings. Two runs per arm cannot show a small difference; this is a first look.

**Known weaknesses.** n = 2 per arm. The spec was written by the language's author within what Tape can do today
(no arrays in request bodies). The agents share a machine and could read outside their directory; they are told
not to. The reference implementation is JavaScript, written by the same author.
