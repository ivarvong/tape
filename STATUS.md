# Status: what Tape can be trusted with, and why

Tape is alpha software. Nobody depends on it in production, and the language, the service and their limits can
change at any time. This page lists what Tape claims, the check that fails when each claim breaks, how strong that
check is, what is known to be broken, and what is taken on trust.

Numbers on this page were produced by the command named beside them on the tree this page describes (22 November
2026), unless a date says otherwise. `node proof/all.ts` runs every check ([`CONTRIBUTING.md`](CONTRIBUTING.md)).

## Claims, and what fails when they break

| Claim | What fails | Kind |
|---|---|---|
| A compiled program computes what the source means. | `proof/verify.ts`: a reference interpreter (`interp.ts`) against three builds, on generated programs and the examples. The interpreter is a second evaluator, not a second front end: it uses the compiler's parser and the passes `parseProgram` runs after it (shadowing, pipes, ambient capabilities, `*` columns), and `movePlan` and `tablesOf` from the rules. A bug there is shared by both sides. | sampled |
| `Int` arithmetic is exact or traps; it never wraps. | `test/ints.ts`: every operator on 21×21 edge values, 0! to 25!, negative literals and the wrapping intrinsics, and 4,000 random expressions at 4 inputs each (16,000 runs, about a fifth of them traps), each run under three builds and the interpreter and compared with BigInt arithmetic, trap code for trap code. The bounds a condition proves for an index (`compiler/gen/range.ts`, which drops the test from `at + 1`) are held by cases where a wrong bound would let an overflow through; each of five planted mistakes in it was seen caught. | sampled |
| An effect is asked for as the source says, in order. | `proof/interp-effects.ts`: the interpreter, given each simulated run's log as its host, must ask for the same statements, calls, timers and draws in the same order and answer the same bytes. 1,823 of 1,896 distinct runs agree over 4,250 effects; none differ; 73 are not followed (below). Four planted differences are each seen. | sampled |
| A keyed call that is lost, repeated, delayed or sent again while it runs takes effect once. | `proof/schedule.ts`: every mix of four outcomes at each call of a small scenario, 484 schedules, none wrong with keys, 381 wrong without; and two overlapping sends of one key to a method that calls, with every outcome of its call and a storage error at every commit, 73 schedules, none wrong (the host before claims: 9 of 40 wrong). `test/calls.ts`: the second send waits for the first run's reply, runs the key when that run fails, and answers `unreachable` when it outlasts its budget. `service/jepsen` in the real service, with sequential retries. | exhaustive within its bound; sampled |
| A request answered once and sent again changes nothing in the end. | `tape sim`: in each run one request answered 200, 201 or 204 is sent again straight after its answer, in a second copy of the run; the rows after settling must match. One request per run, so a rare one can be missed. | sampled |
| Memory released is never read, and reuse changes no result. | `proof/verify.ts` builds with reuse off and with released memory quarantined; `test/memory.ts` on random aliasing scripts. | sampled |
| The rules refuse the bugs they were written for. | `apps/tickets/plants.ts`: of 52 planted bugs, 43 refused by the compiler, 8 caught by the scenarios, 1 missed. `experiments/c78/timed-mutants.ts`: 7 of 7 in `examples/timed`. Each rule has a program it refuses and one it accepts (`test/rules-retries.ts`, `test/machines.ts`, `test/timers-way-out.ts`, `test/timers-keys.ts`). | per rule |
| Programs keep their invariants under lost, dropped and cut calls, timers and time. | `proof/sim-all.ts`: `tape sim` on every program with a `handle`, alone and in the groups deployed together: 37 runs, 36 clean and `examples/trap.tape`, which traps on purpose; 29 of them check invariants (62 declared in 30 files). `proof/sim-invariants.ts`: of 34 bugs planted one against each invariant, 29 caught by it, 3 refused by the compiler first, 2 not caught. `proof/sim-plants.ts`: of tickets' 49 planted bugs that type-check, 40 found from the programs alone in 500 guided runs, 5 of them refused by no rule; 4 missed by both the rules and the simulator. | sampled, guided |
| The simulator's host is the service's. | The same `host.ts` source in both. `service/test/sim-fidelity.test.ts`: 117 requests to `apps/tickets` answered identically by the simulator's host and by the service in workerd. | one transcript, requests one at a time |
| A timer runs at least once: a run cut short or failing on storage is tried again; only a trap removes it. | `test/timers-transient.ts`: a run whose commit fails on `SQLITE_BUSY` keeps its timer, moved later by a wait that doubles to a 15-minute cap, and runs once when storage recovers; a trap removes it (the host before: the timer gone after one `SQLITE_BUSY`). `service/test/service.test.ts`: a jepsen-* plan's `storage_error` at the new `wake` hop fails a woken run, and the alarm runs it again after the wait. | per test |
| A simulator run can be had again. | `test/sim-core.ts`, `test/sim-auto.ts`: a script and seed replay to the same log, random draws included, however long the machine takes between two choices. | per test |
| JSON in is what was sent; anything else is refused. | `test/json.ts`: 300 generated nested values come back as `JSON.stringify` writes them; the same with one thing wrong inside are refused. | sampled |
| `scan` finds the first byte of a compile-time set, and `scan_plain` is that scan for the bytes that end a JSON string's plain run. Each costs one step per 16 bytes read (step version 2). A computed set is C93. A program's own function of the same name still takes a positional first argument. | `test/scan.ts`: three builds and the interpreter against a byte loop and against a Tape byte loop, on generated texts; step counts, including a build that does not inline and counts steps in the global; traps for `at` outside 0 to `len(v)`; a program's own `scan` with a differently named variable, an expression, and a call from another file. `test/step-version.ts`: version 1 still counts a JSON decode as 47, and version 2 counts it as 48. | sampled |
| Two programs that disagree about a message do not talk. | Fingerprints over the whole message: `test/json.ts` (a field two records down), `test/calls.ts`. | per test |
| The definition and the compiler agree. | `test/definition.ts`: every program in `LANGUAGE.md` compiles, is in `fmt`'s layout and is clean under `tape sim`; each edit it shows is refused with the code it names. | per form shown |
| The playground, the highlighter and the trace renderer show what the tree computes. | `apps/playground/test.ts`: the page's SQLite (sql.js) against `node:sqlite` on 61 preset requests, responses and effect logs compared; each request's OTLP against its logs; the homepage's build-time copy against what `node tape.ts` answers, traces and refuses. `apps/highlight/test.ts`: `highlight.tape` gives back its input byte for byte and the tokens of `compiler/lex.ts`, on the 103 `.tape` files in the tree and 6,000 generated sources. `apps/trace/test.ts`: `trace.tape`'s SVG against what the OTLP alone says it should show, on the fixtures and 2,000 generated inputs. Planted bugs, each caught by the test meant for it: 18, 13 and 37 (full gate only). In a browser, by hand only. | sampled; per test |

## How strict the gate's numbers are

`proof/all.ts` fails when a part exits non-zero, prints a line starting with `FAIL`, or does not print its recorded
result. Some recorded results are exact, so a check that finds less fails: the 52 tickets plants (43, 8, 1), the 7
timer mutants, the benchmarks' input counts. Others are floors well below what is measured, so a check can get
weaker by a long way and still pass:

| Part | Measured | Gate requires |
|---|---|---|
| `proof/interp-effects.ts` | 1,823 runs agree | at least 500 |
| `proof/schedule.ts` | 484 schedules | at least 400 |
| `proof/sim-invariants.ts` | 29 of 34 caught | at least 28 |
| `proof/sim-plants.ts` | 40 of 49 | at least 37 of 49 |
| `proof/sim-all.ts` | 115 of 122 paths answered 2xx | not checked |

The files under `proof/results/` are written by these runs and are not read back as baselines.

## Known limitations

Bugs that are reproduced and not fixed, and gaps in the checks that can hide one.

1. **The simulation proofs pass when the simulator crashes on a program.** `proof/sim-all.ts` treats an exception
   from building a program's model as "no handle", `proof/sim-invariants.ts` counts it as refused by the compiler,
   and `proof/interp-effects.ts` drops the group. Each would exit 0, and the counts above would drop by one or two,
   within the floors.
2. **Changing a flag while a request waits on a call makes its replay differ.** The request reads the new value
   after the call, while its log holds the flags it started with, so replaying the log gives another answer
   (reproduced: the live answer used the new value, the replay the old one). Only tests and tools call
   `setFlags` today.
3. **The log-replay row of `proof/verify.ts` compares three builds with each other, not with the answer the request
   originally got.**
4. **The Git capability is not exercised by the gate.** `test/git.ts` needs a local build of
   [ply](https://github.com/ivarvong/ply) and reports ok when it is absent, as it is in CI. `examples/bump.tape`
   (the Git capability) is also the largest part of what the interpreter does not follow.
5. **`test/typed.ts` looks for `// @ts-nocheck` only on a file's first line.** `proof/untyped.txt` is empty, and no
   tracked file opts out of the type checker today, but a second-line comment would pass the test.
6. **A row whose machine column holds an undeclared state traps** at a match on it with a bare `unreachable`, not a
   message that names the state. The triggers keep such rows out unless the data is changed past them.
7. **C80 (`final`) is imprecise.** It follows a value a bounded number of steps and refuses two programs the tests
   hold up as correct, because a call counts as reading the clock when anything in the called function does.
8. **Published pages share the API's origin.** A public route can answer `text/html` or `image/svg+xml` from the
    same origin as the API, with no `Content-Security-Policy` and no `X-Content-Type-Options: nosniff`. The API's
    credentials are bearer tokens, not cookies, so a page cannot use them, but pages of different accounts are not
    isolated from each other.
9. **The effect log and the trace show a statement as the database was given it (`?1`), not as the program wrote
    it (`:name`).**

The language's own limits are in [`LANGUAGE.md` section 12](LANGUAGE.md#12-not-defined-yet). In short: a Float's text is the host's `String`;
call keys (`once:`) are integers; stored replies to keyed calls never expire; JSON has no bytes, no maps with
arbitrary keys, and a record with an `Option` field can be decoded but not written; function values
take one or two parameters and cannot capture a `Buf` or a capability; each file is a namespace for its functions,
while types and constructors are shared by the whole program; memory tops out at 64 MB per request, and lists
rebuilt by `map` and `reverse`, captured variables and `Buf` growth are not reused yet.

## What is on trust

- **The parser and the front-end passes**, shared by the compiler and the interpreter (above).
- **The Wasm engine, SQLite, workerd, and each adapter.**
- **What the interpreter does not follow:** lists and records nested in JSON, interfaces and the Git capability
  (73 of 1,896 simulated runs). A run that traps is not compared.
- **What the simulator does not send.** Its requests are read from the source. It prints which paths were never
  answered 2xx (7 of 122 across the repository) and which matches it could not read. It knows nothing of forms or
  of who is allowed to ask: three planted bugs of that kind are missed by everything.
- **What an invariant cannot say.** An invariant is a SELECT over the rows as they are. It cannot say what an old
  message meant, or who was allowed to ask.
- **A request that claims a different row each time it is sent.** C55 asks an INSERT for a key; an UPDATE that takes
  "the next one" passes every rule. The simulator fails it only when a run happens to send such a request twice.
- **The stand-in for a missing Remote** answers at random within the reply's type. It is not the real service on
  the other side.
- **Timers, faults and concurrency in the real service.** The transcript check covers requests one at a time. The
  service's fault runs (`service/jepsen`) are run by hand, not by the gate, and none interleaves two sends of one
  key; `proof/schedule.ts` does, on the host.
- **How well the tests notice a broken rule.** `node proof/mutate.ts 40 1 --files rules/,sql/ --all`, run on this
  tree: of 2,240 possible small changes to `rules/` and `sql/`, 40 sampled, 24 noticed by some test and 16 not.
  The 16 are not yet sorted into holes and changes that cannot matter. The sample is small, so the true rate is
  uncertain by about fifteen points either way. A change that makes a test time out counts as noticed, and the
  tool's list of checks leaves out `test/sql-results.ts`, `test/sql-tree.ts`, `test/clean.ts` and `test/typed.ts`
  and includes `test/git.ts`, which skips. The compiler and host have not been sampled since they were rewritten.
- **Production.** Nothing here deploys or reads it.
- **Being a real language.** There is a definition and a test that holds the compiler to it for the forms it shows;
  it does not define evaluation. The applications in `apps/` were written by people who also change the compiler.
  No one else has shipped a program in Tape.

## What would raise the level of trust most

1. Fix limitations 1 and 2, and add the checks that would have found them: two overlapping sends of one key in
   `proof/schedule.ts` or the service tests, and storage faults on timers in the fault harness.
2. Make the simulation proofs fail when the simulator throws, and set each floor to the measured number.
3. Triage the 16 mutation survivors, then a larger sample, of the compiler and host too.
4. Reach `examples/kv.tape` from the simulator, so its invariant is tested by a run.
5. Someone who does not work on the compiler shipping a program from `LANGUAGE.md` alone.

How the checks came to be what they are, and what each pass over them found: [`docs/history.md`](docs/history.md).
