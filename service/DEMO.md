# The service, demonstrated

Three walkthroughs of what a user of the service does, run against this code in local workerd. The transcript below
is the output of `demo/demo.ts`, from a run of `test/demo.test.ts` on 22 November 2026. The test checks the
walkthrough's answers as it runs; it does not compare this file, so regenerate the transcript after a change (the
json reporter's `meta.demo`). Ids, hashes, times and durations change from run to run.

Run it yourself:

```
cd service && npm ci
npx vitest run test/demo.test.ts                                     # in workerd, no network
npx vitest run test/demo.test.ts --reporter=json --outputFile=demo.json   # the transcript is in meta.demo
node demo/run.ts --base <url> --token-file <path> --account <unused name>   # against a running service
```

## Transcript

```
A. Upload a program, call it, read its log and trace

POST /demo/hello                     -> 201 version 1, hash 333ff56a…
GET  /demo/hello/v/1/hello/ada        -> 200 Hello, ada
  tape-request-id: 3ea2f2e9-1efb…
  tape-trace-url:  /t/demo/hello/r/db6c…?exp=…&sig=…
GET  /demo/hello/log/1/<id>           -> 200 2 effects, build 106bd081…

the trace link, opened with no token:
  router  GET /{account}/{name}/v/{version}/hello/ada  -> 200  8 ms  trace 8adaf01659f4c4bbc69b092e97a28fb2  (no client traceparent)
    call   hello.invoke  7 ms  rpc.service=demo/hello rpc.method=invoke http.response.status_code=200 tape.call.outcome=answered
      supervisor  demo/hello v1  -> 200  4 ms (run 3 ms)
  
  handle
    ✓   9  Request(method: "GET", path: "/hello/" ++ name) if len(name) > 0 -> greet(
        sql 0 ["ada"] → [[1]]
  greet
    ✓  25  Some(value: Count(n)) if n == 1 -> respond(status: 200) |> append(view: "Hello, \(name)")

GET  /demo/hello with no token       -> 401
the trace link with one digit changed -> 401

B. A durable workflow: reserve stock, charge a card, print a label

start                                 lamp 5  desk 2  ann 300  labels 0
order 1: 1 lamp               -> 201 done, 3 steps   lamp 4  desk 2  ann 260  labels 1
order 2: 2 lamps, 1 ms per step -> 202 reserving        lamp 2  desk 2  ann 260  labels 1
  "inventory.reserve did not answer in time; attempt 2 in 1000 ms"
  the reservation happened anyway: the lamps are taken, the card is not yet charged
POST /advance/2                   -> 201 done, 3 steps   lamp 2  desk 2  ann 180  labels 2

the trace of the resume:
  call inventory.reserve once {"order":2} -> ok (4 ms): inventory v1 answered ok from the reply it stored for key demo-wf/fulfill/reserve/{"order":2}: reserve did not run again, nothing was written
  call payments.charge once {"order":2} -> ok (5 ms): payments v1 ran charge at 2026-11-22T18:15:27.032Z for key demo-wf/fulfill/charge/{"order":2} and answered ok
  call shipping.label once {"order":2} -> ok (5 ms): shipping v1 ran label at 2026-11-22T18:15:27.038Z for key demo-wf/fulfill/label/{"order":2} and answered ok

order 3: a desk, a card that cannot pay -> 200 failed, "card declined: not enough funds"
  the stock went back                 lamp 2  desk 2  ann 180  labels 2

C. Tools for agents

agent uploads a tool that takes a database, with no policy
  -> 403 "Sql is not granted: export fn put takes db: Sql"
agent uploads a pure tool
  -> 201 price_quote, pure: true, imports: ["env.json"]
  qty in its JSON Schema: {"type":"integer","minimum":1,"maximum":100,"description":"Qty, a refined Int: its condition is checked when the message is decoded"}
agent calls it: 3 at 19.99, 10% off, 8% tax
  -> total_cents 5829, with a trace link
a message outside the schema (qty 0)
  -> 422 "qty: expected 1 to 100"
the agent's token on a program route -> 401; on the policy route -> 401
the operator grants {"sql": true}; the same upload -> 201; put -> {"key":"a","revision":1}
MCP tools/list                       -> 200 notes_put, notes_get, price_quote
```

## What each part shows

- **A.** An upload becomes an immutable, numbered version with a hash. Every response names its request and
  carries a signed link to its own trace, which opens without the token and shows the arm of each `match` that
  ran and the SQL it did. A route without the token, or a link with a changed signature, answers 401.
- **B.** An order is a row whose state names the next step, and each step is a call with a key. The order that
  waited 1 ms per step stopped after its reservation had already happened; resuming it was answered from the
  reply inventory stored for that key, so the stock was not taken twice, and the card was charged once. The order
  on a card that could not pay ended `failed` with its stock returned. Here the resume is a request
  (`POST /advance/2`); a timer would also resume it by itself (VERIFY check 17).
- **C.** A tool is a program of exported functions; what it may do is its parameters. With no policy only pure
  tools are accepted, and the refusal names the function and the capability. Refined types become JSON Schema
  limits, the tool itself refuses a message outside them, and the same tools are listed over MCP. The agent's
  token reaches tool routes only.

Not shown here: migrations, timers that resume a workflow by themselves, the key-value shards, and the fault
harness. Those are in `test/` and [`VERIFY.md`](VERIFY.md).
