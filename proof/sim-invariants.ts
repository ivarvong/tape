// Is each declared invariant able to fail? A rule that nothing can break proves nothing by holding. For each
// program this plants one bug its invariant is meant to catch (one edit of the source), runs `tape sim` on it
// with nothing else written, and expects a safety finding that names that invariant.
//   node proof/sim-invariants.ts [--seeds 200] [--only name]     writes proof/results/sim-invariants.json;
//                                                                  exits 1 if the outcomes are not the ones recorded
import '../node25.ts';
import { auto, search } from '../sim.ts';
import { arg, edited, program, record } from './lib.ts';

const seeds = Number(arg('seeds', '200')),
  only = arg('only', '');
const F = 'examples/fulfillment.tape examples/inventory.tape examples/payments.tape examples/shipping.tape'.split(' '),
  T = ['apps/tickets/tickets.tape', 'apps/tickets/pay.tape'];
// [files, file edited, text, replacement, the invariant that should fail]
type Plant = readonly [paths: string[], at: number, from: string, to: string, want: string];
const ALL: Plant[] = [
  [
    ['examples/ledger.tape'],
    0,
    'else -> rollback(out: problem(status: 404, reason: "no such payee"))',
    'else -> problem(status: 404, reason: "no such payee")',
    'each balance is its opening balance',
  ],
  [
    ['examples/ledger.tape'],
    0,
    'WHERE name = :from AND balance >= :amount AND NOT EXISTS',
    'WHERE name = :to AND NOT EXISTS',
    'no balance is below zero',
  ],
  [
    ['examples/hello.tape'],
    0,
    'VALUES (:name, 1)',
    'VALUES (:name, 0)',
    'a name greeted has been greeted at least once',
  ],
  [
    ['examples/ratelimit.tape'],
    0,
    'VALUES (:who, :slot, 1)',
    'VALUES (:who, :slot, 0)',
    'a slot with a row has at least one hit',
  ],
  [
    ['examples/counter.tape'],
    0,
    'INSERT INTO counted(op, name) VALUES (:op, :name)',
    'INSERT INTO counted(op, name) SELECT :op, :name WHERE 1 = 0',
    'a count has an op id recorded',
  ],
  [
    ['examples/tickets.tape'],
    0,
    'UPDATE sections SET seats = seats + :qty WHERE name = :section',
    'UPDATE sections SET seats = seats + :qty + 1 WHERE name = :section',
    "a section's seats left",
  ],
  [['examples/tickets.tape'], 0, 'amount: price * qty', 'amount: price', "a sale costs its section's price"],
  [
    ['examples/orders.tape', 'examples/stock.tape'],
    1,
    'remaining = remaining - 1',
    'remaining = remaining - 2',
    'stock taken for an item',
  ],
  [
    ['examples/orders.tape', 'examples/stock.tape'],
    1,
    'AND remaining > 0 RETURNING',
    'RETURNING',
    'an item has no fewer than none left',
  ],
  [
    F,
    1,
    'remaining = remaining - :qty WHERE sku = :sku AND remaining >= :qty',
    'remaining = remaining - :qty - 1 WHERE sku = :sku AND remaining >= :qty',
    'stock gone for an item',
  ],
  [
    F,
    1,
    'remaining = remaining + :qty WHERE',
    'remaining = remaining + :qty + :qty WHERE',
    'stock gone for an item|no more is released',
  ],
  [
    F,
    2,
    'balance = balance - :amount WHERE card = :card AND balance >= :amount',
    'balance = balance - :amount - 1 WHERE card = :card AND balance >= :amount',
    'a card is charged at least',
  ],
  [
    F,
    2,
    'balance = balance + :amount',
    'balance = balance + :amount + :amount',
    'a card is charged at least|no more is refunded',
  ],
  [F, 3, 'SELECT :address, :sku, :qty WHERE', 'SELECT :address, :sku, :qty + 1 WHERE', 'a done order has a label'],
  [F, 3, 'WHERE :address NOT IN (SELECT address FROM unserved) ', '', 'no label goes to an address'],
  [
    T,
    1,
    "VALUES (:card, :amount, 'charge', :ref)",
    "VALUES (:card, :amount + 1, 'charge', :ref)",
    "a card's balance is its opening balance",
  ],
  [T, 1, 'amount: 0 - amount', 'amount', 'a charge takes and a refund gives'],
  [
    ['examples/timed/authcapture.tape'],
    0,
    "state = 'authorized', void_at = :void_at",
    "state = 'authorized', void_at = :void_at * 0",
    'an authorized payment has a time',
  ],
  [
    ['examples/timed/delivery.tape'],
    0,
    "state = 'placed', accept_by = :accept_by",
    "state = 'placed', accept_by = :accept_by * 0",
    'a placed order has a time',
  ],
  [
    ['examples/timed/escalation.tape'],
    0,
    'INSERT INTO requests(client, approver, manager, due) VALUES (:key, :approver, :manager, :due)',
    'INSERT INTO requests(client, approver, manager, due, paged) VALUES (:key, :approver, :manager, :due, 1)',
    'nobody is paged',
  ],
  [
    ['examples/timed/expense.tape'],
    0,
    "state = 'paid', note = ''",
    "state = 'paid', note = 'late'",
    'a paid expense carries no failure note',
  ],
  [
    ['examples/timed/outbox.tape'],
    0,
    'moved(id, to: "delivered", note: "")',
    'moved(id, to: "delivered", note: "late")',
    'a delivered delivery carries no failure note',
  ],
  [
    ['examples/timed/transfer.tape'],
    0,
    'note = :note, tries = 0 WHERE',
    'note = :note, tries = 1 WHERE',
    'a finished transfer carries no attempts',
  ],
  [
    ['examples/timed/trial.tape'],
    0,
    'VALUES (:key, :email, :ends) ON CONFLICT',
    'VALUES (:key, :email, :ends * 0) ON CONFLICT',
    'a trial has an end',
  ],
  [
    ['testdata/compare/agent.tape'],
    0,
    'step = step + 1 WHERE',
    'step = step + 3 WHERE',
    'a run takes five steps at most',
  ],
  [
    ['testdata/compare/billing.tape'],
    0,
    'INSERT INTO invoices(sub, period, amount) VALUES (:id, :period, :price)',
    'INSERT INTO invoices(sub, period, amount) VALUES (:id, :period, :price + 1)',
    "an invoice is for its subscription's price",
  ],
  [
    ['testdata/compare/billing.tape'],
    0,
    "SET state = 'active', paid_through = max(paid_through, :period)",
    "SET state = 'active', paid_through = max(paid_through, :period + 1)",
    'a period paid through has its invoice',
  ],
  [
    ['examples/kv.tape'],
    0,
    'VALUES (:once, :key, :status, :version, :t) RETURNING',
    'VALUES (:once, :key, :status, :version + 1, :t) RETURNING',
    'a stored reply is for a key',
  ],
  [['apps/queue/queue.tape'], 0, '  do wake(after: for_ms, key: job.id)\n', '', 'no job is left leased'],
  [['apps/queue/queue.tape'], 0, 'attempt >= most -> held', 'attempt > most -> held', 'a job is tried no more often'],
  [
    ['apps/queue/queue.tape'],
    0,
    "SET state = 'done', worker = '', error = ''",
    "SET state = 'done', error = ''",
    'only a leased job has a worker',
  ],
  [
    ['apps/queue/queue.tape'],
    0,
    '  let None = sql_first(row: Job, query: "SELECT * FROM jobs WHERE lease = :key", key) else {\n    Some(value) -> Shown(status: 200, job: value)\n  }\n',
    '',
    'no lease key holds two jobs',
  ],
  [
    ['apps/queue/queue.tape'],
    0,
    'worker = :worker, lease = :key, lease_until = :lease_until WHERE',
    'worker = :worker, lease = :key, lease_until = :lease_until * 0 WHERE',
    'a leased job has a worker and a time',
  ],
  [
    ['examples/todo.tape'],
    0,
    'RETURNING *", key, title, done)',
    'RETURNING *", key, title, done: 2)',
    'a todo is done or not',
  ],
];
const plants = ALL.filter(p => only === '' || p[0].some(f => f.includes(only)));

type Row = { plant: string; result: string; want?: string; code?: string; found?: string };
/** The model of the programs with the bug planted, or what refused it. */
function planted(files: readonly { name: string; text: string }[]): ReturnType<typeof auto> {
  try {
    return auto(files, { clients: 4, ops: 10 });
  } catch (e) {
    return { errors: [{ code: 'sim', message: e instanceof Error ? e.message : String(e) }] };
  }
}
async function tried([paths, at, from, to, want]: Plant): Promise<Row> {
  const label = `${(paths[at] ?? '').replace(/^(examples|apps|compare)\//, '')}: ${from.slice(0, 44)}`;
  const files = paths.map(program);
  const text = edited(files[at]?.text ?? '', [[from, to]]);
  if (text === null) {
    console.log(`STALE   ${label}`);
    return { plant: label, result: 'no such text' };
  }
  const a = planted(files.map((f, i) => (i === at ? { ...f, text } : f)));
  if (a.errors) {
    const [no] = a.errors;
    console.log(`refused ${label}: ${no?.code} ${no?.message.slice(0, 90)}`);
    return { plant: label, want, result: 'refused', code: no?.code ?? '' };
  }
  const r = await search(a.model, { runs: seeds, steps: 120, faults: 3 });
  const said = r.failures.flatMap(f => f.violations);
  const hit = said.some(v => new RegExp(want).test(v));
  const [first] = said;
  const other = r.ok ? 'not caught' : 'another finding';
  const result = hit ? 'caught' : other;
  console.log(`${result.padEnd(7)} ${label}${hit || first === undefined ? '' : `: ${first.slice(0, 120)}`}`);
  return { plant: label, want, result, ...(first !== undefined && !hit ? { found: first.slice(0, 160) } : {}) };
}
const out: Row[] = [];
for (const p of plants) out.push(await tried(p));
const by = (k: string): number => out.filter(o => o.result === k).length;
console.log(
  `${out.length} planted bugs, one per invariant tried: ${by('caught')} caught by the invariant meant for it, ${by('another finding')} found another way, ${by('refused')} refused by the compiler, ${by('not caught')} not caught, ${by('no such text')} stale`,
);
if (only === '') record('sim-invariants', out);
// what is recorded: these are not caught (kv: the simulator cannot write a key to it; queue: the run that breaks
// the rule needs a job failed and leased again after its wait); anything else not caught is a failure
const OPEN = ['kv.tape', 'queue/queue.tape: attempt >= most'];
const bad = out.filter(
  o => o.result === 'no such text' || (o.result === 'not caught' && !OPEN.some(k => o.plant.startsWith(k))),
);
if (bad.length > 0) {
  console.log(`NOT AS RECORDED: ${bad.map(o => `${o.plant}: ${o.result}`).join('; ')}`);
  process.exit(1);
}
