// rules/origins.ts: where a value came from: the row a key names, traced through bindings and calls.
import {
  type CondArm,
  type Expr,
  type FnDecl,
  type Let,
  type PatArm,
  type Pattern,
  armParts,
  eachPattern,
  partsOf,
  unreachable,
} from '../compiler/ast.ts';
import { conjunctsOf } from '../sql.ts';
import { argFor, calleeOf, lc } from './syntax.ts';
import type { Query, RuleContext } from './types.ts';
import { predicateOn, writeOf } from './writes.ts';

// --- C78 and C79: the timer C77 counts names the row, and the run it starts comes back for the row.
//
// C78 reads where a timer's key comes from. A key's origin is a set of signed atoms:
//   +row:N         the key column of the row query N reads, writes or returns
//   +param:f.p/…   parameter p of f (with the path into it), and what every call site passes for it
//   +wake          the key of the timer that started this run (woken's `Wake(key)`)
//   ?              something else (a computed value, the request, a call's answer)
// A literal adds nothing; `0 - x` and `-x` flip the sign; `x + c` keeps it. A row's own key is the row atom of
// the write, and the origin of what its WHERE compares the key column with. A timer names the row when the two
// share an atom. The run decodes it when some timer's run reads the table by its key from `wake` with the same
// sign (decode(encode(id)) = id).
export type Origin = Set<string>;
export const Q = '?';
const unknown = (): Origin => new Set([Q]);
const nothing = (): Origin => new Set();
const WRAP = new Set(['Some.value', 'Moved.value', 'Raced.now', 'Ok.value']);

// ---- what binds each variable
type Var = Extract<Expr, { k: 'var' }>;
/** What binds a variable: a parameter, a `let`, or a pattern over a subject (with the path into it). */
export type Binding =
  | { k: 'param'; name: string; fn: FnDecl }
  | { k: 'let'; value: Expr; fn: FnDecl }
  | { k: 'pat'; subject: Expr | null; path: string[]; fn: FnDecl };
type Env = Map<string, Binding>;
// the names a pattern binds, each with the path from the subject to it; a pattern that is no constructor binds
// its names to nothing that can be followed
function bindPattern(fn: FnDecl, pat: Pattern, subject: Expr | null, path: string[], env: Env): void {
  if (pat.k === 'bind' || pat.k === 'as') env.set(pat.name, { k: 'pat', subject, path, fn });
  if (pat.k === 'as') bindPattern(fn, pat.pat, subject, path, env);
  else if (pat.k === 'ctor')
    for (const s of pat.subs) bindPattern(fn, s.pat, subject, [...path, `${pat.name}.${s.field}`], env);
  else if (pat.k !== 'bind')
    eachPattern(pat, n => {
      if (n.k === 'bind' || n.k === 'as') env.set(n.name, { k: 'pat', subject: null, path: [], fn });
    });
}
function bind(fn: FnDecl, e: Expr, env: Env, out: Map<Var, Binding | null>): void {
  const inner = (x: Expr, en: Env): void => bind(fn, x, en, out);
  switch (e.k) {
    case 'var':
      out.set(e, env.get(e.name) ?? null);
      return;
    case 'block': {
      let en = env;
      for (const l of e.lets) {
        inner(l.value, en);
        en = new Map(en);
        if (l.pat) bindPattern(fn, l.pat, l.value, [], en);
        else en.set(l.name, { k: 'let', value: l.value, fn });
      }
      return inner(e.result, en);
    }
    case 'match':
      if (e.subject) inner(e.subject, env);
      for (const a of e.arms) {
        const en = new Map(env);
        if ('pat' in a) bindPattern(fn, a.pat, e.subject, [], en);
        for (const part of armParts(a)) inner(part, en);
      }
      return;
    case 'lambda': {
      const en = new Map(env);
      for (const p of e.params) en.set(p.name, { k: 'pat', subject: null, path: [], fn });
      return inner(e.body, en);
    }
    default:
      for (const part of partsOf(e)) inner(part, env);
  }
}
const BINDS = new WeakMap<FnDecl, Map<Var, Binding | null>>();
/** Every variable of a function, and what binds it. */
export function bindsOf(fn: FnDecl): Map<Var, Binding | null> {
  const known = BINDS.get(fn);
  if (known) return known;
  const out = new Map<Var, Binding | null>();
  BINDS.set(fn, out);
  const params = fn.params.map((p): [string, Binding] => [p.name, { k: 'param', name: p.name, fn }]);
  bind(fn, fn.body, new Map(params), out);
  return out;
}

// ---- what each expression stands in
/** An expression's parent, and how it stands in it: an argument (by label), a let's value, a match's subject or arm. */
export type Up = { p: Expr; label?: string | null; let?: Let; subject?: true; arm?: PatArm | CondArm };
function parents(e: Expr, up: Up | null, out: Map<Expr, Up>): void {
  if (up) out.set(e, up);
  const inner = (x: Expr | null | undefined, how: Omit<Up, 'p'>): void => {
    if (x) parents(x, { p: e, ...how }, out);
  };
  switch (e.k) {
    case 'call':
    case 'ctor':
      for (const a of e.args) inner(a.value, { label: a.label });
      return;
    case 'block':
      for (const l of e.lets) inner(l.value, { let: l });
      return inner(e.result, {});
    case 'match':
      inner(e.subject, { subject: true });
      for (const a of e.arms) for (const part of armParts(a)) inner(part, { arm: a });
      return;
    default:
      for (const part of partsOf(e)) inner(part, {});
  }
}
const PARENTS = new WeakMap<FnDecl, Map<Expr, Up>>();
export function parentsOf(fn: FnDecl): Map<Expr, Up> {
  const known = PARENTS.get(fn);
  if (known) return known;
  const out = new Map<Expr, Up>();
  PARENTS.set(fn, out);
  parents(fn.body, null, out);
  return out;
}
/** The expressions a body's value can be: the result of its blocks, the body of each arm of its matches. */
export const resultsOf = (e: Expr | null | undefined): Expr[] =>
  !e ? [] : e.k === 'block' ? resultsOf(e.result) : e.k === 'match' ? e.arms.flatMap(a => resultsOf(a.body)) : [e];

// ---- origins
type Hit = { q: Query; i: number };
// one trace: the program it reads, each query by its call, and what has been worked out
type Trace = {
  ctx: RuleContext;
  byNode: Map<Expr, Hit>;
  memo: Map<Expr, Map<string, Origin>>;
  busy: Set<Expr>;
};
const flip = (s: Origin): Origin => new Set([...s].map(a => (a === Q ? Q : (a[0] === '+' ? '-' : '+') + a.slice(1))));
// `x + 1`, `x * 2`, `x + y`: derived from x but not x (C78 wants the key itself); the mark is a trailing ~
const shift = (s: Origin): Origin => new Set([...s].map(a => (a === Q || a.endsWith('~') ? a : a + '~')));
const union = (...ss: Origin[]): Origin => new Set(ss.flatMap(s => [...s]));
// the number an expression is, when it is a literal or a literal negated
const num = (e: Expr): number | null =>
  e.k === 'int' ? Number(e.v) : e.k === 'neg' && e.e.k === 'int' ? -Number(e.e.v) : null;

/** The table a query writes, or the first one it reads. */
export function tableOf(q: Pick<Query, 'ast'>): string | null {
  const w = q.ast && writeOf(q.ast);
  if (w?.table) return w.table;
  const f = q.ast?.k === 'select' ? q.ast.from[0] : null;
  return f && !f.sub ? f.name : null;
}
// a table's key column, when its key is one column
function pkOf(ctx: RuleContext, table: string | null | undefined): string | null {
  if (!table) return null;
  const t = ctx.tables.get(table) ?? [...ctx.tables].find(([n]) => lc(n) === lc(table))?.[1],
    [only] = t?.pk ?? [];
  return t?.pk.length === 1 && only ? only : null;
}
// what a path into a query's result is: the row's key, another field of it, or the value whole
function rowAtom(tr: Trace, hit: Hit, path: string[]): Origin {
  // Some(value: …), Moved(value: …) and the like hold the row: a path through them is a path into the row
  const held = path.findIndex(step => !WRAP.has(step)),
    rest = held < 0 ? [] : path.slice(held),
    [step] = rest;
  if (step === undefined) return new Set([`+val:${hit.i}`]);
  if (rest.length > 1) return unknown();
  const field = step.includes('.') ? step.slice(step.indexOf('.') + 1) : step,
    pk = pkOf(tr.ctx, tableOf(hit.q));
  return new Set([pk && lc(field) === lc(pk) ? `+row:${hit.i}` : `+fld:${hit.i}:${field}`]);
}
type Of<K extends Expr['k']> = Extract<Expr, { k: K }>;
// x + 0, 0 - x: x itself (signed); x + c with c not 0, or x + y: derived; x * c: x for 1, -x for -1, else derived
function arithmetic(tr: Trace, e: Of<'bin'>, fn: FnDecl, d: number): Origin {
  const l = num(e.l),
    r = num(e.r),
    of = (x: Expr): Origin => origin(tr, x, [], fn, d + 1);
  if (e.op === '+' || e.op === '-') {
    const left = l !== null ? nothing() : of(e.l),
      right = r !== null ? nothing() : of(e.r),
      both = union(left, e.op === '-' ? flip(right) : right);
    return l === 0 || r === 0 ? both : shift(both);
  }
  if (e.op !== '*' || (l === null && r === null)) return unknown();
  const c = l ?? r ?? 0,
    x = of(l !== null ? e.r : e.l);
  return c === 0 ? nothing() : c === 1 ? x : c === -1 ? flip(x) : shift(c > 0 ? x : flip(x));
}
// a variable: what bound it, and for a parameter what every call site passes for it
function variable(tr: Trace, e: Var, path: string[], fn: FnDecl, d: number): Origin {
  const b = bindsOf(fn).get(e);
  if (!b) return unknown();
  if (b.k === 'let') return origin(tr, b.value, path, b.fn, d + 1);
  if (b.k === 'pat') return b.subject ? origin(tr, b.subject, [...b.path, ...path], b.fn, d + 1) : unknown();
  const out: Origin = new Set([`+param:${fn.name}.${b.name}${path.length > 0 ? '/' + path.join('/') : ''}`]);
  if (/(^|\.)woken$/.test(fn.name) && path.length === 1 && path[0] === 'Wake.key') out.add('+wake');
  for (const { from, node } of tr.ctx.calls.get(fn.name) ?? []) {
    const passed = argFor(node, fn, b.name);
    if (passed) for (const atom of origin(tr, passed, path, from, d + 1)) out.add(atom);
  }
  return out;
}
// a call: a query's row, or what the function called can give
function called(tr: Trace, e: Of<'call'>, path: string[], fn: FnDecl, d: number): Origin {
  const hit = tr.byNode.get(e);
  if (hit) return rowAtom(tr, hit, path);
  const name = calleeOf(tr.ctx.prog, e.name, fn),
    g = name ? tr.ctx.prog.fns.get(name) : undefined;
  return g ? union(...resultsOf(g.body).map(x => origin(tr, x, path, g, d + 1))) : unknown();
}
function originOf(tr: Trace, e: Expr, path: string[], fn: FnDecl, d: number): Origin {
  switch (e.k) {
    case 'int':
      return path.length > 0 ? unknown() : nothing();
    case 'neg':
      return path.length > 0 ? unknown() : flip(origin(tr, e.e, [], fn, d + 1));
    case 'bin':
      return path.length > 0 ? unknown() : arithmetic(tr, e, fn, d);
    case 'field':
      return origin(tr, e.e, [e.name, ...path], fn, d + 1);
    case 'block':
      return origin(tr, e.result, path, fn, d + 1);
    case 'match':
      return union(...e.arms.map(a => origin(tr, a.body, path, fn, d + 1)));
    case 'ctor': {
      // a path that goes into this constructor's field is the origin of what was put there
      const [step] = path,
        field = step?.startsWith(`${e.name}.`) ? step.slice(e.name.length + 1) : null,
        a = field ? e.args.find(x => x.label === field) : undefined;
      return a ? origin(tr, a.value, path.slice(1), fn, d + 1) : unknown();
    }
    case 'var':
      return variable(tr, e, path, fn, d);
    case 'call':
      return called(tr, e, path, fn, d);
    case 'str':
    case 'interp':
    case 'index':
    case 'not':
    case 'lambda':
    case 'held':
      return unknown();
    default:
      return unreachable(e, 'expression');
  }
}
// the origin of the value at `path` inside e (above), remembered; one being worked out adds nothing to itself
function origin(tr: Trace, e: Expr | undefined, path: string[], fn: FnDecl, d = 0): Origin {
  if (!e || d > 10) return unknown();
  const key = path.join('/'),
    known = tr.memo.get(e)?.get(key);
  if (known) return known;
  if (tr.busy.has(e)) return nothing();
  tr.busy.add(e);
  const r = originOf(tr, e, path, fn, d);
  tr.busy.delete(e);
  const forNode = tr.memo.get(e) ?? new Map<string, Origin>();
  tr.memo.set(e, forNode.set(key, r));
  return r;
}
// a write of one row by its key: its WHERE compares the key column with a value (an INSERT names its row)
function keyed(tr: Trace, q: Query): boolean {
  const w = q.ast && writeOf(q.ast),
    pk = pkOf(tr.ctx, w?.table);
  if (w?.kind === 'insert') return true;
  if (!pk || w?.kind !== 'update') return false;
  const names = [lc(w.table), lc(w.alias)].filter(Boolean);
  return (conjunctsOf(w.where) ?? []).some(c => predicateOn(c, names, pk)?.op === '=');
}
// a row's own key: the write's row, and what its WHERE puts in the key column
function rowKey(tr: Trace, q: Query): Origin {
  const hit = tr.byNode.get(q.at),
    out: Origin = new Set(hit ? [`+row:${hit.i}`] : []),
    w = q.ast && writeOf(q.ast),
    pk = pkOf(tr.ctx, w?.table);
  if (w?.kind !== 'update' || !pk) return out;
  const names = [lc(w.table), lc(w.alias)].filter(Boolean);
  for (const c of conjunctsOf(w.where) ?? []) {
    const pr = predicateOn(c, names, pk),
      v = pr?.op === '=' ? pr.vals[0] : undefined;
    if (v?.k === 'param') for (const a of origin(tr, q.args[String(v.n)], [], q.fn)) if (a !== Q) out.add(a);
  }
  return out;
}
/** The origins of values in one program, as the rules read it. */
export function originsIn(ctx: RuleContext) {
  const byNode = new Map<Expr, Hit>(ctx.queries.map((q, i) => [q.at, { q, i }])),
    tr: Trace = { ctx, byNode, memo: new Map(), busy: new Set() };
  return {
    /** the origin of the value at `path` inside e */
    res: (e: Expr | undefined, path: string[], fn: FnDecl, d = 0): Origin => origin(tr, e, path, fn, d),
    rowKey: (q: Query): Origin => rowKey(tr, q),
    tableOf,
    pkOf: (table: string | null | undefined): string | null => pkOf(ctx, table),
    byNode,
    keyed: (q: Query): boolean => keyed(tr, q),
  };
}
export type Origins = ReturnType<typeof originsIn>;

/** The path from a pattern to the constructor of `type` inside it: `Some(value: Order(…))` gives ['Some.value']. */
export function wrapsTo(pt: Pattern | null | undefined, type: string): string[] {
  if (pt?.k === 'as') return wrapsTo(pt.pat, type);
  if (pt?.k !== 'ctor' || pt.name === type) return [];
  for (const sb of pt.subs)
    if (sb.pat.k === 'ctor' || sb.pat.k === 'as') return [`${pt.name}.${sb.field}`, ...wrapsTo(sb.pat, type)];
  return [];
}
/** An expression as a message shows it. */
export function showExpr(e: Expr | null | undefined): string {
  if (!e) return '';
  if (e.k === 'int') return String(e.v);
  if (e.k === 'var') return e.name;
  if (e.k === 'neg') return `-${showExpr(e.e)}`;
  if (e.k === 'field') return `${showExpr(e.e)}.${e.name}`;
  if (e.k === 'bin') return `${showExpr(e.l)} ${e.op} ${showExpr(e.r)}`;
  if (e.k === 'call') return `${e.name}(…)`;
  return '…';
}
/** The atoms of an origin without their signs, the unknown left out. */
export const unsigned = (s: Origin): Set<string> => new Set([...s].filter(a => a !== Q).map(a => a.slice(1)));
