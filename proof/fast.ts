// proof/fast.ts: the check before a commit, in seconds: format, lint and types for what changed.
//   node proof/fast.ts            the working tree's changes against HEAD, and files not yet tracked (npm run fast)
//   node proof/fast.ts --staged   the files staged (the pre-commit hook: proof/install-hooks.sh)
// Checks the files as they are on disk. Runs, side by side: prettier --check on the changed files; oxlint
// (proof/lint.ts) on the changed TypeScript that is typed; tsc on each project a changed file is in (all of them
// when a file of the toolchain changed, since the service, tape-mcp and the playground import it); and tape fmt
// --check on the changed programs the gate formats. Not the gate: `npm run check` still runs everything.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

const root = new URL('..', import.meta.url).pathname,
  node = process.execPath,
  staged = process.argv.includes('--staged');
const git = (args: string[]): string[] =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(f => f !== '');
const changed = [
  ...new Set(
    staged
      ? git(['diff', '--cached', '--name-only', '--diff-filter=ACMR'])
      : [
          ...git(['diff', '--name-only', '--diff-filter=ACMR', 'HEAD']),
          ...git(['ls-files', '--others', '--exclude-standard']),
        ],
  ),
].filter(f => existsSync(root + f));
if (changed.length === 0) {
  console.log('fast: nothing changed');
  process.exit(0);
}
const ts = changed.filter(f => f.endsWith('.ts'));
// the directories whose programs the gate formats (proof/all.ts)
const FORMATTED = new Set([
  'std',
  'examples',
  'examples/timed',
  'examples/tools',
  'apps/tickets',
  'apps/queue',
  'apps/highlight',
  'apps/trace',
  'apps/trace/fixtures',
  'testdata/compare',
]);
const tapes = changed.filter(f => f.endsWith('.tape') && FORMATTED.has(dirname(f)));
// a TypeScript file's project; a file of the toolchain (anything else) is imported by every project
const PROJECTS: readonly (readonly [prefix: string, projects: readonly string[]])[] = [
  ['service/scripts/', ['service/scripts']],
  ['service/', ['service/tsconfig.json']],
  ['mcp/test/', ['mcp/test']],
  ['mcp/', ['mcp', 'mcp/test']],
  ['apps/playground/', ['apps/playground', 'tsconfig.json']],
  ['apps/highlight/', ['apps/highlight', 'tsconfig.json']],
];
const ALL = [
  'tsconfig.json',
  'service/tsconfig.json',
  'mcp',
  'mcp/test',
  'apps/playground',
  'service/scripts',
  'apps/highlight',
];
const projects = new Set<string>();
for (const f of ts) {
  const hit = PROJECTS.find(([p]) => f.startsWith(p));
  for (const p of hit ? hit[1] : ALL) projects.add(p);
}
type Job = { name: string; cmd: string[] };
const jobs: Job[] = [
  { name: `prettier (${changed.length} files)`, cmd: ['npx', 'prettier', '--check', '--ignore-unknown', ...changed] },
  ...(ts.length > 0 ? [{ name: `oxlint (${ts.length} files)`, cmd: [node, 'proof/lint.ts', ...ts] }] : []),
  ...[...projects].map(p => ({ name: `tsc -p ${p}`, cmd: ['npx', 'tsc', '--noEmit', '-p', p] })),
  ...(tapes.length > 0
    ? [{ name: `tape fmt (${tapes.length} files)`, cmd: [node, 'tape.ts', 'fmt', '--check', ...tapes] }]
    : []),
];
const began = Date.now();
const run = (j: Job): Promise<{ j: Job; ok: boolean; out: string; s: number }> =>
  new Promise(done => {
    const [program = '', ...args] = j.cmd;
    const t = Date.now(),
      child = spawn(program, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }),
      chunks: Buffer[] = [];
    child.stdout.on('data', (b: Buffer) => {
      chunks.push(b);
    });
    child.stderr.on('data', (b: Buffer) => {
      chunks.push(b);
    });
    child.on('close', status => {
      done({ j, ok: status === 0, out: Buffer.concat(chunks).toString('utf8'), s: (Date.now() - t) / 1000 });
    });
  });
const results = await Promise.all(jobs.map(run));
for (const r of results) {
  console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.s.toFixed(1).padStart(5)} s  ${r.j.name}`);
  if (!r.ok)
    console.log(
      r.out
        .trim()
        .split('\n')
        .slice(-30)
        .map(l => `            | ${l}`)
        .join('\n'),
    );
}
const bad = results.filter(r => !r.ok).length;
console.log(
  `fast: ${changed.length} changed files, ${results.length} checks, ${bad} failed, ${((Date.now() - began) / 1000).toFixed(1)} s${bad > 0 ? ' (npx prettier --write <file> fixes the format)' : ''}`,
);
process.exit(bad > 0 ? 1 : 0);
