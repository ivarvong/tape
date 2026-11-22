// apps/queue: the second app. It builds with the rules on, does what its header says request by request (the same
// request twice included), declares invariants that hold throughout, and `tape sim` reaches every path and state
// and finds nothing wrong.
import '../node25.ts';
import { readFileSync } from 'node:fs';
import { instantiate, responseOf } from '../host.ts';
import { nodeSql } from '../nodesql.ts';
import { format } from '../fmt.ts';
import { build, search } from '../sim.ts';
import type { Json } from '../sim/values.ts';
import { finish, ok } from './harness.ts';
import { autoOf, wrongIn } from './simulated.ts';

const dec = new TextDecoder(),
  enc = new TextEncoder();
const text = readFileSync(new URL('../apps/queue/queue.tape', import.meta.url), 'utf8');
const q = build(text);
ok(
  'apps/queue builds with the rules on',
  !q.errors,
  q.errors
    ?.map(e => `${e.code}:${e.line} ${e.message}`)
    .join(' | ')
    .slice(0, 300),
);
ok("it is in fmt's layout", format(text) === text);
if (q.errors) {
  console.log('1 FAILED');
  process.exit(1);
}

const sql = nodeSql(),
  app = instantiate(q.module, { sql, name: 't/queue', services: {} });
/** An answer's fields when it is a JSON object; any other answer is its text, under `text`. */
type Fields = Record<string, Json>;
const fieldsOf = (answer: string): Fields => {
  const parsed: unknown = answer.startsWith('{') ? JSON.parse(answer) : null;
  return typeof parsed === 'object' && parsed !== null ? Object.fromEntries(Object.entries(parsed)) : { text: answer };
};
/** A field that is a number; 0 when it is not. */
const num = (v: Json | undefined): number => (typeof v === 'number' ? v : 0);
const req = async (line: string, body: Json = ''): Promise<[number, Fields]> => {
  const sent = enc.encode(`${line}\n${typeof body === 'string' ? body : JSON.stringify(body)}`);
  const r = responseOf((await app.runLogged(sent, { transaction: f => sql.transaction(f) })).out);
  return [r.status, fieldsOf(dec.decode(r.body))];
};
const holds = (what: string) => {
  const bad = app.invariants();
  ok(
    `the invariants hold ${what}`,
    bad.length === 0,
    bad.map(b => `${b.name}: ${JSON.stringify(b.rows[0])}`).join('; '),
  );
};

const [s1, j1] = await req('POST /jobs', { key: 'a', kind: 'mail', payload: 'hello', most: 2 });
const [s2, j2] = await req('POST /jobs', { key: 'a', kind: 'mail', payload: 'hello', most: 2 });
ok(
  'a job is made once per key: 201, then 200 with the same job',
  s1 === 201 && s2 === 200 && j1.id === j2.id && j1.state === 'ready',
  `${s1} ${s2}`,
);
const [s3] = await req('POST /jobs', { key: 'b', kind: 'mail', payload: 'later', delay_ms: 3600000 });
ok('a job with a delay is made', s3 === 201);
const [l1s, l1] = await req('POST /lease', { key: 'w1-1', worker: 'w1', kind: 'mail', for_ms: 60000 });
const [l2s, l2] = await req('POST /lease', { key: 'w1-1', worker: 'w1', kind: 'mail', for_ms: 60000 });
ok(
  'a lease takes the job that is due; the same lease again is the same job, not another',
  l1s === 200 &&
    l1.state === 'leased' &&
    l1.attempts === 1 &&
    l1.worker === 'w1' &&
    l2s === 200 &&
    l2.id === l1.id &&
    l2.attempts === 1,
  JSON.stringify(l2),
);
const [l3s] = await req('POST /lease', { key: 'w2-1', worker: 'w2', kind: 'mail', for_ms: 60000 });
ok('nothing else is due (the other job waits an hour): 204', l3s === 204, String(l3s));
holds('with a job leased');
const [n0] = await req(`POST /jobs/${num(l1.id)}/nack`, { attempt: 7, error: 'not mine' });
ok('a nack for an attempt that does not hold the lease changes nothing: 409', n0 === 409, String(n0));
const [n1s, n1] = await req(`POST /jobs/${num(l1.id)}/nack`, { attempt: 1, error: 'smtp down' });
ok(
  'a nack puts the job back, to run later, with the error',
  n1s === 200 &&
    n1.state === 'ready' &&
    n1.worker === '' &&
    n1.error === 'smtp down' &&
    num(n1.run_at) > Date.now() + 500,
  JSON.stringify(n1),
);
const [l4s] = await req('POST /lease', { key: 'w2-2', worker: 'w2', kind: 'mail', for_ms: 60000 });
ok('it is not due again at once: 204', l4s === 204, String(l4s));
sql.exec('UPDATE jobs SET run_at = 0 WHERE id = ?1', num(l1.id)); // the wait, gone by
const [l5s, l5] = await req('POST /lease', { key: 'w2-3', worker: 'w2', kind: 'mail', for_ms: 60000 });
ok('due again, it is leased as attempt 2', l5s === 200 && l5.attempts === 2 && l5.worker === 'w2', JSON.stringify(l5));
const [a0] = await req(`POST /jobs/${num(l5.id)}/ack`, { attempt: 1 });
ok('an ack from the attempt that lost the lease is refused: 409', a0 === 409, String(a0));
const [e1s, e1] = await req(`POST /jobs/${num(l5.id)}/extend`, { attempt: 2, for_ms: 120000 });
ok(
  'the attempt that holds the lease can make it longer',
  e1s === 200 && num(e1.lease_until) > num(l5.lease_until),
  JSON.stringify(e1),
);
// the lease runs out: the timer's run gives the job back, and this was its last try
const due = app.due(Date.now() + 86400000);
ok('the lease has a timer', due.includes(num(l5.id)), JSON.stringify(due));
await app.wake(num(l5.id), { transaction: f => sql.transaction(f), now: Date.now() });
const [, early] = await req(`GET /jobs/${num(l5.id)}`);
ok(
  'a timer that fires before the lease ends leaves it leased, and waits again',
  early.state === 'leased' && app.due(Date.now() + 86400000).includes(num(l5.id)),
  JSON.stringify(early.state),
);
sql.exec('UPDATE jobs SET lease_until = 1 WHERE id = ?1', num(l5.id));
await app.wake(num(l5.id), { transaction: f => sql.transaction(f), now: Date.now() + 200000 });
const [, dead] = await req(`GET /jobs/${num(l5.id)}`);
ok(
  'a lease that ran out on the last try leaves the job dead',
  dead.state === 'dead' && dead.worker === '' && dead.attempts === 2 && dead.error === 'the lease ran out',
  JSON.stringify(dead),
);
holds('with a job dead');
const [r1s, r1] = await req(`POST /jobs/${num(l5.id)}/retry`);
ok(
  'a dead job asked for again is ready with five more tries, and its attempts are not set back',
  r1s === 200 && r1.state === 'ready' && r1.attempts === 2 && r1.most === 7,
  JSON.stringify(r1),
);
const [, l6] = await req('POST /lease', { key: 'w1-9', worker: 'w1', kind: 'mail', for_ms: 60000 });
const [k1s, k1] = await req(`POST /jobs/${num(l6.id)}/ack`, { attempt: 3 }),
  [k2s, k2] = await req(`POST /jobs/${num(l6.id)}/ack`, { attempt: 3 });
ok(
  'an ack finishes the job; the same ack again says so',
  k1s === 200 && k1.state === 'done' && k2s === 200 && k2.state === 'done',
  `${k1s} ${k2s}`,
);
const [k3s] = await req(`POST /jobs/${num(l6.id)}/ack`, { attempt: 1 });
ok("an old attempt's ack does not pass for it", k3s === 409, String(k3s));
const [, stats] = await req('GET /stats');
ok(
  'GET /stats counts jobs by state',
  stats.text === '[{"state":"done","jobs":1},{"state":"ready","jobs":1}]',
  JSON.stringify(stats.text),
);
const [b1] = await req('POST /jobs', { key: 'c', kind: '', payload: 'x' }),
  [b2] = await req('POST /lease', { key: 'k', worker: 'w', kind: 'mail', for_ms: 5 });
ok(
  'a kind that is empty and a lease shorter than a second are refused by their types: 400',
  b1 === 400 && b2 === 400,
  `${b1} ${b2}`,
);
holds('at the end');

// the simulator, with nothing written for it
const a = autoOf([{ name: 'queue', text }], { clients: 4, ops: 10 }),
  r = await search(a.model, { runs: 200, steps: 120, faults: 3 });
ok('tape sim: 200 runs, nothing wrong', r.ok, r.ok ? `${r.actions} choices` : wrongIn(r));
const never = a.routes.filter(x => (a.answered.get(x.key)?.ok ?? 0) === 0).map(x => x.key);
ok('every one of its nine paths was answered 2xx', a.routes.length === 9 && never.length === 0, never.join(' | '));
ok(
  'every state of a job was reached',
  ['ready', 'leased', 'done', 'dead'].every(s => r.reached?.includes(`queue.jobs=${s}`)),
  (r.reached ?? []).join(' '),
);
ok('seven invariants were checked', a.invariants.length === 7, String(a.invariants.length));

finish();
