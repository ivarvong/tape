// C77 (rules.ts wayOut): a way out of every state of a machine. The two bugs production Jepsen found in
// apps/tickets, each refused at its line; the fixed program and the repository's machine programs
// accepted; each part of the rule on the smallest program that shows it.
import '../node25.ts';
import type { Problem } from '../compiler/common.ts';
import { finish, lineOf, problems, read, same as T, swap, tour } from './harness.ts';

const errs = (text: string, name = 'program.tape'): Problem[] => problems(text, {}, name);
const c77 = (text: string, name?: string): number[] =>
  errs(text, name)
    .filter(e => e.code === 'C77')
    .map(e => e.line);

// ---- 1. apps/tickets: the fixed program, and the two bugs planted back
const tickets = read('apps/tickets/tickets.tape');
T(
  'tickets as fixed: no errors',
  errs(tickets, 'tickets.tape').map(e => e.code),
  [],
);
const refund = swap(
  tickets,
  '      do wake(after: 5000, key: id)\n      refund_hold(hold: value)',
  '      refund_hold(hold: value)',
);
T(
  'plant 1 (prod jepsen-tix-c1): a refund without its timer is refused at the move to refunding',
  c77(refund, 'tickets.tape'),
  [lineOf(refund, "UPDATE holds SET state = 'refunding'")],
);
T(
  'plant 1: the message names the state, the call, and the sweep that does not come back',
  /"refunding".*remote call.*picks rows by other states \(sweep/.test(
    errs(refund, 'tickets.tape').find(e => e.code === 'C77')?.message ?? '',
  ),
  true,
);
const decline = swap(tickets, '      do wake(after: 0, key: id)\n      held_again(reason)', '      held_again(reason)');
T(
  'plant 2 (prod jepsen-tix-d6): a decline that does not set the timer again is refused at the move back to held',
  c77(decline, 'tickets.tape'),
  [lineOf(decline, "UPDATE holds SET state = 'held', note = :reason")],
);
T(
  "plant 2: the message names the deadline (due reads the clock) and the timer's own run",
  /"held" is left at a time.*\(due, line \d+\).*timer's run/.test(
    errs(decline, 'tickets.tape').find(e => e.code === 'C77')?.message ?? '',
  ),
  true,
);
// the expiry timer of a new hold, dropped: the INSERT that starts a row in "held" is refused
const noExpiry = swap(
  tickets,
  'do wake(after: ms, key: hold.id)\n  ShowHold(status: 201, hold)',
  'ShowHold(status: 201, hold)',
);
T('a hold made without its expiry timer is refused at its INSERT', c77(noExpiry, 'tickets.tape'), [
  lineOf(noExpiry, 'INSERT INTO holds(client, tier, buyer, qty, amount, expires) VALUES'),
]);
// both timers dropped: both refused
T(
  'both bugs at once: both lines',
  c77(
    swap(refund, '      do wake(after: 0, key: id)\n      held_again(reason)', '      held_again(reason)'),
    'tickets.tape',
  ).length,
  2,
);

// ---- 2. the repository's programs with machines are accepted (none had a C77 before)
for (const f of [
  'examples/fulfillment.tape',
  'examples/orders.tape',
  'examples/tickets.tape',
  'examples/bump.tape',
  'testdata/compare/billing.tape',
  'testdata/compare/agent.tape',
])
  T(`${f}: no C77`, c77(read(f), f), []);

// ---- 3. each part on a small program
const S =
  "CREATE TABLE IF NOT EXISTS s(id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, state TEXT NOT NULL DEFAULT 'pending', note TEXT NOT NULL DEFAULT '')";
const M = 'machine s.state: SaleState {\n  Pending -> Paid\n  Pending -> Declined\n}\n';
const prog = (body: string) =>
  `schema "${S}"\n${M}type N { N(n: Int) }\nfn done(n: Int) -> Buf {\n  respond(status: 200) |> write_int(value: n)\n}\n${body}\ntype SaleState { Pending Paid Declined }\n`;
const ins =
  'fn handle(raw: View, db: Sql) -> Buf {\n  done(n: sql_exec(db, query: "INSERT INTO s(key) VALUES (:raw) ON CONFLICT(key) DO NOTHING", raw))\n}\n';
T(
  'no way out: rows start in "pending" and no write moves them on (refused at the machine, line 2)',
  c77(prog(ins)),
  [2],
);
T(
  'no way out: the message names the state and its declared moves',
  (errs(prog(ins)).find(e => e.code === 'C77')?.message ?? '').includes(
    'no write of this program moves a row out of "pending" (declared: "pending" -> "paid", "pending" -> "declined")',
  ),
  true,
);
const pay =
  "fn pay(db: Sql, key: View) -> Move[N] {\n  sql_move(db, row: N, query: \"UPDATE s SET state = 'paid' WHERE key = :key AND state = 'pending' RETURNING id AS n\", key)\n}\n";
T('with a write that moves them on, accepted', c77(prog(ins + pay)), []);
T(
  'a state no write puts a row in may have no way out (nothing is ever in it)',
  c77(
    prog(
      'fn handle(raw: View, db: Sql) -> Buf {\n  done(n: sql_exec(db, query: "SELECT count(*) FROM s WHERE state = :raw", raw))\n}\n',
    ),
  ),
  [],
);
T(
  'no cascade: a machine C58 already refuses is not read for C77',
  errs(
    prog(ins + 'fn note(db: Sql) -> Int {\n  sql_exec(db, query: "UPDATE s SET note = \'x\' WHERE id = 1")\n}\n'),
  ).map(e => e.code),
  ['C58'],
);

// ---- a request is a way out only if one comes back for the row
// The definition's program (LANGUAGE.md), with the timer that covers the call taken away. The request that made
// the order reaches the write out of "paying", but nothing comes back for the order if that request is cut short.
const whole = tour();
const bare = swap(whole, '  do wake(after: 5000, key: order.id)\n  charge(order)', '  charge(order)');
T('the definition compiles as written', errs(whole), []);
T('the request that made the row is not a way out for it', c77(bare), [lineOf(bare, 'INSERT INTO orders')]);
const retried = swap(
  swap(
    bare,
    '    _ -> rendered(outcome: Problem(status: 404, reason: "no such route"))',
    '    Request(method: "POST", path: "/retry/" ++ decimal(id)) -> again(found: load(id)) |> rendered\n    _ -> rendered(outcome: Problem(status: 404, reason: "no such route"))',
  ),
  'fn load(id: Int)',
  'fn again(found: Option[Order]) -> Outcome {\n  match found {\n    Some(value) -> charge(order: value)\n    None -> Problem(status: 404, reason: "no such order")\n  }\n}\n\nfn load(id: Int)',
);
T('a request that reads the row back and moves it on is one', errs(retried), []);

finish();
