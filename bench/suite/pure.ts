// bench/suite/pure.ts: two workloads with no database: CSV (examples/csv.tape against bench/csv-baseline.ts) and
// word counts (examples/words.tape against the twin here).
import { handle as csvJs } from '../csv-baseline.ts';
import { gen as csvGen } from '../csv-gen.ts';
import { dec, enc, rng } from './rand.ts';
import type { Workload } from './common.ts';

// ---- words: the twin of examples/words.tape. A word is a run of ASCII letters; counts by word in byte order.
export function wordsJs(bytes: Uint8Array): Uint8Array {
  const text = dec.decode(bytes);
  const counts = new Map<string, number>();
  for (const w of text.match(/[A-Za-z]+/g) ?? []) counts.set(w, (counts.get(w) ?? 0) + 1);
  const keys = [...counts.keys()].toSorted();
  return enc.encode(JSON.stringify({ distinct: keys.length, counts: keys.map(k => [k, counts.get(k)]) }));
}
const VOCAB = Array.from({ length: 5000 }, (_, i) => {
  const r = rng(i + 1);
  return Array.from({ length: r(1, 10) }, () => String.fromCodePoint(r(0, 9) < 2 ? r(65, 90) : r(97, 122))).join('');
});
const SEPS = [' ', ' ', ' ', ', ', '. ', '\n', ' — ', ' (', ') ', ' 42 ', '’', '-'];
/** About `size` bytes of prose-like text: Zipf-ish words from a fixed vocabulary, punctuation, digits, UTF-8. */
export function prose(size: number, seed: number): Uint8Array {
  const r = rng(seed);
  const parts: string[] = [];
  let n = 0;
  while (n < size) {
    const w = VOCAB[Math.floor(VOCAB.length * (r(0, 1_000_000) / 1_000_001) ** 3)] ?? 'x';
    const s = SEPS[r(0, SEPS.length - 1)] ?? ' ';
    parts.push(w, s);
    n += w.length + s.length;
  }
  return enc.encode(parts.join(''));
}

export const csv: Workload = {
  name: 'csv',
  describe: 'aggregate a CSV body by country (examples/csv.tape vs bench/csv-baseline.ts)',
  tape: 'examples/csv.tape',
  sql: false,
  js: () => csvJs,
  inputs: () => [
    ...Array.from({ length: 40 }, (_, i) => i + 1).flatMap(seed =>
      [200, 5000, 60_000].map(size => csvGen(size, seed, seed % 2 === 0)),
    ),
    ...[
      '',
      'ts,user,amount,country',
      'nope\n1,u,1,US\n',
      'ts,user,amount,country\n1,u,-0,US\n1,u,-,US\n,u,1,US\r\n',
    ].map(t => enc.encode(t)),
  ],
  request: (k, scale) => csvGen(Math.round(2_000_000 * scale), k + 7, k % 2 === 0),
};
export const words: Workload = {
  name: 'words',
  describe: 'count the words of a text body (examples/words.tape vs a JS twin: regex + Map + sort)',
  tape: 'examples/words.tape',
  sql: false,
  js: () => wordsJs,
  inputs: () => [
    ...Array.from({ length: 100 }, (_, i) => prose([10, 300, 5000, 60_000][i % 4] ?? 10, i + 1)),
    ...['', '   ', 'a', 'Aa aA aa AA', 'x1y2z', 'é ü ß', 'one-two three\nfour'].map(t => enc.encode(t)),
  ],
  request: (k, scale) => prose(Math.round(2_000_000 * scale), k + 11),
};
