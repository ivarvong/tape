// A Dec at the edges of a program: decoded from JSON (a number or text, exact at its scale, refused with the field
// otherwise), written to JSON as text with its scale's digits, in a hole, bound to a query as its count (an INTEGER)
// and read back from that column; parse_dec on text. The compiled build with the host, and the reference
// interpreter with a database of its own, against a parser and a writer written here from the definition.
import '../node25.ts';
import { DatabaseSync } from 'node:sqlite';
import { compile } from '../compiler.ts';
import { instantiate, responseOf } from '../host.ts';
import { interpret } from '../interp.ts';
import type { SqlParam } from '../interp.ts';
import { nodeSql } from '../nodesql.ts';
import { bare, call, finish, same, std, answered } from './harness.ts';

const program = `migration 1 "pay" {
  CREATE TABLE pay(id INTEGER PRIMARY KEY, amount INTEGER NOT NULL, fee INTEGER)
}

type Amount = Dec[2] where self > 0.00

type In {
  In(id: Int, amount: Amount, fee: Option[Dec[3]], parts: List[Dec[2]])
}

type Paid {
  Paid(id: Int, amount: Dec[2], fee: Option[Dec[3]])
}

type Out {
  Out(amount: Dec[2], fee: Dec[3], read: Dec[2], units: Int, parts: List[Dec[2]])
}

fn handle(raw: View, db: Sql) -> Response {
  match request(raw) {
    Request(method: Put, path: "/p", body) -> put(body, db)
    Request(method: Get, path: "/text/" ++ text) -> parsed(text)
    Request(method: Get, path: "/flat") -> buf()
      |> write_json(value: Flat(amount: -0.05, fee: 92233720368547.758)) |> respond_as(status: 200, content: Json)
    _ -> empty(status: 404)
  }
}

fn put(body: View, db: Sql) -> Response {
  let Ok(value: In(id, amount, fee, parts)) = decode(json: body, as: In) else {
    Err(error) -> buf() |> append(view: error) |> respond(status: 400)
  }
  let _ = sql_exec(query: "INSERT INTO pay(id, amount, fee) VALUES (:id, :amount, :fee) ON CONFLICT(id) DO UPDATE SET amount = excluded.amount, fee = excluded.fee", id, amount, fee: ofFee(fee))
  let Some(value: Paid(amount: back, fee: kept)) = sql_first(row: Paid, query: "SELECT id, amount, fee FROM pay WHERE id = :id", id) else -> empty(status: 404)
  let Some(value: units) = sql_first(row: Units, query: "SELECT amount AS units FROM pay WHERE id = :id", id) else -> empty(status: 404)
  buf()
    |> write_json(value: Out(amount, fee: ofFee(kept), read: back, units: units.units, parts)) |> respond_as(status: 200, content: Json)
}

type Flat {
  Flat(amount: Dec[2], fee: Dec[3])
}

type Units {
  Units(units: Int)
}

fn ofFee(fee: Option[Dec[3]]) -> Dec[3] {
  match fee {
    Some(value) -> value
    None -> 0.000
  }
}

fn parsed(text: View) -> Response {
  match parse_dec(text, scale: 2) {
    Some(value) -> buf() |> append(view: "\\(value)") |> respond(status: 200)
    None -> empty(status: 422)
  }
}
`;
const b = compile([...std, { name: 'edges.tape', text: program }]);
if (!b.wasm) throw new Error(b.errors.map(e => `${e.code} ${e.line} ${e.message}`).join('; '));
const app = instantiate(new WebAssembly.Module(b.wasm), { sql: nodeSql() });
const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE pay(id INTEGER PRIMARY KEY, amount INTEGER NOT NULL, fee INTEGER)');
// the interpreter has no lists in JSON (interp.ts): it runs the program without them
const flatProgram = program
  .replaceAll(', parts: List[Dec[2]]', '')
  .replaceAll('In(id, amount, fee, parts)', 'In(id, amount, fee)')
  .replace('units: units.units, parts)', 'units: units.units)');
const it = interpret([...std, { name: 'edges.tape', text: flatProgram }], {
  exec: (sql: string, p: SqlParam[]) => Number(db.prepare(sql).run(...p).changes),
  rows: (sql: string, p: SqlParam[]) => {
    const s = db.prepare(sql);
    s.setReturnArrays(true);
    return s
      .all(...p)
      .map(r =>
        Object.values(r).map(c =>
          typeof c === 'bigint' ? Number(c) : typeof c === 'number' || typeof c === 'string' ? c : null,
        ),
      );
  },
});
const dec = new TextDecoder(),
  enc = new TextEncoder();
const compiled = (req: string): string => {
  try {
    const r = responseOf(app.handle(enc.encode(req)));
    return `${r.status} ${dec.decode(r.body)}`;
  } catch (e) {
    return String(e);
  }
};
const interpreted = (req: string): string => {
  try {
    const out = answered(it.handle(enc.encode(req)));
    const [line = '', ...rest] = out.split('\n');
    return `${line.split(' ')[0] ?? ''} ${rest.join('\n')}`;
  } catch (e) {
    return `trap ${String(e)}`;
  }
};

// ---- the reference: text to a count at a scale, and a count to text, from the definition
const MIN = -(2n ** 63n),
  MAX = 2n ** 63n - 1n;
function countOf(text: string, s: number): bigint | null {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!m || ((m[2]?.length ?? 0) > 1 && m[2]?.startsWith('0'))) return null;
  const [whole = '', frac = ''] = [m[2], m[3]];
  const e = Number(m[4] ?? 0) - frac.length + s;
  let n = BigInt(whole + frac);
  // exact at the scale: what is cut off must be zeros
  if (e < -40) return n === 0n ? 0n : null;
  if (e < 0) {
    const p = 10n ** BigInt(-e);
    if (n % p !== 0n) return null;
    n /= p;
  } else if (e > 40) return n === 0n ? 0n : null;
  else n *= 10n ** BigInt(e);
  const v = m[1] === '-' ? -n : n;
  return v < MIN || v > MAX ? null : v;
}
const textOf = (n: bigint, s: number): string => {
  const neg = n < 0n,
    d = (neg ? -n : n).toString().padStart(s + 1, '0');
  return `${neg ? '-' : ''}${d.slice(0, d.length - s)}${s ? `.${d.slice(d.length - s)}` : ''}`;
};

// ---- 1. JSON in and out, SQL in and out
type Case = { amount?: string | number; fee?: string; raw?: string };
const cases: Case[] = [
  { amount: '12.30', fee: '0.125' },
  { amount: 12.3 },
  { amount: '12.300', fee: '-7' },
  { amount: '1.23e1' },
  { amount: 0.01, fee: '0.000' },
  { amount: '90071992547409.91' },
  { amount: '1e-2' },
  { amount: 5 },
  { raw: '12.345678901234567891e1' },
];
const bodyOf = (c: Case, k: number, parts: boolean): string =>
  `{"id": ${k}, "amount": ${c.raw ?? (typeof c.amount === 'string' ? JSON.stringify(c.amount) : String(c.amount))}${c.fee === undefined ? '' : `, "fee": ${JSON.stringify(c.fee)}`}${parts ? ', "parts": [1, "2.50", 0.333e1]' : ''}}`;
const want = (c: Case, parts: boolean): string => {
  const a = countOf(String(c.raw ?? c.amount), 2) ?? 0n;
  const f = c.fee === undefined ? 0n : (countOf(c.fee, 3) ?? 0n);
  const out = `{"amount":"${textOf(a, 2)}","fee":"${textOf(f, 3)}","read":"${textOf(a, 2)}","units":${a}${parts ? ',"parts":["1.00","2.50","3.33"]' : ''}}`;
  return `200 ${out}`;
};
same(
  'a Dec decoded from a number or text, stored as its count, read back, and written as text with its digits: compiled and interpreted',
  cases.map((c, k) => [compiled(`PUT /p\n${bodyOf(c, k, true)}`), interpreted(`PUT /p\n${bodyOf(c, k, false)}`)]),
  cases
    .slice(0, -1)
    .map(c => [want(c, true), want(c, false)])
    .concat([
      [
        '400 amount: expected a number with at most 2 decimals',
        '400 amount: expected a number with at most 2 decimals',
      ],
    ]),
);
const refused: [string, string][] = [
  ['{"id": 1, "amount": "12.345"}', 'amount: expected a number with at most 2 decimals'],
  ['{"id": 1, "amount": 12.345}', 'amount: expected a number with at most 2 decimals'],
  ['{"id": 1, "amount": "12"}', ''],
  ['{"id": 1, "amount": " 12"}', 'amount: expected a number with at most 2 decimals'],
  ['{"id": 1, "amount": "+12"}', 'amount: expected a number with at most 2 decimals'],
  ['{"id": 1, "amount": "012"}', 'amount: expected a number with at most 2 decimals'],
  ['{"id": 1, "amount": "12."}', 'amount: expected a number with at most 2 decimals'],
  ['{"id": 1, "amount": ".5"}', 'amount: expected a number with at most 2 decimals'],
  ['{"id": 1, "amount": true}', 'amount: expected a number with at most 2 decimals'],
  ['{"id": 1, "amount": null}', 'amount: null'],
  ['{"id": 1, "amount": "92233720368547758.08"}', 'amount: expected a number with at most 2 decimals'],
  ['{"id": 1, "amount": 1e999999999999}', 'amount: expected a number with at most 2 decimals'],
  ['{"id": 1, "amount": "-1.00"}', 'amount: expected Amount, more than 0.00'],
  ['{"id": 1, "amount": "1.00", "fee": "0.0001"}', 'fee: expected a number with at most 3 decimals'],
];
same(
  'refused, with the field: more digits than the scale, text that is not JSON’s number syntax, not a number, beyond the counts; a refinement',
  refused
    .filter(([, why]) => why !== '')
    .map(([body]) => [compiled(`PUT /p\n${body.replace('{', '{"parts": [], ')}`), interpreted(`PUT /p\n${body}`)]),
  refused.filter(([, why]) => why !== '').map(([, why]) => [`400 ${why}`, `400 ${why}`]),
);
same(
  'a list item that is not exactly a Dec[2] is refused with its index',
  compiled('PUT /p\n{"id": 1, "amount": 1, "parts": [1, 2.001]}'),
  '400 parts[1]: expected a number with at most 2 decimals',
);
same(
  'beyond ±2^53 units the database is not given the count: the request stops, nothing is rounded',
  [
    compiled('PUT /p\n{"id": 2, "amount": "90071992547409.93", "parts": []}').startsWith('Error'),
    interpreted('PUT /p\n{"id": 2, "amount": "90071992547409.93"}').startsWith('trap'),
  ],
  [true, true],
);

same(
  'a record of Decs alone is written as text too, compiled and interpreted',
  [compiled('GET /flat'), interpreted('GET /flat')],
  ['200 {"amount":"-0.05","fee":"92233720368547.758"}', '200 {"amount":"-0.05","fee":"92233720368547.758"}'],
);

// ---- 2. parse_dec and holes, against the reference
const TEXTS = [
  '12.3',
  '12.30',
  '12.300',
  '1.23e1',
  '1230e-2',
  '12.345',
  '-0.00',
  '0',
  '-92233720368547758.08',
  '92233720368547758.07',
  '92233720368547758.08',
  '1e999999999',
  '1e-999999999',
  '+12',
  '012',
  '12.',
  '.5',
  '0x10',
  '',
  '-',
  '1e',
  '00.5',
  '-0.05',
  '5e-1',
  '123456789012345678.9',
];
same(
  'parse_dec takes JSON’s number syntax, exact at the scale; a hole writes the scale’s digits: compiled and interpreted',
  TEXTS.map(t => [compiled(`GET /text/${t}`), interpreted(`GET /text/${t}`)]),
  TEXTS.map(t => {
    const n = countOf(t, 2);
    const w = n === null ? '422 ' : `200 ${textOf(n, 2)}`;
    return [w, w];
  }),
);

let seed = 0x2545f4914f6cdd1dn;
const rand = (n: number): number => {
  seed = BigInt.asUintN(64, seed * 6364136223846793005n + 1442695040888963407n);
  return Number((seed >> 33n) % BigInt(n));
};
const digits = (n: number): string => Array.from({ length: n }, () => String(rand(10))).join('');
const randomText = (): string => {
  const sign = ['', '', '-', '+'][rand(4)] ?? '';
  const whole = rand(8) === 0 ? '0' : digits(1 + rand(20));
  const frac = rand(2) ? `.${digits(rand(5))}${'0'.repeat(rand(3))}` : '';
  const exp = rand(4) === 0 ? `${['e', 'E'][rand(2)]}${['', '+', '-'][rand(3)]}${digits(1 + rand(2))}` : '';
  return `${sign}${whole}${frac}${exp}`;
};
const random = Array.from({ length: 3000 }, randomText);
same(
  `parse_dec of ${random.length} random texts, compiled and interpreted, as the reference reads them`,
  random
    .filter(t => {
      const n = countOf(t, 2);
      const w = n === null ? '422 ' : `200 ${textOf(n, 2)}`;
      return compiled(`GET /text/${t}`) !== w || interpreted(`GET /text/${t}`) !== w;
    })
    .slice(0, 5),
  [],
);

// ---- 3. the text of every count at every scale's edges
const holes = `fn show(n: Int) -> View {
  let d = dec(n: n, scale: 0) * 0.000000000000000001
  "\\(d)|\\(round(x: d, to: 2, rounding: Down))|\\(rescale(x: round(x: d, to: 0, rounding: Down), to: 1))"
}
`;
const hb = compile([...std, { name: 'h.tape', text: holes }], { exports: ['show'] });
if (!hb.wasm) throw new Error(hb.errors.map(e => e.message).join('; '));
const hx = bare(new WebAssembly.Module(hb.wasm)),
  hi = interpret([...std, { name: 'h.tape', text: holes }]);
// a View comes back as its address and length
const viewOf = (r: unknown): string => {
  const [at = 0, n = 0] = Array.isArray(r) ? r.map(Number) : [];
  return dec.decode(new Uint8Array(hx.memory.buffer, at, n));
};
const COUNTS = [0n, 1n, -1n, 5n, -5n, 10n ** 18n, -(10n ** 18n), 10n ** 18n - 1n, MAX, MIN, 1234567890123456789n];
const shown = COUNTS.map(n => {
  call(hx.fns, 'reset');
  let w: string;
  try {
    w = viewOf(call(hx.fns, 'show', n));
  } catch {
    w = `trap ${hx.why()}`;
  }
  const v = hi.call('show', [n]);
  return [w, v instanceof Uint8Array ? dec.decode(v) : 'not text'];
});
same(
  'holes write a Dec[18] and its roundings with their digits, the least and most counts too: compiled and interpreted',
  shown,
  COUNTS.map(n => {
    const at2 = n / 10n ** 16n,
      at0 = n / 10n ** 18n;
    const w = `${textOf(n, 18)}|${textOf(at2, 2)}|${textOf(at0 * 10n, 1)}`;
    return [w, w];
  }),
);
finish();
