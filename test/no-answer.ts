// C87: no answer is not a refusal (J1, docs/defects.md: a transport exception was taken for a refusal). An arm of a
// match on a call's reply that takes a refusal together with no answer (`Err(error)` or `_` with no `Rejected` arm
// above it) may answer the client, which sends again with the same key; it may not write to the database, make
// another call or set a timer, itself or through what it calls. Each edit is of the program of LANGUAGE.md section 8.
import '../node25.ts';
import { finish, lineOf, problems, same as T, swap, tour } from './harness.ts';

const whole = tour();
// C87's own refusals: the program's charge is also a timer's run, where an arm that only answers is C79's (a timer's
// run leaves the order paying), which is another rule's question
const codes = (text: string): string[] =>
  problems(text)
    .filter(e => e.code === 'C87')
    .map(e => `${e.code}:${e.line}`);
const c87 = (text: string): string => problems(text).find(e => e.code === 'C87')?.message ?? '';
const REFUSED = `        Err(error: Rejected(reason: Declined(reason))) -> moved(m: sql_move(row: Order, query: "UPDATE orders SET state = 'failed', note = :reason WHERE id = :id AND state = 'paying' RETURNING *", reason, id))
`;
const UNKNOWN = `        Err(error) -> {
          do wake(after: 5000, key: id)
          shown(status: 202, found: load(id))
        }
`;
/** The two arms after `Ok` replaced by these. */
const arms = (text: string, extra = ''): string => swap(whole, REFUSED + UNKNOWN, text) + extra;
const FAILED = `        Err(error) -> moved(m: sql_move(row: Order, query: "UPDATE orders SET state = 'failed', note = 'no charge' WHERE id = :id AND state = 'paying' RETURNING *", id))
`;
// J1's shape: the charge got no answer, and the order is refunded as if it had been refused
const REFUND = `        Err(error) -> refunded(id, amount)
`;
const REFUNDED = `
type Refund { Refund(order: Int, amount: Int) }
type Refunded { Refunded(refund: Int) }

fn refunded(id: Int, amount: Int) -> Outcome {
  let Ok(value: Refunded) = call(
    to: payments,
    method: "refund",
    send: Refund(order: id, amount),
    reply: Refunded,
    error: ChargeError,
    within: 2000,
    once: ForOrder(order: id)
  ) else -> shown(status: 502, found: load(id))
  shown(status: 200, found: load(id))
}
`;
const FAILS = `        Err(error) -> failing(id)
`;
const FAILING = `
fn failing(id: Int) -> Outcome {
  moved(m: sql_move(
    row: Order,
    query: "UPDATE orders SET state = 'failed' WHERE id = :id AND state = 'paying' RETURNING *",
    id
  ))
}
`;

T('the program these are edits of compiles', problems(whole), []);

// ---- refused: the arm takes both, and acts on the outcome
{
  const text = arms(FAILED);
  T('a state of failure written on a catch-all that takes Timeout: C87', codes(text), [
    `C87:${lineOf(text, FAILED.trim())}`,
  ]);
  const p = problems(text).find(e => e.code === 'C87');
  T(
    'the message says it writes, and why that is wrong',
    /takes a refusal together with no answer, and writes to the database: with no answer the call may have run/.test(
      p?.message ?? '',
    ),
    true,
  );
  T('the fix is an arm for Rejected alone', p?.hint.includes('`Err(error: Rejected(reason)) -> …`'), true);
}
{
  const text = arms(REFUND, REFUNDED);
  T('J1: a refund sent on a catch-all that takes Timeout (the charge may have run): C87', codes(text), [
    `C87:${lineOf(text, REFUND.trim())}`,
  ]);
  T(
    'the message says it makes another call',
    /and makes another call: with no answer the call may have run/.test(c87(text)),
    true,
  );
}
{
  const text = arms(FAILS, FAILING);
  T('the write made by a function the arm calls: C87', codes(text), [`C87:${lineOf(text, FAILS.trim())}`]);
}
{
  const text = arms(UNKNOWN.replace('Err(error)', '_'));
  T('`_` takes both too, and its timer asks for ever after a refusal: C87', codes(text), [
    `C87:${lineOf(text, '        _ -> {')}`,
  ]);
}
{
  // an arm for Timeout above does not take the refusal away from the catch-all
  const text = arms(`        Err(error: Timeout) -> shown(status: 202, found: load(id))\n${FAILED}`);
  T('an arm for Timeout above it: the catch-all still takes the refusal, C87', codes(text), [
    `C87:${lineOf(text, FAILED.trim())}`,
  ]);
}

// ---- accepted
T(
  'a catch-all that only answers the client (it sends again with the same key)',
  codes(arms(`        Err(error) -> shown(status: 503, found: load(id))\n`)),
  [],
);
T(
  'the refusal in its own arm: the catch-all takes only no answer, and may write',
  codes(arms(REFUSED + FAILED.replace("'failed', note = 'no charge'", "'paying', note = 'no answer yet'"))),
  [],
);
T(
  'Rejected, Timeout and Unreachable each above it: the catch-all takes only Skew, and may write',
  codes(
    arms(
      `${REFUSED}        Err(error: Timeout) -> shown(status: 202, found: load(id))\n        Err(error: Unreachable) -> shown(status: 503, found: load(id))\n${FAILED}`,
    ),
  ),
  [],
);
T(
  'an arm with a guard takes nothing for certain: a Rejected arm with a guard leaves the refusal to the catch-all',
  codes(arms(REFUSED.replace('Declined(reason)))', 'Declined(reason))) if reason == "card"') + FAILED)).length,
  1,
);

finish();
