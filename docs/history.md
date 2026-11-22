# History: what was measured, and what each pass found

Tape was built between 12 and 22 November 2026, before this repository's public history begins. This page keeps
the evidence from that time that is still worth having, condensed from the working notes (a verification ledger of
the deployed service, a root-cause note, a design record and per-pass status notes). Numbers here were measured on
the date given, on code that has changed since; they are records, not claims about the current tree. For those, see
[`STATUS.md`](../STATUS.md).

## Production benchmark on Durable Objects (12 November 2026)

Question, pre-registered with thresholds before any run: on Cloudflare's network, is a Tape Durable Object at least
as fast as idiomatic JavaScript on a key-value workload over SQLite (a benchmark Worker kept outside this repository)?

The run was cut short by a free account's limits (requests per invocation, then rows written per day) after 4
rounds of 2 of the 5 planned cells. Verdict: inconclusive.

| Cell | Rounds | Tape ÷ JS throughput, by round | p50 latency JS / Tape |
|---|---|---|---|
| serial 1 KiB | 4 | 0.96, 0.99, 1.00, 1.07 | 35 / 35 ms |
| serial 16 KiB | 4 | 1.07, 1.70, 0.71, 0.88 | 55 / 54 ms |

Both implementations matched the oracle on every response and row. CPU per call (sampled, integer ms): median JS
4 ms, Tape 6 ms; wall time per call about 38 ms for both. What it says: latency on this workload is bound by
storage, not code, and no speed difference was detectable at this sample size.

## The deployed service (13 to 18 November 2026)

The service was checked against production with numbered checks run by hand with `curl` and scripts; the current
list is [`service/VERIFY.md`](../service/VERIFY.md). What those runs measured:

- **KV write throughput** (15 November, one client location, one Cloudflare location, not a capacity claim): one
  shard stops at about 530 to 680 writes per second, past which the platform sheds load; at 512 requests in flight,
  16 shards gave 4,405 and 4,976 writes per second in two runs (6.6 and 7.3 times one shard), and 4 shards 2.2 to 2.9
  times. A shard under shared load did 275 to 484 writes per second. Runs differed by up to 30 %.
- **Jepsen-style runs against production:** ten KV runs with about 30 % of shard calls faulted (delays, drops, lost
  replies, overload, resets before and after the callee ran) were linearizable per key and clean. Fault runs of the
  fulfillment workflow and the box office (`apps/tickets`) found defects every local check had passed, among them
  the two that led to rule C77 ([`docs/design.md`](design.md#timers-c77-to-c80)).
- **Every fault at every position** (the seams): 180 KV cases and 287 workflow cases in local workerd, every one
  fired, no anomaly. In production the KV cases were clean; the workflow's run found 10 anomalies, which led to a
  fix in the checker (K3) and two recorded gaps, and its re-run did not complete.
- **The defects themselves**, and what they showed about the checks: [`docs/defects.md`](defects.md).

## One command for every check (19 November 2026)

Making one command of every check (`proof/all.ts`) and reading what each printed found five checks that had stopped
checking while everything looked green:

| What | For how long | Why nothing noticed |
|---|---|---|
| The schedule explorer explored 1 schedule, not 484: an example had come to require a client key, and the explorer's requests lacked it. | 4 days | It printed its result and exited 0. |
| The log-replay check had nothing to replay, for the same reason. | 4 days | Same. |
| A program that draws `random(from:)` could replay differently in the simulator: the host took randomness from the machine. | since the simulator existed | The one app tested with it drew randomness only in pages the simulator does not send. |
| One simulator option meant two things, and turning one off broke the other. | hours | No test turned it off. |
| The mutation tool counted any output containing "Error" as a failed check. | unknown | It had not been run with tests that print that word. |

None was a defect in a program or the compiler; each was a check that had stopped checking. Each now fails when it
explores nothing.

## Later passes (19 to 22 November 2026)

- **Invariants, and whether they can fail.** Invariants went from 7 in one file to 61 in 30. A bug was planted
  against each; most are caught by the invariant meant for them ([`STATUS.md`](../STATUS.md)). Doing this found a
  compiler bug (`sql_move` read a condition on another column as part of the row's key, answering `NoRow` for a row
  that was there) and a simulator that never named a row that existed, so two examples had been reported clean
  without ever reaching their main paths.
- **A second application** (`apps/queue`), written from `LANGUAGE.md`, with its friction log.
- **The simulator was not repeatable for short call budgets**: the host timed a call's budget with a real timer, so
  a slow machine changed the run. The simulator now keeps the time itself.
- **A request sent twice.** The simulator now sends one finished request per run again and fails if the rows end
  up different. Two example programs failed and were fixed.
- **The interpreter follows effects.** `interp.ts` ran pure code only; it now runs SQL, calls, timers, the clock,
  random numbers, flags and rollback against a host, and `proof/interp-effects.ts` holds the compiled builds to it.
- **The toolchain in TypeScript.** Every file is typed under `strict`, with no casts, no non-null assertions and no
  `any`. Each large file was rewritten as small functions and run side by side with the old one before the old one
  was deleted (the SQL parser on 63,804 inputs, the SQL checker on 152,680, the Tape parser on 43,681, the lexer on
  23,168, the rules on 22,709 programs); the compiler gave the same bytes for all 63 programs after each step, with
  two changes made on purpose. On the way, thirteen bugs planted in the service were found no longer to match the
  code they edit; that check is now part of the gate.
- **The language at 0.1.** Four things a reader had to be told moved into the language, and the old way of each is
  a compile error: `repeat: True` and `no_floor: True` on a call instead of a comment in its SQL; holes in text;
  one layout; named query values. The plants and the service suite gave the same results before and after.

## Mutation samples (20 November 2026)

Small changes to the code, each run against every test. 40 changes to the rules and the SQL checker: 24 noticed;
of the 16 not noticed, two were real holes and got tests, nine change nothing a program can show (by reading, not
proof) and five were open. 36 changes to lines changed that week: 19 noticed. Both samples were taken on the code
before the TypeScript rewrite and are not a measure of the tests today; [`STATUS.md`](../STATUS.md) has a sample
of the current code.

## Authorship experiments

Two small pre-registered experiments asked whether an agent that has never seen Tape writes, and then changes, a
correct service in it as reliably as in TypeScript. Both arms were close to perfect, so neither task separated the
languages on correctness; Tape cost about 1.2 to 1.4 times the tokens. The pre-registrations, the tasks and the
results are in [`experiments/authorship/`](../experiments/authorship/); the submissions and hidden suites are not
kept.
