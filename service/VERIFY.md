# Verifying the service

How the service's behaviour is checked: in local workerd by its test suite, and against a deployment by hand-run
scripts. Code comments cite these checks by number ("VERIFY.md check 24"); the numbers are kept. The properties the
checkers enforce are stated in [`RUNTIME-SPEC.md`](RUNTIME-SPEC.md); the API is in
[`docs/service.md`](../docs/service.md); what these checks found is in [`docs/defects.md`](../docs/defects.md) and
[`docs/history.md`](../docs/history.md).

This page condenses a longer ledger that was kept while the service was built, with the exact commands, expected
answers and results of each check against the deployment of the day. That ledger pinned versions and hashes that no
longer exist, so it is not part of the repository.

## In local workerd

```sh
cd service && npm ci
npx vitest run                       # the service suite: every route, uploads, migrations, calls, timers, KV, traces
node jepsen/selftest.ts              # the fault harnesses' checkers against fixtures
node model/selftest.ts               # the protocol models, each with its planted bugs
```

The suite is part of the full gate (`node proof/all.ts`; [`CONTRIBUTING.md`](../CONTRIBUTING.md)). Its
`sim-fidelity.test.ts` holds the service to the simulator's host on 117 requests to `apps/tickets`.

## Against a deployment

Every check writes to a fresh account, because nothing in a check deletes what it made. The runners read the token
from a file and send it only in the `authorization` header. Fault injection works only on accounts named
`jepsen-*`.

```sh
export BASE=https://<your deployment>
node service/demo/run.ts --base $BASE --token-file <path> --account demo-1        # the walkthrough of DEMO.md
node service/jepsen/kv-run.ts --base $BASE --token-file <path> --prefix jepsen-k --seeds 1-8
node service/jepsen/run.ts --base $BASE --token-file <path> --prefix jepsen-w --seeds 1-4
node service/jepsen/seams-run.ts --base $BASE --token-file <path> --prefix jepsen-s --kv 1,3 --workflow
```

## The checks

| Check | What it establishes |
|---|---|
| 1 | Every authenticated route answers 401 without the token. |
| 2 | Upload, list and invoke: an upload is an immutable version whose hash matches the one computed offline (`node service/verify/hash.ts <file>`); a program that does not compile, or whose SQL does not fit its schema, stores no version. |
| 3 | A request's log and trace, with the token. |
| 4 | Signed trace links open without the token. |
| 5 | A link with any part changed is 401. |
| 6 | The signing scheme, and expiry after seven days. |
| 7 | The OTLP/JSON export is accepted by an OpenTelemetry Collector. |
| 8 | Every version of a name shares its data. |
| 9 | A retry with a once key charges once, proven by the card's balance read through a second program. Sequential retries only here; overlapping sends of one key are explored on the host (`proof/schedule.ts`). |
| 10 | Migrations apply once, in order, with their hash recorded; an edited migration is refused with 409. |
| 11 | Migration order, and removal without `contract` refused. |
| 12 | The upload check runs against the data as it stands, in a transaction that is rolled back. |
| 13 | A callee's span is timed across the call. |
| 14 | A durable workflow (`examples/fulfillment.tape`) through a timeout, a resume and a compensation, proven by the callees' state. |
| 15 | Faults on the call path of a `jepsen-*` account, judged by the workflow harness (`service/jepsen/harness.ts`). |
| 16 | Tools for agents: capabilities granted per account and checked at upload, the manifest and its JSON Schemas, calls, MCP, the scope of the agent token. |
| 17 | Timers: a stalled step resumes by itself on the Durable Object alarm, recorded and traced; other programs cannot call `woken`. |
| 18 | The deployed compiler accepts and refuses what the local one does. |
| 19 | The sharded KV store: clusters, routing by FNV-1a, versions, compare-and-set, typed errors, traces. |
| 20 | Traces: one tree per request under the client's span, durations measured or marked, op ids, and a storage failure at commit rolled back and reported. |
| 21 | The compiler's rules, and the versions uploaded before them (`?rules`). |
| 22 | Machines: declared moves checked at upload and enforced by triggers across live versions. |
| 23 | The checkers are checked: every reporting site, disabled in turn, must be caught by their self-test (`node service/verify/mutate/mutate.ts --root <a separate checkout> --out <file>`, then `node service/verify/mutate/tally.ts <file>`; it edits files in place, so run it on a separate checkout). |
| 24 | Every fault at every position on the call path, one at a time (`npx vitest run test/seams.test.ts` locally; `service/jepsen/seams-run.ts` against a deployment). |
| 25 | Many seeds of both workloads under one fixed config (`node service/verify/seeds/local.ts --kv 1-2000 --wf 1-500 --out <dir>`). |
| 26 | Planted bugs: each re-introduces a recorded defect in a copy of the tree and must make a run fail (`node service/verify/plant/plant.ts --out <file>`; `--check` is in the gate). |

## Known gaps

- The checks reach the service over HTTP only: its internal tables are seen through traces and answers.
- Whether the Wasm builds are served from Workers Cache cannot be seen from outside.
- No check here sends two overlapping requests with one once key (`proof/schedule.ts` does, on the host), and no
  fault run injects a storage error into a timer's run ([`STATUS.md`](../STATUS.md#known-limitations), limitation 1).
- Production runs are made by hand. Nothing runs them on each deploy.
