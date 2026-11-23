# Runtime invariants of the Tape service and of its verification clients

Technical note · Tape service · written 15 to 17 November 2026, kept current with the code

## 1. Purpose

The Jepsen checkers (`jepsen/kv.ts`, `jepsen/harness.ts`, `jepsen/traces.ts`) and the seam runner judge runs
against properties that were, until this note, written only in code comments. This note states them once, each
with an identifier. A checker rule cites the identifier it enforces; a property no rule enforces says so. When the
code and this note disagree, the disagreement is a defect of one of them and is recorded in [`docs/defects.md`](../docs/defects.md).

Scope: what a client of the deployed service can observe (statuses, bodies, headers, traces, final state), what
an injected fault must look like, and what the verification clients themselves must do for their records to be
evidence. Internal mechanisms are named only where an invariant depends on them.

## 2. Answers

| Id | Invariant | Enforced by |
|---|---|---|
| R-ANS-1 | A request whose effect is unknown to the service says so: 5xx with `outcome: "unknown"` or no `applied`; a request that took no effect says `applied: false` or `outcome: "not applied"`. | `kv.ts` attempter (`not_sent`, `info`); `harness.ts` recorder |
| R-ANS-2 | A storage failure at commit (a `StorageFault`, or an error matching `TRANSIENT` in `program.ts` other than `SQLITE_FULL`), at the client's request, answers 503 with `retry-after: 1`, `transient: true` and `applied: false` (nothing kept) or `applied: "partly"` (the stretches before the run's last call were kept), and `tape-trace-complete: true`. A trap, or any other failure of the program, answers 500 with the same `applied` field and no `retry-after`: sending it again does the same. Before 15 November 2026 both answered 500; all 46 500s in the production workflow runs of 15 November 2026 (33 in 16 seeds, 13 in the seam run) were the storage answer to an injected `storage_error`, so the status did not tell a client which of the two it had. Specified by VERIFY check 20. | VERIFY check 20; `traces.test.ts` (503 for `storage_error`, 500 for a trap); `harness.ts` conservation and order invariants; `kv.ts` history (`applied: false` at 500 or 503 is a fail) |
| R-ANS-3 | A storage failure in a callee, on a call between programs, answers the caller `unreachable`, never `rejected`: the call's once key is not spent, so the caller must not compensate (S2). A send of a key whose first run has not finished waits for that run's reply, and answers `unreachable` when it outlasts its budget. | `service.test.ts` S2 test; workflow conservation |
| R-ANS-4 | A read of a row that does not exist answers 404. (`fulfillment.tape` answered 409 for `GET /orders/<id>` of a missing order until P2.) | `harness.ts` heal (only 200 and 404 are believed) |
| R-ANS-5 | A refusal before any shard or object was called (cluster lookup failure, overload at the router) is `not applied` and carries `tape-trace-complete: false` when its trace is incomplete (S1). | `kv.ts` `refused_untraced` |
| R-ANS-6 | A program's answer is `STATUS LF BODY` or `STATUS SP TYPE LF BODY`, TYPE one of `CONTENT_TYPES` (host.ts: text/plain, text/html, application/json, text/css, image/svg+xml); its content-type header is that type (text types with `charset=utf-8`), and text/plain without one. Any other first line is all body with status 200, as before 17 November 2026, so no program can set another header. | `public.test.ts` (content types), `test/tickets-findings.ts` section 6 |
| R-PUB-1 | Only the operator publishes (`PUT /_public/:account/:name`, a name with a live version; not `kv-*` or `tool-*`). `/p/:account/:name/<path>` answers GET, HEAD and POST, bodies to 64 KB, without a token, by the latest live version; an unpublished or unknown name is 404, the same answer. A public answer carries no trace link and no request id. The program's request line ends in ` public` (std/http `caller: Anyone`); the operator's routes never send it, and the path cannot (a space in a URL arrives percent-encoded). | `public.test.ts` |
| R-LOG-1 | A run's log (`_tape_log`) is written in the transaction of each stretch's writes (a call is a commit point), marked `partial` until the last, for a request's run and a woken run alike; so every committed write, and every timer a run set, has a log that names its span. Before 17 November 2026 a woken run wrote its log only at its end, and a woken run cut short at a call left timers whose parent span was in no record (`trace-not-one-tree`, prod jepsen-tix-b1). | `program.ts` `wakeDue` `keep`; prod tickets Jepsen trace check |
| R-LIST-1 | `GET /:account/:name/requests` (operator token only) lists the router records the name holds (`_tape_routed`, so what R-RET-6 has not pruned), newest first, from `since` (default an hour ago), at most `limit` (1..500): method, path, target, via, version, status, began, took_ms (the router span), buyer if the path or the run's request names one, and signed `/t/` and `/otlp/` links; and the woken runs (`_tape_woken`, the last 200) begun in the window. On the public route the same path is the program's. | `requests.test.ts` |

## 3. Traces

| Id | Invariant | Enforced by |
|---|---|---|
| R-TR-1 | Every request a client sent with a `traceparent` has exactly one router root span under the client's span, unless the response said `tape-trace-complete: false`. | `traces.ts` `tree` (`trace-not-one-tree`), `trace-missing` |
| R-TR-2 | Each order and sale in the final state was created by exactly one traced request; each traced creation is in the final state. | `harness.ts` `*-created-by-no-trace`, `traced-*-not-in-final` |
| R-TR-3 | What the client was told matches the router span's status, unless the client heard nothing complete (status 0 or a thrown error: outcome unknown, K3). | `status-mismatch` |

R-TR-1 and R-TR-2 hold only if R-CLIENT-1 holds: a second send of one request makes a second root and can make
a creation no recorded request explains.

## 4. Injected faults

| Id | Invariant | Enforced by |
|---|---|---|
| R-FAULT-1 | An injected fault behaves like the failure it stands for. A reset stops the invocation that hit it: nothing after it runs (H1: in production `ctx.abort` alone did not stop the code that called it). | production seeds, KV linearizability |
| R-FAULT-2 | Only accounts named `jepsen-*` take faults. | `FAULTY` in `src/index.ts` |
| R-FAULT-3 | A seam enumeration counts positions with one run and no faults; a position that the counting run had and a case run did not is reported as unfired, not as covered. | `seams.ts` `coverage` |

## 5. Verification clients

| Id | Invariant | Enforced by |
|---|---|---|
| R-CLIENT-1 | An operation of a workload is sent once. Its outcome is what that one send produced: a response, a body that broke (status 0, unknown), or a thrown error (unknown). The client never resends it, reads included. (`run.ts` resent reads before `client.ts`.) | `jepsen/client.ts` |
| R-CLIENT-2 | The client's process runs once. A process that is paused and resumed, or a machine restored from a snapshot, resends what it had sent with the same random trace ids, because the random generator's state is restored too. Such a run's anomalies are environmental, and the run is marked: the client compares its wall clock with its monotonic clock each second and records jumps over 2 s (`clock_jumps`). | `client.ts` watchdog |
| R-CLIENT-3 | The runner's own requests (setup, plans, final state, traces) may be resent on a broken connection; one that fails every resend ends the run as a runner error with no verdict. | `client.ts` `RunnerError`; `seams-run.ts` |
| R-CLIENT-4 | The final state is read after the faults are off, and only a 200 or a 404 is believed; any other answer is read again, and one that never reads is reported (`final-unreadable`), never taken as absence (K4). | `harness.ts` `heal`; `kv.ts` final read |
| R-CLIENT-5 | A local run that the machine could not hold (memory) is reported as not run or timed out, never as passed or as a checker verdict. | `verify/seeds/local.ts` |

## 6. Retention

What the service keeps, for how long, and why a retry can never apply twice because of what it removed. The
constants are per KV cluster (`POST /kv/:account/:cluster` body; kept in `_kv_clusters` and in each shard's
`placement` row) and per name (`PUT /_retention/:account/:name`, operator); the defaults are below. *W* is the
op window, *S* the clock allowance, *N* the number of requests whose records an object keeps.

| Id | Invariant | Checked by |
|---|---|---|
| R-RET-1 | An op id names its first send: `<t>_<id>`, where *t* is the client's clock in ms when the op was first sent (13 digits) and `<id>` is 1 to 50 of `A-Z a-z 0-9 - _`. Every resend of the op carries the same op id, so *t* cannot change between attempts. An op id without *t* answers 400 on a cluster made with this rule (`examples/kv.tape` from migration 4). | `kv.test.ts` (format); `retention.ts` `untimed-op-accepted` |
| R-RET-2 | A shard answers an op whose *t* < now − *W* with 410 `{"op_expired": true}` and runs nothing; one whose *t* > now + *S* with 400. The check runs in the same request as the op's lookup in `key_ops`. Defaults *W* = 3,600,000 ms (1 h), *S* = 300,000 ms (5 min); a cluster may choose 1,000 ≤ *W* ≤ 86,400,000 and 1,000 ≤ *S* ≤ 600,000. | `retention.ts` `expired-op-not-refused`, `fresh-op-refused` |
| R-RET-3 | A shard deletes the `key_ops` row of an op only when its *t* < now − *W* − *S*. Deletion runs inside a write that stores a new op (at most 32 rows each), so the table holds at most rate × (*W* + *S*) rows plus 32. | `retention.ts` `op-applied-twice`, `versions-exceed-ops`; plants A and B of `test/retention.test.ts` |
| R-RET-4 | Consequence of R-RET-2 and R-RET-3 (proof below): an op whose attempt is accepted finds the record of an earlier commit of the same op id, so no op id commits twice. | `retention.ts` `op-applied-twice` (answers) and `versions-exceed-ops` (final state); the KV history check `versions-not-dense` |
| R-RET-5 | Tombstones (`kv.live = 0`) are not removed: they grow with the number of distinct keys, not with requests, and they keep versions from repeating, which `?if=` relies on. Stored replies of calls between programs (`_calls`) and the programs' own keyed rows (orders, sales) are not removed: they grow with the operations a program made, and a caller may retry a call for as long as its own row waits. | `storage.test.ts` (no row removed) |
| R-RET-6 | Trace records (`_tape_log` in the data, `_tape_invoked`, `_tape_routed`, `_tape_served` in the name) are kept for the newest *N* rows of each table, default 100,000, at least 10, set per name (`PUT /_retention/:account/:name`) or per KV cluster (`trace_keep`). Each table is pruned by its own count (rowid order; `_tape_routed` by `(at, call_span)`), every 16 requests an object serves. No answer to a request reads them: the readers are the prune, the size report, the trace, log, OTLP and request views, and the request list (R-LIST-1). The KV trace route reports `pruned_before`, the time of the newest record removed (body and `tape-pruned-before` header); a request at or before it may be absent or partial. | `retention.test.ts` (answers unchanged after a prune; a request that never reached its shard keeps its trace; the static readers check); `retention.ts` `trace-missing-not-pruned` |
| R-RET-7 | An account's names are recorded in `<account>/~registry` when a name first stores a version, a KV cluster, a fault plan or a tool policy. `DELETE /_accounts/:account` (operator, with `{"confirm": "<account>"}`) removes every recorded name's storage, its data and its alarm, then the registry; extra names (`"names": [...]`) cover names made before the registry. `POST /_ids` maps names to object ids without creating objects, to match them with the platform's object list. It is not run in production without the owner's list. | `accounts.test.ts` |

Proof of R-RET-4. Let one shard's clock read *c₁* when it accepts an attempt of op id `<t>_<id>` and *c₂* when a
pruning write removes that op's row, both in that object's serial order. Acceptance needs *t* ≥ *c₁* − *W*;
removal needs *t* < *c₂* − *W* − *S*. If the removal came first (*c₂* ≤ *c₁* + *S*, allowing the clock to step back
by up to *S* between the two), then *t* < *c₂* − *W* − *S* ≤ *c₁* − *W* ≤ *t*, a contradiction. So when an attempt
is accepted, the row of any earlier commit of the same op id is still present, and the attempt answers that
commit's reply without writing (the op's `key_ops` lookup and its write are one transaction). *t* is part of the op
id, so no attempt can present another *t* for the same id. The proof assumes the shard's clock does not step back by
more than *S*; a backward step beyond *S* is outside this invariant and is what *S* is sized for.

Bounds at the measured single-shard ceiling of 680 writes per second ([`docs/history.md`](../docs/history.md)): `key_ops` at most
680 × 3,900 s ≈ 2.7 million rows with the defaults; trace records at most *N* = 100,000 requests (about 650 MB at
6.5 KB a request, as measured on 15 November 2026). Domain rows and tombstones are the program's.

## 7. Protocol models

Executable models of three protocols, in `model/`, explored exhaustively by `model/explore.ts`. The search runs breadth
first over every interleaving within the bounds, so the first violation it reports has a shortest counterexample. A
truncated search counts as a failure, never as a pass. The models are
TypeScript rather than TLA+; each transition is a pure function of the state.

| Model | Covers | Invariants |
|---|---|---|
| `kv.ts` | KV write: clients with timeouts and resends of one op id, a network that loses, duplicates and reorders, an atomic shard whose run ends ok, failed, or reset before, after or as the object reopens, R-RET-2/3 window and prune with a shard clock that lags by up to *S* | exactly-once (no op id commits twice), reply-is-its-commit (a 2xx names the version the op committed), versions-grow-by-one |
| `calls.ts` | A call between programs: twin runs of one caller order (a restart re-runs the handler), one once key, the callee's `_calls` row and message, a commit that fails, a lost reply; answers ok, rejected, unreachable, skew | failed-order-not-charged, charged-at-most-once, ok-means-it-ran, existing-order-not-404 |
| `wipe.ts` | `DELETE /_accounts`: unflushed writes, `storage.sync()`, the object's stop racing its reply | deleted-means-gone, failed-means-kept, all-deleted-means-registry-gone (judged once the route has settled) |

Assumption stated in `wipe.ts`: a stop drops writes not yet made durable. This is conservative: in production
the deletes of the retention defect P2 persisted.

Each historical protocol bug is a flag that restores the old rule (`model/configs.ts`). The correct protocol must
show no violation, and each flag must be found by the invariant named. `model/selftest.ts` runs the small bounds
(about 10 s); `model/run.ts` runs the default bounds.

Trace conformance (`model/conformance.ts`, `model/calls-conformance.ts`):
- KV. For each key, the effect of every run taken from its trace (`jepsen/kv.ts` `checkOpTrace`, with the
  run's start `at` on the shard's clock) is replayed through the model's shard rules, extended with CAS, delete
  and read. A run must do exactly what the model allows in that state: read the current version, commit the next
  version, replay its op's own commit, or refuse.
  - Commits are allowed to skip as many versions as there are ops whose effect is unknown.
  - Runs with the same start are taken in an order the model accepts, if one exists. The platform's clock does
    not advance while a request runs, so several runs of one shard can share a millisecond (seen in `jepsen-r1k22`).
- Calls. For each once key at most one callee run commits. Every ok or rejected answer a caller got must be the
  reply that run stored, or the stored reply a deduplicated callee span reports. A non-deduplicated answer with
  no run in the traces is a violation; a deduplicated one with neither is counted as unverifiable.

## 8. Upgrading a cluster's program

A cluster made with an older `examples/kv.tape` keeps running it: each shard holds the program it was given as
v1. Two such programs existed:
- the first, with migration 1 only and no op ids at all;
- the second, with migrations 1 and 2 and op ids by shard in table `ops`.
Neither has the op window. Both accept an unconditional PUT without an op id, which today's compiler refuses
(C54). `POST /kv/:account/:cluster/upgrade {"confirm": "<cluster>"}` moves every shard to the current program.

| Id | Invariant | Checked by |
|---|---|---|
| R-UPG-1 | Data is kept. Every key, value, version and tombstone after the upgrade is what it was before. The migrations the upgrade applies (3 and 4) only add a table, columns and an index, are checked against the data before they run (the upload's check), and stop the upgrade on any problem. | `upgrade.test.ts` (both old programs, built by the compiler of their time, from `test/fixtures/`) |
| R-UPG-2 | No op id commits twice across the upgrade. The current program finds an op's earlier commit in `key_ops` only. An op id the old program stored in `ops` is safe if a resend is refused: an untimed one gets 400 (R-RET-1), and a timed one with *t* < now − *W* − *S* gets 410. A shard holding a timed op id in `ops` that is newer than that is not upgraded (409, nothing changed) until the op id is older. | `upgrade.test.ts`: the held upgrade; the planted variant, where the same steps without the check commit a resend twice (version 2) |
| R-UPG-3 | One point of change per shard. The router asks a shard for its latest live version (version 0), so the shard, not the router, decides which program runs. While a shard upgrades, it refuses new requests before they run (503 `{"outcome": "not applied", "upgrading": true}`) and waits for running ones. Then it checks R-UPG-2, uploads the current program and retires every older version. A request for a retired version, which is what a router from before this change sends, gets 410 and runs nothing. | `upgrade.test.ts`: 4 clients write and resend during the upgrade. Every op id acknowledged by both programs has one version, and each key's version equals the number of distinct op ids acknowledged. In 3 runs the answers were 200/201, 400 and 503 (12 to 13). |
| R-UPG-4 | All or nothing at the check. Every shard is dry-run first, and a refusal on any shard leaves all of them unchanged. A shard that is already current is skipped, so a run that stopped part way is finished by sending it again. A shard stopped between its upload and its retire has v1 and v2 live. Version 0 then runs v2, and only an old router can still reach v1; sending the upgrade again retires it. | `upgrade.test.ts` (`dry_run`, the second upgrade answering `current`) |

After an upgrade the cluster follows today's rules:
- an unconditional write needs `?op=` (428 without);
- an op id needs its *t* (400 without);
- the op window applies with its defaults (migration 4 sets them on the placement row).
A client of the old cluster that relied on the old rules gets these answers, and nothing it sends runs twice.

## 9. Open

- Not bounded, by decision:
  - tombstones, since removing them breaks `?if=` without a version epoch;
  - stored call replies (`_calls`), since removing them lets a late resend run again without a call-key window
    (first-send time in the key, a callee window, 410 for an expired key);
  - domain rows, which are the program's.
  Revisit any of these when a workload's growth is measured to matter.

- Decided 15 November 2026: R-ANS-2 answers a transient storage failure with 503 at the client edge (it was 500)
  and, unchanged, `unreachable` between programs. Reasons: (1) the two answers then agree: a caller program
  already treats the failure as one to retry, and the KV router already answers its own transient conditions
  (overload, a failed cluster lookup) 503 with `retry-after`; (2) a 500 now means a defect in the program, which
  retrying does not fix, so the status separates the two classes the production runs mixed. The body is
  unchanged apart from `transient: true`, so a client that reads `applied` is unaffected. `SQLITE_FULL` (a
  database at its 10 GB limit) is the exception at the edge: it stays full until rows are removed, so it answers
  500, not 503 with a `retry-after` a retry cannot honour; between programs it stays `unreachable`, as S2 requires
  of every storage failure (`program.ts` `TRANSIENT`, `FULL`; `test/transient.test.ts`). No run has seen it.
- R-CLIENT-2 detects a restore only when it changes the clock difference. A restore that does not leaves no
  trace in the client; the checker then reports R-TR-1 and R-TR-2 anomalies, which is how the run of 15 November
  2026 was found.
- Domain guards. C73 now refuses a write that takes from a column without a floor
  guard, and C74 refuses a write that sets a column some other write guards as a state. Decided 17 November 2026:
  a program's only write of a status column, with no machine declared (`service/verify/machines/free.tape`), is
  not checked, and no rule will be added for it. With the guard dropped, the program's text is that of a program
  that overwrites the column on purpose, and nothing else in it says otherwise. The most specific candidate rule
  (a TEXT column with a literal DEFAULT, set from a non-literal by an UPDATE whose WHERE does not name it) catches
  the mutant. It also matches 4 writes in 2 of 496 programs, and all 4 are intended overwrites of free-text
  columns (`orders.note`, `orders.stall`). The remedy is in the language: a
  column that has states declares a `machine`, and C58 then refuses the unguarded write.
- Decided 17 November 2026: the machine checker (C59, C60, C61) reads the program's own matches on a value as
  narrowing it (`"canceled" -> …` and the arms after it). A guard value known only by the states it excludes
  stands for every declared state it does not exclude. This is sound because the column holds only declared
  states (the triggers, C70). A to-state known only by exclusion stays C60.
- Decided 17 November 2026 (R-SQL-1): an Int or Bool parameter is an integer inside SQL. Both SQL APIs bind a
  JavaScript number as REAL, so the host runs each query's `run` text, which casts those parameters
  ([`docs/defects.md`](../docs/defects.md), Q1).

