// std percent_decoded, a path segment's percent-encoding undone, against JavaScript's decodeURIComponent on random
// segments, in the compiled build, the build without cell reuse and the reference interpreter. decodeURIComponent
// throws exactly where percent_decoded is None: a `%` without two hex digits after it, and escapes whose bytes are
// not UTF-8 (a lone continuation byte, an overlong form, a surrogate, a sequence cut short, above U+10FFFF). `+`
// stays a `+` in both (form encoding is form_field's).
import '../node25.ts';
import { interpret } from '../interp.ts';
import { answerText, instantiate, responseOf } from '../host.ts';
import { built, finish, moduleOf, ok, same, std } from './harness.ts';

const PROGRAM = {
  name: 'percent.tape',
  text: `fn handle(raw: View) -> Response {
  match request(raw) {
    Request(method: Post, path: "/dec", body) -> shown(found: percent_decoded(text: body))
    Request(method: Get, path: "/users/" ++ percent_decoded(name) ++ "/tickets") -> buf()
      |> append(view: "[\\(name)]") |> respond(status: 200)
    _ -> empty(status: 404)
  }
}

fn shown(found: Option[View]) -> Response {
  match found {
    Some(value) -> buf() |> push(byte: 49) |> append(view: value) |> respond(status: 200)
    None -> buf() |> push(byte: 48) |> respond(status: 200)
  }
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

/**
 * What decodeURIComponent says of these bytes: the decoded bytes, or null where it throws. It reads a string, so a
 * byte of 128 or more is given to it as its escape, %XX, which decodes to the same byte: percent-decoding is of
 * bytes, and a raw byte is one already decoded.
 */
function oracle(input: Uint8Array): Uint8Array | null {
  const text = [...input].map(b => (b < 128 ? String.fromCodePoint(b) : `%${b.toString(16)}`)).join('');
  try {
    return enc.encode(decodeURIComponent(text));
  } catch {
    return null;
  }
}
const request = (body: Uint8Array): Uint8Array => {
  const head = enc.encode('POST /dec\n');
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
};
const payload = (out: Uint8Array): Uint8Array | null => {
  const rest = responseOf(out).body;
  if (rest[0] === 48 && rest.length === 1) return null;
  if (rest[0] === 49) return rest.subarray(1);
  throw new Error(`percent_decoded answered ${new TextDecoder().decode(out)}`);
};
const equalBytes = (a: Uint8Array | null, b: Uint8Array | null): boolean => {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((x, i) => x === b[i]);
};
const hexOf = (v: Uint8Array | null): string =>
  v === null ? 'none' : [...v].map(b => b.toString(16).padStart(2, '0')).join('');

// ---- random segments: escapes of random bytes and of UTF-8 sequences (right and wrong), bad escapes, `+`, `%`,
// plain ASCII, characters as they are, and now and then a raw byte that is not UTF-8
let seed = 7;
const rand = (n: number): number => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed % n;
};
const HEX = '0123456789abcdefABCDEF';
const esc = (b: number): string => {
  const h = b.toString(16).padStart(2, '0');
  return `%${rand(2) === 0 ? h : h.toUpperCase()}`;
};
const CHARS = ['é', 'ö', '日', '€', '😀', '\u{10FFFF}', '\u{7F}'];
function piece(): number[] {
  const k = rand(14);
  const ascii = (s: string): number[] => [...enc.encode(s)];
  if (k === 0) return ascii(esc(rand(256)));
  if (k === 1) return ascii([...enc.encode(String.fromCodePoint(rand(0x110000 - 0x800) + 0x800))].map(esc).join(''));
  if (k === 2) return ascii([...enc.encode(CHARS[rand(CHARS.length)] ?? '')].map(esc).join(''));
  if (k === 3) {
    // a sequence cut short, or with one byte changed
    const bytes = [...enc.encode(String.fromCodePoint(0x80 + rand(0x10ff00)))];
    const cut =
      rand(2) === 0 ? bytes.slice(0, Math.max(1, rand(bytes.length))) : bytes.map(b => (rand(3) ? b : rand(256)));
    return ascii(cut.map(esc).join(''));
  }
  if (k === 4)
    return ascii(['%', `%${HEX[rand(22)] ?? '0'}`, `%${HEX[rand(22)] ?? '0'}g`, '%%', '%-1'][rand(5)] ?? '%');
  if (k === 5) return ascii('+');
  if (k === 6) return [...enc.encode(CHARS[rand(CHARS.length)] ?? '')];
  if (k === 7 && rand(4) === 0) return [128 + rand(128)];
  if (k === 8) return ascii(['%2F', '%2e%2E', '%00', '%25', '%2525', '%20', '%2B'][rand(7)] ?? '');
  return [32 + rand(95)];
}
const segment = (): Uint8Array => Uint8Array.from(Array.from({ length: rand(12) }, piece).flat());
const FIXED = [
  '',
  'ada',
  'ada%20l',
  'a+b',
  '%2B',
  '%2F',
  '..%2F..',
  '%2e%2e',
  '%00',
  '%',
  '%4',
  '%4G',
  '%%41',
  '%2525',
  '%C3%B6',
  '%c3%b6',
  '%C3',
  '%C3%28',
  '%80',
  '%C0%80',
  '%ED%A0%80',
  '%F4%90%80%80',
  '%F0%9F%98%80',
  'lö',
  '100%',
];
const cases: Uint8Array[] = FIXED.map(s => enc.encode(s));
cases.push(Uint8Array.of(0xff), Uint8Array.of(0x61, 0xc3), Uint8Array.of(0xc3, 0x25, 0x42, 0x36));
const RANDOM = 5000;
for (let i = 0; i < RANDOM; i++) cases.push(segment());
const failing = cases.filter(c => oracle(c) === null).length;
ok(
  `the cases hold both answers: ${cases.length - failing} decoded and ${failing} refused by decodeURIComponent`,
  failing > cases.length / 5 && failing < (cases.length * 4) / 5,
);

const app = instantiate(moduleOf(built([PROGRAM])));
const other = instantiate(moduleOf(built([PROGRAM], { reuse: false })));
const interpreted = interpret([...std, PROGRAM]);
const handlers: readonly (readonly [string, Handler])[] = [
  ['compiled', app],
  ['no reuse', other],
  ['interpreter', interpreted],
];
for (const [label, h] of handlers) {
  let agree = 0;
  let first = '';
  for (const c of cases) {
    const got = payload(h.handle(request(c)));
    const want = oracle(c);
    if (equalBytes(got, want)) agree++;
    else if (first === '') first = `${hexOf(c)}: got ${hexOf(got)}, decodeURIComponent ${hexOf(want)}`;
  }
  ok(
    `${label}: percent_decoded is decodeURIComponent on ${cases.length} segments (${RANDOM} random)`,
    agree === cases.length,
    first,
  );
}

// ---- in a route: the segment is bound on the encoded path, then decoded
const answer = (h: Handler, line: string): string => {
  const out = h.handle(enc.encode(`${line}\n`));
  return answerText(responseOf(out)).replace('\n', ' ');
};
for (const [label, h] of handlers) {
  same(
    `${label}: GET /users/ada%20l/tickets binds "ada l"; %2F stays inside the segment; a bad escape is not the route`,
    [
      answer(h, 'GET /users/ada%20l/tickets'),
      answer(h, 'GET /users/a%2Fb/tickets'),
      answer(h, 'GET /users/a+b/tickets'),
      answer(h, 'GET /users/a%zz/tickets'),
    ],
    ['200 [ada l]', '200 [a/b]', '200 [a+b]', '404 '],
  );
}

// ---- what it costs: a scan of 16 bytes a step, one step an escape, and the UTF-8 check
const stepsFor = (body: string): number => {
  app.handle(request(enc.encode(body)));
  return stepsOf(app);
};
const base = stepsFor('');
const plain = stepsFor('a'.repeat(1600)) - base;
const escaped = stepsFor('%20'.repeat(100)) - base;
const wide = stepsFor('%C3%B6'.repeat(100)) - base;
console.log(
  `  steps above an empty segment: 1,600 ASCII bytes ${plain}, 100 escapes ${escaped}, 100 escaped ö ${wide}`,
);
// each count also holds the handler's copy of the value into its answer, a step per 16 bytes (step version 3): 100
// for the 1,600 bytes, 7 for the 100, 13 for the 200; the decoder's own counts are docs/std.md's 200, 209 and 702
same('1,600 bytes of ASCII and no escape: two scans, each 16 bytes a step, and the copy out', plain, 200 + 100);
same(
  '100 escapes of ASCII: two steps an escape (the loop and its scan), and the check of 300 bytes, and the copy out',
  escaped,
  209 + 7,
);
same(
  '100 escaped two-byte characters: two steps an escape, and three a character in the check, and the copy out',
  wide,
  702 + 13,
);

finish();
