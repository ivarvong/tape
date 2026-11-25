// Mutants for the C77-C80 weaknesses left by round 2 (round 3): a timer for a row whose state is final, a
// constructor carried in a record's field or read through `with`, woken's guard in a function it calls, a sweep
// whose WHERE picks by a subquery, a `final` the compiler cannot check, and a state-filtered read whose None is
// taken as "the row is gone".
// node experiments/c78/round3.ts  -> one line per mutant: its name, the codes it gets and what it wants.
// Each mutant: [name, file, pairs, want] as in round2.ts.
import { shown } from './round2.ts';
import type { Mutant, Pair } from './round2.ts';
const TIX = 'apps/tickets/tickets.tape', FUL = 'examples/fulfillment.tape';
const CANCEL = "UPDATE events SET state = 'canceled'";
const NOREFUNDWAKE: Pair = ['      do wake(after: 5000, key: id)\n      refund_hold(hold: value)', '      refund_hold(hold: value)'];
const SWEEP = "h.state = 'confirmed' ORDER BY h.id LIMIT 1";
const REFUNDING = "UPDATE holds SET state = 'refunding'";
const WOKEN: Pair = ['  match {\n    key < 0 -> Ok(value: summary(outcome: sweep(event: 0 - key)))\n    else -> Ok(value: summary(outcome: due(found: load_hold(id: key))))\n  }\n}', '  Ok(value: summary(outcome: route(key)))\n}\n\nfn route(key: Int) -> Outcome {\n  match {\n    GUARD -> sweep(event: 0 - key)\n    else -> due(found: load_hold(id: key))\n  }\n}'];
const routed = (g: string): Pair[] => [[WOKEN[0], WOKEN[1].replace('GUARD', g)]];
// fulfillment's retry decision, made by a policy of its own (round2's OWN), carried in a record or read by `with`
const PLAN = (stop: string, give: string, carry: string, plannedFn: string): Pair[] => [['waiting(decided: retry_later(timer, key: id, policy: resume(), failed: retries))', carry],
  ['fn waiting(decided: Retry) -> View {', `type Plan {\n  Again(after: Int)\n  ${stop}\n}\n\ntype Boxed {\n  Boxed(plan: Plan, why: View)\n}\n\nfn again(id: Int, failed: Int) -> Plan {\n  match {\n    ${give}\n    else -> {\n      do wake(timer, after: 1000, key: id)\n      Again(after: 1000)\n    }\n  }\n}\n\nfn unboxed(box: Boxed) -> Plan {\n  let Boxed(plan) = box\n  plan\n}\n\n${plannedFn}\n\nfn waiting(decided: Retry) -> View {`]];
const PLANNED = 'fn planned(decided: Plan) -> View {\n  match decided {\n    Again(after) -> "; again in " ++ decimal_text(value: after) ++ " ms"\n    Stop -> "; stopped"\n  }\n}';
// (these two read the policy through `with { … }` until the form went; `let … else` is what it became)
const WITH = (els: string) => `fn planned(id: Int, decided: Plan) -> View {\n  let Again(after) = decided else -> ${els}\n  "; again in " ++ decimal_text(value: after) ++ " ms"\n}`;
const FIELD = 'planned(decided: Boxed(plan: again(id, failed: retries), why: why).plan)';
const PATTERN = 'planned(decided: unboxed(box: Boxed(plan: again(id, failed: retries), why: why)))';
const VIAWITH = 'planned(id, decided: again(id, failed: retries))';
const GIVE = 'failed >= 3 -> Stop';
const CLOCK: Pair[] = [['shipping: Remote, timer: Timer) -> Response {', 'shipping: Remote, timer: Timer, clock: Clock) -> Response {'], ['shipping: Remote, timer: Timer, message: Wake)', 'shipping: Remote, timer: Timer, clock: Clock, message: Wake)']];
const PLANNED_TIMER = 'fn planned(id: Int, decided: Plan) -> View {\n  match decided {\n    Again(after) -> "; again in " ++ decimal_text(value: after) ++ " ms"\n    Stop -> {\n      do wake(timer, after: 60000, key: id)\n      "; stopped, again in 60000 ms"\n    }\n  }\n}';
export const round3: Mutant[] = [
  // (1) a timer set with a move to a final state is keyed by the row and read back as woken reads it
  ['A1 cancel timer keyed 0 - id - 1 (canceled is final)', TIX, [['do wake(after: 0, key: 0 - id)\n      ShowEvent(status: 202, event: value)', 'do wake(after: 0, key: 0 - id - 1)\n      ShowEvent(status: 202, event: value)']], ['C78', CANCEL]],
  ['A2 cancel timer keyed id (woken reads holds by a positive key)', TIX, [['do wake(after: 0, key: 0 - id)\n      ShowEvent(status: 202, event: value)', 'do wake(after: 0, key: id)\n      ShowEvent(status: 202, event: value)']], ['C78', CANCEL]],
  ['A3 control: cancel timer keyed -id', TIX, [['do wake(after: 0, key: 0 - id)\n      ShowEvent(status: 202, event: value)', 'do wake(after: 0, key: -id)\n      ShowEvent(status: 202, event: value)']], []],
  // (2) a constructor carried in a record's field, or read through `with`
  ['B1 policy carried in a record field, its Stop not final', FUL, PLAN('Stop', GIVE, FIELD, PLANNED), ['C79', GIVE]],
  ['B2 control: the same, Stop declared final', FUL, PLAN('Stop final', GIVE, FIELD, PLANNED), []],
  ['B3 policy taken out of a record by a let pattern, Stop not final', FUL, PLAN('Stop', GIVE, PATTERN, PLANNED), ['C79', GIVE]],
  ['B4 control: the same, Stop declared final', FUL, PLAN('Stop final', GIVE, PATTERN, PLANNED), []],
  ['B7 control: record field, Stop not final but its arm sets the timer', FUL, PLAN('Stop', GIVE, FIELD.replace('planned(', 'planned(id, '), PLANNED_TIMER), []],
  ['B8 control: let pattern, Stop not final but its arm sets the timer', FUL, PLAN('Stop', GIVE, PATTERN.replace('planned(', 'planned(id, '), PLANNED_TIMER), []],
  ['B5 policy read by a let, whose else leaves the order', FUL, PLAN('Stop', GIVE, VIAWITH, WITH('"; stopped"')), ['C79', GIVE]],
  ['B6 control: the else of the let sets the timer', FUL, PLAN('Stop', GIVE, VIAWITH, WITH('{\n    do wake(timer, after: 60000, key: id)\n    "; stopped, again in 60000 ms"\n  }')), []],
  // (3) woken's guard in a function it calls
  ['C1 route(key): key > 0 is the sweep', TIX, routed('key > 0'), ['C78', 'INSERT INTO holds(client, tier, buyer, qty, amount, expires) VALUES', 'among']],
  ['C2 route(key): key < 10 is the sweep', TIX, routed('key < 10'), ['C78', 'INSERT INTO holds(client, tier, buyer, qty, amount, expires) VALUES', 'among']],
  ['C3 control: route(key): key < 0 is the sweep', TIX, routed('key < 0'), []],
  // (4) a sweep that picks by a subquery
  ['D1 no refund timer; sweep picks h.id IN (SELECT … confirmed)', TIX, [NOREFUNDWAKE, [SWEEP, "h.id IN (SELECT id FROM holds WHERE state = 'confirmed') ORDER BY h.id LIMIT 1"]], ['C77', REFUNDING]],
  ['D2 no refund timer; sweep picks EXISTS (correlated, confirmed)', TIX, [NOREFUNDWAKE, [SWEEP, "EXISTS (SELECT 1 FROM holds AS h2 WHERE h2.id = h.id AND h2.state = 'confirmed') ORDER BY h.id LIMIT 1"]], ['C77', REFUNDING]],
  ['D3 no refund timer; sweep picks NOT EXISTS (correlated, refunding or refunded)', TIX, [NOREFUNDWAKE, [SWEEP, "h.state <> 'held' AND NOT EXISTS (SELECT 1 FROM holds AS h2 WHERE h2.id = h.id AND h2.state IN ('refunding', 'refunded', 'paying', 'released', 'expired')) ORDER BY h.id LIMIT 1"]], ['C77', REFUNDING]],
  ['D4 control: no refund timer; the subquery admits refunding', TIX, [NOREFUNDWAKE, [SWEEP, "h.id IN (SELECT id FROM holds WHERE state IN ('confirmed', 'refunding')) ORDER BY h.id LIMIT 1"]], []],
  // (5) final is checked: made only where asking again gives it again; matched only on a call with a once key
  ['E1 Stop declared final, made on a clock reading that comes and goes (a nightly window)', FUL, [...CLOCK, ...PLAN('Stop final', 'failed >= 3 or now() % 86400000 < 3600000 -> Stop', VIAWITH.replace('planned(id, ', 'planned('), PLANNED)], ['C80', 'failed >= 3 or now() % 86400000 < 3600000 -> Stop']],
  ['E4 control: Stop declared final, made once a deadline has passed (now() > t only grows true)', FUL, [...CLOCK, ...PLAN('Stop final', 'failed >= 3 or now() > 1800000000000 -> Stop', VIAWITH.replace('planned(id, ', 'planned('), PLANNED)], []],
  ['E5 Stop declared final, made after a clock test came out false (now() > t may yet come true)', FUL, [...CLOCK, ...PLAN('Stop final', 'now() > 1800000000000 -> {\n      do wake(timer, after: 1000, key: id)\n      Again(after: 1000)\n    }\n    failed >= 3 -> Stop', VIAWITH.replace('planned(id, ', 'planned('), PLANNED)], ['C80', 'failed >= 3 -> Stop']],
  ['E2 refund asked (ask: a read, no once key): its Rejected is not a stored reply', FUL, [['call(to: payments, method: "refund", send: Refund(card, amount), reply: Refunded, within: wait, once: ForOrder(order: id))', 'ask(to: payments, method: "refund", send: Refund(card, amount), reply: Refunded, within: wait)']], ['C79', 'Rejected(reason) -> show(status: 500']],
  ['E6 Stop declared final, made by a function a caller calls only in a nightly window', FUL, [...CLOCK, ...PLAN('Stop final', 'failed >= 3 -> stop_now()\n    now() % 86400000 < 3600000 -> stop_now()', VIAWITH.replace('planned(id, ', 'planned('), PLANNED.replace('fn planned(', 'fn stop_now() -> Plan {\n  Stop\n}\n\nfn planned('))], ['C80', 'fn stop_now() -> Plan {\u0001Stop']],
  ['E3 control: Stop declared final, made on a count', FUL, PLAN('Stop final', GIVE, VIAWITH.replace('planned(id, ', 'planned('), PLANNED), []],
  // (6) a read filtered by state: its None is the row in another state, not gone
  ['F1 woken reads the hold only if held, paying or confirmed', TIX, [['else -> Ok(value: summary(outcome: due(found: load_hold(id: key))))', 'else -> Ok(value: summary(outcome: due(found: sql_first(row: Hold, query: "SELECT * FROM holds WHERE id = :key AND state IN (\'held\', \'paying\', \'confirmed\')", key))))']], ['C79', 'fn due(\u0001let Some(value: hold) = found else']],
  ['F2 control: the filter admits every timed state', TIX, [['else -> Ok(value: summary(outcome: due(found: load_hold(id: key))))', 'else -> Ok(value: summary(outcome: due(found: sql_first(row: Hold, query: "SELECT * FROM holds WHERE id = :key AND state IN (\'held\', \'paying\', \'refunding\')", key))))']], []],
];
if (import.meta.url === `file://${process.argv[1]}`) for (const m of round3) console.log(shown(m, 72));
