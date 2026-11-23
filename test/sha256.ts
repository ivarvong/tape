// compiler/sha256.ts against node:crypto's SHA-256 (an implementation that shares nothing with it): every length
// from 0 to 300 bytes (each padding case: 55, 56, 63, 64 bytes and the block boundaries after), random bytes and
// text, and one input of 100 KB; hashing twice gives the same answer (the initial hash is copied, never mutated).
// Sha256 a part at a time (cut anywhere, cloned midway) gives the same digests; compiler/build.ts buildName, which
// keeps the hash of the standard library's part, gives what the formula it replaces gives (the JSON of every
// source and the pin, hashed whole), for std and a program, std alone, a program alone, several files, another pin,
// text beyond ASCII, and a std of other objects after one was kept.
import { createHash } from 'node:crypto';
import { buildName } from '../compiler/build.ts';
import { Sha256, sha256 } from '../compiler/sha256.ts';
import { std } from '../std.ts';
import { finish, same } from './harness.ts';

let seed = 12345;
const byte = (): number => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed >>> 23;
};
const oracle = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const wrong: number[] = [];
for (let n = 0; n <= 300; n++) {
  const b = Uint8Array.from({ length: n }, byte);
  if (sha256(b) !== oracle(b)) wrong.push(n);
}
same('every length 0..300 agrees with node:crypto', wrong, []);
const text = new TextEncoder().encode('std/core.tape\nfn handle(raw: View) -> Buf { … }\n'.repeat(2000));
same('100 KB of text', sha256(text), oracle(text));
same('the empty input', sha256(new Uint8Array(0)), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
const abc = new TextEncoder().encode('abc');
same('twice in a row, the same', [sha256(abc), sha256(abc)], [oracle(abc), oracle(abc)]);

// a part at a time: 200 inputs, each cut at random places, one cut cloned and both copies finished
const cuts: number[] = [];
for (let n = 0; n < 200; n++) {
  const b = Uint8Array.from({ length: (byte() * 7) % 400 }, byte);
  const h = new Sha256();
  let at = 0;
  while (at < b.length) {
    const next = Math.min(b.length, at + (byte() % 90));
    h.update(b.subarray(at, next));
    at = next;
  }
  const copy = h.clone();
  if (h.hex() !== oracle(b) || copy.hex() !== oracle(b)) cuts.push(b.length);
}
same('a part at a time, and a clone of it: node:crypto', cuts, []);

const formula = (sources: { name: string; text: string }[], pin: unknown): string =>
  oracle(new TextEncoder().encode(JSON.stringify([sources.map(x => [x.name, x.text]), pin]))).slice(0, 16);
const prog = { name: 'hello.tape', text: 'fn handle(raw: View) -> Buf {\n  "héllo ✓ \\"q\\""\n}\n' };
const cases: [string, { name: string; text: string }[], unknown][] = [
  ['std and a program', [...std, prog], {}],
  ['std and a program again (from the kept hash)', [...std, prog], {}],
  ['std alone', [...std], {}],
  ['a program alone', [prog], {}],
  ['std and two files', [...std, prog, { name: 'b.tape', text: 'b' }], {}],
  ['another pin', [...std, prog], { beta: true, n: 2 }],
  ['std of other objects, the same text', [...std.map(f => ({ ...f })), prog], {}],
  ['std changed', [...std.map((f, i) => (i === 0 ? { ...f, text: `${f.text}\n` } : f)), prog], {}],
  ['std again, after the change', [...std, prog], {}],
];
same(
  'buildName: the formula it replaces',
  cases.map(([what, s, pin]) => [what, buildName(s, pin)]),
  cases.map(([what, s, pin]) => [what, formula(s, pin)]),
);
finish();
