// What the proof scripts share: where the repository is, an option from the command line, a program read under the
// name its callers reach it by, and a result written down (proof/results/, not tracked: each run writes its own).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFlat } from '../fmt.ts';

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

// proof/results/<name>.json
export const record = (name: string, result: unknown): void => {
  mkdirSync(`${root}proof/results`, { recursive: true });
  writeFileSync(`${root}proof/results/${name}.json`, JSON.stringify(result, null, 1) + '\n');
};
