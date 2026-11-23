// sql/parse/query.ts: expressions and SELECT, which contain each other (a subquery in an expression, an expression
// in a SELECT).
//
// Expressions are read by precedence climbing with SQLite's table (parse.y, lowest first): OR; AND; NOT (prefix);
// IS MATCH LIKE GLOB BETWEEN IN ISNULL NOTNULL != =; > <= < >=; ESCAPE; & | << >>; + -; * / %; || -> ->>; COLLATE;
// unary - + ~. Like SQLite's LALR parser, a finished postfix form (x IN (…), x ISNULL, x BETWEEN a AND b) is the
// left operand of whatever follows it, so `x IN (a) / 2` is `(x IN (a)) / 2`; the low end of BETWEEN takes every
// operator but AND and OR (`x BETWEEN 1 IS 1 AND 2`), its high end binds tighter than BETWEEN.
import type { Expr, Join, OrderTerm, ResultCol, Select, SqlToken, TableRef } from '../ast.ts';
import { type Cursor, column, direction } from './cursor.ts';

const P = { OR: 1, AND: 2, NOT: 3, EQ: 4, CMP: 5, ESC: 6, BIT: 7, ADD: 8, MUL: 9, CAT: 10, COLLATE: 11, UNARY: 12 };
const OP_PREC: ReadonlyMap<string, number> = new Map([
  ...['=', '==', '!=', '<>'].map((o): [string, number] => [o, P.EQ]),
  ...['<', '<=', '>', '>='].map((o): [string, number] => [o, P.CMP]),
  ...['&', '|', '<<', '>>'].map((o): [string, number] => [o, P.BIT]),
  ...['+', '-'].map((o): [string, number] => [o, P.ADD]),
  ...['*', '/', '%'].map((o): [string, number] => [o, P.MUL]),
  ...['||', '->', '->>'].map((o): [string, number] => [o, P.CAT]),
]);
// keywords that are operators at the precedence of `=`, alone or after NOT
const POSTFIX = new Set(['IS', 'IN', 'LIKE', 'GLOB', 'BETWEEN', 'ISNULL', 'NOTNULL', 'MATCH', 'REGEXP']);
const AFTER_NOT = ['NULL', 'IN', 'LIKE', 'GLOB', 'BETWEEN', 'MATCH', 'REGEXP'];

export const expr = (c: Cursor): Expr => climb(c, 0);

// the precedence of the operator at the cursor as an infix or postfix operator, or 0
function infixPrec(c: Cursor): number {
  const t = c.peek();
  if (t.t === 'op') return OP_PREC.get(t.v) ?? 0;
  if (t.t !== 'kw') return 0;
  if (t.v === 'OR') return P.OR;
  if (t.v === 'AND') return P.AND;
  if (POSTFIX.has(t.v)) return P.EQ;
  if (t.v === 'NOT' && AFTER_NOT.some(v => c.isKw(v, 1))) return P.EQ;
  return t.v === 'COLLATE' ? P.COLLATE : 0;
}
// an expression whose operators all bind tighter than `min` (left-associative: an operator of precedence p
// continues only when p > min)
function climb(c: Cursor, min: number): Expr {
  let l = prefix(c);
  for (;;) {
    const p = infixPrec(c);
    if (!p || p <= min) return l;
    l = infix(c, l, p);
  }
}
function prefix(c: Cursor): Expr {
  const t = c.peek();
  if (t.t === 'kw' && t.v === 'NOT' && !c.isKw('EXISTS', 1)) {
    c.skip();
    const x = climb(c, P.NOT - 1);
    return { k: 'un', op: 'NOT', x, s: t.s, e: x.e };
  }
  if (t.t === 'op' && (t.v === '-' || t.v === '+' || t.v === '~')) {
    c.skip();
    const x = climb(c, P.UNARY - 1);
    // a number written with its minus sign is one literal
    if (t.v === '-' && x.k === 'lit' && typeof x.v === 'number' && !x.neg && !x.paren && x.s === t.e)
      return { ...x, v: -x.v, s: t.s, neg: true };
    return { k: 'un', op: t.v, x, s: t.s, e: x.e };
  }
  return primary(c);
}

// ---- infix and postfix forms: l is the left operand, already read
function infix(c: Cursor, l: Expr, prec: number): Expr {
  const t = c.peek();
  const bin = (op: string, r: Expr): Expr => ({ k: 'bin', op, l, r, s: l.s, e: r.e });
  if (t.t === 'op') {
    c.skip();
    if (t.v === '->' || t.v === '->>') c.refuse(`the JSON operator ${t.v}`, t);
    return bin(t.v === '==' ? '=' : t.v === '<>' ? '!=' : t.v, climb(c, prec));
  }
  if (t.v === 'OR' || t.v === 'AND') {
    c.skip();
    return bin(t.v, climb(c, prec));
  }
  if (c.eatKw('COLLATE')) {
    const coll = c.name('a collation');
    return { k: 'collate', x: l, coll, s: l.s, e: c.last().e };
  }
  if (c.eatKw('IS')) {
    // IS NOT DISTINCT FROM is IS; IS DISTINCT FROM is IS NOT
    const not = !!c.eatKw('NOT'),
      distinct = !!c.eatKw('DISTINCT');
    if (distinct) c.kw('FROM');
    return bin(not === distinct ? 'IS' : 'IS NOT', climb(c, prec));
  }
  if (t.v === 'ISNULL' || t.v === 'NOTNULL') {
    c.skip();
    return { k: 'isnull', x: l, not: t.v === 'NOTNULL', s: l.s, e: t.e };
  }
  if (t.v === 'NOT' && c.isKw('NULL', 1)) {
    c.skip(2);
    return { k: 'isnull', x: l, not: true, s: l.s, e: c.last().e };
  }
  return negatable(c, l, prec, !!c.eatKw('NOT'));
}
// the forms that take NOT before them: IN, LIKE, GLOB, BETWEEN
function negatable(c: Cursor, l: Expr, prec: number, not: boolean): Expr {
  if (c.eatKw('IN')) return inList(c, l, not);
  if (c.isAnyKw('LIKE', 'GLOB')) {
    const op = String(c.take().v),
      pat = climb(c, prec),
      esc = c.eatKw('ESCAPE') ? climb(c, P.ESC) : null;
    return { k: 'like', op, x: l, pat, esc, not, s: l.s, e: (esc ?? pat).e };
  }
  if (c.isAnyKw('MATCH', 'REGEXP')) c.refuse(`the ${c.peek().v} operator`);
  if (c.eatKw('BETWEEN')) {
    const lo = climb(c, P.AND);
    c.kw('AND');
    const hi = climb(c, prec);
    return { k: 'between', x: l, lo, hi, not, s: l.s, e: hi.e };
  }
  return c.fail('expected IN, LIKE, GLOB or BETWEEN after NOT');
}
function inList(c: Cursor, l: Expr, not: boolean): Expr {
  if (!c.isOp('(')) c.refuse('IN followed by a table name: write IN (SELECT …)');
  c.op('(');
  if (c.isKw('SELECT')) {
    const sel = select(c);
    c.op(')');
    return { k: 'in', x: l, not, items: null, sel, s: l.s, e: c.last().e };
  }
  const items = c.isOp(')') ? [] : c.list(expr);
  c.op(')');
  return { k: 'in', x: l, not, items, sel: null, s: l.s, e: c.last().e };
}

// ---- primary expressions
/** an expression with no operator outside it: a literal, a name, a call, a CASE, something in parentheses */
export function primary(c: Cursor): Expr {
  const t = c.peek();
  if (t.t === 'num' || t.t === 'str' || t.t === 'param') return literal(c, t);
  if (t.t === 'kw') {
    const form = keywordForm(c, t);
    if (form) return form;
  }
  if (c.eatOp('(')) return parenthesised(c, t.s);
  if (c.isName()) return named(c, t);
  return c.fail('expected an expression');
}
function literal(c: Cursor, t: Extract<SqlToken, { t: 'num' | 'str' | 'param' }>): Expr {
  c.skip();
  if (t.t === 'str') return { k: 'lit', v: t.v, type: 'text', s: t.s, e: t.e };
  if (t.t === 'param') return { k: 'param', n: t.v, s: t.s, e: t.e };
  const v = t.int && /^0x/i.test(t.v) ? Number(t.v) : Number(t.v.replaceAll('_', ''));
  if (t.int && !Number.isSafeInteger(v)) c.refuse("an integer literal outside ±2^53 (tape's Int range on the host)", t);
  return { k: 'lit', v, type: t.int ? 'int' : 'real', s: t.s, e: t.e };
}
// an expression that opens with a keyword, or null when this keyword opens none
function keywordForm(c: Cursor, t: Extract<SqlToken, { t: 'kw' }>): Expr | null {
  const s = t.s;
  if (c.eatKw('NULL')) return { k: 'lit', v: null, type: 'null', s, e: t.e };
  if (t.v === 'CURRENT_TIMESTAMP' || t.v === 'CURRENT_DATE' || t.v === 'CURRENT_TIME') {
    c.skip();
    return { k: 'fn', name: t.v.toLowerCase(), args: [], star: false, distinct: false, kwfn: true, s, e: t.e };
  }
  if (t.v === 'EXISTS' || (t.v === 'NOT' && c.isKw('EXISTS', 1))) {
    const not = t.v === 'NOT';
    c.skip(not ? 2 : 1);
    c.op('(');
    const sel = select(c);
    c.op(')');
    return { k: 'exists', sel, not, s, e: c.last().e };
  }
  if (c.eatKw('CASE')) return caseOf(c, s);
  if (c.eatKw('CAST')) {
    c.op('(');
    const x = expr(c);
    c.kw('AS');
    const type = typeName(c);
    if (!type) c.fail('expected a type name');
    c.op(')');
    return { k: 'cast', x, type, s, e: c.last().e };
  }
  if (t.v === 'RAISE') c.refuse('RAISE outside a trigger');
  if (t.v === 'SELECT') c.fail('a subquery needs parentheses');
  return null;
}
// CASE has been read
function caseOf(c: Cursor, s: number): Expr {
  const base = c.isKw('WHEN') ? null : expr(c),
    whens: { when: Expr; then: Expr }[] = [];
  while (c.eatKw('WHEN')) {
    const when = expr(c);
    c.kw('THEN');
    whens.push({ when, then: expr(c) });
  }
  if (whens.length === 0) c.fail('expected WHEN');
  const otherwise = c.eatKw('ELSE') ? expr(c) : null;
  c.kw('END');
  return { k: 'case', base, whens, else: otherwise, s, e: c.last().e };
}
// `(` has been read: a subquery, one expression in parentheses, or a row of several
function parenthesised(c: Cursor, s: number): Expr {
  if (c.isKw('SELECT')) {
    const sel = select(c);
    c.op(')');
    return { k: 'sub', sel, s, e: c.last().e };
  }
  const items = c.list(expr);
  c.op(')');
  const [only] = items;
  return only && items.length === 1
    ? { ...only, paren: true, ps: s, pe: c.last().e }
    : { k: 'row', items, s, e: c.last().e };
}
// a name: a function call, a column, or TRUE and FALSE
function named(c: Cursor, t: SqlToken): Expr {
  const s = t.s,
    first = c.name();
  if (c.eatOp('(')) return call(c, first.toLowerCase(), s);
  if (c.eatOp('.')) {
    const name = column(c);
    if (c.isOp('.')) c.refuse('a schema-qualified column: name it table.column');
    return { k: 'col', table: first, name, s, e: c.last().e };
  }
  if (/^(true|false)$/i.test(first) && t.t === 'id' && !t.q)
    return { k: 'lit', v: /^true$/i.test(first) ? 1 : 0, type: 'int', bool: true, s, e: t.e };
  return { k: 'col', table: null, name: first, s, e: c.last().e };
}
// `name(` has been read
function call(c: Cursor, name: string, s: number): Expr {
  const star = !!c.eatOp('*'),
    some = !star && !c.isOp(')'),
    distinct = some && !!c.eatKw('DISTINCT'),
    args = some ? c.list(expr) : [];
  if (some && c.isKw('ORDER')) c.refuse('ORDER BY inside an aggregate');
  c.op(')');
  if (c.isAnyKw('FILTER', 'OVER')) c.refuse(`${c.peek().v} on a function call (a window or filtered aggregate)`);
  return { k: 'fn', name, args, star, distinct, s, e: c.last().e };
}

// ---- type names (CAST, and a column's declared type)
// a keyword that may be a name is part of a type's name, unless it opens what follows the type
const ENDS_A_TYPE = new Set([
  'CONSTRAINT',
  'PRIMARY',
  'NOT',
  'NULL',
  'UNIQUE',
  'CHECK',
  'DEFAULT',
  'COLLATE',
  'REFERENCES',
  'GENERATED',
  'AS',
]);
export function typeName(c: Cursor): string {
  const words: string[] = [];
  for (let t = c.peek(); t.t === 'id' || (t.t === 'kw' && !ENDS_A_TYPE.has(t.v) && c.isName()); t = c.peek())
    words.push(c.name());
  if (words.length > 0 && c.eatOp('(')) {
    const size = signedNumber(c);
    if (c.eatOp(',')) signedNumber(c);
    c.op(')');
    words.push(`(${size})`);
  }
  return words.join(' ');
}
function signedNumber(c: Cursor): string {
  const sign = c.eatOp('-') ? '-' : '';
  if (!sign) c.eatOp('+');
  const t = c.peek();
  if (t.t !== 'num') return c.fail('expected a number');
  c.skip();
  return sign + t.v;
}

// ---- SELECT
export function select(c: Cursor): Select {
  const s = c.peek().s;
  if (c.isKw('VALUES')) c.refuse('a VALUES statement on its own: use SELECT');
  const core = selectCore(c);
  if (c.isAnyKw('UNION', 'INTERSECT', 'EXCEPT')) c.refuse(`a compound SELECT (${c.peek().v})`);
  const order = c.eatKw('ORDER') ? (c.kw('BY'), c.list(orderTerm)) : null,
    limit = c.eatKw('LIMIT') ? expr(c) : null,
    offset = limit && c.eatKw('OFFSET') ? expr(c) : null;
  if (limit && !offset && c.eatOp(',')) c.refuse('LIMIT a, b: write LIMIT b OFFSET a', c.last());
  return { ...core, order, limit, offset, ...c.span(s) };
}
// SELECT … up to and including GROUP BY and HAVING
function selectCore(c: Cursor): Select {
  const s = c.peek().s;
  c.kw('SELECT');
  const distinct = !!c.eatKw('DISTINCT');
  if (!distinct) c.eatKw('ALL');
  const cols = c.list(resultCol),
    from = c.eatKw('FROM') ? fromClause(c) : [],
    where = c.eatKw('WHERE') ? expr(c) : null,
    group = c.eatKw('GROUP') ? (c.kw('BY'), c.list(expr)) : null,
    // HAVING without GROUP BY makes the whole selection one group (SQLite 3.39 and later: one row, or none)
    having = c.eatKw('HAVING') ? expr(c) : null;
  if (c.isKw('WINDOW')) c.refuse('a WINDOW clause');
  const rest = { distinct, cols, from, where, group, having, order: null, limit: null, offset: null };
  return { k: 'select', ...c.span(s), ...rest };
}
/** one item of a SELECT list or a RETURNING list */
export function resultCol(c: Cursor): ResultCol {
  const s = c.peek().s;
  if (c.eatOp('*')) return { k: 'rcol', ...c.span(s), star: true, table: null };
  if (c.isName() && c.isOp('.', 1) && c.isOp('*', 2)) {
    const table = c.name();
    c.skip(2);
    return { k: 'rcol', ...c.span(s), star: true, table };
  }
  const x = expr(c),
    bare = c.peek().t === 'id' || c.peek().t === 'str',
    alias = c.eatKw('AS') || bare ? c.name('a column alias') : null;
  return { k: 'rcol', ...c.span(s), star: false, expr: x, alias };
}
function orderTerm(c: Cursor): OrderTerm {
  const s = c.peek().s,
    x = expr(c);
  if (c.eatKw('COLLATE')) c.name('a collation');
  const dir = direction(c);
  if (c.isKw('NULLS')) c.refuse('NULLS FIRST/LAST');
  return { k: 'order', ...c.span(s), expr: x, dir };
}
// the join that the next table is joined by, or null when the FROM clause has ended
function joinWord(c: Cursor): Join | null {
  if (c.eatOp(',')) return ',';
  if (c.isKw('NATURAL')) c.refuse('a NATURAL join: name the columns it joins on with ON');
  if (c.isAnyKw('RIGHT', 'FULL')) c.refuse(`a ${c.peek().v} join: write it as a LEFT JOIN`);
  const join: Join | null = c.eatKw('LEFT')
    ? (c.eatKw('OUTER'), 'left')
    : c.eatKw('INNER')
      ? 'inner'
      : c.eatKw('CROSS')
        ? 'cross'
        : null;
  if (join) c.kw('JOIN');
  return join ?? (c.eatKw('JOIN') ? 'inner' : null);
}
function fromClause(c: Cursor): TableRef[] {
  const out = [tableRef(c, null)];
  for (let join = joinWord(c); join; join = joinWord(c)) out.push(tableRef(c, join));
  return out;
}
function tableRef(c: Cursor, join: Join | null): TableRef {
  const s = c.peek().s,
    ref = tableOrSubquery(c),
    end = c.last().e,
    alias = c.alias(true);
  if (c.isKw('INDEXED') || (c.isKw('NOT') && c.isKw('INDEXED', 1))) c.refuse('INDEXED BY');
  const on = c.eatKw('ON') ? expr(c) : null,
    using = !on && c.eatKw('USING') ? c.parenList(column) : null;
  if ((on || using) && (join === null || join === ',')) c.fail('ON or USING belongs to a JOIN', c.last());
  if (ref.sub && !alias) {
    // the statement written back with the alias, on one line: `FROM (SELECT …) AS t`
    const aliased = `${c.src.slice(0, end)} AS t${c.src.slice(end)}`.replaceAll(/\s+/g, ' ').trim();
    c.fail('a subquery in FROM needs an alias', c.last(), `Name it with AS: \`${aliased}\`.`);
  }
  return { k: 'tref', ...c.span(s), ...ref, alias, join, on, using };
}
function tableOrSubquery(c: Cursor): { sub: Select; name: null } | { sub: null; name: string } {
  if (c.eatOp('(')) {
    if (!c.isKw('SELECT')) c.refuse('a parenthesised join: write the tables in order');
    const sub = select(c);
    c.op(')');
    return { sub, name: null };
  }
  const name = c.tableName();
  if (c.isOp('(')) c.refuse(`the table-valued function ${name}(…)`);
  return { sub: null, name };
}
