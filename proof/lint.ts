// proof/lint.ts: oxlint (.oxlintrc.json), with the rules that need types, over every file that is typed: the
// tracked TypeScript not on proof/untyped.txt, and the TypeScript not yet tracked (a new file is typed from its first
// line: before, a file not yet added was left out, so `npm run fast` passed new files with lint errors in them). A
// file leaves that list by passing tsc and this.
//   node proof/lint.ts [file ...]   with files named, only those of them that are typed (proof/fast.ts)
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const root = new URL('..', import.meta.url).pathname;
const untyped = new Set(readFileSync(`${root}proof/untyped.txt`, 'utf8').split('\n'));
const outside =
  /^service\/runtime\.d\.ts$|^experiments\/(?!(c78\/(mutants|round2|round3|timed-mutants|fulfillment-mutants)|lang\/port-keys)\.ts$)/;
const typed = [
  ...execFileSync('git', ['ls-files', '*.ts'], { cwd: root, encoding: 'utf8' }).split('\n'),
  ...execFileSync('git', ['ls-files', '--others', '--exclude-standard', '*.ts'], { cwd: root, encoding: 'utf8' }).split(
    '\n',
  ),
].filter(f => f !== '' && !untyped.has(f) && !outside.test(f));
const named = new Set(process.argv.slice(2));
if (named.size > 0) typed.splice(0, typed.length, ...typed.filter(f => named.has(f)));
if (typed.length === 0) {
  console.log('0 files to lint');
  process.exit(0);
}

const run = spawnSync('npx', ['oxlint', '--type-aware', '--deny-warnings', ...typed], { cwd: root, stdio: 'inherit' });
console.log(run.status === 0 ? `${typed.length} files, no findings` : 'oxlint found problems');
process.exit(run.status ?? 1);
