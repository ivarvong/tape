// test/sql-tree.ts: the walk over a SQL statement's tree. sql/tree.ts names each node's children case by case;
// here the same walk is done without knowing any node (every object with a `k`, in the order its fields were
// written), and the two must visit the same nodes in the same order, for every statement the repository's programs
// and tests contain. And a statement printed, parsed and printed again is the same text.
import '../node25.ts';
import { readdirSync } from 'node:fs';
import type { SqlNode } from '../sql/ast.ts';
import { numbered } from '../compiler/sqltext.ts';
import { print, tryParse, walkSql } from '../sql.ts';
import { finish, ok, read } from './harness.ts';

const statements = new Set<string>();
const grab = (text: string): void => {
  for (const m of text.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    const quoted = m[1] ?? '';
    if (/\b(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/.test(quoted))
      // a query's names are numbered before it is parsed, as the compiler does
      statements.add(numbered(quoted.replaceAll('\\"', '"').replaceAll('\\n', '\n').trim()).sql);
  }
  for (const m of text.matchAll(/(?:migration[^{]*|invariant[^{]*)\{([^}]*)\}/g))
    for (const part of (m[1] ?? '').split(';')) statements.add(part.trim());
};
for (const dir of ['examples', 'examples/timed', 'apps/queue', 'apps/tickets', 'testdata/compare', 'std', 'test'])
  for (const file of readdirSync(new URL(`../${dir}`, import.meta.url)))
    if (/\.(tape|ts)$/.test(file)) grab(read(`${dir}/${file}`));

// every object with a `k`, outermost first, in the order its fields were written
const blind = (v: unknown, out: object[] = []): object[] => {
  if (typeof v !== 'object' || v === null) return out;
  if ('k' in v && typeof v.k === 'string') out.push(v);
  for (const [key, x] of Object.entries(v)) if (key !== 's' && key !== 'e') blind(x, out);
  return out;
};

let parsed = 0,
  nodes = 0;
const wrong: string[] = [];
for (const text of statements) {
  const r = tryParse(text);
  if (!r.ast) continue;
  parsed++;
  const seen: SqlNode[] = [];
  walkSql(r.ast, n => {
    seen.push(n);
  });
  const want = blind(r.ast);
  nodes += want.length;
  if (seen.length !== want.length || seen.some((n, i) => n !== want[i])) wrong.push(`walk: ${text.slice(0, 80)}`);
  const once = print(r.ast),
    again = tryParse(once);
  if (!again.ast || print(again.ast) !== once) wrong.push(`print: ${text.slice(0, 80)}`);
}
ok(`${parsed} statements parsed, ${nodes} nodes`, parsed > 300 && nodes > 3000);
ok(
  'the walk visits every node, in the order written; print round-trips',
  wrong.length === 0,
  wrong.slice(0, 5).join(' | '),
);
finish();
