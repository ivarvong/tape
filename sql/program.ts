// sql/program.ts: the schema of a whole program: its schema statements and migrations, in order, each checked.
// The schema a program's statements build: schema statements, then migrations, in order. Returns { schema, asts:
// Map(statement text → tree), errors: [{ at: { migration | schema index }, statement, message, kind }] }.
// Schema statements run again after the migrations (a name's data made before, then migrated), quietly.
import type { Schema, Statement } from './ast.ts';
import { analyze } from './analyze.ts';
import { tryParse } from './parse.ts';
import { applyToSchema, newSchema } from './schema.ts';

/** Where a statement of the schema stands: the i-th schema statement, or the i-th statement of a migration. */
export type SchemaAt = { schema: number } | { migration: number; i: number };
export type SchemaError = { at: SchemaAt; statement: string; message: string; kind: string };
export type ProgramSchema = { schema: Schema; asts: Map<string, Statement>; errors: SchemaError[] };
export function schemaOf(
  schemaStatements: readonly string[] = [],
  migrations: readonly { n: number; statements: readonly string[] }[] = [],
): ProgramSchema {
  const sc = newSchema(),
    errors: SchemaError[] = [],
    asts = new Map<string, Statement>();
  const run = (st: string, at: SchemaAt, quiet: boolean): void => {
    const r = tryParse(st);
    if (r.error) {
      if (!quiet)
        errors.push({
          at,
          statement: st,
          message: r.error.message,
          kind: r.error.kind === 'subset' ? 'subset' : 'syntax',
        });
      return;
    }
    asts.set(st, r.ast);
    if (!quiet)
      for (const e of analyze(r.ast, sc, { src: st }).errors)
        errors.push({ at, statement: st, message: e.message, kind: e.kind });
    // a statement that reads or writes rows builds nothing
    if (['insert', 'update', 'delete', 'select'].includes(r.ast.k)) return;
    const e = applyToSchema(sc, r.ast);
    if (e && !quiet) errors.push({ at, statement: st, message: e, kind: 'name' });
  };
  schemaStatements.forEach((st, i) => run(st, { schema: i }, false));
  for (const m of migrations) m.statements.forEach((st, i) => run(st, { migration: m.n, i }, false));
  schemaStatements.forEach((st, i) => run(st, { schema: i }, true));
  return { schema: sc, asts, errors };
}
