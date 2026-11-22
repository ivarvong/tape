// sql/check/query.ts: the type of an expression and the result of a SELECT, which contain each other.
import { unreachable } from '../../compiler/ast.ts';
import type { ColFacts, Expr, Frame, ResultCol, ResultColumn, Select, Source, TableRef, Ty } from '../ast.ts';
import { affinity } from '../schema.ts';
import { lc } from '../tokens.ts';
import {
  AFF_T,
  type Check,
  type Ctx,
  type Stack,
  TAPE_T,
  TY,
  UNKNOWN,
  colType,
  isNumber,
  kindsOf,
  nameOf,
  settled,
  show,
  sourceOf,
  unify,
} from './context.ts';
import { aggregate, bareCol, hasAgg, isAggCall, scalar } from './functions.ts';
import { resolve } from './resolve.ts';

type Of<K extends Expr['k']> = Extract<Expr, { k: K }>;
const ARITHMETIC = new Set(['+', '-', '*', '/', '%', '<<', '>>', '&', '|']);
const WHOLE = new Set(['<<', '>>', '&', '|', '%']);

/** The type of an expression, with every name in it resolved and every problem in it noted. */
export function ty(k: Check, e: Expr, stack: Stack, ctx: Ctx = {}): Ty {
  switch (e.k) {
    case 'lit':
      return TY(e.type, e.v === null);
    case 'param':
      return TY(TAPE_T[k.kinds?.[e.n - 1] ?? ''] ?? 'any', false, { param: e.n });
    case 'col':
      return column(k, e, stack, ctx);
    case 'collate':
      return ty(k, e.x, stack, ctx);
    case 'un':
      return unary(k, e, stack, ctx);
    case 'bin':
      return binary(k, e, stack, ctx);
    case 'in':
      return e.x.k === 'row' ? rowIn(k, e, e.x, stack, ctx) : valueIn(k, e, stack, ctx);
    case 'between': {
      const x = ty(k, e.x, stack, ctx),
        lo = ty(k, e.lo, stack, ctx),
        hi = ty(k, e.hi, stack, ctx);
      compare(k, e, e.x, x, e.lo, lo);
      compare(k, e, e.x, x, e.hi, hi);
      return TY('int', x.null || lo.null || hi.null);
    }
    case 'like': {
      const x = ty(k, e.x, stack, ctx),
        pattern = ty(k, e.pat, stack, ctx);
      k.constrain(e.pat, 'text', `the pattern of ${e.op}`);
      k.constrain(e.x, 'text', `matched with ${e.op}`);
      if (e.esc) ty(k, e.esc, stack, ctx);
      return TY('int', x.null || pattern.null);
    }
    case 'isnull':
      ty(k, e.x, stack, ctx);
      return TY('int', false);
    case 'exists':
      select(k, e.sel, stack);
      return TY('int', false);
    case 'sub':
      return scalarSubquery(k, e, stack);
    case 'row':
      k.err('subset', `a row value ${k.text(e)} outside a comparison`, e);
      return UNKNOWN;
    case 'cast':
      return TY(AFF_T[affinity(e.type)], ty(k, e.x, stack, ctx).null);
    case 'case':
      return caseOf(k, e, stack, ctx);
    case 'fn':
      return call(k, e, stack, ctx);
    default:
      return unreachable(e, 'SQL expression');
  }
}
function column(k: Check, e: Of<'col'>, stack: Stack, ctx: Ctx): Ty {
  // a result name (`SELECT x + 1 AS total … HAVING total > 0`), unless a column of this SELECT has the name
  const alias = e.table ? undefined : ctx.aliases?.get(lc(e.name)),
    shadowed = (stack.at(-1) ?? []).some(s => !s.qualifierOnly && s.cols.some(x => lc(x.name) === lc(e.name)));
  if (alias && !shadowed) return alias;
  const r = resolve(k, e, stack);
  if (!r) return UNKNOWN;
  return r.col.rowid ? TY('int', false) : colType(r.source, r.col);
}
function unary(k: Check, e: Of<'un'>, stack: Stack, ctx: Ctx): Ty {
  const x = ty(k, e.x, stack, ctx);
  if (e.op === 'NOT') return TY('int', x.null);
  const sort = e.op === '~' ? 'bitwise' : 'arithmetic';
  if (x.t === 'text')
    k.err(
      'type',
      `${e.op}${k.text(e.x)} applies ${sort === 'bitwise' ? 'a bitwise' : 'an arithmetic'} operator to text`,
      e,
    );
  k.constrain(e.x, 'int', `${sort} ${e.op}`);
  return TY(x.t === 'real' ? 'real' : 'int', x.null);
}
function binary(k: Check, e: Of<'bin'>, stack: Stack, ctx: Ctx): Ty {
  const l = ty(k, e.l, stack, ctx),
    r = ty(k, e.r, stack, ctx),
    nul = l.null || r.null;
  if (e.op === 'AND' || e.op === 'OR') return TY('int', nul);
  if (e.op === '||') {
    k.constrain(e.l, 'text', 'concatenated with ||');
    k.constrain(e.r, 'text', 'concatenated with ||');
    return TY('text', nul);
  }
  if (ARITHMETIC.has(e.op)) return arithmetic(k, e, l, r);
  compare(k, e, e.l, l, e.r, r);
  return TY('int', e.op === 'IS' || e.op === 'IS NOT' ? false : nul);
}
function arithmetic(k: Check, e: Of<'bin'>, l: Ty, r: Ty): Ty {
  const operands = [
    [e.l, l],
    [e.r, r],
  ] as const;
  for (const [x, xt] of operands)
    if (xt.t === 'text')
      k.err(
        'type',
        `\`${k.text(e)}\`: ${k.text(x)} is text, used in arithmetic (${e.op}); SQLite would read it as a number, 0 if it is not one`,
        x,
      );
  k.constrain(e.l, r.t === 'real' ? 'real' : 'int', `arithmetic with ${k.text(e.r)}`);
  k.constrain(e.r, l.t === 'real' ? 'real' : 'int', `arithmetic with ${k.text(e.l)}`);
  const real = (l.t === 'real' || r.t === 'real') && !WHOLE.has(e.op);
  // division and remainder by zero give NULL
  return TY(real ? 'real' : 'int', l.null || r.null || e.op === '/' || e.op === '%');
}
// `(a, b) IN (SELECT …)`
function rowIn(k: Check, e: Of<'in'>, row: Of<'row'>, stack: Stack, ctx: Ctx): Ty {
  const xs = row.items.map(i => ty(k, i, stack, ctx));
  if (!e.sel) {
    k.err('subset', `a row value ${k.text(row)} IN a list`, e);
    return TY('int', true);
  }
  const r = select(k, e.sel, stack);
  if (r && r.length !== xs.length)
    k.err('name', `the row value has ${xs.length} columns and the subquery gives ${r.length}`, e.sel);
  else if (r)
    xs.forEach((x, i) => {
      const item = row.items[i],
        given = r[i];
      if (item && given) compare(k, e, item, x, null, given);
    });
  return TY('int', xs.some(x => x.null) || !!r?.some(c => c.null));
}
// `x IN (SELECT …)` or `x IN (a, b, …)`
function valueIn(k: Check, e: Of<'in'>, stack: Stack, ctx: Ctx): Ty {
  const x = ty(k, e.x, stack, ctx);
  if (e.sel) {
    const r = select(k, e.sel, stack),
      [given] = r ?? [];
    if (r && r.length !== 1) k.err('name', `the subquery after IN gives ${r.length} columns; it must give 1`, e.sel);
    else if (given) compare(k, e, e.x, x, null, given);
    return TY('int', x.null || !!given?.null);
  }
  const items = e.items.map(item => {
    const t = ty(k, item, stack, ctx);
    compare(k, e, e.x, x, item, t);
    return t;
  });
  return TY('int', x.null || items.some(t => t.null));
}
function scalarSubquery(k: Check, e: Of<'sub'>, stack: Stack): Ty {
  const r = select(k, e.sel, stack),
    [only] = r ?? [];
  if (!r) return UNKNOWN;
  if (r.length !== 1 || !only) {
    k.err('name', `a scalar subquery gives ${r.length} columns; it must give 1`, e);
    return UNKNOWN;
  }
  return TY(only.t, only.null || !oneRow(e.sel));
}
function caseOf(k: Check, e: Of<'case'>, stack: Stack, ctx: Ctx): Ty {
  const base = e.base ? { e: e.base, t: ty(k, e.base, stack, ctx) } : null;
  const arms = e.whens.map(w => {
    const when = ty(k, w.when, stack, ctx);
    if (base) compare(k, w.when, base.e, base.t, w.when, when);
    return ty(k, w.then, stack, ctx);
  });
  const outs = [...arms, e.else ? ty(k, e.else, stack, ctx) : TY('null', true)],
    t = unify(outs);
  if (t === 'mixed') k.err('type', `the arms of this CASE give ${kindsOf(outs)}`, e);
  return TY(
    settled(t),
    outs.some(o => o.null),
  );
}
function call(k: Check, e: Of<'fn'>, stack: Stack, ctx: Ctx): Ty {
  if (!isAggCall(e))
    return scalar(
      k,
      e,
      e.args.map(a => ty(k, a, stack, ctx)),
    );
  if (!ctx.agg)
    k.err(
      'name',
      `misuse of aggregate function ${e.name}(): an aggregate is not allowed here (a WHERE, a VALUES row, a SET)`,
      e,
    );
  const inside = { ...ctx, agg: false };
  return aggregate(
    k,
    e,
    e.args.map(a => ty(k, a, stack, inside)),
    !!ctx.grouped,
  );
}
/**
 * A comparison: both sides of one kind (text with text, numbers with numbers), and a parameter takes the other
 * side's kind. `rn` is null where the right side is a subquery's column. Row values are compared by arity alone.
 */
export function compare(k: Check, at: Expr, ln: Expr, l: Ty, rn: Expr | null, r: Pick<Ty, 't'>): void {
  if (ln.k === 'row' || rn?.k === 'row') return;
  k.constrain(ln, r.t, `compared with ${rn ? k.text(rn) : 'the subquery'}`);
  if (rn) k.constrain(rn, l.t, `compared with ${k.text(ln)}`);
  if ((l.t === 'text' && isNumber(r.t)) || (isNumber(l.t) && r.t === 'text'))
    k.err(
      'type',
      `\`${k.text(at)}\` compares ${show(l.t)} with ${show(r.t)}: SQLite then converts one side by the column's affinity, and the comparison is not what it reads as`,
      at,
    );
}

// ---- SELECT
// a SELECT that gives exactly one row: an aggregate with no GROUP BY (and no LIMIT 0 games)
const oneRow = (sel: Select): boolean => !sel.group && sel.cols.some(c => !c.star && hasAgg(c.expr)) && !sel.limit;
const affinityOf = (c: ResultColumn): ColFacts['aff'] =>
  c.t === 'int' ? 'int' : c.t === 'text' ? 'text' : c.t === 'real' ? 'real' : 'numeric';

// one table of FROM, or a subquery standing as one; null when the table does not exist
function fromSource(k: Check, r: TableRef, outer: Stack): Source | null {
  if (r.sub) {
    const cols = (select(k, r.sub, outer) ?? []).map((c): ColFacts => ({
      name: c.name,
      aff: affinityOf(c),
      notNull: !c.null,
    }));
    return { name: null, alias: r.alias, table: null, cols, nullable: false };
  }
  const t = k.table(r.name);
  if (!t) k.err('name', `no such table: ${r.name}`, r);
  return t ? sourceOf(t, r.alias) : null;
}
// the sources of a FROM clause, or null when one of its tables does not exist
function fromFrame(k: Check, from: readonly TableRef[], outer: Stack): Frame | null {
  const frame: Frame = [];
  for (const r of from) {
    const source = fromSource(k, r, outer);
    if (!source) return null;
    if (frame.some(x => nameOf(x) === nameOf(source)))
      k.err('name', `the table ${source.alias ?? source.name} is named twice in FROM: give one an alias`, r);
    if (r.join === 'left') source.nullable = true;
    const has = (s: Source, c: string): boolean => s.cols.some(y => lc(y.name) === lc(c));
    for (const c of r.using ?? [])
      if (!frame.some(x => has(x, c)) || !has(source, c))
        k.err('name', `cannot join using column ${c}: it is not in both tables`, r);
    frame.push(source);
  }
  return frame;
}
// `*` or `t.*`: every column of the tables it stands for
function starColumns(k: Check, sel: Select, c: Extract<ResultCol, { star: true }>, frame: Frame): ResultColumn[] {
  const from = c.table ? frame.filter(s => lc(s.alias ?? s.name) === lc(c.table)) : frame;
  if (sel.from.length === 0) k.err('name', 'SELECT * with no FROM', c);
  if (c.table && from.length === 0) k.err('name', `no such table: ${c.table}`, c);
  return from.flatMap(s => s.cols.map(col => ({ name: col.name, ...colType(s, col) })));
}
/** A result column for an expression of type t: its name is its alias, the column's name, or its own text. */
export function resultColumn(
  k: Check,
  c: Extract<ResultCol, { star: false }>,
  t: Ty,
  withParam: boolean,
): ResultColumn {
  return {
    name: c.alias ?? (c.expr.k === 'col' ? c.expr.name : k.text(c.expr)),
    t: t.t,
    null: t.null,
    ...(withParam && t.param !== undefined ? { param: t.param } : {}),
    ...(t.pkNull ? { pkNull: t.pkNull } : {}),
  };
}
function resultColumns(k: Check, sel: Select, frame: Frame, stack: Stack): ResultColumn[] {
  const grouped = !!sel.group;
  // an aggregate query with no GROUP BY gives one row even over none: a column outside the aggregates is NULL then
  const lone = !grouped && sel.cols.some(c => !c.star && hasAgg(c.expr));
  return sel.cols.flatMap(c => {
    const columns = c.star
      ? starColumns(k, sel, c, frame)
      : [resultColumn(k, c, ty(k, c.expr, stack, { agg: true, grouped }), true)];
    return lone && (c.star || bareCol(c.expr)) ? columns.map(col => ({ ...col, null: true })) : columns;
  });
}
function orderAndLimit(k: Check, sel: Select, stack: Stack, ctx: Ctx, columns: number): void {
  for (const o of sel.order ?? []) {
    // ORDER BY 2: the second result column
    const nth = o.expr.k === 'lit' && o.expr.type === 'int' ? Number(o.expr.v) : null;
    if (nth === null) ty(k, o.expr, stack, ctx);
    else if (nth < 1 || nth > columns)
      k.err('name', `ORDER BY term ${nth} is out of range: the SELECT has ${columns} columns`, o);
  }
  if (sel.limit) {
    const t = ty(k, sel.limit, stack, {});
    k.constrain(sel.limit, 'int', 'LIMIT');
    if (t.t === 'text') k.err('type', 'LIMIT of text', sel.limit);
  }
  if (sel.offset) {
    ty(k, sel.offset, stack, {});
    k.constrain(sel.offset, 'int', 'OFFSET');
  }
}
/** A SELECT's result columns, in scope `outer` (for correlated subqueries); null when a table it reads is missing. */
export function select(k: Check, sel: Select, outer: Stack = []): ResultColumn[] | null {
  const frame = fromFrame(k, sel.from, outer);
  if (!frame) return null;
  const stack: Stack = [...outer, k.inScope(sel, frame)];
  for (const r of sel.from)
    if (r.on && ty(k, r.on, stack, {}).t === 'text') k.err('type', `the ON of a join is text: ${k.text(r.on)}`, r.on);
  if (sel.where) ty(k, sel.where, stack, { agg: false });
  for (const g of sel.group ?? []) ty(k, g, stack, { agg: false });
  const result = resultColumns(k, sel, frame, stack),
    aliases = new Map(result.map(r => [lc(r.name), TY(r.t, r.null)])),
    ctx: Ctx = { agg: true, grouped: !!sel.group, aliases };
  if (sel.having) ty(k, sel.having, stack, ctx);
  orderAndLimit(k, sel, stack, ctx, result.length);
  return result;
}
