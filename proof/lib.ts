// What the proof scripts share: where the repository is, an option from the command line, a program read under the
// name its callers reach it by, and a result written down (proof/results/, not tracked: each run writes its own).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFlat, usesStripped, usesWritten } from '../fmt.ts';
import { std } from '../std.ts';

export const root = new URL('../', import.meta.url).pathname;

// --name value on the command line, or the fallback
export const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : (process.argv[i + 1] ?? fallback);
};

// a file of the repository, by its path from the root
// a program is read flat (fmt.ts): the proofs that change one do it as text
export const read = (path: string): string =>
  path.endsWith('.tape') ? readFlat(root + path) : readFileSync(root + path, 'utf8');

// examples/orders.tape is the program `orders`: the name a Remote of another program reaches it by
export const program = (path: string): { name: string; text: string } => ({
  name: (path.split('/').pop() ?? path).replace(/\.tape$/, ''),
  text: read(path),
});

// A program with edits made (a planted bug), as a person makes them: to the program without its `uses` clauses, which
// the edits were written before, and the clauses then written again as fmt would, so an edit that drops a `wake`
// drops its function's `timer` with it (no catch: C101). null when an edit's text is not in the program.
export function edited(text: string, pairs: readonly (readonly [string, string])[]): string | null {
  const base = usesStripped(text);
  if (pairs.some(([from]) => !base.includes(from))) return null;
  return usesWritten(
    pairs.reduce((t, [from, to]) => t.replace(from, to), base),
    'program.tape',
    std,
  );
}

// proof/results/<name>.json
export const record = (name: string, result: unknown): void => {
  mkdirSync(`${root}proof/results`, { recursive: true });
  writeFileSync(`${root}proof/results/${name}.json`, JSON.stringify(result, null, 1) + '\n');
};
