// scan_plain(v, at), the built-in std/json.tape reads a string's plain runs with (16 bytes at a time, Wasm SIMD,
// then byte by byte): under the three builds and the interpreter, against a byte loop here, at every position of
// 3,000 generated texts (lengths 0 to 80, so every alignment of the 16-byte blocks and of the tail; each stopping
// byte, a quote, a backslash, a control byte, 127 and 128, 255, at every place), and the traps for `at` outside
// 0..len.
import '../node25.ts';
import { compile } from '../compiler.ts';
import type { Options } from '../compiler.ts';
import { interpret } from '../interp.ts';
import { std } from '../std.ts';
import { bare, finish, handleBare, same } from './harness.ts';

// every position's answer, then the answers for at = len + 1 and at = -1 (each a trap)
const program = `fn handle(raw: View) -> Buf {
  each(v: raw, at: 0, out: buf())
}

fn each(v: View, at: Int, out: Buf) -> Buf {
  match {
    at > len(v) -> out
    else -> each(v, at: at + 1, out: out |> write_int(value: scan_plain(v, at)) |> push(byte: 32))
  }
}

fn past(raw: View) -> Int {
  scan_plain(v: raw, at: len(raw) + 1)
}

fn at_minus_one(raw: View) -> Int {
  scan_plain(v: raw, at: -1)
}
`;
const oracle = (v: Uint8Array): string => {
  let out = '';
  for (let at = 0; at <= v.length; at++) {
    let i = at;
    while (i < v.length && (v[i] ?? 0) >= 32 && (v[i] ?? 0) < 128 && v[i] !== 34 && v[i] !== 92) i++;
    out += `${i} `;
  }
  return out;
};
let seed = 7;
const rand = (n: number): number => {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return (seed >>> 8) % n;
};
const STOPS = [34, 92, 0, 10, 31, 127, 128, 255, 200];
const texts = Array.from({ length: 3000 }, (_, k) => {
  const n = k % 81;
  const b = Uint8Array.from({ length: n }, () => 32 + rand(95));
  // none, one or a few stopping bytes, anywhere (127 does not stop: it is below 128 and not a control byte)
  if (n > 0) for (let s = rand(4); s > 0; s--) b[rand(n)] = STOPS[rand(STOPS.length)] ?? 34;
  return b;
});

const builds: [string, Partial<Options>][] = [
  ['default', {}],
  ['no reuse', { reuse: false }],
  ['tail calls off', { tailCalls: false }],
];
const sources = [...std, { name: 'scan.tape', text: program }];
const dec = new TextDecoder();
const it = interpret(sources);
for (const [label, o] of builds) {
  const r = compile(sources, { ...o, exports: ['handle', 'past', 'at_minus_one'] });
  if (!r.wasm) throw new Error(`${label}: ${r.errors.map(e => e.message).join('; ')}`);
  const b = bare(new WebAssembly.Module(r.wasm));
  let agree = 0;
  for (const v of texts) if (handleBare(b, v) === oracle(v)) agree++;
  same(`${label}: scan_plain at every position of 3,000 texts, as the byte loop`, agree, texts.length);
  const traps = ['past', 'at_minus_one'].map(f => {
    try {
      b.fns[f]?.(0, 0);
      return 'no trap';
    } catch {
      return `trap ${b.why()}`;
    }
  });
  same(`${label}: at past the end, and at -1, trap 3`, traps, ['trap 3', 'trap 3']);
}
let interpAgree = 0;
for (const v of texts.slice(0, 600)) if (dec.decode(it.handle(v)) === oracle(v)) interpAgree++;
same('the interpreter: scan_plain at every position of 600 texts, as the byte loop', interpAgree, 600);
finish();
