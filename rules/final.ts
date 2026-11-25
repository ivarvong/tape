// rules/final.ts: C80 (added in round 3 of the timer-rule mutants, experiments/c78/round3.ts). `final` on a constructor says that asking again gives the same outcome, and C79
// lets a timer's run leave a row on a final outcome (for a request to act on). The compiler checks the declaration
// where the constructor is made: every decision on the way to it (the conditions and guards of the arms it is in,
// those of the arms before them, the subjects of the matches, in its function and in each caller that answers with
// it) reads only what a second run reads the same: arguments, stored rows, constants, a call's reply (a call
// carries a once key, C41, so the callee repeats its stored reply). Not the clock, and not an `ask`'s reply (a read
// has no key). A clock reading that can only change one way is allowed where it is: `now() > t` (or `>=`, or
// `t < now()`) with t not itself read from the clock, true on the arm it guards; `now() < t`, false on the arms
// after it. A matched final constructor is the other half: C79 lets a path end there only when the value comes
// from a call (with its once key), not from an ask.
// What a decision reads is followed only where the clock's value flows into it (issue 21): into a function's value
// through what it returns and the decisions on the way to that, not through every step it takes (a `do` that
// stamps a row with the time decides nothing); into a part of a value by the path to that part (a row's `tries`
// read back from an UPDATE whose SET stores the time in another column is the stored count); into the outcome of
// an UPDATE (Moved, Raced, NoRow, or how many rows it changed) only through its WHERE, not its SET.
import { eachExpr, partsOf } from '../compiler/ast.ts';
import type { Call, CondArm, Ctor, Expr, FnDecl, Match, PatArm, Pattern, Program } from '../compiler/ast.ts';
import { bindsOf, resultsOf } from './origins.ts';
import { argFor, calleeOf, lc } from './syntax.ts';
import { isRemote, pathsOf } from './timers.ts';
import type { CallSite, Query, Report } from './types.ts';

type Calls = ReadonlyMap<string, readonly CallSite[]>;
/**
 * A part of a value, from the outside in: `Ctor.field` (or `*.field` for `x.field`, whatever the constructor), and
 * last, SHAPE for which constructor it is. [] is the whole value.
 */
type Path = readonly string[];
const SHAPE = '#ctor';
const keyOf = (p: Path): string => p.join('/');
const pathOf = (k: string): Path => (k === '' ? [] : k.split('/'));
/** What a value read in a function depends on: the clock (or an ask's reply), and the parts of its parameters. */
type Dep = { clock: boolean; params: Map<string, Set<string>> };
/**
 * `memo`: for each expression and path, whether it is volatile, by how many steps were left to follow it; `deps`:
 * for each expression and path, what it depends on in its function; `busy`: the function bodies being read.
 */
type Reader = {
  readonly prog: Program;
  readonly calls: Calls;
  readonly queries: ReadonlyMap<Expr, Query>;
  readonly memo: Map<Expr, Map<string, (boolean | undefined)[]>>;
  readonly deps: Map<Expr, Map<string, Dep>>;
  readonly busy: Set<string>;
};
/** A decision a second run may make otherwise: its line, what it is, and the caller it was found in. */
type Doubt = { readonly at: number; readonly what: string; readonly via?: string };

// How far a value is followed up the callers of a function, from a parameter to what each call site passes for it.
// Within a function, and into the functions it calls, a value is followed whole. Past this many steps a value
// counts as one a second run reads the same.
const STEPS = 8;

const isNow = (e: Expr): boolean => e.k === 'call' && e.name === 'now';
const keyed = (e: Call): boolean => e.args.some(a => a.label === 'once');
const none = (): Dep => ({ clock: false, params: new Map() });
const clock = (): Dep => ({ clock: true, params: new Map() });
function union(ds: readonly Dep[]): Dep {
  const out = none();
  for (const d of ds) {
    out.clock ||= d.clock;
    for (const [p, ks] of d.params) out.params.set(p, new Set([...(out.params.get(p) ?? []), ...ks]));
  }
  return out;
}

/** The parts of a subject a pattern looks at: each constructor it names, and each value it compares. */
function tested(pat: Pattern, at: Path): Path[] {
  switch (pat.k) {
    case 'any':
    case 'bind':
      return [];
    case 'as':
      return tested(pat.pat, at);
    case 'ctor':
      return [[...at, SHAPE], ...pat.subs.flatMap(sb => tested(sb.pat, [...at, `${pat.name}.${sb.field}`]))];
    default:
      return [at];
  }
}

/** The numbered values of a statement, those read outside a SET (all of them but in an UPDATE), and by column the
 * values a SET gives it. */
type SqlParts = { all: Set<string>; where: Set<string>; setting: Map<string, Set<string>> };
const PARTS = new WeakMap<Query, SqlParts>();
function sqlParts(q: Query): SqlParts {
  const known = PARTS.get(q);
  if (known) return known;
  const all = new Set(Object.keys(q.args));
  const ast = q.ast;
  // only an UPDATE is read apart: what an INSERT inserts decides whether it conflicts, and a SELECT's values decide
  // what it finds
  const parts: SqlParts = { all, where: all, setting: new Map() };
  if (ast?.k === 'update') {
    const count = (n: unknown, into: Map<string, number>): void => {
      if (typeof n !== 'object' || n === null) return;
      if ('k' in n && n.k === 'param' && 'n' in n) into.set(String(n.n), (into.get(String(n.n)) ?? 0) + 1);
      for (const [k, v] of Object.entries(n)) if (k !== 's' && k !== 'e') count(v, into);
    };
    const everywhere = new Map<string, number>(),
      inSet = new Map<string, number>();
    count(ast, everywhere);
    for (const a of ast.set) {
      const here = new Map<string, number>();
      count(a.expr, here);
      for (const [n, c] of here) {
        inSet.set(n, (inSet.get(n) ?? 0) + c);
        parts.setting.set(lc(a.col), new Set([...(parts.setting.get(lc(a.col)) ?? []), n]));
      }
    }
    parts.where = new Set([...all].filter(n => (everywhere.get(n) ?? 0) > (inSet.get(n) ?? 0)));
  }
  PARTS.set(q, parts);
  return parts;
}

/** The numbered values of a query a part of its result depends on. */
function sqlNeeds(q: Query, path: Path): Set<string> {
  const { all, where, setting } = sqlParts(q);
  const [head, ...rest] = path;
  if (q.via === 'sql_exec') return where; // how many rows it changed
  if (head === undefined || q.via === 'sql_all') return all;
  // which outcome it is, and the row as another run left it
  if (head === SHAPE || head === 'Raced.now') return where;
  if (!['Moved.value', 'Some.value', '*.value'].includes(head)) return all;
  const [col] = rest;
  if (col === undefined) return all;
  if (col === SHAPE) return where;
  return new Set([...where, ...(setting.get(lc(col.slice(col.indexOf('.') + 1))) ?? [])]);
}

/** What a function's value, at a path, depends on: of its parameters, and the clock. */
function summary(rd: Reader, g: FnDecl, path: Path): Dep {
  const key = `${g.name}|${keyOf(path)}`;
  // read again while it is being read (it calls itself): every parameter, whole
  if (rd.busy.has(key)) return { clock: false, params: new Map(g.params.map(p => [p.name, new Set([''])])) };
  rd.busy.add(key);
  try {
    return deps(rd, g.body, g, path);
  } finally {
    rd.busy.delete(key);
  }
}

function callDeps(rd: Reader, e: Call, f: FnDecl, path: Path): Dep {
  const args = (): Dep => union(e.args.map(a => deps(rd, a.value, f, [])));
  if (isNow(e)) return clock();
  if (isRemote(e)) return keyed(e) ? args() : clock();
  const q = rd.queries.get(e);
  if (q) {
    const needs = sqlNeeds(q, path);
    return union(Object.entries(q.args).flatMap(([n, x]) => (needs.has(n) ? [deps(rd, x, f, [])] : [])));
  }
  const callee = calleeOf(rd.prog, e.name, f);
  const g = callee === null ? undefined : rd.prog.fns.get(callee);
  if (!g) return args(); // a built-in: its value is made from its arguments
  const s = summary(rd, g, path);
  return union([
    { clock: s.clock, params: new Map() },
    ...[...s.params].flatMap(([p, ks]) => {
      const arg = argFor(e, g, p);
      return arg ? [...ks].map(k => deps(rd, arg, f, pathOf(k))) : [];
    }),
  ]);
}

function ctorDeps(rd: Reader, e: Ctor, f: FnDecl, path: Path): Dep {
  const [head, ...rest] = path;
  if (head === undefined) return union(e.args.map(a => deps(rd, a.value, f, [])));
  if (head === SHAPE) return none();
  const dot = head.indexOf('.');
  const [name, field] = [head.slice(0, dot), head.slice(dot + 1)];
  if (name !== '*' && name !== e.name) return none(); // the part is of another constructor: not this value
  const arg = e.args.find(a => a.label === field) ?? (e.args.length === 1 ? e.args[0] : undefined);
  return arg ? deps(rd, arg.value, f, rest) : union(e.args.map(a => deps(rd, a.value, f, [])));
}

/**
 * What the decisions of a match read, up to its arm `upTo`: the parts of its subject its patterns look at, its
 * guards and its conditions.
 */
function decisionDeps(rd: Reader, mt: Match, f: FnDecl, upTo = Infinity): Dep {
  const arms: readonly (PatArm | CondArm)[] = mt.arms;
  const seen = arms.slice(0, upTo + 1);
  const subject = mt.subject;
  const parts = subject
    ? seen.flatMap(a => ('pat' in a ? tested(a.pat, []) : [])).map(p => deps(rd, subject, f, p))
    : [];
  const tests = seen.flatMap(a => ('pat' in a ? (a.guard ? [a.guard] : []) : a.cond ? [a.cond] : []));
  return union([...parts, ...tests.map(t => deps(rd, t, f, []))]);
}

/** What the part `path` of an expression's value depends on, within its function. */
function deps(rd: Reader, e: Expr, f: FnDecl, path: Path): Dep {
  const k = keyOf(path);
  const known = rd.deps.get(e)?.get(k);
  if (known) return known;
  const d = depsOf(rd, e, f, path);
  rd.deps.set(e, (rd.deps.get(e) ?? new Map<string, Dep>()).set(k, d));
  return d;
}
function depsOf(rd: Reader, e: Expr, f: FnDecl, path: Path): Dep {
  switch (e.k) {
    case 'int':
    case 'float':
    case 'dec':
    case 'str':
    case 'held':
    case 'lambda':
      return none();
    case 'var': {
      const b = bindsOf(f).get(e);
      if (b?.k === 'param') return { clock: false, params: new Map([[b.name, new Set([keyOf(path)])]]) };
      if (b?.k === 'let') return deps(rd, b.value, b.fn, path);
      if (b?.k === 'pat' && b.subject) return deps(rd, b.subject, b.fn, [...b.path, ...path]);
      return none();
    }
    case 'field':
      return deps(rd, e.e, f, [`*.${e.name}`, ...path]);
    case 'call':
      return callDeps(rd, e, f, path);
    case 'ctor':
      return ctorDeps(rd, e, f, path);
    case 'block':
      return deps(rd, e.result, f, path);
    case 'match':
      return union([decisionDeps(rd, e, f), ...e.arms.map(a => deps(rd, a.body, f, path))]);
    default:
      return union(partsOf(e).map(x => deps(rd, x, f, [])));
  }
}

/**
 * Does the part `path` of an expression read the clock or an ask's reply: in its function, in what it calls, or,
 * through a parameter, in what its callers pass?
 */
function volatile(rd: Reader, e: Expr, f: FnDecl, steps = STEPS, path: Path = []): boolean {
  const k = keyOf(path);
  const byPath = rd.memo.get(e) ?? new Map<string, (boolean | undefined)[]>();
  rd.memo.set(e, byPath);
  const known = byPath.get(k) ?? [];
  byPath.set(k, known);
  const had = known[steps];
  if (had !== undefined) return had;
  known[steps] = false; // asked again while it is being answered: what the first asking finds
  const d = deps(rd, e, f, path);
  const is =
    d.clock ||
    (steps > 0 &&
      [...d.params].some(([p, ks]) =>
        (rd.calls.get(f.name) ?? []).some(({ from, node }) => {
          const arg = argFor(node, f, p);
          return !!arg && [...ks].some(pk => volatile(rd, arg, from, steps - 1, pathOf(pk)));
        }),
      ));
  known[steps] = is;
  return is;
}

/** A clock reading on the greater side of a comparison (later, it is only more true) or the lesser side. */
function clockSide(rd: Reader, c: Expr, f: FnDecl): 'grows' | 'shrinks' | null {
  if (c.k !== 'bin' || !['<', '<=', '>', '>='].includes(c.op)) return null;
  const [big, small] = c.op === '>' || c.op === '>=' ? [c.l, c.r] : [c.r, c.l];
  if (isNow(big) && !volatile(rd, small, f)) return 'grows';
  if (isNow(small) && !volatile(rd, big, f)) return 'shrinks';
  return null;
}

/** Would a second run find the condition as this one did, given it was `truth` here? */
function stableAs(rd: Reader, c: Expr, truth: boolean, f: FnDecl): boolean {
  if (c.k === 'bin' && (c.op === 'and' || c.op === 'or'))
    return stableAs(rd, c.l, truth, f) && stableAs(rd, c.r, truth, f);
  const side = clockSide(rd, c, f);
  return side ? side === (truth ? 'grows' : 'shrinks') : !volatile(rd, c, f);
}

/** The first decision of a match, up to its arm i, that a second run may make otherwise. */
function doubtIn(rd: Reader, mt: Match, i: number, f: FnDecl): Doubt | null {
  const subject = mt.subject;
  const looked = mt.arms.slice(0, i + 1).flatMap(a => ('pat' in a ? tested(a.pat, []) : []));
  if (subject && looked.some(p => volatile(rd, subject, f, STEPS, p)))
    return { at: subject.line ?? mt.line, what: 'the value it matches on' };
  const arms: readonly (PatArm | CondArm)[] = mt.arms;
  for (const [j, a] of arms.slice(0, i + 1).entries()) {
    const [test, word] = 'pat' in a ? [a.guard, 'guard'] : [a.cond, 'condition'];
    if (test && !stableAs(rd, test, j === i, f))
      return { at: a.line, what: j === i ? `the ${word} of its arm` : `the ${word} of an arm before it` };
  }
  return null;
}

/**
 * The first decision on the way to a node (in its function, then up its call sites) that a second run may decide
 * otherwise. A caller decides too when it answers with what this function made (the call is what its arm returns);
 * where it passes the value on as data (`retry_at(decided: backoff(…))`), the decision is the callee's.
 */
function unstable(rd: Reader, f: FnDecl, node: Expr, depth = 0, seen: ReadonlySet<string> = new Set()): Doubt | null {
  const path = pathsOf(f).get(node);
  if (!path) return null;
  for (const [mt, i] of path.arms) {
    const doubt = doubtIn(rd, mt, i, f);
    if (doubt) return doubt;
  }
  if (depth >= 4 || seen.has(f.name)) return null;
  const within = new Set([...seen, f.name]);
  for (const { from, node: call } of rd.calls.get(f.name) ?? []) {
    if (!resultsOf(from.body).includes(call)) continue;
    const doubt = unstable(rd, from, call, depth + 1, within);
    if (doubt) return { ...doubt, via: doubt.via ?? from.name };
  }
  return null;
}

/** Every place a constructor declared final is made. */
function madeFinal(prog: Program): { n: Ctor; f: FnDecl }[] {
  const final = new Set([...prog.types.values()].flatMap(d => d.variants.filter(v => v.final).map(v => v.name)));
  if (final.size === 0) return [];
  const made: { n: Ctor; f: FnDecl }[] = [];
  for (const f of prog.fns.values())
    eachExpr(f.body, n => {
      if (n.k === 'ctor' && final.has(n.name)) made.push({ n, f });
    });
  return made;
}

export function finalRules(prog: Program, calls: Calls, queries: readonly Query[], bad: Report): void {
  const rd: Reader = {
    prog,
    calls,
    queries: new Map(queries.map(q => [q.at, q])),
    memo: new Map(),
    deps: new Map(),
    busy: new Set(),
  };
  for (const { n, f } of madeFinal(prog)) {
    const u = unstable(rd, f, n);
    if (!u) continue;
    bad(
      'C80',
      n,
      `${n.name} is declared final (asking again gives it again), but it is made where a second run may decide otherwise: ${u.what} (${u.via ? `${u.via}, ` : ''}line ${u.at}) reads the clock, or the reply of an ask`,
      `Decide it from what a second run reads the same (a count of attempts, a stored row, a call's reply, a deadline passed: \`now() > t\`), or do not declare ${n.name} final.`,
    );
  }
}
