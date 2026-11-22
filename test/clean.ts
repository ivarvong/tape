// test/clean.ts: what a typed file may not have. No cast (`as T`, other than `as const`), no `!` that asserts a value
// is there, no `any`. Every typed file meets this; there is no list of exceptions.
import '../node25.ts';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { finish, ok } from './harness.ts';

const root = new URL('..', import.meta.url).pathname;
const lines = (path: string): string[] =>
  readFileSync(root + path, 'utf8')
    .split('\n')
    .filter(Boolean);
const untyped = new Set(lines('proof/untyped.txt'));
const typed = execFileSync('git', ['ls-files', '*.ts'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter(
    f =>
      f !== '' &&
      !untyped.has(f) &&
      !/^service\/runtime\.d\.ts$|^experiments\/(?!(c78\/(mutants|round2|round3|timed-mutants|fulfillment-mutants)|lang\/port-keys)\.ts$)/.test(
        f,
      ),
  );

/** The casts, `!` and `any` of a file, each as `file:line what`. */
const found = (file: string): string[] => {
  const source = ts.createSourceFile(file, readFileSync(root + file, 'utf8'), ts.ScriptTarget.ESNext, true),
    out: string[] = [];
  const at = (n: ts.Node, what: string): void => {
    out.push(`${file}:${source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1} ${what}`);
  };
  const visit = (n: ts.Node): void => {
    if (ts.isAsExpression(n) && n.type.getText(source) !== 'const') at(n, 'a cast');
    if (ts.isTypeAssertionExpression(n)) at(n, 'a cast');
    if (ts.isNonNullExpression(n)) at(n, 'a `!`');
    if (n.kind === ts.SyntaxKind.AnyKeyword) at(n, '`any`');
    ts.forEachChild(n, visit);
  };
  visit(source);
  return out;
};
const all = typed.flatMap(found);
ok(
  `none of the ${typed.length} typed files has a cast, a \`!\` or \`any\``,
  all.length === 0,
  all.slice(0, 20).join('; '),
);
finish();
