// bench/suite/crud-js.ts: the JS twin of crud.tape, written as one would write it by hand, and its inputs.
// Decoding refuses what decode refuses, with the same reason (LANGUAGE.md section 6): for each object, every field's
// kind in order, missing or null (a key no field names is left unread); then, in order, each field's condition, or
// each element of a list.
import type { NodeSql } from '../../nodesql.ts';
import { dec, enc, rng } from './rand.ts';
import type { Workload } from './common.ts';

type NewItem = { key: string; name: string; qty: number; cents: number };
const bytes = (s: string): number => enc.encode(s).length;
const isObject = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
class Refused extends Error {}
const refuse = (why: string): never => {
  throw new Refused(why);
};
/** A reason at `path` ('' for the body itself): `items[0].qty: missing`. */
const at = (path: string, why: string): string => (path === '' ? why : `${path}: ${why}`);
const inside = (path: string, k: string): string => (path === '' ? k : `${path}.${k}`);
/** The host's checks on one object: kinds in field order (missing, null, a wrong kind); other keys are left unread. */
function shape(v: unknown, fields: Record<string, 't' | 'i' | 'a'>, path = ''): Record<string, unknown> {
  if (!isObject(v)) return refuse(at(path, v === null && path !== '' ? 'null' : 'expected an object'));
  for (const [k, kind] of Object.entries(fields)) {
    const p = inside(path, k);
    if (!Object.hasOwn(v, k)) refuse(`${p}: missing`);
    const x = v[k];
    if (x === null) refuse(`${p}: null`);
    if (kind === 't' && typeof x !== 'string') refuse(`${p}: expected text`);
    if (kind === 'i' && !Number.isSafeInteger(x)) refuse(`${p}: expected an integer`);
    if (kind === 'a' && !Array.isArray(x)) refuse(`${p}: expected an array`);
    if (typeof x === 'string' && !x.isWellFormed()) refuse(`${p}: expected text without lone surrogates`);
  }
  return v;
}
const textIn = (v: string, lo: number, hi: number): boolean => bytes(v) >= lo && bytes(v) <= hi;
// after shape() these hold; the checks only tell the type checker so (they never refuse)
const asText = (x: unknown): string => (typeof x === 'string' ? x : refuse('expected text'));
const asWhole = (x: unknown): number => (typeof x === 'number' ? x : refuse('expected an integer'));
const asList = (x: unknown): unknown[] => (Array.isArray(x) ? x : refuse('expected an array'));
function item(v: unknown, i: number): NewItem {
  const path = `items[${i}]`;
  const o = shape(v, { key: 't', name: 't', qty: 'i', cents: 'i' }, path);
  const [key, name, qty, cents] = [asText(o['key']), asText(o['name']), asWhole(o['qty']), asWhole(o['cents'])];
  if (!textIn(key, 1, 64)) refuse(`${path}.key: expected Key, 1 to 64 bytes`);
  if (!textIn(name, 1, 200)) refuse(`${path}.name: expected Name, 1 to 200 bytes`);
  if (qty < 0 || qty > 1_000_000) refuse(`${path}.qty: expected Qty, 0 to 1000000`);
  if (cents < 0 || cents > 100_000_000) refuse(`${path}.cents: expected Cents, 0 to 100000000`);
  return { key, name, qty, cents };
}
function decode(body: string): { batch: string; items: NewItem[] } {
  if (body === '') refuse('empty');
  let v: unknown;
  try {
    v = JSON.parse(body);
  } catch {
    refuse('not JSON');
  }
  const o = shape(v, { batch: 't', items: 'a' });
  const batch = asText(o['batch']);
  if (!textIn(batch, 1, 64)) refuse('batch: expected Key, 1 to 64 bytes');
  return { batch, items: asList(o['items']).map(item) };
}

export function crud(db: NodeSql): (req: Uint8Array) => Uint8Array {
  db.exec(
    'CREATE TABLE IF NOT EXISTS items(id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, batch TEXT NOT NULL, name TEXT NOT NULL, qty INTEGER NOT NULL, cents INTEGER NOT NULL)',
  );
  db.exec('CREATE INDEX IF NOT EXISTS items_batch ON items(batch)');
  const answer = (status: number, body: string): Uint8Array => enc.encode(`${status}\n${body}`);
  return req => {
    const text = dec.decode(req);
    const nl = text.indexOf('\n');
    const line = nl < 0 ? text : text.slice(0, nl);
    if (line !== 'POST /items')
      return answer(404, '{"type":"about:blank","title":"Not Found","status":404,"detail":"no such route"}');
    let batch: string, items: NewItem[];
    try {
      ({ batch, items } = decode(nl < 0 ? '' : text.slice(nl + 1)));
    } catch (e) {
      if (e instanceof Refused)
        return answer(
          400,
          JSON.stringify({ type: 'about:blank', title: 'Bad Request', status: 400, detail: e.message }),
        );
      throw e;
    }
    let created = 0;
    for (const it of items)
      created += db.exec(
        'INSERT INTO items(key, batch, name, qty, cents) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(key) DO NOTHING',
        it.key,
        batch,
        it.name,
        it.qty,
        it.cents,
      ).rowsWritten;
    const [sum] = db
      .exec(
        'SELECT count(*) AS n, coalesce(sum(qty), 0) AS units, coalesce(sum(qty * cents), 0) AS cents FROM items WHERE batch = ?1',
        batch,
      )
      .toArray();
    const rows = db.exec('SELECT * FROM items WHERE batch = ?1 ORDER BY id', batch).toArray();
    return answer(
      200,
      JSON.stringify({ created, n: sum?.['n'], units: sum?.['units'], cents: sum?.['cents'], items: rows }),
    );
  };
}

const NAMES = ['lamp', 'desk', 'chair "deluxe"', 'mug\\cup', 'café crème', 'tab\there', '日本語', 'x'];
/** A batch of `n` items; keys from `k` (so a later batch can repeat an earlier one's keys). */
function batchOf(n: number, seed: number, k: number): string {
  const r = rng(seed);
  return JSON.stringify({
    batch: `batch-${k}`,
    items: Array.from({ length: n }, (_, i) => ({
      key: `item-${k}-${i}`,
      name: `${NAMES[r(0, NAMES.length - 1)]} ${r(1, 99999)}`,
      qty: r(0, 1000),
      cents: r(0, 250_000),
    })),
  });
}
const BAD = [
  '',
  'nope',
  '[]',
  '{}',
  '{"batch":"","items":[]}',
  '{"batch":"b","items":{}}',
  '{"batch":"b","items":[1]}',
  '{"batch":"b","items":[],"x":1}',
  '{"batch":7,"items":[]}',
  '{"batch":"b","items":[{"key":"k","name":"","qty":1,"cents":1}]}',
  '{"batch":"b","items":[{"key":"k","name":"n","qty":-1,"cents":1}]}',
  '{"batch":"b","items":[{"key":"k","name":"n","qty":1,"cents":1.5}]}',
  '{"batch":"b","items":[{"key":"k","name":"n","qty":1}]}',
  '{"batch":"b","items":[{"key":"k","name":"n","qty":1,"cents":1,"note":"x"}]}',
  '{"batch":"b","items":[{"key":"k","name":"n","qty":1,"cents":100000001}]}',
  `{"batch":"b","items":[{"key":"${'k'.repeat(65)}","name":"n","qty":1,"cents":1}]}`,
  `{"batch":"b","items":[{"key":"k","name":"${'é'.repeat(101)}","qty":1,"cents":1}]}`,
  '{"batch":"b","items":[{"key":"k","name":"\\ud800","qty":1,"cents":1}]}',
  '{"batch":"b","items":[{"key":"k1","name":"n","qty":1,"cents":1},{"key":"k2","name":"n","qty":1e7,"cents":1}]}',
  '{"batch":"b","items":[{"key":"k1","name":"n","qty":1e2,"cents":1}],"batch":"c"}',
];
export const workload: Workload = {
  name: 'crud',
  describe:
    'POST /items with a batch of items: decode + validate each, INSERT each, SELECT totals and the rows, encode',
  tape: 'bench/suite/crud.tape',
  sql: true,
  js: db =>
    crud(
      db ??
        (() => {
          throw new Error('crud needs a database');
        })(),
    ),
  inputs: () =>
    [...Array.from({ length: 90 }, (_, i) => batchOf([0, 1, 5, 40][i % 4] ?? 1, i + 1, i % 30)), ...BAD].map((b, i) =>
      enc.encode(i === 3 ? `GET /items\n${b}` : `POST /items\n${b}`),
    ),
  request: (k, scale) => enc.encode(`POST /items\n${batchOf(Math.round(2000 * scale), k + 1000, k + 1000)}`),
};
