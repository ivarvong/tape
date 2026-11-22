// node service/verify/mutate/mutate.ts --root <checkout> --out <file.jsonl> [--only <file>] [--list]
// Mutation testing of the service's checkers. Each site where a checker reports an anomaly is disabled in turn (the
// call `anomalies.push(…)` or `bad(…)` becomes `void (…)`: its arguments are still evaluated, the control flow
// after it is unchanged, nothing is reported). Then the checkers' self-test is run in <root>; a mutant is killed if
// it fails, and survives if it passes. The file is restored after each mutant, and the checkout is checked clean at
// the end. Run it on a separate checkout (git worktree): it edits files in place.
// (The compiler's rules have their own mutation proof, proof/mutation.ts.)
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { flag, has, need } from '../../jepsen/cli.ts';

const FILES = [
  'service/jepsen/traces.ts',
  'service/jepsen/kv.ts',
  'service/jepsen/harness.ts',
  'service/jepsen/retention.ts',
];
const KILLER = ['service/jepsen/selftest.ts'];

/** A reporting call: where it is, and the anomaly type it reports (or the start of the call). */
export type Site = { line: number; col: number; call: string; type: string };
// every reporting call: anomalies.push( | bad( , not the definition of bad
const SITE = /\banomalies\.push\(|(?<![\w.])bad\(/g;
const typeOf = (rest: string): string =>
  (/^\S+?\(\s*\{\s*type:\s*([`'][^`']*[`'])/.exec(rest) ?? /^\S+?\(\s*(['`][^'`]*['`])/.exec(rest))?.[1] ??
  rest.slice(0, 40);
export const sites = (source: string): Site[] =>
  source.split('\n').flatMap((line, i) => {
    if (/^\s*\/\//.test(line)) return [];
    return [...line.matchAll(SITE)].flatMap((m): Site[] => {
      const before = line.slice(0, m.index),
        through = line.slice(0, m.index + m[0].length);
      // the definition, or inside a comment
      if (/\bbad\s*=\s*\($/.test(through) || before.includes('//')) return [];
      return [{ line: i + 1, col: m.index, call: m[0], type: typeOf(line.slice(m.index)) }];
    });
  });

const root = need('root'),
  out = flag('out'),
  only = flag('only');
const read = (file: string): string => readFileSync(`${root}/${file}`, 'utf8');
const original = new Map(FILES.map(f => [f, read(f)]));
const all = FILES.filter(f => only === undefined || f === only).flatMap(f =>
  sites(read(f)).map(s => ({ file: f, ...s })),
);
if (has('list')) {
  for (const s of all) console.log(`${s.file}:${s.line}:${s.col} ${s.type}`);
  console.log(all.length, 'sites');
  process.exit(0);
}
if (out !== undefined) writeFileSync(out, '');
for (const s of all) {
  const path = `${root}/${s.file}`,
    orig = read(s.file),
    lines = orig.split('\n'),
    line = lines[s.line - 1] ?? '';
  lines[s.line - 1] = `${line.slice(0, s.col)}void (${line.slice(s.col + s.call.length)}`;
  writeFileSync(path, lines.join('\n'));
  const began = Date.now(),
    r = spawnSync(process.execPath, KILLER, { cwd: root, encoding: 'utf8', maxBuffer: 2 ** 28 });
  writeFileSync(path, orig);
  const verdict = r.status === 0 ? 'survived' : 'killed';
  const rec = { verdict, file: s.file, line: s.line, col: s.col, type: s.type, ms: Date.now() - began };
  if (out !== undefined) appendFileSync(out, `${JSON.stringify(rec)}\n`);
  console.log(verdict, `${s.file}:${s.line}`, s.type);
}
// every file as it was before the first mutant
const dirty = FILES.filter(f => read(f) !== original.get(f)).join(' ');
console.log(dirty === '' ? 'CLEAN (every file as it was before)' : `NOT RESTORED: ${dirty}`);
if (out !== undefined) appendFileSync(out, `${JSON.stringify({ clean: dirty === '' })}\n`);
