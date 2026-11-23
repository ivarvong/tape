// compiler/rows.ts: `*` in a query with `row: R` is R's fields.

import { sqlModel } from '../rules.ts';
import type { ResultCol, Schema } from '../sql/ast.ts';
import { tryParse } from '../sql.ts';
import { asName } from '../sql/tokens.ts';
import { type At, type Call, type Program, eachExpr } from './ast.ts';
import { CompileError } from './common.ts';

// In a sql_first, sql_all or sql_move with `row: R`, a `*` in the SELECT list or the RETURNING list is R's fields,
// in R's order: each a column of the statement's one table, or an item the list gives as `expr AS field`
// (`RETURNING *, (SELECT count(*) …) AS invoices`). The query is rewritten before anything reads it, so the
// rules, the SQL checker (C69) and the module's statement list all see the columns; a field that is neither, an
// item that is no field, or a `*` over a join is C75. Without `row:` (sql_exec), `*` is SQL's own.
export const ROW_CALLS: ReadonlySet<string> = new Set(['sql_first', 'sql_all', 'sql_move']);
const text8 = new TextDecoder();
type Star = Extract<ResultCol, { star: true }>;
type Item = Extract<ResultCol, { star: false }>;

export function rowColumns(prog: Program): void {
  const err = (at: At, message: string, hint: string): never => {
    throw new CompileError({ code: 'C75', file: at.file, line: at.line, message, hint });
  };
  let schema: Schema | null = null;
  const expand = (e: Call): void => {
    const ra = e.args.find(a => a.label === 'row'),
      qa = e.args.find(a => a.label === 'query');
    if (!ra || !qa || ra.value.k !== 'ctor' || qa.value.k !== 'str') return; // C13, C14, C32 say what is wrong
    const query = qa.value,
      q = text8.decode(new Uint8Array(query.bytes));
    if (!q.includes('*')) return;
    const ast = tryParse(q).ast;
    if (!ast) return; // C67
    const list =
      ast.k === 'select'
        ? ast.cols
        : ast.k === 'insert' || ast.k === 'update' || ast.k === 'delete'
          ? ast.returning
          : null;
    const stars = (list ?? []).filter((c): c is Star => c.star),
      [star] = stars;
    if (!list || !star) return;
    const R = ra.value.name,
      decl = prog.types.get(R),
      fields = decl?.variants.length === 1 && !decl.refine ? decl.variants[0]?.fields : undefined;
    if (!fields) return; // the row type is checked where it is used
    if (stars.length > 1) err(qa, `the query of ${e.name} has more than one *`, `One * stands for the fields of ${R}.`);
    // the tables the statement reads: those of FROM, or the one a write is on
    const from =
      ast.k === 'select'
        ? ast.from.map(f => ({ name: f.name, alias: f.alias, plain: !f.sub, joined: !!f.join }))
        : 'table' in ast && 'alias' in ast
          ? [{ name: ast.table, alias: ast.alias, plain: true, joined: false }]
          : [];
    // `t.*` names its table, so it may stand in a join (`SELECT w.* FROM waitlist AS w JOIN tiers AS t …`); a bare
    // `*` is the fields of the one table read
    const [first] = from,
      src = star.table
        ? from.find(f => f.plain && (f.alias ?? f.name) === star.table)
        : from.length === 1 && first?.plain && !first.joined
          ? first
          : undefined;
    if (!src && star.table) return; // C68 names the table
    if (!src?.name)
      return err(
        qa,
        `* in a query with row: ${R} reads one table, and this query reads ${from.length > 0 ? from.length : 'none'}`,
        `Name the table the fields come from (\`w.*\`), or list the columns of ${R} (${fields.map(f => f.name).join(', ')}), naming each with its table.`,
      );
    const from1 = src.name;
    schema ??= sqlModel(prog).schema;
    const table = schema.tables.get(from1);
    if (!table) return; // C68 names the table
    const given = new Map<string, string>();
    for (const c of list.filter((item): item is Item => !item.star)) {
      const name = c.alias ?? (c.expr.k === 'col' ? c.expr.name : null);
      if (!name || !fields.some(f => f.name === name))
        return err(
          qa,
          `${q.slice(c.s, c.e)} is not a field of ${R}`,
          `With *, the other items give fields of ${R} that are not columns of ${from1}: write \`expr AS field\` for one of ${fields.map(f => f.name).join(', ')}.`,
        );
      if (given.has(name)) err(qa, `field ${name} of ${R} is given twice`, '');
      given.set(name, q.slice(c.s, c.e));
    }
    const cols = new Set(table.cols.map(c => c.name)),
      pre = star.table ? `${asName(star.table)}.` : src.alias ? `${asName(src.alias)}.` : '';
    const out = fields.map(
      f =>
        given.get(f.name) ??
        (cols.has(f.name)
          ? pre + asName(f.name) // a field named by a keyword the table quotes: "from"
          : err(
              qa,
              `field ${f.name} of ${R} is not a column of ${from1}`,
              `Give it in the list as \`expr AS ${f.name}\`, or add the column, or drop the field from ${R}.`,
            )),
    );
    const s0 = Math.min(...list.map(c => c.s)),
      s1 = Math.max(...list.map(c => c.e));
    query.written = q;
    query.bytes = [...new TextEncoder().encode(q.slice(0, s0) + out.join(', ') + q.slice(s1))];
  };
  for (const f of prog.fns.values())
    eachExpr(f.body, e => {
      if (e.k === 'call' && ROW_CALLS.has(e.name)) expand(e);
    });
}
