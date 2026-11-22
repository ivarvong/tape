// node service/verify/mutate/tally.ts <mutants.jsonl> [--survivors]: the mutants of mutate.ts counted by file and
// verdict, and the total killed; with --survivors, each mutant that was not killed.
import { readFileSync } from 'node:fs';
import { fields, text } from '../../jepsen/json.ts';

const [path, survivors] = process.argv.slice(2);
if (path === undefined) throw new Error('usage: tally.ts <mutants.jsonl> [--survivors]');
const mutants = readFileSync(path, 'utf8')
  .trim()
  .split('\n')
  .map(line => {
    const stored: unknown = JSON.parse(line);
    return fields(stored);
  })
  .filter(r => text(r['file']) !== '');
if (survivors !== undefined)
  for (const r of mutants.filter(m => m['verdict'] !== 'killed'))
    console.log(' ', r['verdict'], r['file'], r['line'], r['type']);
for (const [file, of] of Map.groupBy(mutants, r => text(r['file']))) {
  const verdicts = Object.fromEntries([...Map.groupBy(of, r => text(r['verdict']))].map(([v, rs]) => [v, rs.length]));
  console.log(file, JSON.stringify(verdicts));
}
console.log('total', mutants.filter(r => r['verdict'] === 'killed').length, 'of', mutants.length);
