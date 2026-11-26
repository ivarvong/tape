// std/time.tape's civil, rfc3339 and http_date against JavaScript's Date (getUTC*, toISOString, toUTCString), in
// the compiled build, the build without cell reuse and the reference interpreter. Date holds ±8.64e15 ms (about
// ±275,760 years); an Int instant beyond that is moved into Date's range by whole 400-year cycles (146,097 days, a
// whole number of weeks, so the date, the time and the weekday repeat) and its year moved back, which is how the
// Gregorian calendar repeats. So every case, from the least Int to the largest, is held to Date.
import '../node25.ts';
import { interpret } from '../interp.ts';
import { instantiate } from '../host.ts';
import { built, finish, moduleOf, ok, same, std, answered } from './harness.ts';

const PROGRAM = {
  name: 'dates.tape',
  text: `fn handle(raw: View) -> Response {
  match request(raw) {
    Request(method: Post, path: "/dates", body) -> each(out: buf(), body) |> respond(status: 200)
    Request(method: Get, path: "/one", query: Some(value: parse_int(ms))) -> buf()
      |> append(view: rfc3339(ms)) |> respond(status: 200)
    Request(method: Get, path: "/http", query: Some(value: parse_int(ms))) -> buf()
      |> append(view: http_date(ms)) |> respond(status: 200)
    Request(method: Get, path: "/civil", query: Some(value: parse_int(ms))) -> buf()
      |> write_int(value: civil(ms).year) |> respond(status: 200)
    Request(method: Get, path: "/none", query: Some(value: parse_int(ms))) -> buf()
      |> write_int(value: ms) |> respond(status: 200)
    _ -> empty(status: 404)
  }
}

fn each(out: Buf, body: View) -> Buf {
  let line = until(v: body, byte: 10)
  let rest = after(v: body, byte: 10)
  match parse_int(text: line) {
    Some(value: ms) -> each(out: shown(out, ms), body: rest)
    None -> out
  }
}

fn shown(out: Buf, ms: Int) -> Buf {
  let Civil(year, month, day, hour, minute, second, millisecond) = civil(ms)
  out
    |> append(view: "\\(year) \\(month) \\(day) \\(hour) \\(minute) \\(second) \\(millisecond)|")
    |> append(view: rfc3339(ms))
    |> push(byte: 124)
    |> append(view: http_date(ms))
    |> push(byte: 10)
}
`,
};

type Handler = { handle: (bytes: Uint8Array) => Uint8Array };
const enc = new TextEncoder();
const stepsOf = (mod: { exports: object }): number => {
  if (!('cost' in mod.exports)) throw new TypeError('the module exports no cost');
  const g = mod.exports.cost;
  if (!(g instanceof WebAssembly.Global)) throw new TypeError('the module exports no cost');
  return Number(g.value);
};

// ---- what Date says
const CYCLE = 146097n * 86400000n; // 400 years
const DATE_MAX = 8_640_000_000_000_000n;
const pad = (n: number, w: number): string => String(n).padStart(w, '0');
const isoYear = (y: number): string => (y >= 0 && y <= 9999 ? pad(y, 4) : `${y < 0 ? '-' : '+'}${pad(Math.abs(y), 6)}`);
const httpYear = (y: number): string => `${y < 0 ? '-' : ''}${pad(Math.abs(y), 4)}`;
function oracle(ms: bigint): string {
  // whole cycles, toward zero, until the instant is inside Date's range
  let k = 0n;
  if (ms > DATE_MAX || ms < -DATE_MAX) k = ms / CYCLE;
  const d = new Date(Number(ms - k * CYCLE));
  const year = d.getUTCFullYear() + Number(k) * 400;
  const civil = [
    year,
    d.getUTCMonth() + 1,
    d.getUTCDate(),
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
    d.getUTCMilliseconds(),
  ].join(' ');
  if (k === 0n) return `${civil}|${d.toISOString()}|${d.toUTCString()}`;
  // the same text with the year put back: toISOString's and toUTCString's forms of it
  const iso = `${isoYear(year)}${d.toISOString().replace(/^[+-]?\d+/, '')}`;
  const utc = d.toUTCString().replace(/ -?\d{4,} /, ` ${httpYear(year)} `);
  return `${civil}|${iso}|${utc}`;
}
// the oracle's own forms of the year agree with Date's where Date has one
for (const y of [-271820, -10000, -1, 0, 1, 999, 9999, 10000, 275759]) {
  const d = new Date(0);
  d.setUTCFullYear(y);
  const iso = d.toISOString();
  const utc = d.toUTCString();
  if (!iso.startsWith(isoYear(y)) || !utc.includes(` ${httpYear(y)} `))
    throw new Error(`the oracle writes year ${y} unlike Date: ${iso}, ${utc}`);
}

// ---- the instants
let seed = 0x2545f4914f6cdd1dn;
const next = (): bigint => {
  seed ^= seed << 13n;
  seed &= (1n << 64n) - 1n;
  seed ^= seed >> 7n;
  seed ^= seed << 17n;
  seed &= (1n << 64n) - 1n;
  return seed;
};
const below = (n: bigint): bigint => next() % n;
const INT_MIN = -(2n ** 63n),
  INT_MAX = 2n ** 63n - 1n;
const DAY = 86400000n;
const at = (iso: string): bigint => BigInt(Date.parse(iso));
const FIXED: bigint[] = [
  0n,
  -1n,
  1n,
  DAY - 1n,
  -DAY,
  -DAY - 1n,
  at('2000-02-29T00:00:00Z'),
  at('2000-02-29T23:59:59.999Z'),
  at('2000-03-01T00:00:00Z'),
  at('2100-02-28T23:59:59.999Z'),
  at('2100-03-01T00:00:00Z'),
  at('1900-02-28T23:59:59.999Z'),
  at('1900-03-01T00:00:00Z'),
  at('1600-02-29T12:00:00Z'),
  at('2400-02-29T12:00:00Z'),
  at('0000-01-01T00:00:00Z'),
  at('0000-01-01T00:00:00Z') - 1n,
  at('0000-02-29T00:00:00Z'),
  at('9999-12-31T23:59:59.999Z'),
  at('9999-12-31T23:59:59.999Z') + 1n,
  at('1969-12-31T23:59:59.999Z'),
  at('2026-11-25T14:03:07.123Z'),
  -DATE_MAX,
  DATE_MAX,
  -DATE_MAX - 1n,
  DATE_MAX + 1n,
  INT_MIN,
  INT_MIN + 1n,
  INT_MAX,
  INT_MAX - 1n,
];
const cases = [...FIXED];
const RANDOM = 20_000;
for (let i = 0; i < RANDOM; i++) {
  const kind = i % 5;
  if (kind === 0)
    cases.push(below(2n * DATE_MAX + 1n) - DATE_MAX); // all of Date's range
  else if (kind === 1)
    cases.push(below(2n * 4102444800000n) - 4102444800000n); // 1840 to 2100
  else if (kind === 2)
    cases.push(BigInt.asIntN(64, next())); // any Int
  else if (kind === 3) {
    // the edges of a day: its first and last milliseconds, either side of 1970
    const day = below(2n * 3_000_000n) - 3_000_000n;
    cases.push(day * DAY + (below(2n) === 0n ? 0n : DAY - 1n) + below(3n) - 1n);
  } else {
    // a leap day or the day after a February, in a year divisible by 4 (by 100, by 400 too)
    const y = Number(below(4000n)) * 4 - 8000;
    const d = new Date(0);
    d.setUTCFullYear(y, 1, below(2n) === 0n ? 29 : 28);
    cases.push(BigInt(d.getTime()) + below(DAY));
  }
}

const app = instantiate(moduleOf(built([PROGRAM])));
const other = instantiate(moduleOf(built([PROGRAM], { reuse: false })));
const interpreted = interpret([...std, PROGRAM]);
const handlers: readonly (readonly [string, Handler])[] = [
  ['compiled', app],
  ['no reuse', other],
  ['interpreter', interpreted],
];
const BATCH = 1000;
const wanted = cases.map(oracle);
for (const [label, h] of handlers) {
  const got: string[] = [];
  for (let i = 0; i < cases.length; i += BATCH) {
    const body = cases.slice(i, i + BATCH).join('\n');
    const out = answered(h.handle(enc.encode(`POST /dates\n${body}\n`)));
    got.push(
      ...out
        .slice(out.indexOf('\n') + 1)
        .split('\n')
        .slice(0, -1),
    );
  }
  const off = cases.flatMap((ms, k) => (got[k] === wanted[k] ? [] : [`${ms}: ${got[k]}, Date ${wanted[k]}`]));
  same(
    `${label}: civil, rfc3339 and http_date are Date's on ${cases.length} instants (${RANDOM} random), the least Int to the largest`,
    off.slice(0, 3),
    [],
  );
}
const years = cases.map(ms => Number(oracle(ms).split(' ')[0]));
ok(
  'the instants reach before 1970, before the year 0, past 9999 and past Date',
  years.some(y => y < 1970) && years.some(y => y < 0) && years.some(y => y > 9999) && years.some(y => y > 275760),
);

// ---- the cost: civil loops over nothing; the two texts write their numbers with decimal_text, whose Int digits are
// written by a recursive function, a step a digit
const COST = `fn m_civil(ms: Int) -> Int {
  civil(ms).year
}

fn m_rfc3339(ms: Int) -> Int {
  len(rfc3339(ms))
}

fn m_http_date(ms: Int) -> Int {
  len(http_date(ms))
}
`;
const costly = new WebAssembly.Instance(
  moduleOf(built([{ name: 'cost.tape', text: COST }], { exports: ['m_civil', 'm_rfc3339', 'm_http_date'] })),
  { env: {} },
);
const steps: number[] = [];
for (const ms of [0n, -1n, INT_MIN, INT_MAX, at('2026-11-25T14:03:07.123Z')])
  for (const f of ['m_civil', 'm_rfc3339', 'm_http_date']) {
    const fn = costly.exports[f];
    if (typeof fn !== 'function') throw new TypeError(`no ${f}`);
    const before = stepsOf(costly);
    fn(ms);
    steps.push(stepsOf(costly) - before);
  }
// at 0, -1, the least Int, the largest and 2026-11-25T14:03:07.123Z: civil, rfc3339, http_date. Under step version
// 2 these were [0, 10, 8, 0, 17, 12, 0, 20, 16, 0, 20, 16, 0, 15, 10]: the digits alone. Version 3 adds a step for
// each append of at most 16 bytes, the texts and Views of the two holes and the padding the parts are joined with
// (an append's fixed cost is about an entry's, bench/suite/steps.ts): 18 more for today in each
same(
  'civil costs no steps; rfc3339 and http_date a step a digit they write (decimal_text) and one a piece they join: 33 and 28 for today',
  steps,
  [0, 36, 30, 0, 31, 26, 0, 40, 34, 0, 40, 32, 0, 33, 28],
);

finish();
