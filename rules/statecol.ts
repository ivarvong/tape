// rules/statecol.ts: is this column of a statement the machine's column, and what is it compared with.
import type { Expr, SqlNode, Statement } from '../sql/ast.ts';
import { walkSql } from '../sql.ts';
import type { Analysis, MachineColumn, Value } from './types.ts';
import { lc } from './syntax.ts';
import { isValue } from './writes.ts';

// The tables a statement names anywhere (FROM, JOIN, subqueries, its target), in lower case.
export function tablesNamed(ast: SqlNode | null | undefined): Set<string> {
  const out = new Set<string>();
  walkSql(ast, n => {
    if (n.k === 'tref' && n.name) out.add(lc(n.name));
    if ((n.k === 'insert' || n.k === 'update' || n.k === 'delete') && n.table) out.add(lc(n.table));
  });
  return out;
}
// Is this column node the machine's column? By sql.ts's resolution when the statement resolves against the
// schema; by name (and qualifier, against the statement's own names for the table) when it does not.
export function isMachineCol(
  n: Expr | null | undefined,
  m: MachineColumn,
  a: Pick<Analysis, 'refs'> | null | undefined,
  ast: Statement | null | undefined,
): boolean {
  if (n?.k !== 'col' || lc(n.name) !== lc(m.column)) return false;
  const r = a?.refs.get(n);
  if (r) return !!r.table && lc(r.table.name) === lc(m.table);
  const names = new Set([lc(m.table)]);
  walkSql(ast, x => {
    if (x.k === 'tref' && lc(x.name) === lc(m.table) && x.alias) names.add(lc(x.alias));
    if ((x.k === 'update' || x.k === 'delete' || x.k === 'insert') && lc(x.table) === lc(m.table) && x.alias)
      names.add(lc(x.alias));
  });
  return !n.table || names.has(lc(n.table)) || lc(n.table) === 'excluded';
}
// Every comparison of the machine's column with a literal or a parameter: [operand nodes]. A SET list is not a
// comparison (C59 checks what it sets).
export function comparisonsOf(
  ast: Statement | null | undefined,
  m: MachineColumn,
  a?: Pick<Analysis, 'refs'> | null,
): Value[] {
  const out: Value[] = [];
  walkSql(ast, n => {
    if (n.k === 'bin' && ['=', '!=', 'IS', 'IS NOT'].includes(n.op)) {
      if (isMachineCol(n.l, m, a, ast) && isValue(n.r)) out.push(n.r);
      if (isMachineCol(n.r, m, a, ast) && isValue(n.l)) out.push(n.l);
    }
    if (n.k === 'in' && n.items && isMachineCol(n.x, m, a, ast)) out.push(...n.items.filter(isValue));
    if (n.k === 'case' && n.base && isMachineCol(n.base, m, a, ast))
      out.push(...n.whens.map(w => w.when).filter(isValue));
  });
  return out;
}
