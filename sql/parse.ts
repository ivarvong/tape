// sql/parse.ts: tokens to a tree, for the subset of SQL a tape program may use. A statement outside it is refused
// with the first token that cannot be taken and why.
// parse(src) → one statement's tree, or throws SqlError. Every node has s and e, offsets into src.
// The productions are in sql/parse/: query.ts (expressions, SELECT), write.ts (INSERT, UPDATE, DELETE), ddl.ts
// (CREATE, ALTER, DROP), each a function from the cursor (cursor.ts) to a node.
import type { Statement } from './ast.ts';
import { Cursor } from './parse/cursor.ts';
import { alter, create, drop } from './parse/ddl.ts';
import { select } from './parse/query.ts';
import { del, insert, update } from './parse/write.ts';
import { SqlError } from './tokens.ts';

// statements SQLite has and a tape program may not run
const REFUSED = [
  'PRAGMA',
  'ATTACH',
  'DETACH',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'SAVEPOINT',
  'RELEASE',
  'VACUUM',
  'ANALYZE',
  'REINDEX',
];

function statement(c: Cursor): Statement {
  const t = c.peek();
  if (c.isKw('WITH')) c.refuse('a WITH clause (common table expression)');
  if (c.isKw('EXPLAIN')) c.refuse('EXPLAIN');
  if (c.isAnyKw('SELECT', 'VALUES')) return select(c);
  if (c.isAnyKw('INSERT', 'REPLACE')) return insert(c);
  if (c.isKw('UPDATE')) return update(c);
  if (c.isKw('DELETE')) return del(c);
  if (c.isKw('CREATE')) return create(c);
  if (c.isKw('ALTER')) return alter(c);
  if (c.isKw('DROP')) return drop(c);
  if (c.isAnyKw(...REFUSED)) c.refuse(`the ${t.v} statement`);
  return c.fail('expected a statement (SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER or DROP)');
}
export function parse(src: string): Statement {
  const c = new Cursor(src),
    st = statement(c);
  c.eatOp(';');
  if (c.peek().t !== 'eof') {
    if (c.last().v === ';') c.refuse('a second statement after ";": one statement per query');
    c.fail('expected the end of the statement');
  }
  return st;
}
/** The tree, or the error: `subset` for a form SQLite takes that tape refuses, `syntax` for what is not SQL. */
export function tryParse(src: string): { ast: Statement; error?: undefined } | { error: SqlError; ast?: undefined } {
  try {
    return { ast: parse(src) };
  } catch (e) {
    if (e instanceof SqlError) return { error: e };
    throw e;
  }
}
