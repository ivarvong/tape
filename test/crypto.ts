// std/crypto.tape's sha256, hmac_sha256, hmac_sha256_verify, hex, base64, base64url, from_base64 and
// from_base64url against node:crypto and Buffer (implementations that share nothing with them), in the compiled
// build, the build without cell reuse, the checked build and the reference interpreter: every length from 0 to 300
// bytes (each padding case: 55, 56, 63, 64 bytes and the block boundaries after), random lengths to 1,000, every
// byte value, keys of every length to 150 (shorter than, as long as and longer than the 64-byte block); base64
// text from every encoding of those bytes, round trips, and the same text broken (a character changed, cut, padded
// wrongly, its last bits set), refused exactly where Buffer's encoding of what it decodes is not the text again.
// Then what each costs in steps, as the doc comments say: sha256's 66 a block, and hmac_sha256_verify's the same
// wherever a mac differs.
import '../node25.ts';
import { createHash, createHmac } from 'node:crypto';
import { interpret } from '../interp.ts';
import { instantiate } from '../host.ts';
import { built, finish, moduleOf, ok, same, std } from './harness.ts';

const PROGRAM = {
  name: 'crypto.tape',
  text: `fn handle(raw: View) -> Buf {
  match request(raw) {
    Request(method: "POST", path: "/sha256", body) -> respond(status: 200) |> append(view: sha256(data: body))
    Request(method: "POST", path: "/hmac", query: Some(value: parse_int(n)), body) -> respond(status: 200)
      |> append(view: hmac_sha256(key: slice(v: body, from: 0, to: n), data: slice(v: body, from: n, to: len(body))))
    Request(method: "POST", path: "/verify", query: Some(value: q), body) -> verified(q, body)
    Request(method: "POST", path: "/hex", body) -> respond(status: 200) |> append(view: hex(bytes: body))
    Request(method: "POST", path: "/base64", body) -> respond(status: 200) |> append(view: base64(bytes: body))
    Request(method: "POST", path: "/base64url", body) -> respond(status: 200) |> append(view: base64url(bytes: body))
    Request(method: "POST", path: "/from_base64", body) -> shown(found: from_base64(text: body))
    Request(method: "POST", path: "/from_base64url", body) -> shown(found: from_base64url(text: body))
    _ -> respond(status: 404)
  }
}

// ?k.m: the body is a key of k bytes, a mac of m bytes and the data
fn verified(q: View, body: View) -> Buf {
  let Some(value: k) = parse_int(text: until(v: q, byte: 46)) else -> respond(status: 400)
  let Some(value: m) = parse_int(text: after(v: q, byte: 46)) else -> respond(status: 400)
  let key = slice(v: body, from: 0, to: k)
  let mac = slice(v: body, from: k, to: k + m)
  match hmac_sha256_verify(key, data: slice(v: body, from: k + m, to: len(body)), mac) {
    True -> respond(status: 200) |> push(byte: 49)
    False -> respond(status: 200) |> push(byte: 48)
  }
}

fn shown(found: Option[View]) -> Buf {
  match found {
    Some(value) -> respond(status: 200) |> push(byte: 49) |> append(view: value)
    None -> respond(status: 200) |> push(byte: 48)
  }
}
`,
};

type Handler = { handle: (bytes: Uint8Array) => Uint8Array };
const enc = new TextEncoder();
const cat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const request = (line: string, body: Uint8Array): Uint8Array => cat(enc.encode(`${line}\n`), body);
const bodyOf = (out: Uint8Array): Uint8Array => {
  const head = new TextDecoder().decode(out.subarray(0, 4));
  if (head !== '200\n') throw new Error(`answered ${new TextDecoder().decode(out.subarray(0, 80))}`);
  return out.subarray(4);
};
const hexOf = (v: Uint8Array): string => Buffer.from(v).toString('hex');
const equal = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

let seed = 13;
const rand = (n: number): number => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed % n;
};
const bytes = (n: number): Uint8Array => Uint8Array.from({ length: n }, () => rand(256));

// ---- the cases
const lengths = [...Array.from({ length: 301 }, (_, i) => i), ...Array.from({ length: 40 }, () => 301 + rand(700))];
const datas = lengths.map(bytes);
datas.push(
  Uint8Array.from({ length: 256 }, (_, i) => i),
  Uint8Array.from({ length: 256 }, (_, i) => 255 - i),
);
const every = new Set(datas.flatMap(d => [...d]));
ok(`the data holds every byte value (${every.size}) and every length to 300`, every.size === 256);
const keyed = Array.from({ length: 151 }, (_, k) => ({ key: bytes(k), data: bytes(rand(300)) }));
keyed.push(
  { key: bytes(64), data: bytes(0) },
  { key: bytes(65), data: bytes(55) },
  { key: bytes(200), data: bytes(64) },
);

/** What Buffer decodes of base64 text, or null where the text is not exactly what Buffer encodes it as. */
const oracle64 = (text: string, url: boolean): Uint8Array | null => {
  const kind = url ? 'base64url' : 'base64';
  const got = Buffer.from(text, kind);
  return got.toString(kind) === text ? Uint8Array.from(got) : null;
};
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/-_= \n.';
/** Text near base64: an encoding of random bytes, then one change. */
const broken = (url: boolean): string => {
  const t = Buffer.from(bytes(rand(40))).toString(url ? 'base64url' : 'base64');
  const at = rand(t.length + 1);
  const c = ALPHABET[rand(ALPHABET.length)] ?? 'A';
  switch (rand(6)) {
    case 0:
      return t.slice(0, at) + c + t.slice(at + 1); // a character changed
    case 1:
      return t.slice(0, at) + c + t.slice(at); // one put in
    case 2:
      return t.slice(0, at) + t.slice(at + 1); // one taken out
    case 3:
      return `${t}=`;
    case 4:
      return t.replace(/=+$/, ''); // padding dropped
    default:
      return t;
  }
};
const texts = (url: boolean): string[] => [
  ...datas.slice(0, 120).map(d => Buffer.from(d).toString(url ? 'base64url' : 'base64')),
  ...Array.from({ length: 1500 }, () => broken(url)),
  '',
  '=',
  '==',
  'A',
  'AA',
  'AAA',
  'AAAA',
  'AA==',
  'AA=',
  'AAA=',
  'AB==',
  'AAB=',
  'A===',
  '====',
  'AA==AA==',
  'aGVsbG8=',
  'aGVsbG8',
  'aGVsbG9=',
  'aGVsbG9',
  'Pj4/',
  'Pj4_',
  '+/+/',
  '-_-_',
  'aGVs bG8=',
  'aGVs\nbG8=',
];
const decodeCases = [false, true].flatMap(url => texts(url).map(text => ({ url, text })));
const refused = decodeCases.filter(c => oracle64(c.text, c.url) === null).length;
ok(
  `the base64 cases hold both answers: ${decodeCases.length - refused} decoded and ${refused} refused`,
  refused > decodeCases.length / 5 && refused < (decodeCases.length * 4) / 5,
);

// ---- each build and the interpreter against node:crypto and Buffer
const app = instantiate(moduleOf(built([PROGRAM])));
const handlers: readonly (readonly [string, Handler])[] = [
  ['compiled', app],
  ['no reuse', instantiate(moduleOf(built([PROGRAM], { reuse: false })))],
  ['checked', instantiate(moduleOf(built([PROGRAM], { check: true })))],
  ['interpreter', interpret([...std, PROGRAM])],
];
let answers = 0;
const firstOf = <T>(cases: readonly T[], wrong: (c: T) => string | null): string => {
  for (const c of cases) {
    const why = wrong(c);
    if (why !== null) return why;
  }
  return '';
};
const checkHandler = (label: string, h: Handler): void => {
  const post = (line: string, body: Uint8Array): Uint8Array => {
    answers++;
    return bodyOf(h.handle(request(line, body)));
  };
  const sha = firstOf(datas, d => {
    const got = hexOf(post('POST /sha256', d)),
      want = createHash('sha256').update(d).digest('hex');
    return got === want ? null : `${d.length} bytes: ${got}, node:crypto ${want}`;
  });
  ok(`${label}: sha256 is node:crypto's on ${datas.length} inputs`, sha === '', sha);
  const mac = firstOf(keyed, ({ key, data }) => {
    const got = hexOf(post(`POST /hmac?${key.length}`, cat(key, data))),
      want = createHmac('sha256', key).update(data).digest('hex');
    return got === want ? null : `key ${key.length}, data ${data.length}: ${got}, node:crypto ${want}`;
  });
  ok(`${label}: hmac_sha256 is node:crypto's on ${keyed.length} keys, 0 to 200 bytes`, mac === '', mac);
  const verify = firstOf(keyed.slice(0, 60), ({ key, data }) => {
    const right = Uint8Array.from(createHmac('sha256', key).update(data).digest());
    const flipped = Uint8Array.from(right);
    const at = rand(32);
    flipped[at] = (flipped[at] ?? 0) ^ (1 << rand(8));
    const answer = (m: Uint8Array): string =>
      new TextDecoder().decode(post(`POST /verify?${key.length}.${m.length}`, cat(key, m, data)));
    const got = [answer(right), answer(flipped), answer(right.subarray(0, 31)), answer(cat(right, bytes(1)))];
    return got.join('') === '1000' ? null : `key ${key.length}: ${got.join(' ')}`;
  });
  ok(
    `${label}: hmac_sha256_verify takes the mac, and refuses one bit changed, one byte short and one long (60 keys)`,
    verify === '',
    verify,
  );
  const encoded = firstOf(datas, d => {
    const b = Buffer.from(d);
    const got = [post('POST /hex', d), post('POST /base64', d), post('POST /base64url', d)].map(v =>
      new TextDecoder().decode(v),
    );
    const want = [b.toString('hex'), b.toString('base64'), b.toString('base64url')];
    return got.join() === want.join() ? null : `${hexOf(d)}: ${got.join(' ')}, Buffer ${want.join(' ')}`;
  });
  ok(`${label}: hex, base64 and base64url are Buffer's on ${datas.length} inputs`, encoded === '', encoded);
  const decoded = firstOf(decodeCases, ({ url, text }) => {
    const got = post(url ? 'POST /from_base64url' : 'POST /from_base64', enc.encode(text));
    const value = got[0] === 49 ? got.subarray(1) : null;
    const want = oracle64(text, url);
    const agrees = value === null || want === null ? value === want : equal(value, want);
    return agrees
      ? null
      : `${url ? 'url ' : ''}${JSON.stringify(text)}: ${value && hexOf(value)}, Buffer ${want && hexOf(want)}`;
  });
  ok(
    `${label}: from_base64 and from_base64url decode what Buffer does and refuse what is not its encoding (${decodeCases.length} texts)`,
    decoded === '',
    decoded,
  );
  const round = firstOf(datas, d => {
    const back = (from: string, to: string): Uint8Array => {
      const got = post(from, post(to, d));
      return got[0] === 49 ? got.subarray(1) : Uint8Array.of();
    };
    return equal(back('POST /from_base64', 'POST /base64'), d) &&
      equal(back('POST /from_base64url', 'POST /base64url'), d)
      ? null
      : `${hexOf(d)} does not come back`;
  });
  ok(
    `${label}: from_base64(base64(b)) and from_base64url(base64url(b)) are b, ${datas.length} inputs`,
    round === '',
    round,
  );
};
for (const [label, h] of handlers) checkHandler(label, h);
console.log(`  ${answers} answers in all`);

// ---- what it costs: each function called alone, from an export, on a slice of a literal (a slice costs nothing)
const LONG = 'A'.repeat(10000); // base64 of zeros, too
const COSTS = `fn long() -> View {
  "${LONG}"
}

fn part(n: Int) -> View {
  slice(v: long(), from: 0, to: n)
}

fn digest(n: Int) -> Int {
  sha256(data: part(n))[0]
}

fn mac(k: Int, n: Int) -> Int {
  hmac_sha256(key: part(n: k), data: part(n))[0]
}

// verify with the right mac, or with its byte i changed (built without a loop, so it costs nothing)
fn check(i: Int) -> Int {
  let right = hmac_sha256(key: "key", data: "data")
  let mac = match {
    i < 0 -> right
    else -> buf()
      |> append(view: slice(v: right, from: 0, to: i))
      |> push(byte: right[i] ^ 1)
      |> append(view: slice(v: right, from: i + 1, to: 32))
      |> freeze
  }
  match hmac_sha256_verify(key: "key", data: "data", mac) {
    True -> 1
    False -> 0
  }
}

fn encoded(n: Int) -> Int {
  len(hex(bytes: part(n))) + len(base64(bytes: part(n)))
}

fn decoded(n: Int) -> Int {
  let Some(value) = from_base64url(text: part(n)) else -> -1
  len(value)
}
`;
const costs = instantiate(moduleOf(built(COSTS, { exports: ['digest', 'mac', 'check', 'encoded', 'decoded'] })), {
  log: false,
});
const stepsOf = (fn: string, ...args: number[]): number => {
  const f = costs.exports[fn],
    reset = costs.exports['reset'],
    cost = costs.exports['cost'];
  if (typeof f !== 'function' || typeof reset !== 'function' || !(cost instanceof WebAssembly.Global))
    throw new TypeError(`no ${fn}`);
  reset();
  f(...args.map(BigInt));
  return Number(cost.value);
};
const blocks = (n: number): number => Math.floor((n + 72) / 64);
const sha = (n: number): number => 66 * blocks(n) + 1;
const hmac = (n: number): number => 2 * 65 + sha(64 + n) + sha(96);
const edges = [0, 1, 55, 56, 63, 64, 119, 120, 1000, 10000];
console.log(`  sha256 steps at ${edges.join(', ')} bytes: ${edges.map(n => stepsOf('digest', n)).join(', ')}`);
same(
  'sha256: 66 steps a 64-byte block, and 1 (0 to 55 bytes are one block, 56 to 119 two, 10,000 bytes 157)',
  edges.map(n => stepsOf('digest', n)),
  edges.map(sha),
);
const pairs = [
  [3, 0],
  [20, 100],
  [64, 1000],
  [65, 10],
  [200, 10],
] as const;
same(
  'hmac_sha256: 2 * 65 steps for the keys, then its two digests (64 + n bytes, and 96), and a key past 64 bytes hashed first',
  pairs.map(([k, n]) => stepsOf('mac', k, n)),
  pairs.map(([k, n]) => hmac(n) + (k > 64 ? sha(k) : 0)),
);
same(
  'hmac_sha256_verify: hmac_sha256 and 33 steps, for the right mac and for one that differs at byte 0, 1, 15 or 31',
  [-1, 0, 1, 15, 31].map(i => stepsOf('check', i)),
  [-1, 0, 1, 15, 31].map(() => 2 * hmac(4) + 33), // check makes the right mac first, then verify makes it again
);
same(
  'hex and base64: one step a byte and 1, one for each 3 bytes and 1',
  [0, 1, 2, 3, 100].map(n => stepsOf('encoded', n)),
  [0, 1, 2, 3, 100].map(n => n + 1 + Math.floor(n / 3) + 1),
);
same(
  'from_base64url: one step a character and one for each 4, and 2',
  [0, 2, 3, 4, 100, 1002].map(n => stepsOf('decoded', n)),
  [0, 2, 3, 4, 100, 1002].map(n => n + 1 + Math.floor(n / 4) + 1),
);

finish();
