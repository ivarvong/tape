// compiler/parse/expr.ts: expressions, patterns, and the blocks and matches they stand in.
import type {
  Arg,
  At,
  BinOp,
  Block,
  Call,
  CondArm,
  Expr,
  FieldDecl,
  Let,
  Match,
  Param,
  PatArm,
  Pattern,
  Token,
  TokenOf,
  TypeAst,
} from '../ast.ts';
import { fail, utf8 } from '../common.ts';
import { numbered } from '../sqltext.ts';
import { Cursor, shown } from './cursor.ts';

// how tightly each operator binds; `|>` is read here and becomes a call
const PREC: ReadonlyMap<string, number> = new Map(
  Object.entries({
    or: 1,
    and: 2,
    '==': 4,
    '!=': 4,
    '<': 4,
    '<=': 4,
    '>': 4,
    '>=': 4,
    '|': 5,
    '^': 6,
    '&': 7,
    '<<': 8,
    '>>': 8,
    '+': 9,
    '-': 9,
    '++': 9,
    '*': 10,
    '/': 10,
    '%': 10,
    '|>': 5,
  } satisfies Record<BinOp | '|>', number>),
);
const COMPARISON = 4;
const isBinOp = (v: string): v is BinOp => v !== '|>' && PREC.has(v);

// ---- types, fields and parameters as written
export function type(c: Cursor): TypeAst {
  const t = c.expect('Id'),
    args = c.eat('op', '[') ? c.list(type) : [];
  if (args.length > 0) c.expect('op', ']');
  return { name: t.v, args, ...c.at(t) };
}
const field = (c: Cursor): FieldDecl => {
  const name = c.fieldName().v;
  c.expect('op', ':');
  return { name, type: type(c) };
};
/** the fields of a constructor: `(name: Type, …)`, or nothing */
export const fields = (c: Cursor): FieldDecl[] => (c.eat('op', '(') ? c.listUntil(')', field) : []);
const param = (c: Cursor): Param => {
  const name = c.expect('id').v;
  c.expect('op', ':', 'Every parameter has a type: `name: Type`.');
  return { name, typeAst: type(c) };
};
/** `(name: Type, …)` */
export const params = (c: Cursor): Param[] => {
  c.expect('op', '(');
  return c.listUntil(')', param);
};

// ---- expressions
/**
 * An integer literal, `-` and all when it is negative: a value an Int holds, from -9223372036854775808 to
 * 9223372036854775807, or refused (it would otherwise wrap).
 */
function intLiteral(t: Token, v: bigint): bigint {
  if (v < -(2n ** 63n) || v > 2n ** 63n - 1n)
    fail(
      t,
      'P08',
      `${v} does not fit in an Int`,
      'An Int is a 64-bit signed integer, from -9223372036854775808 to 9223372036854775807.',
    );
  return v;
}
// one argument: `label: value`, or a bare expression (a bare name stands for `name: name`)
function arg(c: Cursor): Arg {
  const first = c.peek(),
    colon = c.peek(1);
  // a field's name may be a reserved word (`Event(type: "view")`)
  if ((first.t === 'id' || first.t === 'kw') && colon.t === 'op' && colon.v === ':') {
    c.pos += 2;
    return { label: first.v, value: expr(c), ...c.at(first) };
  }
  const value = expr(c);
  return { label: value.k === 'var' ? value.name : null, pun: true, value, ...c.at(first) };
}
const args = (c: Cursor): Arg[] => c.listUntil(')', arg);

// a function value: fn(x: Int) -> Int { x + n }
function lambda(c: Cursor, t: Token): Expr {
  const ps = params(c);
  c.expect('op', '->', 'A function value states its result type: `fn(x: Int) -> Int { … }`.');
  return { k: 'lambda', params: ps, retAst: type(c), body: block(c), ...c.at(t) };
}
/** A part of a text literal with holes: the text between two holes (nothing when it is empty), or a hole's expression. */
function holeOrText(c: Cursor, part: TokenOf<'interp'>['v'][number], at: At): Expr[] {
  if ('text' in part) return part.text.length > 0 ? [{ k: 'str', bytes: part.text, ...at }] : [];
  const inner = new Cursor(c.file, part.hole);
  const e = expr(inner);
  if (!inner.is('eof'))
    fail(inner.peek(), 'P02', 'a \\( hole holds one expression', 'Close the hole after it: `"Hello, \\(name)"`.');
  return [e];
}
// an expression with no operator outside it, before any `.field` or `[index]`
function atom(c: Cursor, t: Token): Expr {
  const at = c.at(t);
  if (t.t === 'int') return { k: 'int', v: intLiteral(t, t.v), ...at };
  if (t.t === 'str') return { k: 'str', bytes: t.v, ...at };
  if (t.t === 'interp') return { k: 'interp', parts: t.v.flatMap(part => holeOrText(c, part, at)), ...at };
  if (t.t === 'kw' && t.v === 'fn') return lambda(c, t);
  if (t.t === 'op' && t.v === '(') {
    const inner = expr(c);
    c.expect('op', ')');
    return inner;
  }
  if (t.t === 'id')
    return c.eat('op', '(')
      ? numberedCall({ k: 'call', name: t.v, args: args(c), ...at })
      : { k: 'var', name: t.v, ...at };
  if (t.t === 'Id') return { k: 'ctor', name: t.v, args: c.eat('op', '(') ? args(c) : [], ...at };
  // a match is an expression like any other: a value, an argument, the left side of a pipe
  if (t.t === 'kw' && t.v === 'match') return match(c, t);
  return fail(
    t,
    'P02',
    `expected an expression but found ${shown(t)}`,
    'An expression is a number, a text, a name, a call, a constructor, `fn(…) -> T { … }`, or one of those with operators.',
  );
}
// an atom and what follows it: `.field`, `file.name(…)`, `[index]`
function primary(c: Cursor): Expr {
  const t = c.next(),
    at = c.at(t);
  let e = atom(c, t);
  for (;;) {
    if (c.eat('op', '.')) {
      const name = c.fieldName().v;
      e =
        e.k === 'var' && c.eat('op', '(')
          ? { k: 'call', name: `${e.name}.${name}`, args: args(c), ...at }
          : { k: 'field', e, name, ...at };
    } else if (c.eat('op', '[')) {
      const i = expr(c);
      c.expect('op', ']');
      e = { k: 'index', e, i, ...at };
    } else return e;
  }
}
// A call that runs a query names the values it takes: `query: "… WHERE id = :id AND state = :from", id, from: "new"`.
// From here on the query is the statement the database is given, each name numbered in the order it first appears,
// and the argument of each name carries that number (`p1`): the checker, the rules and the log read one form.
const SQL_CALL = /^sql_(exec|first|all|move)$/,
  NOT_VALUES = new Set(['db', 'query', 'row', 'repeat', 'no_floor']);
function numberedCall(e: Call): Expr {
  const query = SQL_CALL.test(e.name) ? e.args.find(a => a.label === 'query')?.value : undefined;
  if (query?.k !== 'str') return e;
  const { sql, names, mixed } = numbered(new TextDecoder().decode(Uint8Array.from(query.bytes)));
  // a query that numbers its own placeholders, or one that does both, is left for the compiler to refuse
  if (names === null || mixed) return e;
  const number = (a: Arg): Arg => {
    const n = a.label === null || NOT_VALUES.has(a.label) ? -1 : names.indexOf(a.label);
    return n < 0 ? a : { ...a, label: `p${n + 1}`, as: names[n] ?? '' };
  };
  return {
    ...e,
    params: names,
    args: e.args.map(a => (a.value === query ? { ...a, value: { ...query, bytes: utf8(sql) } } : number(a))),
  };
}
// `-` before a number is part of it: `-7` is a literal, and so is the least Int, -9223372036854775808, whose
// digits alone do not fit. Before anything else it negates, binding tighter than every binary operator.
function unary(c: Cursor): Expr {
  const t = c.peek();
  if (!c.eat('op', '-')) return primary(c);
  const n = c.peek(),
    after = c.peek(1);
  if (n.t === 'int' && !(after.t === 'op' && (after.v === '.' || after.v === '['))) {
    c.next();
    return { k: 'int', v: intLiteral(t, -n.v), ...c.at(t) };
  }
  return { k: 'neg', e: unary(c), ...c.at(t) };
}
// a |> f(b: 1) is f(<f's first parameter>: a, b: 1). The right side is one call (or a function's name, for a call
// with nothing else to pass). Which parameter is first is known once every file is parsed (resolvePipes).
function pipe(c: Cursor, l: Expr, t: Token): Expr {
  const at = c.peek(),
    r = primary(c),
    piped: Arg = { label: null, piped: true, value: l, ...c.at(t) };
  if (r.k === 'var') return { k: 'call', name: r.name, args: [piped], line: r.line, file: c.file };
  if (r.k === 'call') return { ...r, args: [piped, ...r.args] };
  return fail(
    at,
    'P07',
    'the right side of |> must be a function call',
    r.k === 'ctor'
      ? `A constructor's fields are named; write \`${r.name}(field: value)\` instead of piping into it.`
      : "Write `value |> f(other: …)`: the value becomes f's first parameter. To use the result in arithmetic or a comparison, put the pipe in parentheses.",
  );
}
/** an expression whose operators all bind at least as tightly as `min` */
export function binary(c: Cursor, min: number): Expr {
  const not = c.eat('kw', 'not');
  let l: Expr = not ? { k: 'not', e: binary(c, 3), ...c.at(not) } : unary(c);
  for (;;) {
    const t = c.peek(),
      prec = t.t === 'op' || t.t === 'kw' ? PREC.get(t.v) : undefined;
    if (prec === undefined || prec < min || (t.t !== 'op' && t.t !== 'kw')) return l;
    c.next();
    if (!isBinOp(t.v)) {
      l = pipe(c, l, t);
      continue;
    }
    l = { k: 'bin', op: t.v, l, r: binary(c, prec + 1), ...c.at(t) };
    const after = c.peek();
    if (prec === COMPARISON && after.t === 'op' && PREC.get(after.v) === COMPARISON)
      fail(after, 'P03', 'comparisons cannot be chained', 'Combine two comparisons with `and`.');
  }
}
/** an expression */
export function expr(c: Cursor): Expr {
  // there was `with { pattern <- e … -> result else -> fallback }`; `let … else` does what it did, a step at a time
  if (c.is('kw', 'with'))
    fail(
      c.peek(),
      'C35',
      '`with { … }` is not a form',
      'Write each step as `let pattern = expression else -> fallback` on its own line; the function goes on with what the pattern matched.',
    );
  return binary(c, 1);
}

// ---- patterns
// `P ++ "text"` matches text ending in "text"; `P ++ "sep" ++ Q` splits at the first "sep": P matches what is
// before it, Q what is after. With `"prefix" ++ …` this gives mid-path captures: `"/runs/" ++ decimal(id) ++ "/advance"`.
export function pattern(c: Cursor): Pattern {
  const head = simplePattern(c);
  if (head.k === 'str' || head.k === 'prefix' || !c.is('op', '++')) return head;
  const at = c.at(c.next());
  const sep =
    c.eat('str') ??
    fail(
      c.peek(),
      'P04',
      'after `pattern ++` comes a text literal',
      'Write `decimal(id) ++ "/advance"`: the text that ends the capture.',
    );
  return c.eat('op', '++')
    ? { k: 'split', head, bytes: sep.v, rest: pattern(c), ...at }
    : { k: 'suffix', head, bytes: sep.v, ...at };
}
// a pattern that opens with a name: `name = Pattern` (the whole value, once it matches), `decimal(n)`, or a binding
function namedPattern(c: Cursor, t: Token & { t: 'id' }): Pattern {
  const at = c.at(t);
  if (c.eat('op', '=')) return { k: 'as', name: t.v, pat: pattern(c), ...at };
  if (!c.eat('op', '(')) return { k: 'bind', name: t.v, ...at };
  const sub = pattern(c);
  c.expect('op', ')', 'A function pattern takes one pattern: `decimal(n)`.');
  return { k: 'fn', name: t.v, sub, ...at };
}
// one field of a constructor pattern: `field: pattern`, or a bare name, which binds the field under its own name
function fieldPattern(c: Cursor): { field: string; pat: Pattern; pun?: true } {
  const f = c.fieldName();
  if (c.eat('op', ':')) return { field: f.v, pat: pattern(c) };
  if (f.t === 'kw')
    fail(
      f,
      'P01',
      `\`${f.v}\` is a reserved word: a field of that name is matched, not bound by its own name`,
      `Name what it binds: \`${f.v}: ${f.v === 'type' ? 'kind' : `${f.v}_value`}\`.`,
    );
  return { field: f.v, pun: true, pat: { k: 'bind', name: f.v, ...c.at(f) } };
}
function simplePattern(c: Cursor): Pattern {
  const t = c.next(),
    at = c.at(t);
  if (t.t === 'op' && t.v === '_') return { k: 'any', ...at };
  if (t.t === 'int') return { k: 'int', v: intLiteral(t, t.v), ...at };
  if (t.t === 'op' && t.v === '-') return { k: 'int', v: intLiteral(t, -c.expect('int').v), ...at };
  if (t.t === 'str')
    return c.eat('op', '++') ? { k: 'prefix', bytes: t.v, rest: pattern(c), ...at } : { k: 'str', bytes: t.v, ...at };
  if (t.t === 'id') return namedPattern(c, t);
  if (t.t !== 'Id')
    return fail(
      t,
      'P04',
      `expected a pattern but found ${shown(t)}`,
      'A pattern is a constructor, a number, a text literal, a name or `_`.',
    );
  const subs = c.eat('op', '(') ? c.list(fieldPattern) : [];
  if (subs.length > 0) c.expect('op', ')');
  return { k: 'ctor', name: t.v, subs, ...at };
}

// ---- match
const armBody = (c: Cursor): Expr => (c.is('op', '{') ? block(c) : expr(c));
// arms, each on its own line, up to and past the closing brace
function arms<A>(c: Cursor, arm: (c: Cursor) => A): A[] {
  const out: A[] = [];
  while (!c.is('op', '}')) {
    out.push(arm(c));
    c.expect('nl', undefined, 'Put each arm on its own line.');
    c.skipNl();
  }
  c.next();
  return out;
}
function patArm(c: Cursor): PatArm {
  const at = c.at(c.peek()),
    pat = pattern(c),
    guard = c.eat('kw', 'if') ? binary(c, 1) : undefined;
  c.expect('op', '->', 'An arm is `pattern -> expression`.');
  return { ...at, pat, ...(guard ? { guard } : {}), body: armBody(c) };
}
function condArm(c: Cursor): CondArm {
  const at = c.at(c.peek()),
    cond = c.eat('kw', 'else') ? null : binary(c, 1);
  c.expect('op', '->', 'An arm is `condition -> expression`, and the last arm is `else -> expression`.');
  return cond ? { ...at, cond, body: armBody(c) } : { ...at, else: true, body: armBody(c) };
}
// from just after the word `match`
function match(c: Cursor, word: Token): Match {
  const at = c.at(word),
    subject = c.is('op', '{') ? null : binary(c, 1);
  c.expect('op', '{');
  c.skipNl();
  return subject
    ? { k: 'match', subject, arms: arms(c, patArm), ...at }
    : { k: 'match', subject, arms: arms(c, condArm), ...at };
}

// ---- blocks: steps, then the expression the block is worth
type Steps = { lets: Let[]; result: Expr };
// `do call(…)`: run it for what it does; its value is dropped. A step like a `let`, with no name to invent.
function doStep(c: Cursor, n: number): Let {
  const d = c.next(),
    value = expr(c);
  if (value.k !== 'call')
    fail(
      d,
      'C82',
      '`do` runs a call for what it does, and this is not a call',
      'Write `do name(…)`, or `let name = …` to keep a value.',
    );
  c.expect('nl', undefined, 'After a `do` step comes a new line, and the block ends with an expression.');
  return { name: `do${d.line}_${n}`, value, do: true, ...c.at(d) };
}
// the arms after `else`: `else -> fallback`, or `else { pattern -> value … }`
function elseArms(c: Cursor): PatArm[] {
  const at = c.at(c.expect('kw', 'else'));
  if (c.eat('op', '->')) return [{ pat: { k: 'any', ...at }, body: armBody(c), ...at }];
  c.expect('op', '{', '`let P = e else { pattern -> value … }`, or `else -> value`.');
  c.skipNl();
  return arms(c, patArm);
}
// `let P = e else { arms }` (or `else -> fallback`): a step. When e matches P, its names are bound for the rest of
// the block; otherwise the first matching arm is the block's value. It is read as `match e { P -> rest, arms }`, so
// the arms are checked like any match: together with P they must cover every value of e.
function letElse(c: Cursor, at: { line: number; file: string }, pat: Pattern, value: Expr): Expr {
  const others = elseArms(c);
  c.expect('nl', undefined, 'After `else { … }` comes a new line.');
  c.skipNl();
  const rest = steps(c),
    first: PatArm = { pat, body: { k: 'block', ...rest, ...at }, ...at, step: true };
  return { k: 'match', subject: value, arms: [first, ...others], ...at };
}
// `let name = e`
function plainLet(c: Cursor): Let {
  const n = c.expect('id');
  c.expect('op', '=');
  const value = expr(c);
  c.expect('nl');
  return { name: n.v, value, ...c.at(n) };
}
function steps(c: Cursor): Steps {
  const lets: Let[] = [];
  for (;;) {
    if (c.is('kw', 'do')) lets.push(doStep(c, lets.length));
    else if (!c.eat('kw', 'let')) return { lets, result: expr(c) };
    // `let Order(id, sku) = e` takes a value apart; the pattern must always match (checked where it is compiled),
    // unless an `else` takes the other cases. Any pattern can stand here: a constructor, a text, a number
    // (`let 1 = sql_exec(…) else -> …`: go on when one row changed).
    else if (c.is('Id') || c.is('str') || c.is('int') || (c.is('op', '-') && c.peek(1).t === 'int')) {
      const at = c.at(c.peek()),
        pat = pattern(c);
      c.expect('op', '=', 'A destructuring `let` is `let Ctor(field, …) = expression`.');
      const value = expr(c);
      if (c.is('kw', 'else')) return { lets, result: letElse(c, at, pat, value) };
      lets.push({ pat, value, ...at });
      c.expect('nl');
    } else lets.push(plainLet(c));
    c.skipNl();
  }
}
export function block(c: Cursor): Block {
  const t = c.expect('op', '{');
  c.skipNl();
  const { lets, result } = steps(c);
  c.skipNl();
  c.expect('op', '}', 'A block is `let` lines followed by one expression.');
  return { k: 'block', lets, result, ...c.at(t) };
}
