// rules/move.ts: sql_move, a compare-and-set whose outcome is typed (C62, C63).
import type { Expr } from '../sql/ast.ts';
import { conjunctsOf } from '../sql.ts';
import type { MachineColumn, RuleTable } from './types.ts';
import { treeOf } from './model.ts';
import { lc, stripComments } from './syntax.ts';
import { isCol } from './writes.ts';

// ---- sql_move: a compare-and-set whose outcome is typed (C62, C63). The statement is one UPDATE of one row, named by
// its key, with a top-level guard on the column it compares (the table's machine column, or a column it sets), and
// RETURNING. When it changes no row, the same row is read by its key alone, in the same transaction, so the outcome
// is Moved(the row as RETURNING gives it), Raced(the row as it is now: another request moved it first) or NoRow.
// The re-read is derived here from the statement's tree, so a program never writes it, and never confuses the last
// two. Returns { table, select, params: [the UPDATE's placeholder numbers the SELECT takes, in its order] } or
// { error }.
// `tables` (tablesOf) tells which of the `column = value` conjuncts name the row: those on its primary key or a
// UNIQUE set. Any other one is a condition on the row (`AND attempts = ?2`), and failing it is a lost race, not a
// missing row: before 19 November 2026 such a condition was read as part of the key, and a row that was there was
// answered NoRow.
/** How a sql_move reads the row back when its UPDATE changes none, or why the statement cannot be a sql_move. */
export type MovePlan =
  | { error: string; select?: undefined }
  | {
      error?: undefined;
      table: string;
      /** the SELECT of the same row by its key alone */
      select: string;
      /** the UPDATE's placeholder numbers the SELECT takes, in its order */
      params: number[];
      /** the conjuncts that compare a column the statement sets, or the machine's */
      guards: Expr[];
      keyCols: (string | null)[];
      /** the `column = value` conjuncts that are no part of the key: conditions on the row */
      conditions: (string | null)[];
    };
export function movePlan(
  raw: string,
  machines: readonly MachineColumn[] = [],
  tables: ReadonlyMap<string, RuleTable> | null = null,
): MovePlan {
  const sql = stripComments(raw).replaceAll(/\s+/g, ' ').trim();
  const { ast, error } = treeOf(sql);
  if (error) return { error: `it is not SQL the checker reads (${error.message})` };
  if (ast.k !== 'update' || !ast.where || !ast.returning)
    return { error: 'sql_move takes one `UPDATE table SET … WHERE … RETURNING …`' };
  const table = ast.table,
    names = [lc(table), lc(ast.alias)].filter(Boolean),
    assigns = ast.set;
  const cs = conjunctsOf(ast.where);
  if (!cs) return { error: 'its WHERE has a top-level OR, so no conjunct names the row' };
  const machineCols = machines.filter(x => lc(x.table) === lc(table)).map(x => x.column);
  const cas = [...new Set([...machineCols, ...assigns.map(a => a.col)])];
  const guards = cs.filter(c => cas.some(col => guardOf(c, names, col)));
  if (guards.length === 0)
    return {
      error: `its WHERE compares no column it sets${machineCols.length > 0 ? ` and not ${table}.${machineCols[0]}` : ''} (\`AND ${machineCols[0] ?? assigns[0]?.col ?? 'state'} = …\`), so it is not a compare-and-set`,
    };
  const key = cs.filter(c => !guards.includes(c));
  const keyCol = (c: Expr): string | null =>
    c.k === 'bin' && c.op === '='
      ? c.l.k === 'col' && (!c.l.table || names.includes(lc(c.l.table))) && keyValue(c.r)
        ? c.l.name
        : c.r.k === 'col' && (!c.r.table || names.includes(lc(c.r.table))) && keyValue(c.l)
          ? c.r.name
          : null
      : null;
  const badC = key.find(c => !keyCol(c));
  if (key.length === 0 || badC)
    return {
      error: badC
        ? `besides the compare-and-set, its WHERE has \`${sql.slice(badC.ps ?? badC.s, badC.pe ?? badC.e)}\`, which is not \`column = value\`: the row must be named by its key alone, so a row that is there is told from one that is not`
        : 'its WHERE names no row: add the key (`id = :id`)',
    };
  const params: number[] = [];
  const ret = sql.slice(ast.returning[0]?.s, ast.returning.at(-1)?.e);
  const t = tables?.get(table) ?? [...(tables ?? [])].find(([n]) => lc(n) === lc(table))?.[1];
  const unique =
    t && [t.pk, ...t.uniques].find(u => u.length > 0 && u.every(c => key.some(k => lc(keyCol(k)) === lc(c))));
  const naming = unique ? key.filter(k => unique.some(c => lc(c) === lc(keyCol(k)))) : key;
  const select =
    `SELECT ${ret} FROM ${table} WHERE ${naming.map(c => sql.slice(c.ps ?? c.s, c.pe ?? c.e)).join(' AND ')}`.replaceAll(
      /\?(\d+)/g,
      (_, n: string) => {
        let i = params.indexOf(Number(n));
        if (i < 0) i = params.push(Number(n)) - 1;
        return `?${i + 1}`;
      },
    );
  return {
    table,
    select,
    params,
    guards,
    keyCols: key.map(keyCol),
    conditions: key.filter(k => !naming.includes(k)).map(keyCol),
  };
}
// C62 is about one row's compare-and-set: a WHERE that fixes a key of the table (its primary key, or a UNIQUE
// column set) with \`column = value\` conjuncts at the top level. A set update (\`… WHERE state = 'held' AND tier IN
// (…)\`) asks "which rows are still in this state", and 0 rows is its answer, not a lost race to tell apart.
/** What namesOneRow reads of a table: its keys, as the schema or the rules hold them. */
type Keys = { rowid?: string | null; pk: string[]; uniques?: ({ cols: string[] } | string[])[] };
export function namesOneRow(
  where: Expr | null | undefined,
  names: readonly string[],
  t: Keys | null | undefined,
): boolean {
  if (!t) return true;
  const own = (n: Expr): n is Extract<Expr, { k: 'col' }> =>
    n?.k === 'col' && (!n.table || names.includes(lc(n.table)));
  const fixed = new Set(
    (conjunctsOf(where) ?? []).flatMap(c =>
      c.k !== 'bin' || (c.op !== '=' && c.op !== '==')
        ? []
        : own(c.l) && !own(c.r)
          ? [lc(c.l.name)]
          : own(c.r) && !own(c.l)
            ? [lc(c.r.name)]
            : [],
    ),
  );
  if (t.rowid && fixed.has('rowid')) return true;
  return [t.pk, ...(t.uniques ?? []).map(u => (Array.isArray(u) ? u : u.cols))].some(
    k => k.length > 0 && k.every(c => fixed.has(lc(c))),
  );
}
const keyValue = (e: Expr): boolean => (e.k === 'lit' && (e.type === 'text' || e.type === 'int')) || e.k === 'param';
// A guard conjunct on the column: `col = v`, `v = col` or `col IN (v, …)`, with v a text literal or ?n. Its operand
// nodes, or null.
export function guardOf(c: Expr, names: readonly string[], col: string): Expr[] | null {
  const v = (e: Expr | null | undefined): boolean => (e?.k === 'lit' && e.type === 'text') || e?.k === 'param';
  if (c.k === 'bin' && c.op === '=') {
    if (isCol(c.l, names, col) && v(c.r)) return [c.r];
    if (isCol(c.r, names, col) && v(c.l)) return [c.l];
  }
  if (c.k === 'in' && !c.not && c.items && isCol(c.x, names, col) && c.items.length > 0 && c.items.every(v))
    return c.items;
  return null;
}
