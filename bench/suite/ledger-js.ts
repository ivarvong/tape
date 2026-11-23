// bench/suite/ledger-js.ts: the JS twin of ledger.tape, written as one would by hand, and its inputs.
import type { NodeSql } from '../../nodesql.ts';
import { dec, enc, rng } from './rand.ts';
import type { Workload } from './common.ts';

type Transfer = { key: string; from: string; to: string; amount: number };
const isObject = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
const bytes = (s: string): number => enc.encode(s).length;
class Refused extends Error {}
const refuse = (why: string): never => {
  throw new Refused(why);
};
const asText = (x: unknown): string => (typeof x === 'string' ? x : refuse('expected text'));
const asWhole = (x: unknown): number => (typeof x === 'number' ? x : refuse('expected a whole number'));
const FIELDS = ['key', 'from', 'to', 'amount'] as const;
function transfer(v: unknown, i: number): Transfer {
  const at = `transfers[${i}]: `;
  if (!isObject(v)) return refuse(`${at}not an object`);
  for (const k of FIELDS) {
    if (!Object.hasOwn(v, k)) refuse(`${at}missing key ${JSON.stringify(k)}`);
    const x = v[k];
    if (k === 'amount' ? !Number.isSafeInteger(x) : typeof x !== 'string')
      refuse(`${at}${k}: expected ${k === 'amount' ? 'a whole number' : 'text'}`);
    if (typeof x === 'string' && !x.isWellFormed()) refuse(`${at}${k}: text with a lone surrogate`);
  }
  // the loop above refused any other kind; these checks only tell the type checker so
  const t: Transfer = {
    key: asText(v['key']),
    from: asText(v['from']),
    to: asText(v['to']),
    amount: asWhole(v['amount']),
  };
  if (bytes(t.key) < 1 || bytes(t.key) > 64) refuse(`${at}key: not a valid Key`);
  if (t.amount < 1 || t.amount > 1_000_000) refuse(`${at}amount: not a valid Amount`);
  return t;
}
function decode(body: string): Transfer[] {
  if (body === '') refuse('empty');
  let v: unknown;
  try {
    v = JSON.parse(body);
  } catch {
    refuse('not JSON');
  }
  if (!isObject(v)) return refuse('not an object');
  if (!Object.hasOwn(v, 'transfers')) refuse('missing key "transfers"');
  if (!Array.isArray(v['transfers'])) refuse('transfers: expected an array');
  const transfers = v['transfers'];
  return (Array.isArray(transfers) ? transfers : refuse('transfers: expected an array')).map(transfer);
}

export function ledger(db: NodeSql): (req: Uint8Array) => Uint8Array {
  db.exec('CREATE TABLE IF NOT EXISTS accounts(name TEXT PRIMARY KEY NOT NULL, balance INTEGER NOT NULL)');
  db.exec(
    'CREATE TABLE IF NOT EXISTS transfers(key TEXT PRIMARY KEY, payer TEXT NOT NULL, payee TEXT NOT NULL, amount INTEGER NOT NULL)',
  );
  const one = (t: Transfer): number => {
    const [done] = db.exec('SELECT payer, payee, amount FROM transfers WHERE key = ?1', t.key).toArray();
    if (done) return done['payer'] === t.from && done['payee'] === t.to && done['amount'] === t.amount ? 200 : 422;
    if (db.exec('SELECT name FROM accounts WHERE name = ?1', t.to).toArray().length === 0) return 404;
    const debit = db.exec(
      'UPDATE accounts SET balance = balance - ?1 WHERE name = ?2 AND balance >= ?1 AND NOT EXISTS (SELECT 1 FROM transfers WHERE key = ?3 AND payer = ?2)',
      t.amount,
      t.from,
      t.key,
    );
    if (debit.rowsWritten !== 1) return 409;
    const credit = db.exec(
      'UPDATE accounts SET balance = balance + ?1 WHERE name = ?2 AND NOT EXISTS (SELECT 1 FROM transfers WHERE key = ?3 AND payee = ?2)',
      t.amount,
      t.to,
      t.key,
    );
    if (credit.rowsWritten !== 1) return 500;
    db.exec(
      'INSERT INTO transfers(key, payer, payee, amount) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(key) DO NOTHING',
      t.key,
      t.from,
      t.to,
      t.amount,
    );
    return 200;
  };
  return req => {
    const text = dec.decode(req);
    const nl = text.indexOf('\n');
    if ((nl < 0 ? text : text.slice(0, nl)) !== 'POST /transfers') return enc.encode('404\n{"error":"no such route"}');
    let transfers: Transfer[];
    try {
      transfers = decode(nl < 0 ? '' : text.slice(nl + 1));
    } catch (e) {
      if (e instanceof Refused) return enc.encode(`400\n${JSON.stringify({ error: e.message })}`);
      throw e;
    }
    const results = transfers.map(t => [t.key, one(t)]);
    const accounts = db.exec('SELECT * FROM accounts ORDER BY name').toArray();
    return enc.encode(`200\n${JSON.stringify({ results, accounts })}`);
  };
}

export const ACCOUNTS = 200;
/** The same opening balances on each database. */
export function seedAccounts(db: NodeSql): void {
  db.transaction(() => {
    for (let i = 0; i < ACCOUNTS; i++)
      db.exec('INSERT OR IGNORE INTO accounts VALUES (?1, ?2)', `acct-${String(i).padStart(3, '0')}`, 1000 + i * 37);
  });
}
/** `n` transfers; keys from `k`, a few repeated or reused, a few to or from no one, some too large. */
function batch(n: number, seed: number, k: number): string {
  const r = rng(seed);
  const acct = (): string =>
    r(0, 99) < 2 ? `ghost-${r(0, 9)}` : `acct-${String(r(0, ACCOUNTS - 1)).padStart(3, '0')}`;
  const made: Transfer[] = [];
  for (let i = 0; i < n; i++) {
    const roll = r(0, 99);
    const prev = made[r(0, Math.max(0, made.length - 1))];
    if (roll < 3 && prev) made.push({ ...prev });
    else if (roll < 5 && prev) made.push({ ...prev, amount: prev.amount + 1 });
    else made.push({ key: `t-${k}-${i}`, from: acct(), to: acct(), amount: r(1, roll < 10 ? 5000 : 300) });
  }
  return JSON.stringify({ transfers: made });
}
const BAD = [
  '',
  'x',
  '{}',
  '{"transfers":[],"x":1}',
  '{"transfers":[{"key":"","from":"a","to":"b","amount":1}]}',
  '{"transfers":[{"key":"k","from":"a","to":"b","amount":0}]}',
  '{"transfers":[{"key":"k","from":"a","to":"b","amount":1000001}]}',
  '{"transfers":[{"key":"k","from":"a","to":"b"}]}',
  '{"transfers":[{"key":"k","from":1,"to":"b","amount":1}]}',
  '{"transfers":[{"key":"k","from":"a","to":"b","amount":1,"memo":"m"}]}',
  '{"transfers":{}}',
  '{"transfers":["k"]}',
];
export const workload: Workload = {
  name: 'ledger',
  describe: 'POST /transfers with a batch of transfers: each a key check, a guarded debit and credit (CAS), an insert',
  tape: 'bench/suite/ledger.tape',
  sql: true,
  seed: seedAccounts,
  js: db =>
    ledger(
      db ??
        (() => {
          throw new Error('ledger needs a database');
        })(),
    ),
  inputs: () =>
    [...Array.from({ length: 90 }, (_, i) => batch([0, 1, 6, 50][i % 4] ?? 1, i + 7, i % 25)), ...BAD].map((b, i) =>
      enc.encode(i === 5 ? `GET /transfers\n${b}` : `POST /transfers\n${b}`),
    ),
  request: (k, scale) => enc.encode(`POST /transfers\n${batch(Math.round(2000 * scale), k + 99, k + 1000)}`),
};
