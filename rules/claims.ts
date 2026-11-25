// rules/claims.ts: C95. A request sent twice claims one row, not two. An UPDATE that takes "the next one" (the
// oldest job that is ready, a seat that is free) chooses its row by a property it changes itself, so a second run
// of the same request finds another row, and its compare-and-set holds there too: C54 and C55 pass it, and a
// `POST /lease` heard twice leases two jobs (apps/queue/FRICTION.md, entry 7). The exact rule is in
// docs/design.md, "A claim keyed by the request: C95".
import { eachExpr } from '../compiler/ast.ts';
import type { Expr as TapeExpr, FnDecl } from '../compiler/ast.ts';
import type { Expr, Select } from '../sql/ast.ts';
import { conjunctsOf } from '../sql/tree.ts';
import { claims, moveSource, reachable } from './flow.ts';
import { bindsOf } from './origins.ts';
import { type Node, argFor, lc, walk } from './syntax.ts';
import type { Query, Reading, RuleTable, Write } from './types.ts';
import { colsIn, predicateOn, writeOf } from './writes.ts';

type Update = Extract<Write, { kind: 'update' }>;

/** The columns of `table` a SELECT's WHERE reads (a column with no table named is the FROM's). */
function readsOf(sel: Select, table: string): Set<string> {
  const from = sel.from.flatMap(t => (t.name ? [{ name: lc(t.name), alias: lc(t.alias) }] : []));
  const mine = from.filter(t => t.name === table);
  if (mine.length === 0) return new Set();
  const names = new Set(mine.flatMap(t => [t.name, t.alias].filter(Boolean)));
  return new Set(
    colsIn(sel.where)
      .filter(c => (c.table ? names.has(lc(c.table)) : from.length === 1))
      .map(c => lc(c.name)),
  );
}

/** Does a WHERE name one row of the table by a whole unique key, each column `= value`? */
function byKey(where: Expr | null, names: readonly string[], t: RuleTable): boolean {
  const cs = conjunctsOf(where) ?? [];
  return t.uniques.some(u => u.length > 0 && u.every(col => cs.some(c => predicateOn(c, names, col)?.op === '=')));
}

const isSelect = (n: object): n is Select => 'k' in n && n.k === 'select';
/** The subqueries anywhere in a WHERE. */
function subqueries(e: Expr | null): Select[] {
  const out: Select[] = [];
  const go = (n: unknown): void => {
    if (typeof n !== 'object' || n === null) return;
    if (isSelect(n)) out.push(n);
    for (const [k, v] of Object.entries(n)) if (k !== 's' && k !== 'e') go(v);
  };
  go(e);
  return out;
}

/** The query whose result a value was read from: through `let`s, patterns, fields and the callers' arguments. */
function readFrom(r: Reading, e: TapeExpr | undefined, f: FnDecl, depth = 0): Query | null {
  if (!e || depth > 6) return null;
  if (e.k === 'field') return readFrom(r, e.e, f, depth + 1);
  if (e.k === 'call') return r.queries.find(q => q.at === e) ?? null;
  if (e.k !== 'var') return null;
  const b = bindsOf(f).get(e);
  if (b?.k === 'let') return readFrom(r, b.value, b.fn, depth + 1);
  if (b?.k === 'pat') return readFrom(r, b.subject ?? undefined, b.fn, depth + 1);
  if (b?.k !== 'param') return null;
  for (const { from, node } of r.calls.get(f.name) ?? []) {
    const found = readFrom(r, argFor(node, f, b.name), from, depth + 1);
    if (found) return found;
  }
  return null;
}

/** How an UPDATE takes a row chosen by what it changes: the columns, where the choice is made, and the query. */
type Choice = { readonly cols: string[]; readonly by: string; readonly from: Query | null };
function chosen(r: Reading, q: Query, w: Update, t: RuleTable, requested: ReadonlySet<string>): Choice | null {
  const table = lc(w.table);
  const names = [table, lc(w.alias)].filter(Boolean);
  const sets = new Set(w.assigns.map(a => lc(a.col)));
  // a subquery in its own WHERE over its table
  for (const sel of subqueries(w.where)) {
    const cols = [...readsOf(sel, table)].filter(c => sets.has(c));
    if (cols.length > 0) return { cols, by: 'a subquery in its WHERE', from: null };
  }
  // its row named by key, the key read from a row an earlier query chose by what this UPDATE changes
  const cs = conjunctsOf(w.where) ?? [];
  for (const u of t.uniques)
    for (const col of u) {
      const v = cs.map(c => predicateOn(c, names, col)).find(p => p?.op === '=')?.vals[0];
      if (v?.k !== 'param') continue;
      const from = readFrom(r, q.args[String(v.n)], q.fn);
      const sel = from?.ast?.k === 'select' ? from.ast : null;
      // a choice made only in a timer's run is that run's: a sweep takes the next row on each run, as it is meant to
      if (!from || !sel || !requested.has(from.fn.name) || byKey(sel.where, [table], t)) continue;
      const cols = [...readsOf(sel, table)].filter(c => sets.has(c));
      if (cols.length > 0) return { cols, by: `the query that chose its row, line ${from.at.line ?? 0}`, from };
    }
  return null;
}

/**
 * A column this UPDATE writes a value the request brings into (`SET lease = :key`), which a query of the table
 * reads by (`WHERE lease = :key`) in a function `within` names: the claim's own, or that of the query that chose.
 */
function keyedBy(r: Reading, w: Update, within: ReadonlySet<string>): string | null {
  const table = lc(w.table);
  for (const a of w.assigns) {
    if (a.expr.k !== 'param') continue;
    const col = lc(a.col);
    const read = r.queries.some(q => {
      const ast = q.ast;
      if (!within.has(q.fn.name)) return false;
      if (!ast || (ast.k !== 'select' && ast.k !== 'update' && ast.k !== 'delete')) return false;
      const where = ast.where;
      const names =
        ast.k === 'select'
          ? ast.from.flatMap(t => (t.name && lc(t.name) === table ? [table, lc(t.alias)].filter(Boolean) : []))
          : lc(ast.table) === table
            ? [table, lc(ast.alias)].filter(Boolean)
            : [];
      if (names.length === 0) return false;
      return (conjunctsOf(where) ?? []).some(c => predicateOn(c, names, col)?.vals.some(x => x.k === 'param'));
    });
    if (read) return a.col;
  }
  return null;
}

/**
 * The nodes of a function that run at most once per request: in the Moved arm of a match on a compare-and-set, or
 * in the arm a claim of an op id lets through (flow.ts reads both for C54), where `apart` holds of what is matched.
 */
function guardedIn(r: Reading, fn: FnDecl, apart: (subject: TapeExpr, fn: FnDecl) => boolean): Set<Node> {
  const inside = new Set<Node>();
  walk(fn.body, n => {
    if (n.k !== 'match' || !n.subject || !apart(n.subject, fn)) return;
    const claim = claims(n.subject),
      move = moveSource(n.subject, fn, r.calls, 0);
    const rows = n.subject.k === 'call' && n.subject.name === 'sql_exec';
    for (const a of n.arms)
      if (
        (claim &&
          ((rows && a.pat.k === 'int' && a.pat.v >= 1n) || (!rows && a.pat.k === 'ctor' && a.pat.name === 'Some'))) ||
        (move && a.pat.k === 'ctor' && a.pat.name === 'Moved')
      )
        walk(a.body, x => {
          inside.add(x);
        });
  });
  return inside;
}
/** Does a node run at most once per request: guarded in its function, or at every call of it. */
function once(
  r: Reading,
  node: Node,
  fn: FnDecl,
  apart: (subject: TapeExpr, fn: FnDecl) => boolean,
  from: Query | null,
  depth = 0,
): boolean {
  if (depth > 4) return false;
  if (guardedIn(r, fn, apart).has(node)) return true;
  const all = r.calls.get(fn.name) ?? [];
  // a choice handed in by a caller is made only where a call passes it: a call that passes a key of its own (a
  // path's id) takes the row it names
  const inherited =
    !!from &&
    !reachable(r.prog, r.calls, new RegExp(`^${fn.name.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)).has(from.fn.name);
  const sites = inherited ? all.filter(s => s.node.args.some(a => readsChoice(r, a.value, s.from, from))) : all;
  return sites.length > 0 && sites.every(s => once(r, s.node, s.from, apart, from, depth + 1));
}
/** Does an expression read anything from what the query `from` returned? */
function readsChoice(r: Reading, e: TapeExpr, fn: FnDecl, from: Query | null): boolean {
  if (!from) return false;
  let hit = false;
  eachExpr(e, x => {
    if ((x.k === 'var' || x.k === 'field') && readFrom(r, x, fn) === from) hit = true;
  });
  return hit;
}

/**
 * The row an UPDATE a request reaches takes by what it changes, when nothing keys it to the request: the choice, or
 * null. `requested`: the functions a request reaches.
 */
export function claimed(r: Reading, q: Query, requested: ReadonlySet<string>): (Choice & { w: Update }) | null {
  const w = writeOf(q.ast);
  if (w?.kind !== 'update' || !requested.has(q.fn.name)) return null;
  const t = r.tables.get(w.table) ?? [...r.tables].find(([n]) => lc(n) === lc(w.table))?.[1];
  const choice = t ? chosen(r, q, w, t, requested) : null;
  if (!choice) return null;
  const cs = conjunctsOf(w.where) ?? [];
  if (keyedBy(r, w, new Set([q.fn.name, choice.from?.fn.name ?? q.fn.name])) || cs.some(c => c.k === 'exists' && c.not))
    return null;
  // a guard keyed by the row chosen is a guard of that row, not of the request: a second run chooses another
  const apart = (subject: TapeExpr, fn: FnDecl): boolean =>
    subject.k !== 'call' || !subject.args.some(a => readsChoice(r, a.value, fn, choice.from));
  return once(r, q.at, q.fn, apart, choice.from) ? null : { ...choice, w };
}
export const requestedOf = (r: Reading): Set<string> => reachable(r.prog, r.calls, /(^|\.)handle$/);

export function claimRules(r: Reading): void {
  const requested = requestedOf(r);
  for (const q of r.queries) {
    const c = q.repeat ? null : claimed(r, q, requested);
    if (!c) continue;
    r.bad(
      'C95',
      q.at,
      `this UPDATE takes a ${c.w.table} row chosen by ${c.cols.join(', ')}, which it changes (${c.by}): sent again, the same request finds another row and takes that one too (a lease heard twice takes two jobs)`,
      `Let the request name its claim: write the client's key into the row it takes (\`SET lease = :key\`), and before choosing, read the row that key already holds (\`SELECT * FROM ${c.w.table} WHERE lease = :key\`) and answer with it. Or claim an op id first (\`let 1 = sql_exec(query: "INSERT … ON CONFLICT DO NOTHING") else -> …\`). If each request is meant to take another row (no client key, and clients do not retry it), say so in the call: \`repeat: True\`.`,
    );
  }
}
