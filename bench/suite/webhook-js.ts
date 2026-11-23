// bench/suite/webhook-js.ts: the JS twin of webhook.tape, written as one would by hand, and its inputs.
import type { NodeSql } from '../../nodesql.ts';
import { dec, enc, rng } from './rand.ts';
import type { Workload } from './common.ts';

type Event = { id: string; kind: string; account: string; amount: number; note: string };
const isObject = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
const bytes = (s: string): number => enc.encode(s).length;
class Refused extends Error {}
const refuse = (why: string): never => {
  throw new Refused(why);
};
const asText = (x: unknown): string => (typeof x === 'string' ? x : refuse('expected text'));
const asWhole = (x: unknown): number => (typeof x === 'number' ? x : refuse('expected an integer'));
const FIELDS = ['id', 'kind', 'account', 'amount', 'note'] as const;
function event(v: unknown, i: number): Event {
  const at = `events[${i}]`;
  if (!isObject(v)) return refuse(`${at}: ${v === null ? 'null' : 'expected an object'}`);
  for (const k of FIELDS) {
    if (!Object.hasOwn(v, k)) refuse(`${at}.${k}: missing`);
    const x = v[k];
    if (x === null) refuse(`${at}.${k}: null`);
    if (k === 'amount' ? !Number.isSafeInteger(x) : typeof x !== 'string')
      refuse(`${at}.${k}: expected ${k === 'amount' ? 'an integer' : 'text'}`);
    if (typeof x === 'string' && !x.isWellFormed()) refuse(`${at}.${k}: expected text without lone surrogates`);
  }
  // the loop above refused any other kind; these checks only tell the type checker so
  const e: Event = {
    id: asText(v['id']),
    kind: asText(v['kind']),
    account: asText(v['account']),
    amount: asWhole(v['amount']),
    note: asText(v['note']),
  };
  if (bytes(e.id) < 1 || bytes(e.id) > 64) refuse(`${at}.id: expected Id, 1 to 64 bytes`);
  if (bytes(e.account) < 1 || bytes(e.account) > 64) refuse(`${at}.account: expected Account, 1 to 64 bytes`);
  if (e.amount < 0 || e.amount > 100_000_000) refuse(`${at}.amount: expected Amount, 0 to 100000000`);
  return e;
}
function decode(body: string): { source: string; events: Event[] } {
  if (body === '') refuse('empty');
  let v: unknown;
  try {
    v = JSON.parse(body);
  } catch {
    refuse('not JSON');
  }
  if (!isObject(v)) return refuse('expected an object');
  if (!Object.hasOwn(v, 'source')) refuse('source: missing');
  const source = v['source'];
  if (source === null) refuse('source: null');
  if (typeof source !== 'string') return refuse('source: expected text');
  if (!source.isWellFormed()) refuse('source: expected text without lone surrogates');
  if (!Object.hasOwn(v, 'events')) refuse('events: missing');
  const events = v['events'];
  if (events === null) refuse('events: null');
  if (!Array.isArray(events)) return refuse('events: expected an array');
  return { source, events: events.map(event) };
}

export function webhook(db: NodeSql): (req: Uint8Array) => Uint8Array {
  db.exec('CREATE TABLE IF NOT EXISTS seen(id TEXT PRIMARY KEY NOT NULL, source TEXT NOT NULL)');
  db.exec(
    'CREATE TABLE IF NOT EXISTS payments(id TEXT PRIMARY KEY NOT NULL, account TEXT NOT NULL, amount INTEGER NOT NULL)',
  );
  db.exec(
    'CREATE TABLE IF NOT EXISTS customers(account TEXT PRIMARY KEY NOT NULL, total INTEGER NOT NULL, note TEXT NOT NULL)',
  );
  const pay = (e: Event, amount: number): number => {
    db.exec(
      'INSERT INTO payments(id, account, amount) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO NOTHING',
      e.id,
      e.account,
      amount,
    );
    return db.exec(
      "INSERT INTO customers(account, total, note) VALUES (?1, ?2, '') ON CONFLICT(account) DO UPDATE SET total = total + excluded.total",
      e.account,
      amount,
    ).rowsWritten;
  };
  const outcome = (source: string, e: Event): string => {
    if (
      db.exec('INSERT INTO seen(id, source) VALUES (?1, ?2) ON CONFLICT(id) DO NOTHING', e.id, source).rowsWritten !== 1
    )
      return 'duplicate';
    const ok = (n: number, what: string): string => (n === 1 ? what : 'failed');
    switch (e.kind) {
      case 'charge.succeeded':
        return ok(pay(e, e.amount), 'charged');
      case 'refund.created':
        return ok(pay(e, -e.amount), 'refunded');
      case 'customer.updated':
        return ok(
          db.exec(
            'INSERT INTO customers(account, total, note) VALUES (?1, 0, ?2) ON CONFLICT(account) DO UPDATE SET note = excluded.note',
            e.account,
            e.note,
          ).rowsWritten,
          'updated',
        );
      default:
        return 'ignored';
    }
  };
  return req => {
    const text = dec.decode(req);
    const nl = text.indexOf('\n');
    if ((nl < 0 ? text : text.slice(0, nl)) !== 'POST /hooks') return enc.encode('404\n{"error":"no such route"}');
    let d: { source: string; events: Event[] };
    try {
      d = decode(nl < 0 ? '' : text.slice(nl + 1));
    } catch (e) {
      if (e instanceof Refused) return enc.encode(`400\n${JSON.stringify({ error: e.message })}`);
      throw e;
    }
    const results = d.events.map(e => [e.id, outcome(d.source, e)]);
    const [t] = db.exec('SELECT count(*) AS customers, coalesce(sum(total), 0) AS total FROM customers').toArray();
    return enc.encode(`200\n${JSON.stringify({ results, customers: t?.['customers'], total: t?.['total'] })}`);
  };
}

const KINDS = ['charge.succeeded', 'charge.succeeded', 'refund.created', 'customer.updated', 'invoice.created'];
const WORDS = ['order', 'shipped', 'to', 'the', 'customer', 'café', '"quoted"', 'back\\slash', 'line\nbreak', '✓'];
/** `n` events of `source`; ids from `k`, about 3% sent twice (within or across batches). */
function delivery(n: number, seed: number, k: number): string {
  const r = rng(seed);
  const events: Event[] = [];
  for (let i = 0; i < n; i++) {
    const prev = events[r(0, Math.max(0, events.length - 1))];
    if (r(0, 99) < 3 && prev) {
      events.push({ ...prev });
      continue;
    }
    events.push({
      id: `evt_${k}_${i}_${r(0, 0xffffff).toString(16)}`,
      kind: KINDS[r(0, KINDS.length - 1)] ?? '',
      account: `cus_${r(0, 499)}`,
      amount: r(0, 50_000),
      note: Array.from({ length: r(3, 24) }, () => WORDS[r(0, WORDS.length - 1)]).join(' '),
    });
  }
  return JSON.stringify({ source: `stripe-${seed % 3}`, events });
}
const BAD = [
  '',
  '[]',
  '{"source":"s"}',
  '{"source":"s","events":[],"x":1}',
  '{"source":1,"events":[]}',
  '{"source":"s","events":[{"id":"","kind":"k","account":"a","amount":1,"note":""}]}',
  '{"source":"s","events":[{"id":"i","kind":"k","account":"","amount":1,"note":""}]}',
  '{"source":"s","events":[{"id":"i","kind":"k","account":"a","amount":-1,"note":""}]}',
  '{"source":"s","events":[{"id":"i","kind":"k","account":"a","amount":1}]}',
  '{"source":"s","events":[{"id":"i","kind":2,"account":"a","amount":1,"note":""}]}',
  '{"source":"s","events":[{"id":"i","kind":"k","account":"a","amount":1,"note":"","extra":0}]}',
  '{"source":"s","events":[null]}',
];
export const workload: Workload = {
  name: 'webhook',
  describe:
    'POST /hooks with a batch of events: decode + validate, dedupe by id (INSERT … ON CONFLICT), route by kind to 0–2 more statements',
  tape: 'bench/suite/webhook.tape',
  sql: true,
  js: db =>
    webhook(
      db ??
        (() => {
          throw new Error('webhook needs a database');
        })(),
    ),
  inputs: () =>
    [...Array.from({ length: 90 }, (_, i) => delivery([0, 1, 8, 60][i % 4] ?? 1, i + 3, i % 20)), ...BAD].map((b, i) =>
      enc.encode(i === 2 ? `PUT /hooks\n${b}` : `POST /hooks\n${b}`),
    ),
  request: (k, scale) => enc.encode(`POST /hooks\n${delivery(Math.round(10_000 * scale), k + 5, k + 1000)}`),
};
