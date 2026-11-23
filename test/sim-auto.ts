// `tape sim`: a model from the programs alone (sim.ts auto), a Remote stood in for by its reply types, the guided
// search, an invariant across two programs, and rule C87 (a refusal apart from no answer).
import '../node25.ts';
import { replay, rng, search, shrink, valueOf } from '../sim.ts';
import type { Auto, AutoOptions } from '../sim/model.ts';
import type { Json } from '../sim/values.ts';
import { plants } from '../apps/tickets/plants.ts';
import { finish, ok, problems, read } from './harness.ts';
import { autoOf, wrongIn } from './simulated.ts';

const tickets = read('apps/tickets/tickets.tape'),
  pay = read('apps/tickets/pay.tape');
const planted = (words: string): string =>
  (plants.find(x => x.name.includes(words))?.pairs ?? []).reduce((t, [from, to]) => t.replace(from, to), tickets);
const both = (text: string, opts: AutoOptions = {}): Auto =>
  autoOf(
    [
      { name: 'tickets', text },
      { name: 'pay', text: pay },
    ],
    { clients: 4, ops: 10, ...opts },
  );

// what is read from the programs
const a = both(tickets);
const keys = a.routes.map(
  r =>
    `${r.method ?? '*'} ${r.path.map(p => p.lit ?? (p.int === undefined ? '<w>' : '<n>')).join('')}${r.body ? ` {${r.body}}` : ''}`,
);
ok(
  'paths and their bodies are read from the matches',
  [
    '* /holds {HoldReq}',
    '* /holds/<n>/checkout {Checkout}',
    '* /holds/<n>/refund',
    '* /events {NewEvent}',
    'GET /users/<w>/tickets',
  ].every(k => keys.includes(k)),
  keys.join(' | ').slice(0, 300),
);
ok(
  'no Remote is stood in for when its program is given, and the invariants are found',
  Object.keys(a.stubs).length === 0 && a.invariants.length === 11,
  String(a.invariants.length),
); // nine of tickets (the ninth bounds a sweep's waits), two of pay
const alone = autoOf([{ name: 'tickets', text: tickets }], { clients: 4, ops: 10 });
ok(
  'alone, pay is stood in for by the reply types of charge and refund',
  Object.keys(alone.stubs.pay ?? {})
    .toSorted()
    .join(',') === 'charge,refund' && alone.stubs.pay?.charge?.properties?.payment?.type === 'integer',
);
{
  const r = rng(3),
    schema = {
      type: 'object',
      required: ['key', 'qty', 'card'],
      properties: {
        key: { type: 'string', minLength: 1, maxLength: 64 },
        qty: { type: 'integer', minimum: 1, maximum: 9 },
        card: { type: 'string' },
        note: { type: 'string', maxLength: 3 },
        tiers: {
          type: 'array',
          items: { type: 'object', required: ['price'], properties: { price: { type: 'integer', minimum: 0 } } },
        },
      },
    };
  const ctx = { ids: [1, 2, 3, 40], keys: [], said: {}, dict: { card: ['visa-4242'] } },
    vs = Array.from({ length: 300 }, () => valueOf(schema, r, ctx));
  const fields = (v: Json): Record<string, Json> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {});
  const num = (v: Json | undefined): number => (typeof v === 'number' ? v : Number.NaN);
  const text = (v: Json | undefined): string => (typeof v === 'string' ? v : '');
  const priced = (tiers: Json | undefined): boolean =>
    tiers === undefined || (Array.isArray(tiers) && tiers.every(t => num(fields(t)['price']) >= 0));
  const fits = (v: Record<string, Json>): boolean =>
    num(v['qty']) >= 1 &&
    num(v['qty']) <= 9 &&
    text(v['key']).length > 0 &&
    (v['note'] === undefined || text(v['note']).length <= 3) &&
    priced(v['tiers']);
  const made = vs.map(fields);
  ok(
    'values fit their schema: bounds, lengths, required keys, text from the seed rows',
    made.every(fits) &&
      made.filter(v => v['card'] === 'visa-4242').length > 150 &&
      new Set(made.map(v => v['key'])).size < 300,
    `${new Set(made.map(v => v['key'])).size} keys in 300`,
  );
}

// as written: nothing wrong, with pay and without
const clean = await search(a.model, { runs: 250 });
ok(
  'tickets and pay as written: 250 guided runs, nothing wrong',
  clean.ok,
  clean.ok ? `${clean.actions} choices, ${clean.reached.length} states reached` : wrongIn(clean),
);
ok(
  'the search reaches the deep states',
  ['tickets.holds=confirmed', 'tickets.holds=refunding', 'tickets.holds=refunded', 'tickets.events=canceled'].every(s =>
    clean.reached.includes(s),
  ),
  clean.reached.join(' '),
);
const solo = await search(alone.model, { runs: 250 });
ok(
  'tickets alone, pay stood in for: nothing wrong',
  solo.ok,
  solo.ok
    ? `refund_failed ${solo.reached.includes('tickets.holds=refund_failed') ? '' : 'not '}reached`
    : wrongIn(solo),
);
ok(
  'a stood-in pay that refuses a refund takes the hold to refund_failed',
  solo.reached?.includes('tickets.holds=refund_failed'),
);

// the two bugs the production fault runs found, from the programs alone, rules off
for (const words of ['a decline without its expiry timer', 'a refund without its retry timer']) {
  const m = both(planted(words), { rules: false });
  const r = await search(m.model, { runs: 600 });
  ok(
    `${words}: found from the programs alone`,
    !r.ok && r.failures[0]?.kind === 'liveness',
    r.ok ? 'not found in 600 runs' : `run ${r.ran}: ${wrongIn(r).slice(0, 90)}`,
  );
  const [first] = r.failures;
  if (!first) continue;
  const again = await replay(m.model, first.script, { seed: first.seed });
  ok(`${words}: its script and seed replay to the same failure`, !again.ok && again.violations[0] === wrongIn(r));
}

// the bug the stand-in found: a refused refund asked again for ever. The arm that fixed it removed, rules off.
const REFUSAL = tickets.slice(
  tickets.indexOf('    // A refund the payment service refuses will be refused again'),
  tickets.indexOf(
    '    Err(error) -> refund_unknown(',
    tickets.indexOf('    // A refund the payment service refuses will be refused again'),
  ),
);
ok(
  'the refusal arm is where this test expects it',
  REFUSAL.includes('Err(error: Rejected(reason)) -> refund_refused('),
);
// and, as it was then, an unknown answer asked about again every 5 s with no cap (apps/tickets/tickets.tape now backs
// off and gives up, refund_unknown, so without the arm a refused refund ends in refund_unresolved instead)
const UNCAPPED =
  '    Err(error) -> {\n      do wake(after: 5000, key: id)\n      shown_hold(found: load_hold(id))\n    }';
ok('the unknown arm is where this test expects it', tickets.includes('    Err(error) -> refund_unknown(id, n: tries)'));
const before = tickets
  .replace(REFUSAL, '')
  .replace('    Err(error) -> refund_unknown(id, n: tries)', UNCAPPED)
  .replace('refunded(id, tries: tries_of(id), reply:', 'refunded(id, reply:')
  .replace('fn refunded(id: Int, tries: Int, reply:', 'fn refunded(id: Int, reply:');
const strict = problems(before);
ok(
  'C87: without that arm the program does not build',
  strict.map(e => e.code).join(',') === 'C87',
  strict[0]?.message.slice(0, 110),
);
{
  const m = autoOf([{ name: 'tickets', text: before }], { rules: false, clients: 4, ops: 10 }),
    r = await search(m.model, { runs: 600 });
  ok(
    'and the simulator, standing in for pay, finds what the rule is about',
    !r.ok && /asks again for ever/.test(wrongIn(r)),
    r.ok ? 'not found in 600 runs' : `run ${r.ran}: ${wrongIn(r).slice(0, 80)}`,
  );
  const real = await search(both(before, { rules: false }).model, { runs: 200 });
  ok(
    'with the real pay, which never refuses a refund, it does not show: the stand-in is what found it',
    real.ok,
    real.ok ? '' : wrongIn(real).slice(0, 90),
  );
}
ok(
  'C87: an arm for the refusal that sets the timer on purpose is accepted',
  problems(
    before.replace(
      '    Err(error) -> {\n      do wake(after: 5000, key: id)\n      shown_hold(found: load_hold(id))',
      '    Err(error: Rejected(reason)) -> {\n      do wake(after: 5000, key: id)\n      shown_hold(found: load_hold(id))\n    }\n    Err(error) -> {\n      do wake(after: 5000, key: id)\n      shown_hold(found: load_hold(id))',
    ),
  ).length === 0,
  'the question is asked; the simulator checks the answer',
);

// what the command says about its own reach, and the check that needs nothing declared
{
  const never = a.routes.filter(x => (a.answered.get(x.key)?.ok ?? 0) === 0).map(x => x.key);
  ok(
    'after the runs above, every path but the three form pages was answered 2xx at least once',
    never.every(k => /\/hold$|\/me$|<w>$/.test(k)) && never.length <= 3,
    never.join(' | '),
  );
  ok('tickets and pay: no request changes a row when sent a second time', clean.repeats.length === 0, clean.repeats[0]);
  // The duplicate rule: a request answered 200, 201 or 204, sent again at once, must not change where the rows end
  // up. A link made on every POST passes every rule of the compiler (the INSERT names its key: a random id) and
  // makes two links for one request heard twice.
  const keyless = `
schema "CREATE TABLE IF NOT EXISTS links(id INTEGER PRIMARY KEY, url TEXT NOT NULL)"
type NewLink { NewLink(url: View) }
type Link { Link(id: Int, url: View) }
fn handle(raw: View, db: Sql, dice: Entropy) -> Buf {
  match request(raw) {
    Request(method: "POST", path: "/links", body) -> create(body)
    _ -> respond(status: 404)
  }
}
fn create(body: View) -> Buf {
  let Ok(value: NewLink(url)) = decode(json: body, as: NewLink) else -> respond(status: 400)
  let Some(value) = sql_first(row: Link, query: "INSERT INTO links(id, url) VALUES (:id, :url) RETURNING *", id: random() % 1000000000, url) else -> respond(status: 500)
  respond(status: 201) |> write_json(value)
}`;
  const made = autoOf([{ name: 'links', text: keyless }], { clients: 4, ops: 10 });
  const twice = await search(made.model, { runs: 40 });
  ok(
    'a POST that makes a second row when it is sent twice passes the compiler and fails the simulator (repeat)',
    !twice.ok &&
      twice.failures[0]?.kind === 'repeat' &&
      /^sent twice: POST \/links .* rows without the duplicate/.test(wrongIn(twice)),
    twice.ok ? 'not found' : wrongIn(twice).slice(0, 160),
  );
  const off = await search({ ...made.model, duplicates: false }, { runs: 40 });
  ok(
    'with duplicates: false it is only a note',
    off.ok && off.repeats.some(n => /^POST \/links .*rows became/.test(n)),
    off.repeats[0],
  );
  const noted = await search({ ...made.model, duplicates: false, repeat: 'strict' }, { runs: 40 });
  ok('and with repeat: strict the note is a failure', !noted.ok && noted.failures[0]?.kind === 'repeat');
  // the same route with the client's key is one link however often it is sent
  const short = autoOf([{ name: 'shortener', text: read('examples/shortener.tape') }], { clients: 4, ops: 10 });
  const kept = await search(short.model, { runs: 60 });
  ok('examples/shortener.tape, which takes a key, passes', kept.ok, kept.ok ? '' : wrongIn(kept).slice(0, 160));
  // a write that says each attempt counts is the declared exception: every GET of hello counts a greeting
  const hello = autoOf([{ name: 'hello', text: read('examples/hello.tape') }], { clients: 4, ops: 10 });
  const counted = await search(hello.model, { runs: 40 });
  ok(
    'a write marked `repeat: True` may count twice (examples/hello.tape)',
    counted.ok,
    counted.ok ? '' : wrongIn(counted).slice(0, 160),
  );
  const unmarked = autoOf([{ name: 'hello', text: read('examples/hello.tape').replace('repeat: True, ', '') }], {
    rules: false,
    clients: 4,
    ops: 10,
  });
  const uncounted = await search(unmarked.model, { runs: 40 });
  ok(
    'without the mark the same count is a failure',
    !uncounted.ok && uncounted.failures[0]?.kind === 'repeat',
    uncounted.ok ? 'not found' : wrongIn(uncounted).slice(0, 120),
  );
  // the option that turns the repeat check off once shared a name with the limit on a timer's runs: turning one off
  // broke the other. With repeat off, a timer that runs for ever is still found.
  const m = autoOf([{ name: 'tickets', text: before }], { rules: false, clients: 4, ops: 10 }),
    r3 = await search({ ...m.model, repeat: false }, { runs: 600 });
  ok(
    'with the repeat check off, a timer that asks again for ever is still found',
    !r3.ok && /has run 100 times/.test(wrongIn(r3)),
    r3.ok ? 'not found' : wrongIn(r3).slice(0, 80),
  );
}

// an invariant across two programs
{
  const wrong = tickets.replace(
    'send: Charge(card, amount, ref: "hold-\\(id)")',
    'send: Charge(card, amount: amount + 1, ref: "hold-\\(id)")',
  );
  ok('the planted overcharge is in the text', wrong !== tickets);
  const r = await search(both(wrong, { rules: false }).model, { runs: 300 });
  ok(
    "a charge of one cent too much breaks the invariant that reads pay's ledger",
    !r.ok && /is charged its amount once it is confirmed/.test(wrongIn(r)),
    r.ok ? 'not found' : wrongIn(r).slice(60, 190),
  );
  const [first] = r.failures;
  if (first) {
    const small = await shrink(both(wrong, { rules: false }).model, first, { budget: 300 });
    ok(
      'and shrinks',
      small.script.length < first.script.length,
      `${first.script.length} -> ${small.script.length} choices`,
    );
  }
  const lone = await search(autoOf([{ name: 'tickets', text: wrong }], { rules: false }).model, { runs: 60 });
  ok('alone, that invariant cannot be run and is passed over', lone.ok || !/is charged its amount/.test(wrongIn(lone)));
}

finish();
