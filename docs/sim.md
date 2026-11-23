# The simulator: `tape sim`

From the command line, for programs that run together; the MCP server's tools do not run it. The guide
([guide.md](guide.md)) is how to write a program; this is how to try one under every order of events a deployment
may give it.


```
node tape.ts sim apps/tickets/tickets.tape apps/tickets/pay.tape
```

runs the programs together in one process and makes every choice a deployment leaves to chance: which request
starts next, what happens to each call between programs, when a due timer runs, how far the clock moves. Nothing is
written for it. From the programs it reads:

- **requests**: every path a `match` names, with a body of the type that arm decodes. Values come from each type's
  JSON Schema (a refinement's bounds included); text comes from the programs' own seed rows, so a card or a tier that
  exists is sent; an id or a key from an earlier answer comes back in later requests.
- **what must hold**: the invariants the programs declare (above), a run that fails, and a timer that runs again and
  again once nothing fails any more.
- **the other side of a call**: a file's name is the name its callers reach it by (`pay.tape` is the Remote `pay`).
  A Remote that no file serves is **stood in for**: three times in four it answers with a value of the reply's
  type, otherwise it refuses, and a key seen before gets the reply it got before.

A call is a commit point, so a run can be cut short only at a call. Each call is delivered, lost before it ran,
dropped after it ran, or cut (the caller's object reset, before or after the callee ran). A run is the list of those
choices, a script; the same script and seed give the same run, a failing one is shrunk, and the command prints the
line that runs it again. The search is guided: a run that reaches something new (a machine in a state, a call
waiting, a fault taken on a method) leaves its script as a starting point for later runs, so a confirmed hold or a
refund in flight is somewhere to start from, not luck.

```
programs    tickets, pay; requests go to tickets
requests    18 paths: GET /events, … POST /holds {HoldReq}, * /holds/<n>/checkout {Checkout}, * /holds/<n>/refund, …
invariants  tickets: "a tier's seats left and seats held add up to its capacity"; … 9 in all
ok          500 runs, 24456 choices, nothing wrong (5694 ms)
answered    16 of 18 paths with a 2xx at least once; never: GET /hold?<q>, POST /<form>
states      14 of 15 reached; never: tickets.holds=refund_failed
```

(`refund_failed` needs a payment service that refuses a refund. The real `pay` never does; run
`tape sim apps/tickets/tickets.tape` alone and the stand-in does.)

The command also says what it did not do, so that a clean run is not read as more than it is:

- `answered`: how many paths were answered 2xx at least once, and which never were. A path that only ever got
  404 was not exercised.
- `not read`: match arms on a path it could not turn into requests.
- `states`: which states of each machine were reached, and which never.
- `sent again`: once everything has settled, each request that was answered 2xx is sent a second time, exactly
  as it was, and one that changes a row then is listed. This is a note: a row a request left half-way is moved on
  by its retry, by design.

A request sent twice at once is a failure, not a note. In each run one request that was answered 200, 201 or 204
is picked, and the run is lived twice from that point: once as it went, once with the request sent again straight
after its answer. Both are left to settle. If the rows end up different, the run fails (`repeat`), and the script
that shows it is shrunk like any other. A write marked `repeat: True` is the exception. This found a
link shortener that made a second link on a retry (`POST /links` carries a key now) and a transfer whose
`/resume` answered 200 while starting the work over (it answers 202).

One simulated request in seven is an earlier one sent again while others are in flight, and an id goes where an id
of its kind belongs (`/holds/<n>` gets a hold's id, a field named `tier` a tier's). What a program draws with
`random(from:)` comes from the run's seed.

**Is the model the real thing?** The simulator runs `host.ts` over node:sqlite; the service runs the same
`host.ts` source over a Durable Object's SQLite with calls as RPC. `node proof/sim-transcript.ts` writes down
what the simulator's host answers to 117 requests to `apps/tickets` with `pay`;
`service/test/sim-fidelity.test.ts` asks the real service the same in workerd and requires every status and body
to match. They do. That covers requests one at a time with every call delivered; it does not cover timers,
faults or two requests at once, where the service has its own fault runs (`service/jepsen`).

**What it found here, with nothing written for it** (`node proof/sim-all.ts`: every program in this repository
that has a `handle`, alone and in the groups deployed together: 37 runs of the command, 29 of them with invariants
to check; 61 invariants are declared in 30 files):

- `apps/tickets`, alone: a refund the payment service **refuses** was asked again every five seconds for ever, and
  a canceled event's sweep waited on it for ever. The same shape as the two bugs the production fault runs found,
  and not reachable with the real `pay`. The same in four of the seven `examples/timed`: a void, a refund, a page
  and a mail that the Remote refuses.
- Each now has an arm for the refusal (a state to rest in, for a person), and rule **C87** asks for one: an arm
  that takes `Rejected` together with no answer, and sets a timer, does not compile. The rule also flags the two
  compensation steps of `examples/fulfillment.tape` and one of `examples/timed/transfer.tape`, which retry a
  bounded number of times; they now say so in an arm of their own.
- After that: 36 of 37 are clean, and the other is `examples/trap.tape`, which divides by zero on purpose.
- 115 of 122 paths are answered with a 2xx at least once. The command prints the ones that never are.

**Can each invariant fail?** (`node proof/sim-invariants.ts`: one bug planted against each.) Of 34, 29 are
caught by the invariant meant for them, 3 are refused by the compiler first (C73 twice, C77), and 2 are not
caught: `examples/kv.tape`, which the simulator cannot write a key to, and an off-by-one in `apps/queue` that
needs a job failed and leased again after its wait.

**Against the 52 planted bugs of `apps/tickets`** (`node proof/sim-plants.ts`; each built with
`compile(…, { rules: false })`, 3 do not type-check either way):

| | Plants |
|---|---|
| Found from the programs alone, in 500 guided runs | 40 of 49 |
| of which no rule refuses | 5 |
| Found by the hand-written model (`apps/tickets/sim.ts`, 400 random runs) | 41 of 49 |
| Refused by the rules | 40 of 49 |
| Missed by both the rules and the simulator | 4: tickets issued without ON CONFLICT (which changes nothing: the move before it runs once), a transfer without the owner check, cancel open to anyone, a page that does not escape a name |

The last three need an oracle a SELECT over the rows cannot give: who was allowed to ask.

```
node tape.ts sim files… [--seeds n] [--steps n] [--faults n] [--random] [--exhaust depth] [--no-rules]
node test/sim-core.ts    # the simulator itself: explore, exhaust, shrink, replay
node test/sim-auto.ts    # tape sim: the model from the programs, stand-ins, the guided search, C87
```

What it is not: it runs programs on `host.ts` over node:sqlite, a model of the host, so it says nothing about
workerd or production (`service/jepsen` does). The requests are guesses from the text: a route reached only
through a form is not sent, and a path matched in a way it does not read is missed without a
word. A stood-in Remote answers at random within the reply's type, which is harsher than most real services and
kinder than some.

