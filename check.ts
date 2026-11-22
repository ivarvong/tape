// check.ts: build-time check of a compiled module's SQL against its own schema, using SQLite itself (node:sqlite).
// Every statement must prepare against the schema; a query's result columns must be the row type's fields, in
// order, by name; and a column's declared type must fit the field (INTEGER for Int and Bool, TEXT for View).
import './node25.ts';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

/** What the check reads of a compiled module: each query, and the statements that build its schema. */
export type Checked = {
  queries: { sql: string; row?: string | null; columns?: string[] | null }[];
  schema: string[];
  migrations?: { statements: string[] }[];
};
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
// The schema at the chain point the program targets: its schema statements, then every migration in order.
export function checkQueries({ queries, schema, migrations = [] }: Checked): string[] {
  const db = new DatabaseSync(':memory:'),
    problems: string[] = [];
  for (const s of [...schema, ...migrations.flatMap(m => m.statements)])
    try {
      db.exec(s);
    } catch (e) {
      problems.push(`schema: ${messageOf(e)}: ${s}`);
    }
  for (const q of queries) {
    let st: StatementSync;
    try {
      st = db.prepare(q.sql);
    } catch (e) {
      problems.push(`${messageOf(e)}: ${q.sql}`);
      continue;
    }
    const cols = st.columns(),
      row = q.row,
      named = q.columns ?? [];
    if (!row) {
      if (cols.length > 0 && !/returning/i.test(q.sql))
        problems.push(`sql_exec is given a query that returns rows; use sql_first or sql_all: ${q.sql}`);
      continue;
    }
    if (cols.length !== row.length) {
      problems.push(
        `the query returns ${cols.length} columns (${cols.map(c => c.name).join(', ')}) but the row type has ${row.length} fields (${named.join(', ')}): ${q.sql}`,
      );
      continue;
    }
    cols.forEach((c, i) => {
      if (c.name !== named[i])
        problems.push(
          `column ${i + 1} is \`${c.name}\` but the row type's field ${i + 1} is \`${named[i]}\`; name the column with AS or reorder: ${q.sql}`,
        );
      const want = row[i]?.toLowerCase() === 't' ? 'TEXT' : 'INTEGER';
      if (c.type && c.type.toUpperCase() !== want)
        problems.push(`column \`${c.name}\` is declared ${c.type} but field \`${named[i]}\` needs ${want}: ${q.sql}`);
    });
  }
  return problems;
}
