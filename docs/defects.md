# Defects found, and what they say about the checks

A condensed record of every defect found while Tape and its service were built (13 to 18 November 2026), each
traced to its mechanism and to the layer of checking that should have caught it. Defect ids (J1, R7, S2, …) are the
ones code comments and [`service/RUNTIME-SPEC.md`](../service/RUNTIME-SPEC.md) cite. The original note was much
longer, with the commit that introduced and fixed each defect; those commits predate this repository's public
history, so they are left out.

## The question

The defects of the first week, taken together, were suspected to show one gap in how the system was checked rather
than many unrelated mistakes. To test that, each defect was traced to the code path, the invariant it broke, the
layer that should have caught it, and why that layer did not.

The layers that existed then:

| Layer | What it checks |
|---|---|
| L1 tests in `test/`, doc examples (`tape test`) | hand-written examples, compiler and host in Node |
| L2 `proof/verify.ts` | a reference interpreter against the compiled builds on generated programs; memory release |
| L3 `proof/schedule.ts`, `proof/mutate.ts` | every schedule of a small keyed-call scenario; sampled mutation of compiler and host |
| L4 `proof/replay-logs.ts` | effect logs replay identically under three builds |
| L5 the service's tests in local workerd | routes, uploads, migrations, calls |
| L6 Jepsen-style harnesses (`service/jepsen/`) | state conservation, per-key linearizability, then trace structure |
| L7 checks against the deployed service ([`service/VERIFY.md`](../service/VERIFY.md)) | the deployed system, by hand-run scripts |

## The gaps

Each defect with a known mechanism was assigned one primary gap.

| Gap | Definition | Defects |
|---|---|---|
| G1 The environment model omits Durable Object semantics | Tests did not model the frozen clock, broken stubs after a reset, a reset cutting a stream, or eviction before a post-reply timer | O1, R1, R3 |
| G2 Oracles check outcomes, not the system's own records | Checkers read state and answers; logs, traces and joins were not checked as data | R2, R4, R6, R9, O2, O3, O4, C9 |
| G3 No written invariant specification independent of the implementation | Tests asserted what the code did | J3, R5, R7, R8, R11, M1, M2, M4 |
| G4 Faults injected only at chosen seams | The transport, client hop, storage and object-to-object hop were not faulted | J1, J5 |
| G5 Local workerd differs from production | Clock, latency and network behaviour | R10, P1 |
| G6 The checkers are themselves unchecked | Exit codes, checker rules and test assumptions were never tested | T1, R12 |
| G7 Workload and generator coverage | Generated inputs never reach the faulty construct | C1 to C8, M3 |
| G8 No model checking of protocols | Concurrent interleavings of keys, compare-and-set and caches were not explored | J2, J4 |

Of the first 38 defects, 36 have a determined mechanism. 27 of the 36 sit in G1 to G6 and G8: the system had been
checked against the implementation's own model of its environment and of what correct means. 8 of the 9 G7
defects were caught by layers that already existed and reached no user. Two measurements made for the note:
local workerd advanced `Date.now()` by 39 ms across a synchronous loop where production reads 0 ms (n = 1), and
deleting each of the trace checker's 53 rules in turn left every checker test passing for 30 of them.

## What was built because of it

| Recommendation | What exists now |
|---|---|
| A written invariant specification, with checkers that cite it | [`service/RUNTIME-SPEC.md`](../service/RUNTIME-SPEC.md): each property has an id, and each checker rule names the one it enforces |
| Mutation testing of every checker | `service/verify/mutate/`: every reporting site of the checkers, disabled in turn, must be caught by their self-test |
| Faults at every position | `service/jepsen/seams.ts`: every fault at every position on the call path, one at a time |
| Model checking of the call protocols | `service/model/`: the once-key, KV and wipe protocols explored exhaustively within small bounds, with planted bugs |
| Language rules for the defects in program text | rules C51 to C88 ([`docs/design.md`](design.md)) |
| Production differential runs on every deploy | not built |

## The defects

### The first 38 (13 and 14 November 2026)

| Id | Gap | Defect |
|---|---|---|
| J1 | G4 | A transport exception was treated as a refusal. Its shape in a program, a write or a call on an arm that takes a refusal and no answer together, is C87 since 25 November 2026. |
| J2 | G8 | Seats were released twice. |
| J3 | G3 | Stale notes appeared on finished orders. |
| J4 | G8 | An existing order answered 404 (the phantom 404). |
| J5 | G4 | A reset mid-run surfaced as a raw exception, and a late failure as an unhandled rejection. |
| R1 | G1 | The router's record was lost after a callee reset. |
| R2 | G2 | A reset in flight erased the record of a committed write. |
| R3 | G1 | A reply body was cut off mid-stream. |
| R4 | G2 | A trapping program answered 503 and left no trace. |
| R5 | G3 | The record of a served call was written after the reply. |
| R6 | G2 | Two runs were joined to one shared call row. |
| R7 | G3 | An unconditional write retried after a lost reply was applied twice. |
| R8 | G3 | A router kept a stale cluster size after a 421. |
| R9 | G2 | Call span starts were estimated. |
| R10 | G5 | A busy Durable Object began a call on a stale clock. |
| R11 | G3 | The answer to a reused op id depended on the hash. |
| R12 | G6 | The trace checker itself had four errors. |
| C1 | G7 | Generic functions were not counted against the step budget. |
| C2 | G7 | A field read inside a function value captured the whole record. |
| C3 | G7 | A field read gave no type to infer a generic call from. |
| C4 | G7 | An argument to a function value was compiled as a tail call. |
| C5 | G7 | A nested case left out of a match was accepted. |
| C6 | G7 | The Wasm did not validate when a program's only JSON use was a call reply. |
| C7 | G7 | An exported function named like a std function (`put`) did not compile. |
| C8 | G7 | `parseProgram` had no migrations list. |
| C9 | G2 | A trace pointed at the wrong line for a form that fell through. |
| M1 | G3 | Additive-only migrations were not enforced. |
| M2 | G3 | Destructive changes were detected by keyword. |
| M3 | G7 | Migrations ran before schema statements on a fresh name. |
| M4 | G3 | The upload check judged statements, not data. |
| O1 | G1 | Callee spans read 0 ms. |
| O2 | G2 | Client span starts were drawn from the request's start. |
| O3 | G2 | Served and tool calls were rendered as root spans. |
| O4 | G2 | `ask` spans did not join their callee. |
| T1 | G6 | Several test files exited 0 on failure. |
| P1 | G5 | A 50 ms call budget in `tickets.tape` timed out in production. |
| U1 | undetermined | 3 untraced status-0 attempts in production KV runs. |
| U2 | undetermined | One flaky service test, not reproduced. |

Three hazards were recorded as latent, with no harness that reached them: gap 21 (ids reused after a lost
insert), gap 22 (a callee that itself calls is not exactly-once under concurrent sends of one key) and gap 23
(creations took no client key). Gap 23 was closed by rule C55. Gap 22 was reproduced on 21 November 2026 and
closed on 22 November: a keyed run claims its key in its first stretch, and an overlapping send waits for its reply
(`proof/schedule.ts`, overlapping sends).

### Found by the checks built after it (15 to 18 November 2026)

| Id | Found by | Defect |
|---|---|---|
| S1 | fault seams | A failed cluster lookup answered "a shard stopped", outcome unknown, with no trace. |
| S3 | production soak | A Durable Object storage reset before the run's log began was rethrown (`program.ts` `#failed`). The Worker answered 503 `outcome: unknown` with no `tape-request-id` and no `traceparent`, so a client could not tell whether a PUT had been kept or correlate the five failures (0.02% of 23,653 requests). |
| S2 | fault seams | A callee whose commit failed answered Rejected, so its caller compensated and a racing retry then paid. |
| H1 | production | An injected reset did not stop the invocation in production; the run went on and committed. |
| K1 to K6 | checker mutation and review | Errors in the checkers themselves: a phantom-404 rule too lenient, a dropped response held to have a trace, a broken body taken as an answer, any failed read taken as "no such row", a read resent under the same trace id, no clock watchdog. |
| E1 | review of a run | The verification client ran twice, replaying its requests with the same random trace ids. |
| L1 | local seeds | Seed chunks ran out of memory, so their last seeds timed out. |
| P2 | seeds | `fulfillment.tape` answered 409 for a read of a missing order. |
| V1 | building the rules | The rules skipped a user function that shares a name with a standard library function. |
| W1 | review | Renaming the call import weakened the tools capability check. |
| H2 | review | A callee replayed the stored reply of a key for another message. |
| R13 | prototype | A router written in Tape gave two keys the same call key. |
| M1 (models) | protocol models | A key reused for another message answered `rejected`, a refusal the caller may compensate. |
| P1, P2 (retention) | before release; production | The first trace prune deleted a router record whose call never reached its shard; the account delete answered 500 for every name it deleted. |
| U1 (upgrade) | before release | The first cluster upgrade deadlocked every shard. |
| Q1 to Q6 | the SQL parser and its differential fuzz against SQLite | An Int parameter bound as REAL; C58 not seeing DELETE; C52 missing an outer column in a subquery; `TEXT PRIMARY KEY` without NOT NULL in five examples; a CHECK inside `ADD COLUMN` not resolved; parser and checker defects found by fuzzing. |
| L1, L2 (compiler) | writing programs | An unknown type in a signature crashed the compiler; a program could not reuse a name std defines. |
| P2, P3 (production) | Jepsen runs on `apps/tickets` in production | A refund cut short left the order `refunding` for ever; a declined hold went back to `held` with no expiry. These led to rule C77. |
| P4, P5 | rule C79 | Two bugs in new example programs, refused before they ran. |
| H1, H3, H4 (harness) | the harnesses | A rolled-back insert counted by the trace checker; a test that failed under load; a settle loop that stopped early. |

Some ids were reused in later sections of the original note (P1, P2, M1, U1, H1, L1); the column "Found by" tells
them apart, as the section they were found in did.
