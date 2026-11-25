// std/text.tape write_units (how a hole and write_json write a Dec: units · 10^-scale with `scale` digits after the
// point) writes each digit as units % 10 on the way back up from the highest, one division by 10 a digit. The
// loop it replaced (kept here, as written before 2026-11-23, as old_*: count the digits, make 10^(n-1), then
// units / p % 10 for each) is the oracle, and so is a writer written here from the definition with BigInt. The
// compiled build answers the same bytes as the old loop and the BigInt writer on the edges (0, ±1, ±9, ±10, every
// ±10^k and ±(10^k - 1), the greatest and the least Int, at scales -1, 0, 1, 2, 17 and 18) and on 200,000 random
// (units, scale) pairs, the units uniform over all Ints or of a uniform number of digits, the scale from -2 to 18;
// a scale above 18 traps as integer overflow under both; the reference interpreter agrees on the edges.
import '../node25.ts';
import { compile } from '../compiler.ts';
import { instantiate, responseOf } from '../host.ts';
import { interpret } from '../interp.ts';
import { finish, ok, same, std } from './harness.ts';

const program = `fn handle(raw: View) -> Buf {
  match request(raw) {
    Request(method: "POST", path: "/old", body) -> each(out: respond(status: 200), rest: body, old: True)
    Request(method: "POST", path: "/new", body) -> each(out: respond(status: 200), rest: body, old: False)
    _ -> respond(status: 404)
  }
}

// Each line "units,scale", written by the old loop or by std's write_units, one a line.
fn each(out: Buf, rest: View, old: Bool) -> Buf {
  match {
    len(rest) == 0 -> out
    else -> each(out: one(out, line: until(v: rest, byte: 10), old), rest: after(v: rest, byte: 10), old)
  }
}

fn one(out: Buf, line: View, old: Bool) -> Buf {
  let Some(value: units) = parse_int(text: until(v: line, byte: 44)) else -> append(buf: out, view: "?\\n")
  let Some(value: scale) = parse_int(text: after(v: line, byte: 44)) else -> append(buf: out, view: "?\\n")
  match old {
    True -> push(buf: old_units(out, units, scale), byte: 10)
    False -> push(buf: write_units(out, units, scale), byte: 10)
  }
}

// std/text.tape write_units and its helpers before 2026-11-23, renamed.
fn old_units(out: Buf, units: Int, scale: Int) -> Buf {
  let n = old_digits(units: units / 10, scale, n: 1)
  let signed = match {
    units < 0 -> push(buf: out, byte: 45)
    else -> out
  }
  old_places(out: signed, units, at: n - 1, p: old_ten(n: n - 1, p: 1), scale)
}

fn old_digits(units: Int, scale: Int, n: Int) -> Int {
  match {
    units != 0 or n <= scale -> old_digits(units: units / 10, scale, n: n + 1)
    else -> n
  }
}

fn old_ten(n: Int, p: Int) -> Int {
  match {
    n <= 0 -> p
    else -> old_ten(n: n - 1, p: p * 10)
  }
}

fn old_places(out: Buf, units: Int, at: Int, p: Int, scale: Int) -> Buf {
  let d = units / p % 10
  let digit = push(buf: out, byte: 48 + match {
    d < 0 -> 0 - d
    else -> d
  })
  match {
    at == 0 -> digit
    at == scale -> old_places(out: push(buf: digit, byte: 46), units, at: at - 1, p: p / 10, scale)
    else -> old_places(out: digit, units, at: at - 1, p: p / 10, scale)
  }
}
`;
// write_units is private to std/text.tape (C94): the program here is read as the end of that file, which may call it
const sources = std.map(s => (s.name === 'std/text.tape' ? { ...s, text: `${s.text}\n${program}` } : s));
const b = compile(sources);
if (!b.wasm) throw new Error(b.errors.map(e => `${e.code} ${e.line} ${e.message}`).join('; '));
const app = instantiate(new WebAssembly.Module(b.wasm), { name: 'write-units' });
const it = interpret(sources);
const enc = new TextEncoder(),
  dec = new TextDecoder();
const answer = (r: Uint8Array): string => {
  const a = responseOf(r);
  return `${a.status} ${dec.decode(a.body)}`;
};
const compiled = (path: string, body: string): string => {
  try {
    return answer(app.handle(enc.encode(`POST ${path}\n${body}`)));
  } catch (e) {
    return (e instanceof Error ? e.message : String(e)).split(':')[0] ?? '';
  }
};
const interpreted = (path: string, body: string): string => answer(it.handle(enc.encode(`POST ${path}\n${body}`)));

/** The definition: |units| in decimal, at least scale + 1 digits, the point before the last `scale`; a sign. */
function written(units: bigint, scale: number): string {
  const digits = (units < 0n ? -units : units).toString();
  const s = scale > 0 ? digits.padStart(scale + 1, '0') : digits;
  const pointed = scale > 0 ? `${s.slice(0, -scale)}.${s.slice(-scale)}` : s;
  return `${units < 0n ? '-' : ''}${pointed}`;
}

type Pair = [bigint, number];
const MAX = 2n ** 63n - 1n,
  MIN = -(2n ** 63n);
const tens = Array.from({ length: 19 }, (_, k) => 10n ** BigInt(k));
const edgeUnits = [0n, 1n, 9n, 10n, 99n, ...tens, ...tens.slice(1).map(p => p - 1n), MAX].flatMap(u => [u, -u]);
const edges: Pair[] = [...edgeUnits, MIN].flatMap(u => [-1, 0, 1, 2, 17, 18].map((s): Pair => [u, s]));

// mulberry32
let seed = 11;
const rnd = (n: number): number => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) % n;
};
const word = (): bigint => BigInt(rnd(2 ** 16)) * 2n ** 16n + BigInt(rnd(2 ** 16));
const anyInt = (): bigint => BigInt.asIntN(64, word() * 2n ** 32n + word());
// a number of 1 to 19 digits, each count as likely, either sign, kept inside an Int
function ofDigits(): bigint {
  const n = 1 + rnd(19);
  let text = String(1 + rnd(9));
  for (let i = 1; i < n; i++) text += String(rnd(10));
  const u = BigInt(text);
  const signed = rnd(2) === 0 ? u : -u;
  return signed > MAX ? MAX : signed < MIN ? MIN : signed;
}
const random: Pair[] = Array.from({ length: 200_000 }, (): Pair => [rnd(2) === 0 ? anyInt() : ofDigits(), rnd(21) - 2]);

const bodyOf = (pairs: readonly Pair[]): string => pairs.map(([u, s]) => `${u},${s}\n`).join('');
const wanted = (pairs: readonly Pair[]): string => `200 ${pairs.map(([u, s]) => `${written(u, s)}\n`).join('')}`;
/** Pairs whose lines differ between two answers: the first five. */
function differing(pairs: readonly Pair[], got: string, want: string): string[] {
  const g = got.split('\n'),
    w = want.split('\n');
  return pairs.flatMap(([u, s], i) => (g[i] === w[i] ? [] : [`${u},${s}: ${g[i]} wanted ${w[i]}`])).slice(0, 5);
}
function check(what: string, pairs: readonly Pair[]): void {
  const old: string[] = [],
    defined: string[] = [];
  for (let at = 0; at < pairs.length; at += 5000) {
    const part = pairs.slice(at, at + 5000);
    const body = bodyOf(part);
    const now = compiled('/new', body);
    old.push(...differing(part, now, compiled('/old', body)));
    defined.push(...differing(part, now, wanted(part)));
  }
  same(`${what}: write_units writes what the old loop wrote`, old.slice(0, 5), []);
  same(`${what}: and what the definition says`, defined.slice(0, 5), []);
}
check(`${edges.length} edges`, edges);
check(`${random.length} random pairs`, random);
same(
  'the random pairs reach every scale from -2 to 18 and both signs',
  [new Set(random.map(([, s]) => s)).size, random.some(([u]) => u < 0n), random.some(([u]) => u > 0n)],
  [21, true, true],
);

// a scale above 18: 10^scale is more than an Int holds, and both trap as integer overflow
const big: Pair[] = [0n, 5n, -5n, MIN, MAX].flatMap(u => [19, 20, 64].map((s): Pair => [u, s]));
same(
  'a scale above 18 traps as integer overflow, as before',
  big.map(([u, s]) => [compiled('/new', `${u},${s}\n`), compiled('/old', `${u},${s}\n`)]),
  big.map(() => ['trap 6', 'trap 6']),
);

// the reference interpreter runs std's write_units too
const ib = bodyOf(edges);
ok('the interpreter writes the edges as the compiled build does', interpreted('/new', ib) === compiled('/new', ib));
ok('and as the old loop does', interpreted('/old', ib) === compiled('/new', ib));
finish();
