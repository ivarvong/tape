# Contributing

Tape is alpha software with one maintainer. Issues and pull requests are welcome; a pull request that changes what
the language accepts or refuses should change [`LANGUAGE.md`](LANGUAGE.md) in the same commit, and a pull request
that changes a claim should change [`STATUS.md`](STATUS.md).

To report a vulnerability, see [`SECURITY.md`](SECURITY.md) instead.

## Setup

Node 25 or newer; every entry point stops early, with the version it found, on anything older. Everything is
TypeScript that Node runs as written (types only: no enums, no namespaces), so there is nothing to build.

```sh
npm ci                     # the formatter, the type checker and the linter
(cd service && npm ci)     # the service and its tests in workerd; needed only for the full gate
(cd mcp && npm ci)         # tape-mcp, the hosted compiler and runner, and its tests in workerd
```

## The gate

```sh
npm test                     # node proof/all.ts --quick
npm run check                # node proof/all.ts: everything
node proof/all.ts --only sim # the parts whose name contains a word
```

`proof/all.ts` runs every check below, prints one table, and exits 0 only when every part passed. A part passes when
it exits 0, prints no line starting with `FAIL`, and prints the result recorded for it (how many planted bugs are
caught, and by what). On a 16-core laptop on 22 November 2026, the full gate's 61 parts took 583 s in all, of
which the service suite was 211 s; `--quick` leaves out the service suite, three simulations and the apps'
planted bugs, and takes about two and a half minutes.

| Part | What it checks |
|---|---|
| format, types, lint | `prettier --check`; `tsc --noEmit` under `strict` for the toolchain, for the service against the Workers types, and for `apps/playground` and `apps/highlight/page.ts` against the browser's; oxlint with type-aware rules (`proof/lint.ts`) |
| `tape fmt --check` | every `.tape` file is in the formatter's layout |
| `test/*.ts` | one file per subject; each runs alone (`node test/json.ts`) |
| doc examples | the examples written in comments in `std/` and `examples/` (`node tape.ts test`) |
| `proof/verify.ts` | the reference interpreter against three builds on generated programs and the examples; replay of effect logs |
| `proof/schedule.ts` | every schedule of keyed calls in a small scenario |
| `apps/tickets/` scenarios and plants | the box office's scenarios, and 52 planted bugs: 43 refused by the compiler, 8 caught by the scenarios, 1 missed |
| `experiments/c78/timed-mutants.ts` | 7 planted timer bugs, each refused |
| `service/verify/plant/plant.ts --check` | every bug planted in the service still matches the code it edits |
| `proof/sim-transcript.ts --check` | the transcript the service is compared with is current |
| `tape sim` on `apps/tickets` | 300 guided runs with `pay`, and 300 with it stood in for |
| `proof/interp-effects.ts` | the compiled builds and the interpreter ask for the same effects and answer the same bytes |
| `bench/*.ts` | each benchmark's answers match the JavaScript beside it (not its times) |
| `apps/highlight/test.ts`, `apps/trace/test.ts`, `apps/playground/test.ts` | the highlighter and the trace renderer (both in Tape) against oracles that are not them; the playground's logic and build without a browser |
| `proof/sim-all.ts`, `proof/sim-invariants.ts`, `proof/sim-plants.ts` (full only) | the simulator on every program; a bug planted against every invariant; tickets' planted bugs found from the programs alone |
| the apps' `--plants` (full only) | 13 bugs planted in `highlight.tape`, 37 in `trace.tape`, 18 in the playground's modules, each caught by the test meant for it |
| service suite (full only) | `cd service && npx vitest run`, in workerd |
| `mcp/test.ts`; mcp suite and `--plants` (full only) | tape-mcp's tools and HTTP face in Node, against README.md and the playground's traces; `cd mcp && npx vitest run` in workerd; 31 planted bugs, each caught |

What the recorded numbers do and do not hold fixed is in [`STATUS.md`](STATUS.md#how-strict-the-gates-numbers-are).
`.github/workflows/check.yml` runs the full gate each night and on demand, not on every push; run `npm test`
before you push.

## Rules for the code

- Every file is typed: no `// @ts-nocheck`, no cast, no non-null `!`, no `any` (`test/typed.ts`, `test/clean.ts`).
- A syntax tree is a tagged union, and a `switch` over one ends in `unreachable`, so a new variant without a case
  does not compile.
- JSON from outside is read as `unknown` and narrowed.
- `experiments/` is an archive of one-off scripts, kept as they were run; it is not typed or linted, and some of it
  calls code that no longer exists.

## Two tools for changing things safely

```sh
node proof/same-output.ts > before.txt            # before a change to the compiler
node proof/same-output.ts --against before.txt    # after it: the programs whose output differs, exit 1 if any
node proof/same-behaviour.ts old.tape new.tape    # is a rewritten program the same program, under the simulator
```

Neither is part of the gate. A program that no longer compiles (one under `experiments/lang/before/` uses a form
the language has since removed) is hashed as `threw:`, so it still compares against itself.

## Other checks run by hand

```sh
node proof/mutate.ts 40 1 --files rules/,sql/ --all   # small changes to the rules, each run against every test (about a minute each)
node service/jepsen/selftest.ts                       # the fault harnesses' checkers against fixtures
node service/model/selftest.ts                        # the protocol models, with planted bugs
```

The service's checks against a deployment are in [`service/VERIFY.md`](service/VERIFY.md).
