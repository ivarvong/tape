// rules/floors.ts: C73. A write that takes from a column keeps it from going below its floor.
import type { Expr, Table } from '../sql/ast.ts';
import { conjunctsOf } from '../sql/tree.ts';
import { lc } from './syntax.ts';
import type { Reading } from './types.ts';
import { isCol, same, writeOf } from './writes.ts';

const int = (n: Expr): number | null => (n.k === 'lit' && n.type === 'int' && typeof n.v === 'number' ? n.v : null);
const signed = (n: Expr): number | null => {
  const inner = n.k === 'un' && n.op === '-' ? int(n.x) : null;
  return inner === null ? int(n) : -inner;
};
const plus = (n: number | null, more: number): number | null => (n === null ? null : n + more);

/** The floor one conjunct of a CHECK puts on a column: `c >= 0`, `c > 0`, `0 <= c`, `c BETWEEN 1 AND 9`. */
function floorIn(c: Expr, isc: (n: Expr) => boolean): number | null {
  if (c.k === 'bin' && isc(c.l) && signed(c.r) !== null)
    return c.op === '>=' ? signed(c.r) : c.op === '>' ? plus(signed(c.r), 1) : null;
  if (c.k === 'bin' && isc(c.r) && signed(c.l) !== null)
    return c.op === '<=' ? signed(c.l) : c.op === '<' ? plus(signed(c.l), 1) : null;
  if (c.k === 'between' && !c.not && isc(c.x)) return signed(c.lo);
  return null;
}

/** The floor a table's CHECKs put on a column, at the top level of a CHECK, or null when none does. */
function floorOf(mt: Table | undefined, col: string): number | null {
  const isc = (n: Expr): boolean => n.k === 'col' && lc(n.name) === lc(col);
  const floors = (mt?.checks ?? []).flatMap(ch => (conjunctsOf(ch) ?? []).flatMap(c => floorIn(c, isc) ?? []));
  return floors.length > 0 ? Math.max(...floors) : null;
}

/** A lower bound a conjunct puts on the column: `col >= lo`, `lo <= col`, BETWEEN, or `col - minus >= lo`. */
type Bound = { readonly lo: Expr; readonly strict: boolean; readonly minus: Expr | null };
function boundIn(c: Expr, names: readonly string[], col: string): Bound | null {
  if (c.k === 'bin' && ['>=', '>'].includes(c.op) && isCol(c.l, names, col))
    return { lo: c.r, strict: c.op === '>', minus: null };
  if (c.k === 'bin' && ['<=', '<'].includes(c.op) && isCol(c.r, names, col))
    return { lo: c.l, strict: c.op === '<', minus: null };
  if (c.k === 'between' && !c.not && isCol(c.x, names, col)) return { lo: c.lo, strict: false, minus: null };
  if (c.k === 'bin' && c.op === '>=' && c.l.k === 'bin' && c.l.op === '-' && isCol(c.l.l, names, col))
    return { lo: c.r, strict: false, minus: c.l.r };
  return null;
}

const sameAmount = (a: Expr, b: Expr): boolean => same(a, b) || (int(a) !== null && int(a) === int(b));

/** Does the bound keep `col - take` at or above the floor? */
function keeps({ lo, strict, minus }: Bound, take: Expr, floor: number): boolean {
  const low = int(lo);
  if (minus) return sameAmount(minus, take) && low !== null && low >= floor;
  const least = plus(low, strict ? 1 : 0);
  const taken = int(take);
  if (least !== null && taken !== null && least - taken >= floor) return true;
  return sameAmount(lo, take) && (strict ? 1 : 0) >= floor;
}

/** Whether a top-level conjunct keeps `col - take` at or above floor (any lower bound on col, when floor is null). */
function floorGuard(
  cs: readonly Expr[],
  names: readonly string[],
  col: string,
  take: Expr,
  floor: number | null,
): boolean {
  return cs.some(c => {
    const bound = boundIn(c, names, col);
    return !!bound && (floor === null || keeps(bound, take, floor));
  });
}

// C73, and C88 for a write that says `no_floor: True` where C73 has nothing to refuse
export function floorRules({ model, queries, bad: report }: Reading): void {
  for (const q of queries) {
    let found = 0;
    const bad: Reading['bad'] = (...problem) => {
      found++;
      if (!q.noFloor) report(...problem);
    };
    floorsOf(model, q, bad);
    if (q.noFloor && found === 0)
      report(
        'C88',
        q.at,
        'this call says `no_floor: True`, and its statement takes nothing from a column without a guard',
        'Take the argument out: it is only for a write that rule C73 would refuse.',
      );
  }
}
function floorsOf(model: Reading['model'], q: Reading['queries'][number], bad: Reading['bad']): void {
  const s = writeOf(q.ast);
  const assigns = s?.kind === 'update' ? s.assigns : s?.kind === 'insert' ? s.upsert : null;
  if (!s || s.kind === 'delete' || !assigns) return;
  const cs = conjunctsOf(s.kind === 'update' ? s.where : s.upsertWhere) ?? [];
  const names = [lc(s.table), lc(s.alias)].filter(Boolean);
  const mt = model.schema.tables.get(lc(s.table));
  for (const x of assigns) {
    const e = x.expr;
    if (e.k !== 'bin' || e.op !== '-' || !isCol(e.l, names, x.col)) continue;
    if (e.r.k === 'lit' && typeof e.r.v === 'number' && e.r.v <= 0) continue;
    const floor = floorOf(mt, x.col);
    if (floorGuard(cs, names, x.col, e.r, floor)) continue;
    const shown = q.raw.slice(e.r.s, e.r.e).trim();
    bad(
      'C73',
      q.at,
      floor === null
        ? `this write takes ${shown} from ${s.table}.${x.col} and nothing in its WHERE stops it going below zero (or any floor): two requests that each see enough both take, and the column is overdrawn`
        : `this write takes ${shown} from ${s.table}.${x.col}, whose CHECK keeps it at ${floor} or more, and its WHERE does not ensure that: when it would go below, the database refuses the statement and the request fails instead of being told no`,
      `Guard it at the top level of the WHERE: \`AND ${x.col} >= ${floor !== null && floor !== 0 ? `${shown} + ${floor}` : shown}\`; then a take that does not fit changes no row, which the program can answer. If the column has no floor, say so in the call: \`no_floor: True\`.`,
    );
  }
}
