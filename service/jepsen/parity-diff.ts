// node service/jepsen/parity-diff.ts <a.jsonl> <b.jsonl>
// Two sides of the parity check (parity.ts), compared seed by seed: each file holds one record per line, as
// parity-run.ts writes them (a line may begin with PARITY, as the local half prints them). Every difference is
// printed; the exit status is 1 when there is one, or when a seed is on one side only.
import { readFileSync } from 'node:fs';
import { parityDiff, recordOf } from './parity.ts';
import type { Record1 } from './parity.ts';

const recordsIn = (path: string): Map<number, Record1> =>
  new Map(
    readFileSync(path, 'utf8')
      .split('\n')
      .map(line => line.replace(/^PARITY /, ''))
      .filter(line => line.startsWith('{'))
      .map((line): [number, Record1] => {
        const stored: unknown = JSON.parse(line);
        const record = recordOf(stored);
        return [record.seed, record];
      }),
  );
const [left, right] = process.argv.slice(2);
if (left === undefined || right === undefined) throw new Error('usage: parity-diff.ts <a.jsonl> <b.jsonl>');
const a = recordsIn(left),
  b = recordsIn(right);
let differing = 0;
for (const seed of [...new Set([...a.keys(), ...b.keys()])].toSorted((x, y) => x - y)) {
  const [one, other] = [a.get(seed), b.get(seed)];
  const differences =
    one && other ? parityDiff(one, other) : [['seed', seed, one?.account ?? null, other?.account ?? null]];
  if (differences.length > 0) differing++;
  console.log(JSON.stringify({ seed, same: differences.length === 0, differences }));
}
console.log(JSON.stringify({ seeds: new Set([...a.keys(), ...b.keys()]).size, differing }));
process.exitCode = differing > 0 ? 1 : 0;
