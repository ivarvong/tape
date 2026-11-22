// proof/same-output.ts: has a change to the compiler changed what it makes? Every program of the repository is
// compiled with the rules on and off, parsed, and formatted; everything that comes back is hashed, a line a
// program. Moving code about must leave every line as it was.
//   node proof/same-output.ts > before.txt          before the change
//   node proof/same-output.ts --against before.txt  after it: prints the programs whose line differs, exits 1 if any
import '../node25.ts';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { compile, parseProgram } from '../compiler.ts';
import { format } from '../fmt.ts';
import { std } from '../std.ts';
import { root, arg, read } from './lib.ts';

const DIRS = ['examples', 'apps', 'service/test/fixtures', 'experiments/lang/before', 'testdata'];
const tapes = (dir: string): string[] =>
  readdirSync(root + dir).flatMap((f): string[] => {
    const path = `${dir}/${f}`;
    return statSync(root + path).isDirectory() ? tapes(path) : f.endsWith('.tape') ? [path] : [];
  });
// bytes as base64 and big integers as text, so a module and its tables hash by what they hold
const plain = (_key: string, value: unknown): unknown =>
  value instanceof Uint8Array
    ? Buffer.from(value).toString('base64')
    : typeof value === 'bigint'
      ? String(value)
      : value;
const hash = (value: unknown): string =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value, plain))
    .digest('hex')
    .slice(0, 12);
const attempt = (make: () => unknown): string => {
  try {
    return hash(make());
  } catch (e) {
    return `threw:${hash(e instanceof Error ? e.message : String(e))}`;
  }
};

const lines = DIRS.flatMap(tapes)
  .toSorted()
  .map(path => {
    // a program is read flat, which parses it: one that no longer parses (an archived one in an old form) is a line
    // of what it threw, in each column, and is compared like any other
    let text = '';
    const flat = attempt(() => (text = read(path)));
    if (flat.startsWith('threw:')) return [path, flat, flat, flat, flat].join(' ');
    const sources = [...std, { name: 'program.tape', text }];
    return [
      path,
      attempt(() => compile(sources)),
      attempt(() => compile(sources, { rules: false })),
      attempt(() => parseProgram(sources)),
      attempt(() => format(read(path))),
    ].join(' ');
  });

const against = arg('against', '');
if (!against) {
  console.log(lines.join('\n'));
} else {
  const before = new Map(
    readFileSync(against, 'utf8')
      .trim()
      .split('\n')
      .map(line => [line.split(' ')[0], line]),
  );
  const changed = lines.filter(line => before.get(line.split(' ')[0]) !== line).map(line => line.split(' ')[0]);
  const gone = [...before.keys()].filter(path => !lines.some(line => line.startsWith(path + ' ')));
  console.log(
    changed.length > 0 || gone.length > 0
      ? `DIFFERENT: ${[...changed, ...gone.map(p => `${p} (gone)`)].join(', ')}`
      : `the same: ${lines.length} programs, each compiled with the rules on and off, parsed and formatted`,
  );
  process.exit(changed.length > 0 || gone.length > 0 ? 1 : 0);
}
