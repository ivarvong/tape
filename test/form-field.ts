// std form_field. Reading every field used to walk the form again from the start, so the steps grew as n²
// (n = 256 was 460,899 steps, n = 1024 was 7,738,976, about 16.8× for 4× the fields; n = 4096 passed the
// 50,000,000-step budget). Memory was already linear. The scan is now one pass in the module, and the answers
// are the ones the walk gave: a direct port of it here, and URLSearchParams on the cases a browser agrees with.
import '../node25.ts';
import { interpret } from '../interp.ts';
import { formRaw } from '../interp/form.ts';
import { instantiate } from '../host.ts';
import { built, finish, moduleOf, ok, same, std } from './harness.ts';

const PROGRAM = {
  name: 'form.tape',
  text: `fn handle(raw: View) -> Buf {
  match request(raw) {
    Request(path: "/n/" ++ decimal(n)) -> read_all(n)
    Request(path: "/get", query: Some(value: q), body) -> shown(o: form_field(body: q, name: body))
    Request(method: "POST", path: "/check", body) -> checked(body)
    _ -> respond(status: 404)
  }
}

fn read_all(n: Int) -> Buf {
  let q = freeze(buf: form(out: buf(), i: 0, n))
  respond(status: 200) |> write_int(value: total(q, i: 0, n, acc: 0))
}

fn form(out: Buf, i: Int, n: Int) -> Buf {
  match {
    i >= n -> out
    i == 0 -> form(out: out |> append(view: "f0=1"), i: 1, n)
    else -> form(out: out |> append(view: "&f") |> write_int(value: i) |> append(view: "=1"), i: i + 1, n)
  }
}

fn total(q: View, i: Int, n: Int, acc: Int) -> Int {
  match {
    i >= n -> acc
    else -> total(q, i: i + 1, n, acc: acc + found(o: form_field(body: q, name: "f\\(i)")))
  }
}

fn found(o: Option[View]) -> Int {
  match o {
    Some(value) -> 1
    None -> 0
  }
}

fn shown(o: Option[View]) -> Buf {
  match o {
    Some(value) -> respond(status: 200) |> append(view: "[\\(value)]")
    None -> respond(status: 200) |> append(view: "none")
  }
}

fn checked(body: View) -> Buf {
  let Some(value: n) = decimal(until(v: body, byte: 10)) else -> respond(status: 400)
  let rest = after(v: body, byte: 10)
  match form_field(body: slice(v: rest, from: n, to: len(rest)), name: slice(v: rest, from: 0, to: n)) {
    Some(value) -> respond(status: 200) |> push(byte: 49) |> append(view: value)
    None -> respond(status: 200) |> push(byte: 48)
  }
}
`,
};

type Handler = { handle: (bytes: Uint8Array) => Uint8Array };
const enc = new TextEncoder();
const dec = new TextDecoder();
const textOf = (out: Uint8Array): string => {
  const nl = out.indexOf(10);
  return dec.decode(nl < 0 ? out : out.subarray(nl + 1));
};
const stepsOf = (mod: { exports: object }): number => {
  if (!('cost' in mod.exports)) throw new TypeError('the module exports no cost');
  const g = mod.exports.cost;
  if (!(g instanceof WebAssembly.Global)) throw new TypeError('the module exports no cost');
  return Number(g.value);
};

// ---- the old walk, as a port of form_from / form_named / form_bytes (no arm falls through)
const isHex = (b: number): boolean => (b >= 48 && b <= 57) || (b >= 97 && b <= 102) || (b >= 65 && b <= 70);
const hex = (b: number): number => (b <= 57 ? b - 48 : b >= 97 ? b - 87 : b - 55);
const byteAt = (v: Uint8Array, i: number): number => v[i] ?? 0;
function named(raw: Uint8Array, name: Uint8Array): boolean {
  let at = 0;
  let n = 0;
  while (at <= raw.length) {
    if (at >= raw.length) return n === name.length;
    if (n >= name.length) return false;
    const b = byteAt(raw, at);
    const want = byteAt(name, n);
    if (b === 43) {
      if (want !== 32) return false;
      at += 1;
      n += 1;
      continue;
    }
    if (b === 37 && at + 2 < raw.length && isHex(byteAt(raw, at + 1)) && isHex(byteAt(raw, at + 2))) {
      const decoded = (hex(byteAt(raw, at + 1)) << 4) | hex(byteAt(raw, at + 2));
      if (want !== decoded) return false;
      at += 3;
      n += 1;
      continue;
    }
    if (want !== b) return false;
    at += 1;
    n += 1;
  }
  return false;
}
function decodeRaw(raw: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let at = 0; at < raw.length;) {
    const b = byteAt(raw, at);
    if (b === 43) {
      out.push(32);
      at += 1;
    } else if (b === 37 && at + 2 < raw.length && isHex(byteAt(raw, at + 1)) && isHex(byteAt(raw, at + 2))) {
      out.push((hex(byteAt(raw, at + 1)) << 4) | hex(byteAt(raw, at + 2)));
      at += 3;
    } else {
      out.push(b);
      at += 1;
    }
  }
  return Uint8Array.from(out);
}
/** The raw value span the old walk would decode, or null. */
function rawOf(body: Uint8Array, name: Uint8Array): Uint8Array | null {
  let at = 0;
  while (at <= body.length) {
    let end = at;
    while (end < body.length && byteAt(body, end) !== 38) end++;
    let eq = at;
    while (eq < end && byteAt(body, eq) !== 61) eq++;
    if (named(body.subarray(at, eq), name)) return eq < end ? body.subarray(eq + 1, end).slice() : new Uint8Array();
    if (end >= body.length) return null;
    at = end + 1;
  }
  return null;
}
const fieldOf = (body: Uint8Array, name: Uint8Array): Uint8Array | null => {
  const raw = rawOf(body, name);
  return raw === null ? null : decodeRaw(raw);
};
const equalBytes = (a: Uint8Array | null, b: Uint8Array | null): boolean => {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};
const hexOf = (v: Uint8Array | null): string =>
  v === null ? 'none' : [...v].map(b => b.toString(16).padStart(2, '0')).join('');

const app = instantiate(moduleOf(built([PROGRAM])));
const other = instantiate(moduleOf(built([PROGRAM], { reuse: false })));
const interpreted = interpret([...std, PROGRAM]);

const ask = (h: Handler, request: string): string => textOf(h.handle(enc.encode(request)));

// ---- steps: n lookups of n fields. The exponent is the least-squares slope of log(steps) on log(n).
const sweepN = [256, 512, 1024, 2048, 4096];
const sweep = sweepN.map(n => {
  const out = app.handle(enc.encode(`GET /n/${n}`));
  return { n, body: textOf(out), steps: stepsOf(app), bytes: app.bytesUsed };
});
const logFit = (rows: readonly { n: number; steps: number }[]): number => {
  const xs = rows.map(r => Math.log(r.n));
  const ys = rows.map(r => Math.log(r.steps));
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = (xs[i] ?? 0) - mx;
    num += dx * ((ys[i] ?? 0) - my);
    den += dx * dx;
  }
  return den === 0 ? NaN : num / den;
};
const exponent = logFit(sweep);
console.log('form_field sweep (steps were 460899 at n=256 and 7738976 at n=1024, exponent 2.03)');
for (let i = 0; i < sweep.length; i++) {
  const row = sweep[i];
  const prev = sweep[i - 1];
  if (!row) continue;
  const ratio = prev ? (row.steps / prev.steps).toFixed(3) : '-';
  console.log(`n=${row.n} steps=${row.steps} bytes=${row.bytes} body=${row.body} ratio=${ratio}`);
}
console.log(`fitted exponent ${exponent.toFixed(4)}`);
for (const row of sweep) same(`every field of a ${row.n}-field form is found`, row.body, String(row.n));
same(
  `steps grow linearly across n=256..4096: fitted exponent ${exponent.toFixed(3)} (was 2.03)`,
  exponent < 1.35 && exponent > 0.7,
  true,
);
for (let i = 1; i < sweep.length; i++) {
  const prev = sweep[i - 1];
  const row = sweep[i];
  if (!prev || !row) continue;
  same(
    `doubling the fields from ${prev.n} to ${row.n} multiplies the steps by less than 3 (was about 4)`,
    row.steps < prev.steps * 3,
    true,
  );
}
const at256 = sweep[0];
const at1024 = sweep[2];
const at4096 = sweep[4];
same('n=4096 answers inside the step budget', (at4096?.steps ?? Infinity) < 5_000_000, true);
same(
  'a form 4 times longer, read 4 times as often, takes at most about 4 times the memory (it took 16)',
  at256 !== undefined && at1024 !== undefined && at1024.bytes < 5 * at256.bytes,
  true,
);
// the build without cell reuse answers the same counts
for (const n of [256, 1536, 4096]) {
  same(
    `no reuse: every field of a ${n}-field form is found`,
    textOf(other.handle(enc.encode(`GET /n/${n}`))),
    String(n),
  );
}

// ---- the answers, against URLSearchParams
const forms: readonly (readonly [string, string])[] = [
  ['qty=2&buyer=ada+l%C3%B6', 'buyer'],
  ['qty=2', 'buyer'],
  ['done', 'done'],
  ['done=', 'done'],
  ['x=1&done&y', 'done'],
  ['a=1&a=2', 'a'],
  ['a+b=1', 'a b'],
  ['a%20b=1', 'a b'],
  ['a%2=1&a%=2', 'a%'],
  ['%61=1', 'a'],
  ['ab=1', 'a'],
  ['a=1', 'ab'],
  ['=1&x=2', ''],
  ['k=%zz', 'k'],
  ['k=%2525', 'k'],
  ['%C3%B6=yes', 'ö'],
  ['', 'a'],
];
for (const [form, name] of forms) {
  const want = new URLSearchParams(form).get(name);
  same(
    `form_field(${JSON.stringify(form)}, ${JSON.stringify(name)})`,
    ask(app, `GET /get?${form}\n${name}`),
    want === null ? 'none' : `[${want}]`,
  );
}

// ---- the same answers as the old walk, on structured forms and on random bytes
const checkReq = (name: Uint8Array, form: Uint8Array): Uint8Array => {
  const head = enc.encode(`POST /check\n${name.length}\n`);
  const req = new Uint8Array(head.length + name.length + form.length);
  req.set(head, 0);
  req.set(name, head.length);
  req.set(form, head.length + name.length);
  return req;
};
const payload = (out: Uint8Array): Uint8Array | null => {
  const rest = out.subarray(out.indexOf(10) + 1);
  const tag = rest[0];
  if (tag === 48) return null;
  if (tag === 49) return rest.subarray(1);
  throw new Error(`form check answered ${dec.decode(out)}`);
};
const handlers: readonly (readonly [string, Handler])[] = [
  ['compiled', app],
  ['no reuse', other],
  ['interpreter', interpreted],
];
let seed = 1;
const rand = (n: number): number => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed % n;
};
const SPECIAL = [37, 38, 43, 61, 32, 0, 255, 10, 13, 48, 65, 70, 97, 102];
const bytesOf = (n: number): Uint8Array =>
  Uint8Array.from({ length: n }, () => (rand(3) === 0 ? (SPECIAL[rand(SPECIAL.length)] ?? 0) : rand(256)));
const cases: (readonly [Uint8Array, Uint8Array])[] = [
  [enc.encode(''), enc.encode('')],
  [enc.encode(''), enc.encode('a')],
  [enc.encode('%2525=v'), enc.encode('%25')],
  [enc.encode('%2525=v'), enc.encode('%')],
  [enc.encode('+=1'), enc.encode(' ')],
  [enc.encode('+=1'), enc.encode('+')],
  [enc.encode('a%3D=1'), enc.encode('a=')],
  [enc.encode('%26=1'), enc.encode('&')],
  [enc.encode('&&x=1'), enc.encode('')],
  [enc.encode('%41=1'), enc.encode('A')],
  [enc.encode('%41=1'), enc.encode('%41')],
  [enc.encode('%4=1'), enc.encode('%4')],
  [enc.encode('%4G=1'), enc.encode('%4G')],
  [enc.encode('%2b=1'), enc.encode('+')],
  [enc.encode('%2B=1'), enc.encode('+')],
  [enc.encode('%2b=1'), enc.encode(' ')],
  [enc.encode('+'), enc.encode(' ')],
  [enc.encode('+'), enc.encode('+')],
  [enc.encode('a=%'), enc.encode('a')],
  [enc.encode('a=%2'), enc.encode('a')],
  [enc.encode('='), enc.encode('')],
  [enc.encode('&'), enc.encode('')],
];
for (let i = 0; i < 400; i++) cases.push([bytesOf(rand(64)), i % 7 === 0 ? new Uint8Array() : bytesOf(rand(12))]);

let rawAgree = 0;
for (const [form, name] of cases) if (equalBytes(formRaw(form, name), rawOf(form, name))) rawAgree++;
same("form_raw returns the old walk's raw value, on every case", rawAgree, cases.length);

for (const [label, h] of handlers) {
  let agree = 0;
  let first = '';
  for (const [form, name] of cases) {
    const got = payload(h.handle(checkReq(name, form)));
    const want = fieldOf(form, name);
    if (equalBytes(got, want)) agree++;
    else if (first === '') first = `got ${hexOf(got)} wanted ${hexOf(want)}`;
  }
  ok(`${label}: form_field matches the old walk on ${cases.length} forms`, agree === cases.length, first);
}

finish();
