// compiler/sha256.ts against node:crypto's SHA-256 (an implementation that shares nothing with it): every length
// from 0 to 300 bytes (each padding case: 55, 56, 63, 64 bytes and the block boundaries after), random bytes and
// text, and one input of 100 KB; hashing twice gives the same answer (the initial hash is copied, never mutated).
import { createHash } from 'node:crypto';
import { sha256 } from '../compiler/sha256.ts';
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
finish();
