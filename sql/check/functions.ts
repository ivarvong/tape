// sql/check/functions.ts: the functions the checker knows, each with how many arguments it takes, what it makes of
// its parameters, and the type it gives. A function not here is refused: its type would be a guess.
import type { Expr, Fn, SqlNode, Ty, TyName } from '../ast.ts';
import { children } from '../tree.ts';
import { type Check, TY, UNKNOWN, kindsOf, settled, unify } from './context.ts';

// ---- aggregates
const AGGREGATES = new Set(['count', 'sum', 'total', 'avg', 'max', 'min', 'group_concat', 'string_agg']);
/** A call of an aggregate. max and min of several values are the scalar functions. */
export const isAggCall = (e: SqlNode): boolean =>
  e.k === 'fn' && AGGREGATES.has(e.name) && (e.star || (e.name !== 'max' && e.name !== 'min') || e.args.length === 1);
// Does `found` hold somewhere in e, outside any aggregate and outside any subquery?
const outsideAggregates = (e: SqlNode | null | undefined, found: (e: SqlNode) => boolean | null): boolean => {
  if (!e || e.k === 'select' || e.k === 'sub' || e.k === 'exists') return false;
  if (e.k === 'in' && e.sel) return outsideAggregates(e.x, found);
  return found(e) ?? children(e).some(c => outsideAggregates(c, found));
};
/** An aggregate in this expression, not counting those inside a subquery. */
export const hasAgg = (e: SqlNode | null | undefined): boolean =>
  outsideAggregates(e, n => (isAggCall(n) ? true : null));
/**
 * A column read outside any aggregate (and outside a subquery). In an aggregate query with no GROUP BY, such a
 * column is NULL when no row matched: the one row an aggregate always gives has nothing to take it from.
 */
export const bareCol = (e: SqlNode | null | undefined): boolean =>
  outsideAggregates(e, n => (isAggCall(n) ? false : n.k === 'col' ? true : null));

/** One call being checked: the function, its arguments, and the type of each. */
type Call = { k: Check; e: Fn; n: string; args: Expr[]; ts: Ty[] };
const anyNull = (c: Call): boolean => c.ts.some(t => t.null);
const firstType = (c: Call): TyName => c.ts[0]?.t ?? 'any';
// the call takes between lo and hi arguments
function arity(c: Call, lo: number, hi = lo): void {
  const n = c.args.length;
  if (n >= lo && n <= hi) return;
  const takes = lo === hi ? lo : hi === Infinity ? `at least ${lo}` : `${lo} to ${hi}`;
  c.k.err('name', `${c.n}() takes ${takes} argument${hi === 1 ? '' : 's'}, not ${n}`, c.e);
}
// every argument from `from` on is a parameter of this kind, if it is a parameter
const each = (c: Call, t: TyName, why: string, from = 0): void =>
  c.args.slice(from).forEach(a => c.k.constrain(a, t, why));

/**
 * The type an aggregate gives. Over no rows, sum, max and min give NULL, unless the query is grouped: then each
 * group has a row.
 */
export function aggregate(k: Check, e: Fn, ts: Ty[], grouped: boolean): Ty {
  const c: Call = { k, e, n: e.name, args: e.args, ts },
    first = ts[0],
    overNone = grouped ? !!first?.null : true;
  if (c.n === 'count') {
    if (!e.star) arity(c, 1);
    return TY('int', false);
  }
  if (e.star) k.err('name', `${c.n}(*) is not a function`, e);
  if (c.n === 'max' || c.n === 'min') return TY(firstType(c), overNone);
  arity(c, 1, c.n === 'group_concat' || c.n === 'string_agg' ? 2 : 1);
  if (c.n === 'total') return TY('real', false);
  if (c.n === 'avg') return TY('real', true);
  if (c.n !== 'sum') return TY('text', true);
  const [summed] = e.args;
  if (first?.t === 'text' && summed) k.err('type', `sum() of text: ${k.text(summed)}`, e);
  return TY(first?.t === 'real' ? 'real' : first?.t === 'any' ? 'any' : 'int', overNone);
}

// ---- scalar functions
const fixed =
  (lo: number, hi: number, t: TyName, nul: (c: Call) => boolean): ((c: Call) => Ty) =>
  c => {
    arity(c, lo, hi);
    return TY(t, nul(c));
  };
const never = (): boolean => false;
const always = (): boolean => true;
const withArgs = (c: Call): boolean => c.args.length > 0;
// text functions: every argument that is a parameter is text
const textual =
  (lo: number, hi: number, t: TyName, why?: string): ((c: Call) => Ty) =>
  c => {
    arity(c, lo, hi);
    each(c, 'text', why ?? `${c.n}()`);
    return TY(t, anyNull(c));
  };
const oneText = (c: Call): Ty => {
  arity(c, 1);
  c.k.constrain(c.args[0], 'text', `${c.n}()`);
  return TY('text', anyNull(c));
};
const substr = (c: Call): Ty => {
  arity(c, 2, 3);
  c.k.constrain(c.args[0], 'text', `${c.n}()`);
  each(c, 'int', `the position of ${c.n}()`, 1);
  return TY('text', anyNull(c));
};
const coalesce = (c: Call): Ty => {
  arity(c, 2, c.n === 'ifnull' ? 2 : Infinity);
  const t = unify(c.ts);
  if (t === 'mixed') c.k.err('type', `${c.n}() of ${kindsOf(c.ts)}`, c.e);
  // a parameter among the arguments is of the kind of the others
  c.args.forEach((a, i) =>
    c.ts.forEach((other, j) => {
      if (i !== j) c.k.constrain(a, other.t, `another argument of ${c.n}()`);
    }),
  );
  return TY(
    settled(t),
    c.ts.every(x => x.null),
  );
};
const iif = (c: Call): Ty => {
  arity(c, 3);
  const t = unify(c.ts.slice(1));
  if (t === 'mixed') c.k.err('type', 'the two values of iif() differ in type', c.e);
  return TY(settled(t), !!c.ts[1]?.null || !!c.ts[2]?.null);
};
const greatest = (c: Call): Ty => {
  arity(c, 2, Infinity);
  return TY(settled(unify(c.ts)), anyNull(c));
};
const abs = (c: Call): Ty => {
  arity(c, 1);
  if (c.ts[0]?.t === 'text') c.k.err('type', 'abs() of text', c.e);
  c.k.constrain(c.args[0], 'int', 'abs()');
  return TY(c.ts[0]?.t === 'real' ? 'real' : 'int', anyNull(c));
};
const format = (c: Call): Ty => {
  arity(c, 1, Infinity);
  c.k.constrain(c.args[0], 'text', `the format of ${c.n}()`);
  return TY('text', !!c.ts[0]?.null);
};
const likely = (c: Call): Ty => {
  arity(c, 1);
  return c.ts[0] ?? UNKNOWN;
};
// date and time functions take any arguments; with none they read the clock and are never NULL
const moment =
  (t: TyName): ((c: Call) => Ty) =>
  c =>
    TY(t, withArgs(c));

const SCALAR: ReadonlyMap<string, (c: Call) => Ty> = new Map<string, (c: Call) => Ty>([
  ['coalesce', coalesce],
  ['ifnull', coalesce],
  ['nullif', c => (arity(c, 2), TY(firstType(c), true))],
  ['iif', iif],
  ['max', greatest],
  ['min', greatest],
  ['abs', abs],
  ['length', fixed(1, 1, 'int', anyNull)],
  ['octet_length', fixed(1, 1, 'int', anyNull)],
  ['lower', oneText],
  ['upper', oneText],
  ['trim', textual(1, 2, 'text')],
  ['ltrim', textual(1, 2, 'text')],
  ['rtrim', textual(1, 2, 'text')],
  ['substr', substr],
  ['substring', substr],
  ['replace', textual(3, 3, 'text', 'replace()')],
  ['instr', textual(2, 2, 'int', 'instr()')],
  ['typeof', fixed(1, 1, 'text', never)],
  ['quote', fixed(1, 1, 'text', never)],
  ['hex', fixed(1, 1, 'text', never)],
  ['printf', format],
  ['format', format],
  ['round', fixed(1, 2, 'real', anyNull)],
  ['random', fixed(0, 0, 'int', never)],
  ['unicode', fixed(1, 1, 'int', always)],
  ['char', () => TY('text', false)],
  ['likely', likely],
  ['unlikely', likely],
  ['unixepoch', fixed(0, Infinity, 'int', withArgs)],
  ['date', moment('text')],
  ['time', moment('text')],
  ['datetime', moment('text')],
  ['strftime', moment('text')],
  ['julianday', moment('real')],
  ['current_timestamp', () => TY('text', false)],
  ['current_date', () => TY('text', false)],
  ['current_time', () => TY('text', false)],
  ['changes', fixed(0, 0, 'int', never)],
  ['total_changes', fixed(0, 0, 'int', never)],
  ['last_insert_rowid', fixed(0, 0, 'int', never)],
]);
/** The type a function that is not an aggregate gives, its arguments already typed. */
export function scalar(k: Check, e: Fn, ts: Ty[]): Ty {
  const known = SCALAR.get(e.name);
  if (known) return known({ k, e, n: e.name, args: e.args, ts });
  k.err(
    'subset',
    `the function ${e.name}(): tape's SQL checker does not know its type, so it is refused rather than guessed at`,
    e,
  );
  return UNKNOWN;
}
