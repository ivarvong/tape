// rules/writes.ts: what a statement writes, and what guards it.
import type { Assign, Expr, SqlNode, Statement } from '../sql/ast.ts';
import { conjunctsOf } from '../sql.ts';
import type { Analysis, ColumnRead, Predicate, RuleTable, Value, Write } from './types.ts';
import { lc } from './syntax.ts';

// ---- reading a write
/** What a statement writes, or null for one that writes nothing. */
export function writeOf(ast: Statement | null | undefined): Write | null {
  if (!ast) return null;
  if (ast.k === 'update')
    return { kind: 'update', table: ast.table, alias: ast.alias, assigns: ast.set, where: ast.where };
  if (ast.k === 'insert')
    return {
      kind: 'insert',
      table: ast.table,
      alias: ast.alias,
      cols: ast.cols ?? (ast.defaults ? [] : null),
      vals: ast.values?.[0] ?? null,
      rows: ast.values?.length ?? 0,
      select: ast.select,
      replace: ast.or === 'REPLACE',
      upsert: ast.upsert?.action === 'update' ? ast.upsert.set : null,
      upsertWhere: ast.upsert?.where ?? null,
      upsertNode: ast.upsert,
    };
  if (ast.k === 'delete') return { kind: 'delete', table: ast.table, alias: ast.alias, where: ast.where };
  return null;
}
// The columns an expression reads (not inside a subquery): [{ table: the table it resolved to | qualifier, name, excluded }]
const isSqlNode = (n: object): n is SqlNode => 'k' in n;
export function colsIn(e: SqlNode | null | undefined, a?: Pick<Analysis, 'refs'> | null): ColumnRead[] {
  const out: ColumnRead[] = [];
  // every object is gone into, whatever it is (a CASE's WHEN pairs are not nodes); a SELECT is another scope
  const go = (n: unknown): void => {
    if (typeof n !== 'object' || n === null) return;
    // an object with a kind is a node of the tree; the others are gone through for the nodes they hold
    const node = isSqlNode(n) ? n : null;
    if (node?.k === 'select') return;
    if (node?.k === 'col') {
      const r = a?.refs.get(node);
      out.push({
        table: r?.table?.name ?? (lc(node.table) === 'excluded' ? null : node.table),
        name: node.name,
        excluded: r ? r.excluded : lc(node.table) === 'excluded',
      });
      return;
    }
    for (const [k, v] of Object.entries(n)) if (k !== 's' && k !== 'e' && typeof v === 'object' && v !== null) go(v);
  };
  go(e);
  return out;
}
export const isCol = (e: Expr | null | undefined, names: readonly string[], col: string): boolean =>
  e?.k === 'col' && lc(e.name) === lc(col) && (!e.table || names.includes(lc(e.table)));
export const isValue = (e: Expr | null | undefined): e is Value => (e?.k === 'lit' && e.v !== null) || e?.k === 'param';
/** two values that are the same parameter or the same literal */
export const same = (a: Expr | null | undefined, b: Expr | null | undefined): boolean =>
  !!a &&
  !!b &&
  (a.k === 'param'
    ? b.k === 'param' && a.n === b.n
    : a.k === 'lit'
      ? b.k === 'lit' && a.v === b.v && a.type === b.type
      : false);
// a top-level conjunct comparing the column with a value: `col = v`, `v = col` or `col IN (v, …)` → [v nodes] or null
export function predicateOn(c: Expr, names: readonly string[], col: string): Predicate | null {
  if (c.k === 'bin' && c.op === '=') {
    if (isCol(c.l, names, col) && isValue(c.r)) return { op: '=', vals: [c.r] };
    if (isCol(c.r, names, col) && isValue(c.l)) return { op: '=', vals: [c.l] };
  }
  if (c.k === 'in' && !c.not && c.items && isCol(c.x, names, col) && c.items.length > 0 && c.items.every(isValue))
    return { op: 'IN', vals: c.items };
  return null;
}
// A compare-and-set guard on a changed column: equality (or IN) with the old value, at the top level of the WHERE,
// which the write makes false. The new value must differ from what the guard accepts: `SET state = state`, `SET
// state = 'a' WHERE state = 'a'`, or a new value inside the IN list would leave the row matching, and a second run
// would apply again.
export function casOn(
  cs: readonly Expr[],
  col: string,
  assigns: readonly Assign[],
  names: readonly string[],
): Predicate | null {
  const to = assigns.find(a => lc(a.col) === lc(col))?.expr;
  if (!to) return null;
  for (const c of cs) {
    const p = predicateOn(c, names, col);
    if (!p) continue;
    if (to.k === 'col' && lc(to.name) === lc(col)) return null;
    if (p.vals.some(v => same(v, to))) continue;
    return p;
  }
  return null;
}
// NOT EXISTS (SELECT … FROM d WHERE …) at the top level: true when it names the row (every key column, by the
// parameter the write uses for it) over a table the program inserts op ids into; false when it does not name the
// row; null: no such guard
export function dedupeGuard(
  cs: readonly Expr[],
  s: Write,
  t: Pick<RuleTable, 'pk'> | null | undefined,
  opTables: ReadonlySet<string>,
): boolean | null {
  const g = cs.find(
    (c): c is Extract<Expr, { k: 'exists' }> =>
      c.k === 'exists' && c.not && c.sel.from.length === 1 && !!c.sel.from[0]?.name,
  );
  if (!g || !t) return null;
  if (!opTables.has(lc(g.sel.from[0]?.name))) return null; // nothing records op ids there: the guard never holds
  if (t.pk.length === 0) return false;
  const others = cs.filter(c => c !== g),
    inner = conjunctsOf(g.sel.where) ?? [];
  const keyParam = (c: string): number | null => {
    if (s.kind === 'delete') return null;
    if (s.kind === 'update') {
      for (const x of others) {
        const p = predicateOn(x, [lc(s.table), lc(s.alias)], c);
        const v = p?.op === '=' ? p.vals[0] : undefined;
        if (v?.k === 'param') return v.n;
      }
      return null;
    }
    const i = (s.cols ?? []).findIndex(x => lc(x) === lc(c));
    const v = i >= 0 ? s.vals?.[i] : null;
    return v?.k === 'param' ? v.n : null;
  };
  return t.pk.every(c => {
    const n = keyParam(c);
    return (
      n !== null &&
      inner.some(
        x =>
          x.k === 'bin' &&
          x.op === '=' &&
          ((x.l.k === 'col' && x.r.k === 'param' && x.r.n === n) ||
            (x.r.k === 'col' && x.l.k === 'param' && x.l.n === n)),
      )
    );
  });
}
