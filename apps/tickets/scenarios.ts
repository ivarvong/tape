// scenarios.ts: tickets.tape against pay.tape in node (world.ts). Each scenario ends with the invariants.
// node apps/tickets/scenarios.ts [tickets.tape source path]   (exit 1 on any failure; --json for plants.ts)
import { readFileSync } from 'node:fs';
import { world, sources } from './world.ts';
import type { Answer, World } from './world.ts';
import { cellText } from '../../host/log.ts';

type Result = { name: string; ok: boolean; got: unknown; want: unknown };
const results: Result[] = [];
const asJson = process.argv.includes('--json');
const T = (name: string, got: unknown, want: unknown): void => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  results.push({ name, ok, got, want });
  if (asJson) return;
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` -> ${JSON.stringify(got)} wanted ${JSON.stringify(want)}`}`,
  );
};
const [, , given] = process.argv;
const tickets = given !== undefined && !given.startsWith('--') ? readFileSync(given, 'utf8') : sources.tickets;
let n = 0;
const key = (p: string): string => `${p}-${++n}`;

function finish(): never {
  if (asJson) console.log(JSON.stringify(results));
  else console.log(`${results.length} checks, ${results.filter(r => !r.ok).length} failed`);
  process.exit(results.some(r => !r.ok) ? 1 : 0);
}
const fresh = async (): Promise<World> => {
  const w = await world({ tickets });
  if (w.errors === undefined) return w;
  T(
    'it compiles',
    w.errors.map(e => e.code),
    [],
  );
  return finish();
};
/** What an answer says, by field: none when it is not a JSON object. */
const fieldsIn = (json: unknown): Record<string, unknown> => {
  const fields: Record<string, unknown> = {};
  if (typeof json === 'object' && json !== null) Object.assign(fields, json);
  return fields;
};
const said = (r: Answer): Record<string, unknown> => fieldsIn(r.json);
const numberOf = (v: unknown): number => (typeof v === 'number' ? v : Number.NaN);
/** The hold an answer made. */
const made = (r: Answer): { id: number; qty: number } => ({ id: numberOf(said(r).id), qty: numberOf(said(r).qty) });
/** The seats a tier has left. */
const left = (w: World, tier: number): number => numberOf(w.row(`SELECT left FROM tiers WHERE id = ${tier}`).left);
const hold = (w: World, tier: number, buyer: string, qty = 1, extra: Record<string, number> = {}): Promise<Answer> =>
  w.req('POST /holds', { key: key('h'), tier, buyer, qty, ...extra });
const statuses = (rs: readonly Answer[]): number[] => rs.map(r => r.status);
const count = (xs: readonly number[], v: number): number => xs.filter(x => x === v).length;
const inv = (name: string, w: World): void => {
  T(`${name}: invariants`, w.check(), []);
};
/** Wait until the pay hop holds a call at its gate. */
const gated = async (w: World): Promise<void> => {
  while (w.gated() === 0)
    await new Promise<void>(turn => {
      setImmediate(turn);
    });
};
const sleep = (ms: number): Promise<void> =>
  new Promise(done => {
    setTimeout(done, ms);
  });

// 1. Oversell under concurrency: 40 buyers race for the 4 front-row seats, then all pay at once.
{
  const w = await fresh();
  const rs = await Promise.all(Array.from({ length: 40 }, (_, i) => hold(w, 3, `b${i}`)));
  T(
    'oversell: 40 concurrent holds on 4 seats: 4 held, 36 refused',
    [count(statuses(rs), 201), count(statuses(rs), 409)],
    [4, 36],
  );
  const won = rs.filter(r => r.status === 201).map(r => made(r).id);
  const paid = await Promise.all(won.map(id => w.req(`POST /holds/${id}/checkout`, { card: 'visa-4242' })));
  T(
    'oversell: the 4 pay concurrently, 4 confirmed',
    paid.map(r => said(r).state),
    ['confirmed', 'confirmed', 'confirmed', 'confirmed'],
  );
  T('oversell: 0 left, 4 tickets', [left(w, 3), w.row('SELECT count(*) AS n FROM tickets').n], [0, 4]);
  // mixed sizes on a bigger tier: never more than capacity
  const mixed = await Promise.all(Array.from({ length: 60 }, (_, i) => hold(w, 1, `m${i}`, 1 + (i % 4))));
  const taken = mixed.filter(r => r.status === 201).reduce((s, r) => s + made(r).qty, 0);
  T(
    'oversell: 60 concurrent holds of 1-4 seats on 20: at most 20 taken, and the rest refused',
    [taken <= 20, taken + left(w, 1)],
    [true, 20],
  );
  inv('oversell', w);
}

// 2. Hold expiry racing checkout.
{
  const w = await fresh();
  // (a) checkout moves the hold to paying, the charge is in flight when the hold's time is up and its timer fires
  const h = made(await hold(w, 2, 'ada', 2, { seconds: 2 }));
  w.faults.push('gate');
  const paying = w.req(`POST /holds/${h.id}/checkout`, { card: 'visa-4242' });
  await gated(w);
  w.advance(2500);
  const fired = w.fire(); // the timer sees paying and asks pay again with the same once key
  await sleep(5);
  w.open();
  const [c] = await Promise.all([paying, fired]);
  await w.fire();
  T(
    'expiry vs checkout (a): a paying hold is not expired; one charge',
    [
      said(c).state ?? c.status,
      w.row(`SELECT state FROM holds WHERE id = ${h.id}`).state,
      w.payRow(`SELECT count(*) AS n FROM ledger WHERE ref = 'hold-${h.id}'`).n,
    ],
    ['confirmed', 'confirmed', 1],
  );
  // (b) the timer comes first: the hold expires, the seats go back, and a late checkout is refused without a charge
  const h2 = made(await hold(w, 2, 'bob', 3, { seconds: 2 }));
  const before = left(w, 2);
  w.advance(2500);
  await w.fire();
  const late = await w.req(`POST /holds/${h2.id}/checkout`, { card: 'visa-4242' });
  T(
    'expiry vs checkout (b): expired first, checkout 409, seats back, no charge',
    [
      w.row(`SELECT state FROM holds WHERE id = ${h2.id}`).state,
      late.status,
      left(w, 2) - before,
      w.payRow(`SELECT count(*) AS n FROM ledger WHERE ref = 'hold-${h2.id}'`).n,
    ],
    ['expired', 409, 3, 0],
  );
  // (c) checkout at the exact expiry, before the timer ran: refused as expired (410), the timer then expires it
  const h3 = made(await hold(w, 2, 'cy', 1, { seconds: 2 }));
  w.advance(2000);
  const at = await w.req(`POST /holds/${h3.id}/checkout`, { card: 'visa-4242' });
  await w.fire();
  T(
    'expiry vs checkout (c): at the deadline checkout is 410 and the timer expires it',
    [at.status, w.row(`SELECT state FROM holds WHERE id = ${h3.id}`).state],
    [410, 'expired'],
  );
  // (d) a declined charge outlives the hold: the timer fires while it is paying (and is declined too), then the
  // request's decline lands; the hold must still expire and give its seats back (prod Jepsen, jepsen-tix-d6)
  const h4 = made(await hold(w, 2, 'dee', 2, { seconds: 2 }));
  const before4 = left(w, 2);
  w.faults.push('gate');
  const slow = w.req(`POST /holds/${h4.id}/checkout`, { card: 'poor-0002' });
  await gated(w);
  w.advance(2500);
  await w.fire();
  w.open();
  await slow;
  await w.fire();
  T(
    'expiry vs checkout (d): declined after its time was up, it still expires; seats back, no charge',
    [
      w.row(`SELECT state FROM holds WHERE id = ${h4.id}`).state,
      left(w, 2) - before4,
      w.payRow(`SELECT count(*) AS n FROM ledger WHERE ref = 'hold-${h4.id}'`).n,
    ],
    ['expired', 2, 0],
  );
  inv('expiry vs checkout', w);
}

// 3. Payment with an unknown outcome.
{
  const w = await fresh();
  const h = made(await hold(w, 4, 'ada', 2));
  w.faults.push('lost-after'); // pay charged, the reply was lost
  const r = await w.req(`POST /holds/${h.id}/checkout`, { card: 'visa-4242' });
  T(
    'unknown outcome: checkout answers 202, the hold stays paying, the money moved once',
    [r.status, said(r).state, w.payRow(`SELECT count(*) AS n FROM ledger WHERE ref = 'hold-${h.id}'`).n],
    [202, 'paying', 1],
  );
  inv('unknown outcome (in doubt)', w);
  w.advance(60000); // well past the hold's own expiry: a paying hold is never expired
  await w.fire();
  T(
    'unknown outcome: the timer asks again with the same once key and confirms; still one charge',
    [
      w.row(`SELECT state FROM holds WHERE id = ${h.id}`).state,
      w.payRow(`SELECT count(*) AS n FROM ledger WHERE ref = 'hold-${h.id}'`).n,
      w.row(`SELECT count(*) AS n FROM tickets WHERE hold = ${h.id}`).n,
    ],
    ['confirmed', 1, 2],
  );
  const h2 = made(await hold(w, 4, 'bob', 1));
  w.faults.push('lost-before', 'lost-before'); // never reached pay, twice
  const r2 = await w.req(`POST /holds/${h2.id}/checkout`, { card: 'visa-4242' });
  w.advance(5000);
  await w.fire(); // the retry is lost too
  T(
    'unknown outcome: lost before pay twice: still paying, nothing charged',
    [
      r2.status,
      w.row(`SELECT state FROM holds WHERE id = ${h2.id}`).state,
      w.payRow(`SELECT count(*) AS n FROM ledger WHERE ref = 'hold-${h2.id}'`).n,
    ],
    [202, 'paying', 0],
  );
  w.advance(5000);
  await w.fire();
  T(
    'unknown outcome: the third try reaches pay: confirmed, one charge',
    [
      w.row(`SELECT state FROM holds WHERE id = ${h2.id}`).state,
      w.payRow(`SELECT count(*) AS n FROM ledger WHERE ref = 'hold-${h2.id}'`).n,
    ],
    ['confirmed', 1],
  );
  inv('unknown outcome', w);
}

// 4. Duplicate checkout retries, and a declined card.
{
  const w = await fresh();
  const h = made(await hold(w, 1, 'ada', 3));
  const rs = await Promise.all(
    Array.from({ length: 8 }, () => w.req(`POST /holds/${h.id}/checkout`, { card: 'visa-4242' })),
  );
  const again = await w.req(`POST /holds/${h.id}/checkout`, { card: 'visa-4242' });
  T(
    'duplicates: 8 concurrent checkouts and a retry: all see confirmed, one charge, 3 tickets',
    [
      rs.every(r => said(r).state === 'confirmed'),
      said(again).state,
      w.payRow(`SELECT count(*) AS n FROM ledger WHERE ref = 'hold-${h.id}'`).n,
      w.row(`SELECT count(*) AS n FROM tickets WHERE hold = ${h.id}`).n,
    ],
    [true, 'confirmed', 1, 3],
  );
  const k = key('dup');
  const a = await w.req('POST /holds', { key: k, tier: 1, buyer: 'bob', qty: 2 }),
    b = await w.req('POST /holds', { key: k, tier: 1, buyer: 'bob', qty: 2 });
  T(
    'duplicates: the same hold key twice is one hold (201 then 200, same id)',
    [a.status, b.status, made(a).id === made(b).id],
    [201, 200, true],
  );
  const other = await w.req('POST /holds', { key: k, tier: 2, buyer: 'bob', qty: 2 });
  T('duplicates: the same key on another tier is 409 and takes no seats', [other.status, left(w, 2)], [409, 50]);
  const d = await w.req(`POST /holds/${made(a).id}/checkout`, { card: 'poor-0002' });
  const ok = await w.req(`POST /holds/${made(a).id}/checkout`, { card: 'amex-0005' });
  T(
    'declined: 402 and the hold is held again; another card confirms',
    [d.status, said(ok).state, said(ok).card],
    [402, 'confirmed', 'amex-0005'],
  );
  inv('duplicates', w);
}

// 5. Release, release twice, refund, transfer.
{
  const w = await fresh();
  const h = made(await hold(w, 2, 'ada', 4));
  const r1 = await w.req(`POST /holds/${h.id}/release`),
    r2 = await w.req(`POST /holds/${h.id}/release`);
  T('release twice: 200 then 409, the seats come back once', [r1.status, r2.status, left(w, 2)], [200, 409, 50]);
  const p = made(await hold(w, 2, 'ada', 2));
  await w.req(`POST /holds/${p.id}/checkout`, { card: 'visa-4242' });
  const pubRefund = await w.pub(`POST /holds/${p.id}/refund`);
  const f1 = await w.req(`POST /holds/${p.id}/refund`),
    f2 = await w.req(`POST /holds/${p.id}/refund`);
  T(
    'refund: public 403; operator refunds once (twice is the same answer); tickets void, seats back, money back',
    [
      pubRefund.status,
      said(f1).state,
      said(f2).state,
      w.row(`SELECT count(*) AS n FROM tickets WHERE hold = ${p.id} AND state = 'valid'`).n,
      left(w, 2),
      w.payRow(`SELECT sum(amount) AS s FROM ledger WHERE ref = 'hold-${p.id}'`).s,
    ],
    [403, 'refunded', 'refunded', 0, 50, 0],
  );
  const q = made(await hold(w, 1, 'ada', 1));
  await w.req(`POST /holds/${q.id}/checkout`, { card: 'visa-4242' });
  const t = numberOf(w.row(`SELECT id FROM tickets WHERE hold = ${q.id}`).id);
  const g1 = await w.req(`POST /tickets/${t}/transfer`, { from: 'ada', to: 'bob' }),
    g2 = await w.req(`POST /tickets/${t}/transfer`, { from: 'ada', to: 'cy' });
  const bobs = await w.req('GET /users/bob/tickets');
  T(
    'transfer: ada gives it to bob; ada cannot give it again (409); bob lists it',
    [g1.status, g2.status, Array.isArray(bobs.json) ? bobs.json.map((x: unknown) => fieldsIn(x).id) : null],
    [200, 409, [t]],
  );
  inv('release, refund, transfer', w);
}

// 5b. A refund cut short while its call is out (the object reset; found by the prod Jepsen run, seed 1). The gate
// is never opened: that run never finishes, and only what it committed before the call stays.
{
  const w = await fresh();
  const p = made(await hold(w, 2, 'ada', 2));
  await w.req(`POST /holds/${p.id}/checkout`, { card: 'visa-4242' });
  w.faults.push('gate');
  void w.req(`POST /holds/${p.id}/refund`); // abandoned
  await gated(w);
  T('cut refund: the hold is left refunding', w.row(`SELECT state FROM holds WHERE id = ${p.id}`).state, 'refunding');
  w.advance(6000);
  await w.fire();
  T(
    'cut refund: its timer asks pay again and settles it; refunded once, seats back',
    [
      w.row(`SELECT state FROM holds WHERE id = ${p.id}`).state,
      w.payRow(`SELECT sum(amount) AS s FROM ledger WHERE ref = 'hold-${p.id}'`).s,
      left(w, 2),
    ],
    ['refunded', 0, 50],
  );
  inv('cut refund', w);
}

// 6. Waitlist promotion when holds expire.
{
  const w = await fresh();
  const hs = await Promise.all([hold(w, 3, 'f1', 2, { seconds: 10 }), hold(w, 3, 'f2', 2, { seconds: 10 })]);
  const wl = await w.req('POST /waitlist', { key: key('w'), tier: 3, buyer: 'carol', qty: 2 });
  const wl2 = await w.req('POST /waitlist', { key: key('w'), tier: 3, buyer: 'dan', qty: 3 });
  T(
    'waitlist: sold out, carol and dan wait',
    [statuses(hs), said(wl).state, said(wl2).state],
    [[201, 201], 'waiting', 'waiting'],
  );
  const [first] = hs;
  await w.req(`POST /holds/${made(first).id}/checkout`, { card: 'visa-4242' });
  w.advance(11000);
  await w.fire(); // the unpaid hold expires; its 2 seats go to carol (dan needs 3)
  const c = w.row(`SELECT * FROM waitlist WHERE buyer = 'carol'`);
  const offered = numberOf(c.hold);
  const ch = w.row(`SELECT * FROM holds WHERE id = ${offered}`);
  T(
    "waitlist: the expired hold's seats are offered to carol as a hold of her own; dan still waits",
    [c.state, ch.buyer, ch.qty, ch.state, w.row(`SELECT state FROM waitlist WHERE buyer = 'dan'`).state],
    ['offered', 'carol', 2, 'held', 'waiting'],
  );
  await w.fire(); // firing again does not offer twice
  T(
    'waitlist: a timer firing again offers nothing more',
    w.row(`SELECT count(*) AS n FROM holds WHERE buyer = 'carol'`).n,
    1,
  );
  w.advance(301000);
  await w.fire(); // carol does not pay either: her hold expires and the seats return
  T(
    "waitlist: carol's offer expires too; the seats are back",
    [w.row(`SELECT state FROM holds WHERE id = ${offered}`).state, left(w, 3)],
    ['expired', 2],
  );
  inv('waitlist', w);
}

// 7. Admin cancel of an event, refunding everyone; one charge still in doubt when it starts.
{
  const w = await fresh();
  const paid = [];
  for (let i = 0; i < 5; i++) {
    const h = made(await hold(w, 1 + (i % 2), `p${i}`, 1 + (i % 3)));
    await w.req(`POST /holds/${h.id}/checkout`, { card: 'visa-4242' });
    paid.push(h.id);
  }
  await hold(w, 2, 'idle', 2);
  const doubt = made(await hold(w, 1, 'doubt', 1));
  w.faults.push('lost-after');
  await w.req(`POST /holds/${doubt.id}/checkout`, { card: 'amex-0005' });
  // tier 1 is now 20 - (1 + 3 + 2) - 1 = 13 left: fill it so a waitlist can form
  await hold(w, 1, 'filler', 8);
  await hold(w, 1, 'filler2', 5);
  await w.req('POST /waitlist', { key: key('w'), tier: 1, buyer: 'late', qty: 1 });
  const pub = await w.pub('POST /events/1/cancel');
  const c = await w.req('POST /events/1/cancel'),
    c2 = await w.req('POST /events/1/cancel');
  T('cancel: public 403; operator 202, again 200', [pub.status, c.status, c2.status], [403, 202, 200]);
  for (let i = 0; i < 6; i++) {
    await w.fire();
    w.advance(5000);
  }
  const states = w
    .rows(
      'SELECT h.state, count(*) AS n FROM holds AS h JOIN tiers AS t ON t.id = h.tier WHERE t.event = 1 GROUP BY h.state ORDER BY h.state',
    )
    .map(r => `${cellText(r.state)}:${cellText(r.n)}`);
  T(
    'cancel: every paid order refunded (the one in doubt too, once it settled), open holds released, the waitlist dropped',
    [states, w.row("SELECT state FROM waitlist WHERE buyer = 'late'").state],
    [['refunded:6', 'released:3'], 'dropped'],
  );
  T('cancel: no money stays charged for event 1', w.payRow('SELECT coalesce(sum(amount), 0) AS s FROM ledger').s, 0);
  T(
    'cancel: holds and the waitlist on a canceled event are refused',
    [
      (await hold(w, 1, 'z')).status,
      (await w.req('POST /waitlist', { key: key('w'), tier: 1, buyer: 'z', qty: 1 })).status,
    ],
    [409, 404],
  );
  T('cancel: event 2 is untouched', w.row('SELECT state FROM events WHERE id = 2').state, 'onsale');
  inv('cancel', w);
}

// 8. The pages: HTML, escaped, through the public route; forms post once per key.
{
  const w = await fresh();
  const home = await w.pub('GET /');
  T(
    'pages: / is HTML with the demo events and a hold form',
    [home.type, home.text.includes('Tape Live: The Retry Tour'), home.text.includes('action="buy"')],
    ['text/html; charset=utf-8', true, true],
  );
  const k = /name=key value="([^"]+)"/.exec(home.text)?.[1] ?? '';
  const form = `key=${k}&tier=1&buyer=%3Cscript%3Ealert(1)%3C%2Fscript%3E&qty=2`;
  const a = await w.pub('POST /buy', form),
    b = await w.pub('POST /buy', form);
  T(
    'pages: the hold form posted twice is one hold; the name is escaped',
    [
      a.status,
      b.status,
      w.row('SELECT count(*) AS n FROM holds').n,
      a.text.includes('<script>'),
      a.text.includes('&lt;script&gt;'),
    ],
    [201, 200, 1, false, true],
  );
  const id = numberOf(w.row('SELECT id FROM holds').id);
  const paid = await w.pub(`POST /pay?id=${id}`, 'card=visa-4242');
  T(
    'pages: pay from the hold page: confirmed, tickets listed',
    [paid.status, paid.text.includes('<b>confirmed</b>'), (paid.text.match(/Ticket \d+/g) ?? []).length],
    [200, true, 2],
  );
  const me = await w.pub('GET /me?buyer=%3Cscript%3Ealert(1)%3C%2Fscript%3E');
  T(
    'pages: my tickets lists both, with transfer forms',
    [me.status, (me.text.match(/action="give\?id=/g) ?? []).length],
    [200, 2],
  );
  const t = numberOf(w.row('SELECT id FROM tickets ORDER BY id').id);
  const g = await w.pub(`POST /give?id=${t}`, `from=%3Cscript%3Ealert(1)%3C%2Fscript%3E&to=bob`);
  T(
    'pages: transfer from the page; bob has it',
    [g.status, w.row(`SELECT owner FROM tickets WHERE id = ${t}`).owner],
    [200, 'bob'],
  );
  T(
    'pages: admin JSON through the public route is 403',
    [
      (await w.pub('POST /events', { key: 'x', name: 'x', starts: 'x' })).status,
      (await w.req('POST /events', { key: 'x', name: 'x', starts: 'x' })).status,
    ],
    [403, 201],
  );
  T('pages: JSON is application/json', (await w.pub('GET /events')).type, 'application/json');
  inv('pages', w);
}

finish();
