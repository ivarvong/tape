// rules/timers.ts: a row put in a state the program must leave itself has a timer that comes back for it
// (C77-C79, C87).
import type { Call, CondArm, Expr, FnDecl, Machine, Match, PatArm, Pattern } from '../compiler/ast.ts';
import { conjunctsOf, walkSql } from '../sql.ts';
import type { Col, Exists, In, Expr as SqlExpr, Statement, TableRef } from '../sql/ast.ts';
import { analysisOf } from './model.ts';
import { Q, bindsOf, originsIn, parentsOf, resultsOf, showExpr, unsigned, wrapsTo } from './origins.ts';
import type { Origin } from './origins.ts';
import { isMachineCol, tablesNamed } from './statecol.ts';
import { argFor, calleeOf, dec, lc, walk } from './syntax.ts';
import type { Node } from './syntax.ts';
import type { MachineContext } from './machines/paths.ts';
import type { Wrote } from './machines/check.ts';
import type { Analysis, Query } from './types.ts';
import { predicateOn, writeOf } from './writes.ts';

// --- C77: a way out of every state. A machine's state that has a move out (a non-final state) must be left by
// something. The rule finds every write that moves a row out of each state (its exits) and every write that puts
// a row in it (its entries: a move in, or an INSERT that starts there), from checkMachine's reading of the writes,
// and asks who comes back for a row that is left there:
//
//   no way out   no write of the program moves a row out of the state: it is refused at the machine.
//   in doubt     every exit of the state is made after a remote call (in the arm of a match on a call's reply, in a
//                function entered with a call's reply, or after a `let` that called): a run that commits the state
//                at the call and is cut short there (its object reset), or whose call fails, leaves the row in it,
//                and only a later run can move it. An entry made by a timer's run (a function `woken` reaches) has
//                no client to ask again: it sets a timer in the same commit. An entry made only by requests is
//                passed when a request can reach an exit (its client is told the outcome is unknown, and may ask
//                again), or when it comes from a state that itself has a timer.
//   deadline     the state has an exit a timer's run makes under a reading of the clock (`now()` in the arm's
//                guard or in the write's parameters: an expiry): the row is to leave it at a time, so every entry
//                sets a timer in the same commit, or (an entry made only by requests) comes from a state that has
//                one. A timer's run consumes its timer when it ends, so an entry in a timer's run sets its own.
//
// "Sets a timer in the same commit": a `wake` reached in the write's own arm (not in another arm of a match around
// the write, and not after a remote call that the write is before), in a function called from that arm before any
// call, or in every caller's arm that leads to the write. Found in tickets (apps/tickets) by production Jepsen:
// a refund cut short at its call stayed `refunding` (in doubt, entered by the cancel's sweep), and
// a declined hold whose expiry timer had run while it was paying stayed `held` (deadline, entered by the timer's
// own run). "After a remote call" counts a call of a function that may make one, in a let, a match's subject or an
// earlier argument. A timer counts only when its key names the row (C78, below); what the timer's run then does
// with the row is C79's.
export const isRemote = (n: Node | null | undefined): boolean =>
  n?.k === 'call' &&
  (n.name === 'call' || n.name === 'ask' || (n.name.includes('.') && n.args.some(a => a.label === 'within')));
function hasRemote(e: unknown): boolean {
  let f = false;
  walk(e, n => {
    if (isRemote(n)) f = true;
  });
  return f;
}
function hasNow(e: unknown): boolean {
  let f = false;
  walk(e, n => {
    if (n.k === 'call' && n.name === 'now') f = true;
  });
  return f;
}
// every node of a function with the arms around it ([match, arm index]), the guards and conditions of those arms,
// and whether a remote call is evaluated before it in its run (after: a match on a call's value, or a let after one)
/** A pattern an arm matched; or, for a match whose subject reads the clock, that subject. */
type Matched = Pattern | { subject: Expr } | null;
/** Where a node is: the arms around it, their guards and patterns, and whether a remote call comes before it. */
export type Place = { arms: [Match, number][]; guards: (Expr | null)[]; pats: Matched[]; after: boolean };
type Calling = (e: Expr) => boolean;
const PATHS = new WeakMap<FnDecl, Map<Node, Place>>();
const isNode = (e: object): e is Node => 'k' in e && typeof e.k === 'string';
const guardOf = (a: PatArm | CondArm): Expr | null => ('pat' in a ? a.guard : a.cond) ?? null;

/** The arms of a match, each walked in its own place. */
function placeArms(e: Match, st: Place, calling: Calling, go: (e: unknown, st: Place) => void): void {
  go(e.subject, st);
  const after = st.after || (e.subject !== null && calling(e.subject));
  const clock = e.subject !== null && hasNow(e.subject) ? e.subject : null;
  for (const [i, a] of e.arms.entries()) {
    const s2: Place = {
      arms: [...st.arms, [e, i]],
      guards: [...st.guards, guardOf(a), ...(clock ? [clock] : [])],
      pats: [...st.pats, 'pat' in a ? a.pat : null, ...(clock ? [{ subject: clock }] : [])],
      after,
    };
    if ('pat' in a) go(a.pat, s2);
    go(guardOf(a), s2);
    go(a.body, s2);
  }
}
/** Values evaluated in order: what follows one that calls out is after the call. Gives the place after the last. */
function placeInOrder(
  values: readonly Expr[],
  st: Place,
  calling: Calling,
  go: (e: unknown, st: Place) => void,
): Place {
  let s2 = st;
  for (const value of values) {
    go(value, s2);
    if (!s2.after && calling(value)) s2 = { ...s2, after: true };
  }
  return s2;
}
export function pathsOf(fn: FnDecl, calling: Calling = hasRemote): Map<Node, Place> {
  const known = PATHS.get(fn);
  if (known) return known;
  const out = new Map<Node, Place>();
  const go = (e: unknown, st: Place): void => {
    if (typeof e !== 'object' || e === null) return;
    if (Array.isArray(e)) {
      for (const x of e) go(x, st);
      return;
    }
    if (!isNode(e)) {
      for (const [k, v] of Object.entries(e)) if (k !== 'line' && k !== 'file') go(v, st);
      return;
    }
    out.set(e, st);
    if (e.k === 'match') placeArms(e, st, calling, go);
    else if (e.k === 'block')
      go(
        e.result,
        placeInOrder(
          e.lets.map(l => l.value),
          st,
          calling,
          go,
        ),
      );
    // arguments are evaluated in order: what follows an argument that calls out is after the call
    // (a constructor pattern has no arguments, and what is under it is not placed)
    else if (e.k === 'call' || e.k === 'ctor')
      placeInOrder('args' in e ? e.args.map(a => a.value) : [], st, calling, go);
    else for (const [k, v] of Object.entries(e)) if (k !== 'line' && k !== 'file') go(v, st);
  };
  go(fn.body, { arms: [], guards: [], pats: [], after: false });
  PATHS.set(fn, out);
  return out;
}
const compatible = (a: Place, b: Place): boolean =>
  a.arms.every(([m, i]) => b.arms.every(([n, j]) => n !== m || j === i));

type Finding = { code: string; at?: { file?: string; line?: number }; message: string; hint: string };
/** A `wake` and the function it is in. */
type Wake = { node: Call; fn: FnDecl };
/** Why a timer's key does not bring its run back to the row. */
type KeyWrong =
  | { kind: 'names'; key: Expr }
  | { kind: 'derived'; key: Expr }
  | { kind: 'unread'; key: Expr }
  | { kind: 'sign'; key: Expr; enc: number; read: [number, Query] }
  | { kind: 'routed'; key: Expr; enc: number; guard: { line: number }; read: Query };
type Wrong = Wake & { why: KeyWrong };
/** Whether a write's commit sets a timer for its row: one that names it, or only ones that do not, or none. */
type Covered = { ok?: true; wrong?: Wrong };
/** What a body does, with what it calls: the writes that move a row out of each state, the timers set, a call out. */
type Closure = { exits: Map<string, Query[]>; wakes: Wake[]; remote: boolean };
/** An arm a call's reply is matched by, and the function it is in. */
type Outcome = { a: PatArm; fn: FnDecl };
type CtorPat = Extract<Pattern, { k: 'ctor' }>;
/** Where to say a path is left: an arm or a call, and the function it is in. */
type Where = { a: { line: number; file?: string }; fn: FnDecl };
/** A timer set on a path, keyed by something that is not the row. */
type Lost = { w: Wake; why: KeyWrong };
/** How a path is not handled: `at` the branch point where it gives up, `deep` the program's own call into std. */
type Fail = { at?: Where; deep?: Where; wrong?: Lost };
/** A path: handled (null), or how it is not. */
type Path = Fail | null;
/** For each constructor a value may be (`*` for any other value): how the paths that end with it did. */
type Summary = Map<string, Path>;
type SumEnv = Map<string, Summary>;
type Arm = PatArm | CondArm;
const patOf = (a: Arm): Pattern | null => ('pat' in a ? a.pat : null);
const FAIL: Fail = Object.freeze({});
const pick = (a: Path, b: Path): Path => {
  if (!a || !b) return a ?? b;
  if (a.wrong) return a;
  if (b.wrong) return b;
  if (a.at) return a;
  if (b.at) return b;
  return a.deep ? a : b;
};
const one = (k: string, v: Path): Summary => new Map([[k, v]]);
const overall = (sm: Summary): Path => {
  let f: Path = null;
  for (const v of sm.values()) if (v) f = pick(f, v);
  return f;
};
const handled = (sm: Summary): Summary => new Map([...sm.keys()].map(k => [k, null]));
/** What came before (pre), then sm: a path is handled once something on it is; else the failure to keep. */
const seq = (pre: Path, sm: Summary): Summary =>
  pre === null
    ? handled(sm)
    : new Map(
        [...sm].map(([k, v]) => [k, v === null ? null : pick(v.at || v.wrong ? v : pre.wrong || pre.at ? pre : v, v)]),
      );
const either = (a: Path, b: Path): Path => {
  if (a === null) return b;
  return b === null ? a : pick(a, b);
};
const alt = (sms: readonly Summary[]): Summary => {
  const out: Summary = new Map();
  for (const sm of sms) for (const [k, v] of sm) out.set(k, out.has(k) ? either(out.get(k) ?? null, v) : v);
  return out.size > 0 ? out : one('*', FAIL);
};
const mark = (sm: Summary, fld: 'deep' | 'at', val: Where): Summary =>
  new Map([...sm].map(([k, v]) => [k, v && !v[fld] ? (fld === 'deep' ? { ...v, deep: val } : { ...v, at: val }) : v]));
// a path is handled once something on it is (pre null); else FAIL, or the failure to keep
const after = (pre: Path, sm: Summary): Path => {
  const o = overall(sm);
  return pre === null || o === null ? null : pick(o.wrong || o.at ? o : pre, pre);
};
const pathSign = (v: Path): number => {
  if (v === null) return 0;
  return v.wrong ? 2 : 1;
};
const sigOf = (env: SumEnv): string =>
  [...env].map(([k, sm]) => `${k}=${[...sm].map(([c, v]) => `${c}:${pathSign(v)}`).join('+')}`).join(';');
const altE = (sms: readonly Summary[]): Summary =>
  sms.every(x => x.size === 0) ? new Map() : alt(sms.filter(x => x.size > 0));
/** An arm that leaves the row where it was; `wrong`: it sets a timer keyed by something else. */
type Left = Where & { wrong?: Lost };
type Exit = { q: Query; to: string };
type Entry = { q: Query; from: string | null };
/** A state as C77 reads it: its ways out, whether it is left at a time, in doubt, and by a request that comes back. */
type StateKind = { out: Exit[]; deadline: boolean; doubt: boolean; requestExit: boolean };
type Callee = { node: Call; callee: string };
/** The sign a function's parameters carry the timer's key with: +1 for `key`, -1 for `0 - key`. */
type Signs = ReadonlyMap<string, number>;
/**
 * Where a key of one sign goes from woken. reads: `${sigma}:${query}` for each reader's key parameter it reaches;
 * uses: the same for any parameter; guard: the first arm of a guard on the key; lost, unused: an arm it may take
 * that reads it nowhere, or passes it to no query.
 */
type Flow = {
  reads: Set<string>;
  uses: Set<string>;
  found: boolean;
  guard?: CondArm | null;
  lost?: CondArm;
  unused?: CondArm;
};
const FLIP: Readonly<Record<string, string>> = { '<': '>', '>': '<', '<=': '>=', '>=': '<=', '==': '==', '!=': '!=' };
const intOf = (e: Expr | null | undefined): number | null => {
  if (e?.k === 'int') return Number(e.v);
  return e?.k === 'neg' && e.e.k === 'int' ? -Number(e.e.v) : null;
};
/** Does `operand op c` hold for every value in [lo, hi] (true), for none (false), or for some (null). */
function holdsOver(op: string, lo: number, hi: number, c: number): boolean | null {
  const all: Record<string, boolean> = {
    '<': hi < c,
    '<=': hi <= c,
    '>': lo > c,
    '>=': lo >= c,
    '==': lo === c && hi === c,
    '!=': c < lo || c > hi,
  };
  const none: Record<string, boolean> = {
    '<': lo >= c,
    '<=': lo > c,
    '>': hi <= c,
    '>=': hi < c,
    '==': c < lo || c > hi,
    '!=': lo === c && hi === c,
  };
  if (all[op] === true) return true;
  return none[op] === true ? false : null;
}
/** The states a condition lets through; `exact`: no more than these. */
type Admitted = { set: Set<string>; exact: boolean };
type Facts = Pick<Analysis, 'refs'> | null;
const whereOf = (ast: Statement): SqlExpr | null => ('where' in ast ? ast.where : null);
const fromOf = (ast: Statement): TableRef[] => (ast.k === 'select' ? ast.from : []);
const NOWHERE: Place = { arms: [], guards: [], pats: [], after: false };
/** The nodes directly under a node: its fields that are nodes, and the nodes in its fields that are lists. */
const nodesIn = (e: Node): Node[] =>
  Object.entries(e).flatMap(([k, v]: [string, unknown]) => {
    if (k === 'line' || k === 'file' || typeof v !== 'object' || v === null) return [];
    const list: unknown[] = Array.isArray(v) ? v : [v];
    return list.flatMap(x => (typeof x === 'object' && x !== null && isNode(x) ? [x] : []));
  });

export function wayOut(m: Machine, ctx: MachineContext, writes: ReadonlyMap<Query, Wrote>): Finding[] {
  const { prog, calls } = ctx,
    problems: Finding[] = [],
    label = `machine ${m.table}.${m.column}`;
  const fnOf = (name: string): FnDecl | undefined => prog.fns.get(name);
  // the row types read from this machine's table (Hold for holds), and from any table
  const O = originsIn(ctx),
    isTable = (tb: string | null | undefined): boolean => Boolean(tb) && lc(tb) === lc(m.table),
    rowTypes = new Set<string>(),
    anyRowTypes = new Set<string>();
  for (const q of ctx.queries) {
    const r = q.at.args.find(a => a.label === 'row')?.value;
    if (r?.k !== 'ctor') continue;
    anyRowTypes.add(r.name);
    if (isTable(O.tableOf(q))) rowTypes.add(r.name);
  }
  // fn name -> the calls it makes
  const callees = new Map<string, Callee[]>();
  for (const [callee, sites] of calls)
    for (const { from, node } of sites) callees.set(from.name, [...(callees.get(from.name) ?? []), { node, callee }]);
  // which roots reach a function: a timer's (woken) and the rest (handle, exported methods, what nothing calls)
  const reach = (roots: readonly string[]): Set<string> => {
    const seen = new Set(roots),
      todo = [...roots];
    while (todo.length > 0)
      for (const c of callees.get(todo.pop() ?? '') ?? [])
        if (!seen.has(c.callee)) {
          seen.add(c.callee);
          todo.push(c.callee);
        }
    return seen;
  };
  const fnNames = [...prog.fns.keys()];
  const byTimer = reach(fnNames.filter(n => /(^|\.)woken$/.test(n)));
  const byRequest = reach(fnNames.filter(n => !/(^|\.)woken$/.test(n) && (calls.get(n) ?? []).length === 0));
  // a remote call in an expression, or a call of a function that may make one (C77's ordering reads both)
  const calling = (e: unknown, fn0?: FnDecl): boolean => {
    let f = false;
    walk(e, n => {
      if (f || n.k !== 'call') return;
      if (isRemote(n)) f = true;
      else {
        const c = fn0 ? calleeOf(prog, n.name, fn0) : null;
        if (c !== null && mayCall(c)) f = true;
      }
    });
    return f;
  };
  const P = (fn: FnDecl): Map<Node, Place> => pathsOf(fn, e => calling(e, fn));
  const at = (fn: FnDecl, node: Node): Place => P(fn).get(node) ?? NOWHERE;
  // is the node evaluated after a remote call in its run: in its function, or the function is entered after one
  const entering = new Map<string, boolean>();
  const entered = (fn: FnDecl, depth = 0): boolean => {
    const known = entering.get(fn.name);
    if (known !== undefined) return known;
    entering.set(fn.name, false);
    const sites = calls.get(fn.name) ?? [];
    const r =
      depth < 6 &&
      sites.length > 0 &&
      sites.every(({ from, node }) => hasRemote(node.args) || afterCall(from, node, depth + 1));
    entering.set(fn.name, r);
    return r;
  };
  const afterCall = (fn: FnDecl, node: Node, depth = 0): boolean => at(fn, node).after || entered(fn, depth);
  // a deadline: a clock reading in an arm around the write (or its caller's, up the call sites), or in its parameters
  // (a guard on a pattern of another table's row is that row's deadline, not this one's: due's
  // `Hold(…) if expires <= now()` is the hold's, and the waitlist entry it promotes has none)
  const ofRow = (pt: Matched | undefined): boolean => {
    if (!pt) return true;
    // a clock read in a match's subject: a query's, about its own table (the expiry a new hold is inserted with)
    if ('subject' in pt) {
      const hit = O.byNode.get(pt.subject);
      return hit ? isTable(O.tableOf(hit.q)) : true;
    }
    let mine = false,
      other = false;
    walk(pt, x => {
      if (x.k === 'ctor') {
        if (rowTypes.has(x.name)) mine = true;
        else if (anyRowTypes.has(x.name)) other = true;
      }
    });
    return mine || !other;
  };
  const clocked = (fn: FnDecl, node: Node, depth = 0): boolean => {
    const st = at(fn, node);
    return (
      st.guards.some((g, i) => g !== null && hasNow(g) && ofRow(st.pats[i])) ||
      (node.k === 'call' && hasNow(node.args)) ||
      (depth < 3 && (calls.get(fn.name) ?? []).some(({ from, node: n }) => clocked(from, n, depth + 1)))
    );
  };
  // the timers a function may set before any remote call: [{ node, fn }]
  const setting = new Map<string, Wake[]>();
  const wakesOf = (name: string, depth: number): Wake[] => {
    const known = setting.get(name);
    if (known) return known;
    const fn = fnOf(name);
    if (!fn || depth > 5) return [];
    setting.set(name, []);
    const r: Wake[] = [];
    for (const [n, st] of P(fn)) if (!st.after && n.k === 'call' && n.name === 'wake') r.push({ node: n, fn });
    for (const c of callees.get(name) ?? [])
      if (!at(fn, c.node).after && !calling(c.node.args, fn)) r.push(...wakesOf(c.callee, depth + 1));
    setting.set(name, r);
    return r;
  };
  // the timers set in the same commit as a write (C77): in its arm, in what that arm calls first, or in every
  // caller's arm that leads to it. Each is judged by its key (C78): { ok } when one names the row (and the timer's
  // run decodes it), { wrong: { node, fn, why } } when timers are set but none does, {} when none is set.
  const covering = (fn: FnDecl, node: Node, row: Query, depth = 0, seen = new Set<string>()): Covered => {
    if (depth > 5 || seen.has(fn.name)) return {};
    const here = at(fn, node),
      found: Wake[] = [];
    for (const [n, st] of P(fn)) {
      if (n.k !== 'call' || !compatible(st, here) || (st.after && !here.after)) continue;
      if (n.name === 'wake') {
        found.push({ node: n, fn });
        continue;
      }
      const callee = calleeOf(prog, n.name, fn);
      if (callee !== null && n !== node && !calling(n.args, fn)) found.push(...wakesOf(callee, depth + 1));
    }
    let wrong: Wrong | null = null;
    for (const w of found) {
      const why = keyWrong(w, row);
      if (why === null) return { ok: true };
      wrong ??= { ...w, why };
    }
    if (wrong) return { wrong };
    const sites = calls.get(fn.name) ?? [],
      s2 = new Set([...seen, fn.name]);
    if (sites.length === 0) return {};
    const up = sites.map(({ from, node: n }) => covering(from, n, row, depth + 1, s2));
    if (up.every(u => u.ok === true)) return { ok: true };
    // a caller that sets no timer at all is C77's (a missing timer), not a wrong key
    const first = up.find(u => u.wrong)?.wrong;
    return first && up.every(u => u.ok === true || u.wrong !== undefined) ? { wrong: first } : {};
  };
  // a function that may make a remote call (anywhere in it, or in what it calls)
  const callsOut = new Map<string, boolean>();
  const mayCall = (name: string, depth = 0): boolean => {
    const known = callsOut.get(name);
    if (known !== undefined) return known;
    const fn = fnOf(name);
    if (!fn || depth > 8) return false;
    callsOut.set(name, false);
    const r = hasRemote(fn.body) || (callees.get(name) ?? []).some(c => mayCall(c.callee, depth + 1));
    callsOut.set(name, r);
    return r;
  };
  // is a remote call made after the node in its run: in its arm, later in its function (by line), or in what that
  // calls; or after the call that reached its function, in a caller
  const followed = (fn: FnDecl, node: Node, depth = 0): boolean => {
    const here = at(fn, node);
    for (const [n, st] of P(fn)) {
      if (n === node || n.k !== 'call' || !compatible(st, here) || n.line < node.line) continue;
      if (isRemote(n)) return true;
      const callee = calleeOf(prog, n.name, fn);
      if (callee !== null && mayCall(callee)) return true;
    }
    return depth < 3 && (calls.get(fn.name) ?? []).some(({ from, node: n }) => followed(from, n, depth + 1));
  };
  // a timer's run cut short at a call keeps its timer and is run again (RUNTIME-SPEC R-WAKE): it comes back for the
  // row if it reaches it again, which it does not when, on its way to the write, it picks rows of the table by
  // other states (a sweep that picks the 'confirmed' rows does not come back for the one it left 'refunding')
  const ancestors = (fn: FnDecl): Set<string> => {
    const seen = new Set([fn.name]),
      todo = [fn.name];
    while (todo.length > 0)
      for (const { from } of calls.get(todo.pop() ?? '') ?? [])
        if (byTimer.has(from.name) && !seen.has(from.name)) {
          seen.add(from.name);
          todo.push(from.name);
        }
    return seen;
  };
  // the states a read's WHERE lets through: each top-level conjunct on the column (=, !=, <>, IN, NOT IN, NOT …)
  // narrows them, with a value that is a text literal or a parameter given one (C77's reading)
  const textOf = (v: SqlExpr, q: Query): string | null => {
    if (v.k === 'lit') return v.type === 'text' && typeof v.v === 'string' ? v.v : null;
    if (v.k !== 'param') return null;
    const given = q.args[v.n];
    const b = given?.k === 'var' ? bindsOf(q.fn).get(given) : undefined;
    const a = given?.k === 'var' ? (b?.k === 'let' ? b.value : null) : given;
    return a?.k === 'str' ? dec(a.bytes) : null;
  };
  // a WHERE read as a tree (AND, OR, NOT, parentheses): { set, exact }; a condition not on the column lets every
  // state through (inexact), and NOT of an inexact one does too, so the set is never smaller than the truth
  const admittedBy = (where: SqlExpr | null, q: Query, A: Facts, ast: Statement): Set<string> => {
    const all = new Set(m.states),
      any: Admitted = { set: all, exact: false },
      // TRUE: an EXISTS's correlation (it holds of the row)
      TRUE = new Set<SqlExpr>();
    const not = (x: Admitted): Admitted =>
      x.exact ? { set: new Set([...all].filter(st => !x.set.has(st))), exact: true } : any;
    const go = (c: SqlExpr | null): Admitted => {
      if (!c) return any;
      if (c.k === 'bin' && (c.op === 'AND' || c.op === 'OR')) {
        const l = go(c.l),
          r = go(c.r);
        return {
          set: c.op === 'AND' ? new Set([...l.set].filter(x => r.set.has(x))) : new Set([...l.set, ...r.set]),
          exact: l.exact && r.exact,
        };
      }
      if (c.k === 'un' && c.op === 'NOT') return not(go(c.x));
      // a subquery about the same row: `key IN (SELECT key FROM t WHERE …)`, or `EXISTS (SELECT … FROM t
      // AS t2 WHERE t2.key = t.key AND …)`: the row's state is what the subquery's WHERE lets through; any other
      // subquery lets every state through
      if (TRUE.has(c)) return { set: all, exact: true };
      if ((c.k === 'in' && c.sel) || c.k === 'exists') {
        const same = sameRow(c, ast);
        if (typeof same === 'object') TRUE.add(same);
        if (same === false) return any;
        const x = go(c.sel.where);
        return c.not ? not(x) : x;
      }
      let vals: SqlExpr[] | null = null,
        keep = true;
      if (c.k === 'bin' && (c.op === '=' || c.op === '!=' || c.op === '<>')) {
        const v = isMachineCol(c.l, m, A, ast) ? c.r : isMachineCol(c.r, m, A, ast) ? c.l : null;
        if (v) {
          vals = [v];
          keep = c.op === '=';
        }
      } else if (c.k === 'in' && isMachineCol(c.x, m, A, ast)) {
        vals = c.items;
        keep = !c.not;
      }
      if (!vals) return any;
      const texts = new Set(vals.map(v => textOf(v, q)));
      if (texts.has(null)) return any;
      return { set: new Set([...all].filter(x => keep === texts.has(x))), exact: true };
    };
    return go(where).set;
  };
  // is a subquery (IN or EXISTS) about the row the statement picks: it reads one row of this table, by its key, the
  // key of the row outside it
  // (true for an IN about the row; for an EXISTS, the conjunct that ties its row to the one outside)
  const sameRow = (c: In | Exists, ast: Statement): SqlExpr | boolean => {
    const pk = O.pkOf(m.table),
      sel = c.sel;
    if (pk === null || !sel) return false;
    const own = sel.from.filter(f => !f.sub && isTable(f.name));
    const [only] = own;
    if (!only || own.length !== 1 || sel.from.length !== 1) return false;
    const inner = lc(only.alias ?? only.name),
      outer = new Set<string>();
    walkSql(ast, x => {
      if (x.k === 'tref' && isTable(x.name) && x !== only) outer.add(lc(x.alias ?? x.name));
      if ((x.k === 'update' || x.k === 'delete') && isTable(x.table)) outer.add(lc(x.alias ?? x.table));
    });
    const isKey = (e: SqlExpr | null | undefined, names: ReadonlySet<string>, bare: boolean): boolean =>
      e?.k === 'col' && lc(e.name) === lc(pk) && (e.table === null ? bare : names.has(lc(e.table)));
    if (c.k === 'in') {
      const [col] = sel.cols.length === 1 ? sel.cols : [];
      return (
        isKey(c.x, outer, outer.size === 1) && isKey(col && 'expr' in col ? col.expr : null, new Set([inner]), true)
      );
    }
    return (
      (conjunctsOf(sel.where) ?? []).find(
        x =>
          x.k === 'bin' &&
          x.op === '=' &&
          ((isKey(x.l, new Set([inner]), false) && isKey(x.r, outer, false)) ||
            (isKey(x.r, new Set([inner]), false) && isKey(x.l, outer, false))),
      ) ?? false
    );
  };
  const picksOthers = (fn: FnDecl, S: string, write: Query): Query | null => {
    const up = ancestors(fn);
    for (const q of ctx.queries) {
      if (q === write || !up.has(q.fn.name) || !q.ast || q.via === 'sql_exec' || writeOf(q.ast)) continue;
      if (!tablesNamed(q.ast).has(lc(m.table))) continue;
      const a = analysisOf(q.raw, q.ast, ctx.schema),
        A = a.errors.some(e => e.kind === 'name') ? null : a;
      if (!admittedBy(whereOf(q.ast), q, A, q.ast).has(S)) return q;
    }
    return null;
  };
  // C78: the timer's key (originsIn, below)
  let DEC: Map<number, Query[]> | null = null;
  // a reader -> the parameters its WHERE compares the key column with
  const READ = new Map<Query, Set<number>>();
  // the signs with which the timer's runs read this table's rows by key from the timer's key: +1 for `key`, -1 for
  // `0 - key`; with where each is read
  const decodes = (): Map<number, Query[]> => {
    if (DEC) return DEC;
    const made = new Map<number, Query[]>();
    DEC = made;
    const pk = O.pkOf(m.table);
    if (pk === null) return made;
    for (const q of ctx.queries) {
      if (!byTimer.has(q.fn.name) || !q.ast || !isTable(O.tableOf(q))) continue;
      const w = writeOf(q.ast),
        where = w ? ('where' in w ? w.where : null) : whereOf(q.ast),
        names = [
          lc(m.table),
          ...(w?.alias ? [lc(w.alias)] : []),
          ...fromOf(q.ast).flatMap(f => (f.alias && isTable(f.name) ? [lc(f.alias)] : [])),
        ];
      for (const c of conjunctsOf(where) ?? []) {
        const pr = predicateOn(c, names, pk);
        const [val] = pr?.op === '=' ? pr.vals : [];
        if (val?.k !== 'param') continue;
        const D = O.res(q.args[val.n], [], q.fn);
        if (D.has('+wake')) made.set(1, [...(made.get(1) ?? []), q]);
        if (D.has('-wake')) made.set(-1, [...(made.get(-1) ?? []), q]);
        READ.set(q, (READ.get(q) ?? new Set<number>()).add(val.n));
      }
    }
    return made;
  };
  // C78 (4): woken's guards on its key send a key of each sign down some arms; a reader the key reaches is read on
  // one of them, or outside the match. A key of sign e is e * id with id >= 1: a guard `key < c` (`<=`, `>`, `>=`,
  // `==`, `!=`, either way round) holds for all of those, none, or some; an arm is taken when its guard may hold,
  // and the arms after it only when it may not.
  const qAt = new Map(ctx.queries.map(q => [q.at, q]));
  let ROUTES: Map<number, Flow> | null | undefined;
  let FLOWS: Map<number, Flow> | null = null;
  const routes = (): Map<number, Flow> | null => {
    if (ROUTES !== undefined) return ROUTES;
    ROUTES = null;
    decodes();
    const wk = [...byTimer].flatMap(name => fnOf(name) ?? []).find(f => /(^|\.)woken$/.test(f.name));
    if (!wk) return ROUTES;
    // the sign the key has in a guard's operand: +1 for `key`, -1 for `0 - key` / `-key`, else null
    const keySign = (e: Expr): number | null => {
      if (e.k !== 'var' && e.k !== 'bin' && e.k !== 'neg') return null;
      const r = O.res(e, [], wk);
      if (r.has('+wake') && !r.has('-wake')) return 1;
      return r.has('-wake') && !r.has('+wake') ? -1 : null;
    };
    const negated = (x: number | null): number | null => (x === null ? null : -x);
    // forward from an arm: where the key goes, as an argument, into the functions it calls, to a reader's key
    // parameter: the signs (sigma) with which it is read there (the reader reads sigma * key)
    const signIn = (e: Expr | null | undefined, f: FnDecl, T: Signs): number | null => {
      if (!e) return null;
      if (e.k === 'neg') return negated(signIn(e.e, f, T));
      if (e.k === 'bin' && (e.op === '-' || e.op === '+')) {
        const l = e.l.k === 'int' ? Number(e.l.v) : null,
          r = e.r.k === 'int' ? Number(e.r.v) : null;
        if (e.op === '-' && l === 0) return negated(signIn(e.r, f, T));
        if (r === 0) return signIn(e.l, f, T);
        if (e.op === '+' && l === 0) return signIn(e.r, f, T);
        return null;
      }
      if (e.k !== 'var') return null;
      const b = bindsOf(f).get(e);
      if (f === wk) return keySign(e);
      if (b?.k === 'param') return T.get(b.name) ?? null;
      if (b?.k === 'let') return signIn(b.value, f, T);
      return null;
    };
    // true, false or null (some): does the guard hold for every key of sign e. The guard may be in woken or in a
    // function the key is passed to: its operand's sign is the key's there (signIn)
    const holds = (cond: Expr | undefined, e: number, f: FnDecl, T: Signs): boolean | null => {
      if (cond?.k !== 'bin' || FLIP[cond.op] === undefined) return null;
      const left = signIn(cond.l, f, T);
      const straight = left !== null && intOf(cond.r) !== null;
      const ks = straight ? left : signIn(cond.r, f, T);
      const c = intOf(straight ? cond.r : cond.l);
      if (ks === null || c === null) return null;
      // the operand's values: [lo, hi]
      const sg = ks * e;
      return holdsOver(
        straight ? cond.op : (FLIP[cond.op] ?? cond.op),
        sg > 0 ? 1 : -Infinity,
        sg > 0 ? Infinity : -1,
        c,
      );
    };
    const onKey = (c: Expr | undefined, f: FnDecl, T: Signs): boolean =>
      c?.k === 'bin' && FLIP[c.op] !== undefined && (signIn(c.l, f, T) !== null || signIn(c.r, f, T) !== null);
    // the paths a key of sign e takes from woken: through the functions it is passed to (as an argument, with its
    // sign there), down the arms of every guard on it that may hold for it. st.reads: `${sigma}:${query}` for each
    // reader's key parameter it reaches (the reader reads sigma * key); st.lost: an arm a key of sign e may take that
    // reads it nowhere
    const startsWith = (set: ReadonlySet<string>, e: number): boolean => [...set].some(x => x.startsWith(`${e}:`));
    const flow = (body: unknown, f: FnDecl, T: Signs, e: number, st: Flow, seen: Set<string>, d = 0): void => {
      // the arms of a guard on the key: each one a key of sign e may take, until one it must
      const guarded = (arms: readonly CondArm[]): void => {
        st.found = true;
        for (const a of arms) {
          const h = a.else ? true : holds(a.cond, e, f, T);
          if (h === false) continue;
          st.guard ??= a;
          const sub: Flow = { reads: new Set(), uses: new Set(), found: true };
          flow(a.body, f, T, e, sub, seen, d);
          if (!startsWith(sub.reads, e)) st.lost ??= a;
          if (!startsWith(sub.uses, e)) st.unused ??= a;
          if (sub.lost) st.lost ??= sub.lost;
          if (sub.unused) st.unused ??= sub.unused;
          for (const x of sub.reads) st.reads.add(x);
          for (const x of sub.uses) st.uses.add(x);
          if (h === true) break;
        }
      };
      // a call: the key read by a query, and passed on into the function called
      const called = (n: Call): void => {
        const q = qAt.get(n);
        const qi = q ? ctx.queries.indexOf(q) : -1;
        for (const i of (q && READ.get(q)) ?? []) {
          const sg = signIn(q?.args[i], f, T);
          if (sg !== null && sg !== 0) st.reads.add(`${sg}:${qi}`);
        }
        for (const i of Object.keys(q?.args ?? {})) {
          const sg = signIn(q?.args[i], f, T);
          if (sg !== null && sg !== 0) st.uses.add(`${sg}:${qi}:${i}`);
        }
        const c = calleeOf(prog, n.name, f),
          g = c === null ? undefined : fnOf(c);
        if (!g || d > 10) return;
        const T2 = new Map<string, number>();
        for (const p of g.params) {
          const a = argFor(n, g, p.name),
            sg = a ? signIn(a, f, T) : null;
          if (sg !== null && sg !== 0) T2.set(p.name, sg);
        }
        const k = `${c}|${[...T2].join(',')}`;
        if (T2.size > 0 && !seen.has(k)) {
          seen.add(k);
          flow(g.body, g, T2, e, st, seen, d + 1);
        }
      };
      const rec = (n: unknown): void => {
        if (typeof n !== 'object' || n === null) return;
        if (Array.isArray(n)) {
          for (const x of n) rec(x);
          return;
        }
        if (isNode(n) && n.k === 'match' && n.subject === null && n.arms.some(a => onKey(a.cond, f, T))) {
          guarded(n.arms);
          return;
        }
        if (isNode(n) && n.k === 'call') called(n);
        for (const [k, v] of Object.entries(n)) if (k !== 'line' && k !== 'file') rec(v);
      };
      rec(body);
    };
    const flows = new Map<number, Flow>();
    let found = false;
    for (const e of [1, -1]) {
      const st: Flow = { reads: new Set(), uses: new Set(), guard: null, found: false };
      flow(wk.body, wk, new Map(), e, st, new Set());
      if (st.found) found = true;
      flows.set(e, st);
    }
    FLOWS = flows;
    ROUTES = found ? flows : null;
    return ROUTES;
  };
  const keyWrong = (w: Wake, row: Query | null): KeyWrong | null => (row ? keyWrongTo(w, O.rowKey(row)) : null);
  // R: the row's key as atoms (a write's rowKey, or the key field of a row a match picks)
  const keyWrongTo = (w: Wake, R: Origin): KeyWrong | null => {
    const k = w.node.args.find(a => a.label === 'key')?.value;
    if (!k) return null;
    const K = O.res(k, [], w.fn),
      ru = unsigned(R);
    const enc = new Set<number>();
    for (const a of K)
      if (a !== Q && ru.has(a.slice(1)))
        for (const b of R) if (b !== Q && b.slice(1) === a.slice(1)) enc.add(a[0] === b[0] ? 1 : -1);
    const [firstEnc = 1] = enc;
    if (enc.size === 0)
      return [...K].some(a => a.endsWith('~') && ru.has(a.slice(1, -1)))
        ? { kind: 'derived', key: k }
        : { kind: 'names', key: k };
    const read = decodes();
    const [[firstSign = 1, firstReaders = []] = []] = read;
    const [reader] = firstReaders;
    if (read.size === 0 || !reader) return { kind: 'unread', key: k };
    if (![...enc].some(e => read.has(e))) return { kind: 'sign', key: k, enc: firstEnc, read: [firstSign, reader] };
    const rt = routes(),
      mine = new Set(
        (read.get(1) ?? [])
          .concat(read.get(-1) ?? [])
          .filter(q => isTable(O.tableOf(q)))
          .map(q => ctx.queries.indexOf(q)),
      );
    // a key of sign e is read back when every arm it may take reads this table by it with sign e
    const back = (e: number): boolean => {
      const r = rt?.get(e);
      return !!r && !r.lost && [...r.reads].some(x => x.startsWith(`${e}:`) && mine.has(Number(x.split(':')[1])));
    };
    if (!rt || [...enc].some(back)) return null;
    const e = [...enc].find(x => read.has(x)) ?? firstEnc,
      r = rt.get(e);
    return {
      kind: 'routed',
      key: k,
      enc: e,
      guard: r?.lost ?? r?.guard ?? { line: 0 },
      read: (read.get(e) ?? firstReaders)[0] ?? reader,
    };
  };
  const toldWake = new Set<Call>();
  const keyProblem = (e: Entry, how: string, S: string, wr: Wrong): Finding => {
    toldWake.add(wr.node);
    const y = wr.why;
    const shown = showExpr(y.key),
      line = wr.node.line;
    const why =
      y.kind === 'names' || y.kind === 'derived'
        ? `the timer set with it (${wr.fn.name}, line ${line}) is keyed by \`${shown}\`, which ${y.kind === 'derived' ? "is computed from this row's key but is not it" : "is not this row's key"}: the run it starts reads another ${m.table} row, or none, and nothing comes back for this one in "${S}"`
        : y.kind === 'routed'
          ? `the timer set with it (${wr.fn.name}, line ${line}) is keyed by \`${shown}\`, ${y.enc < 0 ? 'a negative number' : 'a positive number'} (ids are), and woken's guard (line ${y.guard.line}) sends such a key where ${m.table} is not read by it (${y.read.fn.name}, line ${y.read.at.line}, reads it on another arm): nothing comes back for this row in "${S}"`
          : y.kind === 'unread'
            ? `the timer set with it (${wr.fn.name}, line ${line}) is keyed by the row, but no timer's run reads ${m.table} by its key from the timer's key (\`Wake(key)\` in woken, to a WHERE on ${O.pkOf(m.table) ?? 'its key'}), so its run does not come back for the row in "${S}"`
            : `the timer set with it (${wr.fn.name}, line ${line}) is keyed by \`${shown}\`, ${y.enc < 0 ? "the row's key negated" : "the row's key"}, but the timer's run reads ${m.table} by ${y.read[0] < 0 ? '`0 - key`' : '`key`'} (${y.read[1].fn.name}, line ${y.read[1].at.line}): it reads another row, or none, and nothing comes back for this one in "${S}"`;
    return {
      code: 'C78',
      at: e.q.at,
      message: `this write ${how}, and ${why}`,
      hint: `Key the timer by the row the write names (\`wake(after: …, key: id)\` with the id in its WHERE, or the id of the row it returns), as woken reads it back.`,
    };
  };
  // exits and entries of each state
  const exits = new Map<string, Exit[]>(),
    entries = new Map<string, Entry[]>();
  const enters = (state: string, e: Entry): void => {
    entries.set(state, [...(entries.get(state) ?? []), e]);
  };
  for (const [q, w] of writes) {
    for (const mv of w.moves) {
      const [from = '', to = ''] = mv.split('\u0000');
      exits.set(from, [...(exits.get(from) ?? []), { q, to }]);
      enters(to, { q, from });
    }
    for (const st of w.starts) enters(st, { q, from: null });
  }
  const nonFinal = [...new Set(m.moves.map(x => x.from))];
  // Does a request come back for a row in S? A way out that a request reaches is one a client's retry can take,
  // unless the only row it is ever given is the one the same request has just put in S: then the request that
  // made the row is the only one that moves it, and a run cut short at its call leaves the row for nobody.
  // Read from where the key of the way out comes from, following only calls made on a request's side: a row
  // read from the table, or an id the request names, is a row come back for; the row an entry write of S
  // returns is not. Anything this cannot read counts as coming back (the rule stays as lenient as it was).
  const onRequests = originsIn({
    ...ctx,
    calls: new Map([...calls].map(([name, sites]) => [name, sites.filter(site => byRequest.has(site.from.name))])),
  });
  const comesBack = (exit: Exit, S: string): boolean => {
    const w = exit.q.ast && writeOf(exit.q.ast),
      pk = O.pkOf(m.table);
    if (w?.kind !== 'update' || pk === null) return true;
    const names = [lc(w.table), lc(w.alias)].filter(Boolean);
    const named = (conjunctsOf(w.where) ?? [])
      .flatMap(c => {
        const pr = predicateOn(c, names, pk);
        const [val] = pr?.op === '=' ? pr.vals : [];
        return val?.k === 'param' ? [val] : [];
      })
      .at(0);
    if (!named) return true;
    const made = new Set((entries.get(S) ?? []).map(e => O.byNode.get(e.q.at)?.i));
    for (const atom of onRequests.res(exit.q.args[named.n], [], exit.q.fn)) {
      if (atom === Q) return true;
      const row = /^[+-](?:row|fld|val):(\d+)/.exec(atom);
      if (row && !made.has(Number(row[1]))) return true;
    }
    return false;
  };
  // what a request or a timer can run: handle, the exported functions, woken, and what they call. A function nothing
  // calls is a root of byRequest (above), but its write is no way out of a state a run takes: an uncalled `unknown`
  // with a move out of "paying" (tickets' give-up, in a mutant that pages instead) made "paying" look left without
  // a call, and C79 stopped reading it
  const live = reach(fnNames.filter(n => n === 'handle' || fnOf(n)?.exported === true || /(^|\.)woken$/.test(n)));
  const kind = new Map<string, StateKind>();
  for (const S of nonFinal) {
    const out = exits.get(S) ?? [];
    const direct = out.filter(e => live.has(e.q.fn.name) && !afterCall(e.q.fn, e.q.at));
    const deadline = direct.some(e => byTimer.has(e.q.fn.name) && clocked(e.q.fn, e.q.at));
    kind.set(S, {
      out,
      deadline,
      doubt: out.length > 0 && direct.length === 0,
      requestExit: out.some(e => byRequest.has(e.q.fn.name) && comesBack(e, S)),
    });
  }
  const timed = (S: string): boolean => {
    const k = kind.get(S);
    return !!k && (k.deadline || k.doubt);
  };
  const coveredStates = new Set<string>();
  for (const S of nonFinal) {
    const k = kind.get(S);
    if (!k) continue;
    // a state no write puts a row in cannot hold one: its missing way out is harmless
    if (k.out.length === 0 && (entries.get(S) ?? []).length > 0) {
      problems.push({
        code: 'C77',
        at: m,
        message: `${label}: no write of this program moves a row out of "${S}" (declared: ${m.moves
          .filter(x => x.from === S)
          .map(x => `"${S}" -> "${x.to}"`)
          .join(', ')}): a row that reaches it stays there`,
        hint: `Write the move (an UPDATE … WHERE ${m.column} = '${S}' that a request or a timer reaches), or remove the moves out of "${S}" if it is final.`,
      });
      continue;
    }
    if (k.out.length === 0 || !timed(S)) continue;
    const seen = new Set<Call>();
    for (const e of entries.get(S) ?? []) {
      if (seen.has(e.q.at)) continue;
      // in doubt only where a call follows the write in its run (a state entered after the last call is not)
      if (!k.deadline && !followed(e.q.fn, e.q.at)) continue;
      const cv = covering(e.q.fn, e.q.at, e.q);
      if (cv.ok) {
        coveredStates.add(S);
        continue;
      }
      const byT = byTimer.has(e.q.fn.name);
      if (!byT && e.from && timed(e.from)) continue;
      if (!byT && !k.deadline && k.requestExit) continue;
      const other = byT && !k.deadline ? picksOthers(e.q.fn, S, e.q) : null;
      if (byT && !k.deadline && !other) continue;
      seen.add(e.q.at);
      const how = e.from ? `moves a row from "${e.from}" to "${S}"` : `inserts a row in "${S}"`;
      if (cv.wrong) {
        problems.push(keyProblem(e, how, S, cv.wrong));
        continue;
      }
      const why = k.deadline
        ? `"${S}" is left at a time, by a timer's run that reads the clock (${k.out.filter(x => byTimer.has(x.q.fn.name)).map(x => `${x.q.fn.name}, line ${x.q.at.line}`)[0]}), and no timer is set with this write${byT ? ": this write is made by a timer's run (reached from woken), whose own timer is spent when it ends" : ''}`
        : `every way out of "${S}" is made after a remote call (${k.out
            .map(x => `${x.q.fn.name}, line ${x.q.at.line}`)
            .slice(0, 2)
            .join(
              '; ',
            )}): a run cut short at that call leaves the row in "${S}", and ${byT ? `this write is made by a timer's run, which when it runs again picks rows by other states (${other?.fn.name}, line ${other?.at.line}) and does not come back for this one` : 'no request reaches a way out'}`;
      problems.push({
        code: 'C77',
        at: e.q.at,
        message: `this write ${how}, and nothing comes back for it: ${why}`,
        hint: `Set a timer in the same commit, before the call: \`wake(after: …, key: …)\` in this arm (for example as an argument of the function it calls next), and let woken move the row on from "${S}".`,
      });
    }
  }
  // C79: a timer's run that finds the row in a timed state moves it out, or sets a timer again. Its own timer is
  // spent when the run ends (a run cut short keeps it), so an outcome that leaves the row where it was, and sets
  // none, leaves it there for ever. Read at two places of a timer's run: the outcomes of a remote call that some
  // outcome moves the row out of S (its other outcomes must too, or set a timer, or call again), and the arms of a
  // match that picks the row by its state S. An outcome is followed into a function that matches on what it is
  // given (fulfillment's `stalled` on the call's error): each of its arms. A definite refusal (Rejected, Skew)
  // is not asked again (the answer would be the same), so it may leave the row for an operator. A timer set
  // again is keyed by the row (C78).
  const qOf = new Map(ctx.queries.map(q => [q.at, q]));
  const closureOf = (body: unknown, fn: FnDecl): Closure => {
    const r: Closure = { exits: new Map(), wakes: [], remote: false },
      seen = new Set<string>();
    const go = (b: unknown, f: FnDecl, d: number): void => {
      walk(b, n => {
        if (n.k !== 'call') return;
        if (n.name === 'wake') r.wakes.push({ node: n, fn: f });
        if (isRemote(n)) r.remote = true;
        const q = qOf.get(n),
          w = q && writes.get(q);
        if (q && w)
          for (const mv of w.moves) {
            const [from = ''] = mv.split('\u0000');
            r.exits.set(from, [...(r.exits.get(from) ?? []), q]);
          }
        const c = calleeOf(prog, n.name, f),
          g = c === null ? undefined : fnOf(c);
        if (c !== null && g && d < 8 && !seen.has(c)) {
          seen.add(c);
          go(g.body, g, d + 1);
        }
      });
    };
    go(body, fn, 0);
    return r;
  };
  // the outcomes of a remote call: the arms of a match on it, on the parameter it is passed as, or on its let
  const continuation = (c: Expr, F: FnDecl): Outcome[] => {
    const up = parentsOf(F).get(c);
    if (!up) return [];
    if (up.p.k === 'match' && up.subject && up.p.subject !== null) return up.p.arms.map(a => ({ a, fn: F }));
    const out: Outcome[] = [];
    if (up.p.k === 'call' && up.label) {
      const passed = up.label;
      const g = fnOf(calleeOf(prog, up.p.name, F) ?? '');
      if (!g) return [];
      walk(g.body, n => {
        if (
          n.k === 'match' &&
          n.subject !== null &&
          n.subject.k === 'var' &&
          n.subject.name === passed &&
          bindsOf(g).get(n.subject)?.k === 'param'
        )
          out.push(...n.arms.map(a => ({ a, fn: g })));
      });
    } else if (up.p.k === 'block' && up.let?.name) {
      walk(up.p, n => {
        if (n.k !== 'match' || n.subject === null || n.subject.k !== 'var') return;
        const b = bindsOf(F).get(n.subject);
        if (b?.k === 'let' && b.value === c) out.push(...n.arms.map(a => ({ a, fn: F })));
      });
    }
    return out;
  };
  // (C79) An outcome is read path by path: it is handled when every path through it moves the row out
  // of S (a write from S), sets a timer (keyed by the row, C78), or makes a call whose own outcomes are handled.
  // Arguments are evaluated before the call, a let before what follows, a match's subject before its arms, and
  // every arm a value may take must handle. A path may also end, by declaration, where asking again does not help:
  // at a final constructor (`Rejected(…) final` in std/core.tape, `GaveUp(…) final` in std/retry.tape), matched or
  // made, when a request can still move the row out of S. And where the row is not in S: the None or NoRow of a
  // read of this table, the Raced of a compare-and-set whose WHERE expects S.
  const FINAL = new Set<string>();
  for (const d of prog.types.values()) for (const v of d.variants) if (v.final) FINAL.add(v.name);
  const finalPat = (pat: unknown): boolean => {
    let f = false;
    walk(pat, x => {
      if (x.k === 'ctor' && FINAL.has(x.name)) f = true;
    });
    return f;
  };
  const topCtor = (pt: Pattern | null | undefined): CtorPat | null => {
    if (pt?.k === 'as') return topCtor(pt.pat);
    return pt?.k === 'ctor' ? pt : null;
  };
  // may a value come from an ask (a remote read: no once key, so its reply is not stored and may differ next time)
  const askMemo = new Map<Expr, boolean>();
  const asked = (e: Expr | null | undefined, f: FnDecl, d = 0): boolean => {
    if (!e || d > 8) return false;
    const known = askMemo.get(e);
    if (known !== undefined) return known;
    askMemo.set(e, false);
    let r = false;
    if (e.k === 'call' && isRemote(e)) r = !e.args.some(x => x.label === 'once');
    else if (e.k === 'var') {
      const b = bindsOf(f).get(e);
      if (b?.k === 'let') r = asked(b.value, b.fn, d + 1);
      else if (b?.k === 'pat') r = b.subject !== null && asked(b.subject, b.fn, d + 1);
      else if (b?.k === 'param')
        r = (calls.get(f.name) ?? []).some(({ from, node }) => asked(argFor(node, f, b.name), from, d + 1));
    } else if (e.k === 'call') {
      const c = calleeOf(prog, e.name, f),
        g = c === null ? undefined : fnOf(c);
      r = g !== undefined && resultsOf(g.body).some(x => asked(x, g, d + 1));
    } else if (e.k === 'block') r = asked(e.result, f, d + 1);
    else if (e.k === 'match') r = e.arms.some(a => asked(a.body, f, d + 1));
    else if (e.k === 'field') r = asked(e.e, f, d + 1);
    askMemo.set(e, r);
    return r;
  };
  const fromStd = (n: { file?: string } | null | undefined): boolean => (n?.file ?? '').startsWith('std/');
  const absent = (a: Arm, sub: Expr | null, f: FnDecl, S: string): boolean => {
    const c = topCtor(patOf(a));
    if (!c || !['None', 'NoRow', 'Raced'].includes(c.name) || !sub) return false;
    if (c.name === 'Raced' && stateOfPat(patOf(a))?.S === S) return false;
    const atoms = [...O.res(sub, [], f)].filter(x => !x.startsWith('+param:'));
    if (atoms.length === 0 || atoms.some(x => !/^\+val:\d+$/.test(x))) return false;
    return atoms.every(x => {
      const q = ctx.queries[Number(x.slice(5))];
      if (!q || !isTable(O.tableOf(q))) return false;
      // NoRow: sql_move read the row back by its key alone and found none. None: no row passed the query's WHERE,
      // which says the row is not in S only when the WHERE lets a row in S through (a read filtered by
      // state gives None for a row in another state)
      if (c.name === 'NoRow') return q.via === 'sql_move';
      if (c.name === 'None') {
        const w = q.ast && writeOf(q.ast);
        if (w?.kind === 'insert' || !q.ast) return false;
        return admittedBy(w ? w.where : whereOf(q.ast), q, null, q.ast).has(S);
      }
      const w = q.ast && writeOf(q.ast);
      const where = w && 'where' in w ? w.where : null;
      if (!q.ast || !where) return false;
      const { ast } = q;
      let names = false;
      walkSql(where, y => {
        if (y.k === 'col' && isMachineCol(y, m, null, ast)) names = true;
      });
      return names && admittedBy(where, q, null, ast).has(S);
    });
  };
  // Each expression is read as a summary: for each constructor its value may be (or * for any other value),
  // whether every path that ends with that value is handled (null) or how one is not (a failure). A function
  // that matches on a parameter reads each arm with what the argument's paths that give that constructor did:
  // `decided(plan: retry_later(…))` matching RetryIn finds the timer set on that path, and GaveUp none.
  const handledIn = (S: string, R: Origin): ((body: Expr, fn: FnDecl) => Path) => {
    const req = kind.get(S)?.requestExit === true,
      memo = new Map<Node, Map<SumEnv, Summary>>(),
      busy = new Set<Node | string>(),
      envs = new Map<string, SumEnv>();
    const NOENV: SumEnv = new Map();
    const preOf = (sub: Summary | null, c: CtorPat | null): Path => {
      if (!sub) return FAIL;
      return c && sub.has(c.name) ? (sub.get(c.name) ?? null) : overall(sub);
    };
    // the paths of a value's part: `r.plan`, or a name a pattern binds (`let Boxed(plan) = box`), read
    // where the part was made: the constructor argument it is, through lets, matches, calls and what each call site
    // passes for a parameter. A part made by something it cannot see into (a query, a remote call) is null: the
    // caller keeps the old reading, the paths of the whole
    const proj = (
      e: Expr | null | undefined,
      path: readonly string[],
      f: FnDecl,
      env: SumEnv,
      d = 0,
    ): Summary | null => {
      if (path.length === 0) return go(e, f, env);
      if (!e || d > 12) return null;
      switch (e.k) {
        case 'ctor': {
          const [h = '', ...rest] = path,
            dot = h.indexOf('.'),
            cn = dot >= 0 ? h.slice(0, dot) : null,
            fld = dot >= 0 ? h.slice(dot + 1) : h;
          if (cn !== null && cn !== '' && cn !== e.name) return new Map();
          const arg = e.args.find(a => a.label === fld);
          if (!arg) return null;
          const r = proj(arg.value, rest, f, env, d + 1);
          if (!r) return null;
          const pre = argsPre(
            e.args.filter(a => a !== arg).map(a => a.value),
            f,
            env,
          );
          return seq(pre, r);
        }
        case 'block': {
          let pre: Path = FAIL;
          for (const l of e.lets) pre = after(pre, go(l.value, f, env));
          const r = proj(e.result, path, f, env, d + 1);
          return r && seq(pre, r);
        }
        case 'match': {
          const sub = e.subject ? go(e.subject, f, env) : null,
            outs: Summary[] = [];
          for (const a of e.arms) {
            const r = proj(a.body, path, f, env, d + 1);
            if (!r) return null;
            outs.push(seq(preOf(sub, topCtor(patOf(a))), r));
          }
          return altE(outs);
        }
        case 'field':
          return proj(e.e, [e.name, ...path], f, env, d + 1);
        case 'var': {
          const b = bindsOf(f).get(e);
          if (b?.k === 'let' && b.fn === f) return proj(b.value, path, f, env, d + 1);
          if (b?.k === 'pat' && b.subject && b.fn === f) return proj(b.subject, [...b.path, ...path], f, env, d + 1);
          // a parameter: what every call site passes for it (read there with no parameters known)
          if (b?.k !== 'param') return null;
          const sites = calls.get(f.name) ?? [],
            outs: Summary[] = [];
          for (const { from, node } of sites) {
            const a = argFor(node, f, b.name),
              r = a ? proj(a, path, from, NOENV, d + 1) : null;
            if (!r) return null;
            outs.push(r);
          }
          return outs.length > 0 ? altE(outs) : null;
        }
        case 'call': {
          const k = isRemote(e) ? null : callInto(e, f, env);
          if (!k) return null;
          const { g, en, pre, sig } = k;
          if (busy.has(sig) || busy.size > 400) return null;
          busy.add(sig);
          const r = proj(g.body, path, g, en, d + 1);
          busy.delete(sig);
          if (!r) return null;
          return seq(pre, fromStd(g) && !fromStd(e) ? mark(r, 'deep', { a: e, fn: f }) : r);
        }
        default:
          return null;
      }
    };
    const callInto = (e: Call, f: FnDecl, env: SumEnv): { g: FnDecl; en: SumEnv; pre: Path; sig: string } | null => {
      const c = calleeOf(prog, e.name, f),
        g = c === null ? undefined : fnOf(c);
      if (!g) return null;
      const pre = argsPre(
          e.args.map(a => a.value),
          f,
          env,
        ),
        genv: SumEnv = new Map();
      for (const p of g.params) {
        const a = argFor(e, g, p.name);
        if (a) genv.set(p.name, go(a, f, env));
      }
      const sig = `${c}|${sigOf(genv)}`,
        en = envs.get(sig) ?? genv;
      envs.set(sig, en);
      return { g, en, pre, sig };
    };
    const go = (e: Node | null | undefined, f: FnDecl, env: SumEnv): Summary => {
      if (!e) return one('*', FAIL);
      const byEnv = memo.get(e) ?? new Map<SumEnv, Summary>();
      memo.set(e, byEnv);
      const known = byEnv.get(env);
      if (known) return known;
      if (busy.has(e)) return one('*', FAIL);
      busy.add(e);
      const r = step(e, f, env);
      busy.delete(e);
      byEnv.set(env, r);
      return r;
    };
    const argsPre = (xs: readonly Node[], f: FnDecl, env: SumEnv): Path => {
      let pre: Path = FAIL;
      for (const x of xs) pre = after(pre, go(x, f, env));
      return pre;
    };
    type Read = { a: Arm; sm: Summary; exempt?: true; own?: boolean };
    const arms = (list: readonly Arm[], sub: { e: Expr; sm: Summary } | null, f: FnDecl, env: SumEnv): Summary => {
      const outs = list.map((a): Read => {
        if ((finalPat(patOf(a)) && req && !asked(e0(sub), f)) || absent(a, e0(sub), f, S))
          return { a, sm: handled(go(a.body, f, env)), exempt: true };
        const pre = preOf(sub?.sm ?? null, topCtor(patOf(a))),
          body = go(a.body, f, env);
        return { a, sm: seq(pre, body), own: overall(body) === null };
      });
      // a branch point: an arm that does not handle the row where another arm of the same match does, itself
      const some = outs.some(o => o.exempt !== true && o.own === true);
      return alt(
        outs.map(o => {
          if (fromStd(o.a) || overall(o.sm) === null) return o.sm;
          let sm = mark(o.sm, 'deep', { a: o.a, fn: f });
          if (some) sm = mark(sm, 'at', { a: o.a, fn: f });
          return sm;
        }),
      );
    };
    const e0 = (sub: { e: Expr } | null): Expr | null => sub?.e ?? null;
    const step = (e: Node, f: FnDecl, env: SumEnv): Summary => {
      switch (e.k) {
        case 'block': {
          let pre: Path = FAIL;
          for (const l of e.lets) pre = after(pre, go(l.value, f, env));
          return seq(pre, go(e.result, f, env));
        }
        case 'match':
          return e.subject
            ? arms(e.arms, { e: e.subject, sm: go(e.subject, f, env) }, f, env)
            : arms(e.arms, null, f, env);
        case 'lambda':
        case 'int':
        case 'float':
        case 'str':
          return one('*', FAIL);
        case 'var': {
          const b = bindsOf(f).get(e);
          if (b?.k === 'param') return env.get(b.name) ?? one('*', FAIL);
          if (b?.k === 'let' && b.fn === f) return go(b.value, f, env);
          const r = b?.k === 'pat' && b.subject && b.fn === f ? proj(b.subject, b.path, f, env) : null;
          return r && r.size > 0 ? r : one('*', FAIL);
        }
        case 'field': {
          const r = proj(e.e, [e.name], f, env);
          return r && r.size > 0 ? r : one('*', argsPre([e.e], f, env));
        }
        case 'bin':
          return e.op === 'and' || e.op === 'or'
            ? one('*', overall(go(e.l, f, env)))
            : one('*', argsPre([e.l, e.r], f, env));
        case 'ctor': {
          const pre = argsPre('args' in e ? e.args.map(a => a.value) : [], f, env);
          return one(e.name, FINAL.has(e.name) && req ? null : pre);
        }
        case 'call':
          return stepCall(e, f, env);
        default:
          return one('*', argsPre(nodesIn(e), f, env));
      }
    };
    const stepCall = (e: Call, f: FnDecl, env: SumEnv): Summary => {
      const pre = argsPre(
        e.args.map(a => a.value),
        f,
        env,
      );
      if (e.name === 'wake') {
        if (pre === null) return one('*', null);
        const w = { node: e, fn: f },
          why = keyWrongTo(w, R);
        return one('*', why ? { wrong: { w, why } } : null);
      }
      const q = qOf.get(e),
        wr = q && writes.get(q);
      if (wr && [...wr.moves].some(mv => mv.split('\u0000')[0] === S)) return one('*', null);
      const k = isRemote(e) ? null : callInto(e, f, env);
      if (!k) return one('*', pre);
      const { g, en, sig } = k;
      if (busy.has(sig) || busy.size > 400) return one('*', pre);
      busy.add(sig);
      const body = go(g.body, g, en);
      busy.delete(sig);
      // a path that fails inside the standard library is told where the program calls into it
      return seq(pre, fromStd(g) && !fromStd(e) ? mark(body, 'deep', { a: e, fn: f }) : body);
    };
    return (body, fn) => overall(go(body, fn, new Map()));
  };
  // null when the arm is handled; else { a, fn } (where to say it: the branch point where it gives up, or the arm),
  // with wrong: a timer keyed by something else
  const handles = (a: Arm, fn: FnDecl, S: string, R: Origin): Left | null => {
    const r = handledIn(S, R)(a.body, fn);
    if (!r) return null;
    if (r.wrong) {
      const d = r.deep ?? { a, fn };
      return { ...d, wrong: r.wrong };
    }
    return r.at ?? { a, fn };
  };
  const stateOfPat = (pt: Pattern | null | undefined): { S: string; type: string } | null => {
    if (!pt) return null;
    if (pt.k === 'as') return stateOfPat(pt.pat);
    if (pt.k !== 'ctor') return null;
    for (const sb of pt.subs) {
      if (rowTypes.has(pt.name) && lc(sb.field) === lc(m.column) && sb.pat.k === 'str')
        return { S: dec(sb.pat.bytes), type: pt.name };
      const inner = stateOfPat(sb.pat);
      if (inner) return inner;
    }
    return null;
  };
  const told = new Set<object>();
  const leaves = (h: Left, S: string, where: string): void => {
    const { a, fn } = h,
      key = h.wrong ? h.wrong.w.node : a;
    if (told.has(key)) return;
    told.add(key);
    if (h.wrong) {
      const { w, why } = h.wrong;
      toldWake.add(w.node);
      problems.push({
        code: 'C78',
        at: { file: a.file ?? fn.file, line: a.line },
        message: `in a timer's run (${fn.name}, reached from woken), this arm leaves the row in "${S}" and sets its timer again (${w.fn.name}, line ${w.node.line}) keyed by \`${showExpr(why.key)}\`, which ${why.kind === 'names' ? "is not the row's key" : why.kind === 'derived' ? "is computed from the row's key but is not it" : why.kind === 'unread' ? `no timer's run reads ${m.table} by` : why.kind === 'routed' ? `woken's guard (line ${why.guard.line}) sends where ${m.table} is not read by it` : 'woken reads with the other sign'}: the run it starts does not come back for this row`,
        hint: `Key the timer by the row: \`wake(after: …, key: id)\` with the row's id.`,
      });
      return;
    }
    problems.push({
      code: 'C79',
      at: { file: a.file ?? fn.file, line: a.line },
      message: `in a timer's run (${fn.name}, reached from woken), this arm leaves the row in "${S}" and sets no timer: ${where}; the timer that started the run is spent when it ends, and nothing comes back for the row`,
      hint: `Move the row out of "${S}" in this arm, or set the timer again (\`wake(after: …, key: …)\` keyed by the row).`,
    });
  };
  const pk = O.pkOf(m.table);
  const timedStates = nonFinal.filter(timed);
  // the calls first, then the matches by state (a path both read is told once, by the first)
  if (timedStates.length > 0)
    for (const pass of [0, 1])
      for (const name of byTimer) {
        const fn = fnOf(name);
        if (!fn) continue;
        walk(fn.body, n => {
          if (pass === 0 && n.k === 'call' && isRemote(n)) {
            const arms = continuation(n, fn);
            if (arms.length < 2) return;
            const cl = arms.map(x => closureOf(x.a.body, x.fn));
            // a call made in an arm that picks the row by its state is made with the row in that state, and only
            // that one (fulfillment's steps: the reply of the reserve call moves the order out of "reserving")
            const inArm = at(fn, n)
              .arms.flatMap(([mt, i]) => {
                const arm = mt.arms[i];
                return stateOfPat(arm ? patOf(arm) : null)?.S ?? [];
              })
              .at(-1);
            for (const S of inArm === undefined ? timedStates : timedStates.filter(x => x === inArm)) {
              // a set update by another column (tickets WHERE hold = ?1) follows another row's machine: not this one's
              const by = arms.findIndex((_x, i) => (cl[i]?.exits.get(S) ?? []).some(q => O.keyed(q)));
              const mover = arms[by];
              if (!mover) continue;
              const R = new Set(cl.flatMap(c => (c.exits.get(S) ?? []).flatMap(q => [...O.rowKey(q)])));
              for (const x of arms) {
                if (finalPat(x.a.pat) && kind.get(S)?.requestExit === true) continue;
                const h = handles(x.a, x.fn, S, R);
                if (h) leaves(h, S, `another outcome of the call (line ${n.line}) moves it out (line ${mover.a.line})`);
              }
            }
          }
          // a read of the row by the timer's key that lets only some states through: its None is the row in another
          // state, so for a timed state it does not let through, the arm that takes None is the row's path
          if (pass === 1 && n.k === 'match' && n.subject !== null) {
            const atoms = [...O.res(n.subject, [], fn)].filter(x => !x.startsWith('+param:'));
            const reads =
              atoms.length > 0 && atoms.every(x => /^\+val:\d+$/.test(x))
                ? atoms.map(x => ctx.queries[Number(x.slice(5))])
                : [];
            for (const q of reads) {
              if (!q?.ast || q.via === 'sql_move' || writeOf(q.ast) || !isTable(O.tableOf(q)) || pk === null) continue;
              const names = [
                lc(m.table),
                ...fromOf(q.ast).flatMap(f => (f.alias && isTable(f.name) ? [lc(f.alias)] : [])),
              ];
              const kp = (conjunctsOf(whereOf(q.ast)) ?? [])
                .flatMap(c => {
                  const pr = predicateOn(c, names, pk);
                  const [val] = pr?.op === '=' ? pr.vals : [];
                  return val?.k === 'param' ? [val] : [];
                })
                .at(0);
              if (!kp) continue;
              const K = O.res(q.args[kp.n], [], q.fn);
              if (!K.has('+wake') && !K.has('-wake')) continue;
              const A = admittedBy(whereOf(q.ast), q, null, q.ast),
                R = new Set([...K].filter(x => x !== Q));
              let some = false;
              for (const a of n.arms) {
                const c = topCtor(a.pat),
                  any = a.pat.k === 'any' || a.pat.k === 'bind';
                if (c?.name === 'Some') some = true;
                if (!(c?.name === 'None' || (any && some))) continue;
                for (const S of timedStates.filter(x => !A.has(x))) {
                  const h = handles(a, fn, S, R);
                  if (h)
                    leaves(
                      h,
                      S,
                      `the read it took None from (${q.fn.name}, line ${q.at.line}) lets through only rows in ${[...A].map(x => `"${x}"`).join(', ') || 'no state'}, so a row in "${S}" reads as None here`,
                    );
                }
              }
            }
          }
          if (pass === 1 && n.k === 'match' && n.subject !== null)
            for (const a of n.arms) {
              const st = stateOfPat(a.pat);
              if (!st || !timedStates.includes(st.S)) continue;
              const R =
                pk === null
                  ? new Set<string>()
                  : new Set(
                      [...O.res(n.subject, [...wrapsTo(a.pat, st.type), `${st.type}.${pk}`], fn)].filter(x => x !== Q),
                    );
              const h = handles(a, fn, st.S, R);
              if (h)
                leaves(
                  h,
                  st.S,
                  h.a === a
                    ? `the arm picks the row by its state "${st.S}" and does not move it`
                    : `it is on the path of the arm that picks the row by its state "${st.S}" (${fn.name}, line ${a.line}), and another arm here does handle it`,
                );
            }
        });
      }
  // C78 for every timer set with a write of this table, whatever state the write leaves the row in: a
  // move to a final state may set a timer for work left to do for the row (tickets' cancel: refund every order of
  // the event). A timer keyed from the row's key must be the key itself, and some path a key of that sign takes
  // from woken must use it in a query: as this table's key, or as a column that refers to a row (tiers.event), not
  // as another table's key. A timer keyed by another row's key is that row's, and C77 to C79 read it there.
  const sameCommit = (fn: FnDecl, node: Node, depth = 0, seen = new Set<string>()): Wake[] => {
    if (depth > 5 || seen.has(fn.name)) return [];
    const here = at(fn, node),
      found: Wake[] = [];
    for (const [n, st] of P(fn)) {
      if (n.k !== 'call' || !compatible(st, here) || (st.after && !here.after)) continue;
      if (n.name === 'wake') {
        found.push({ node: n, fn });
        continue;
      }
      const callee = calleeOf(prog, n.name, fn);
      if (callee !== null && n !== node && !calling(n.args, fn)) found.push(...wakesOf(callee, depth + 1));
    }
    if (found.length > 0) return found;
    const s2 = new Set([...seen, fn.name]);
    return (calls.get(fn.name) ?? []).flatMap(({ from, node: n }) => sameCommit(from, n, depth + 1, s2));
  };
  // the column a parameter is compared with, and its table when the statement leaves no doubt which
  const colOfParam = (q: Query, i: string): { table: string; col: string } | null => {
    const hits: Col[] = [];
    walkSql(q.ast, x => {
      if (hits.length > 0 || x.k !== 'bin' || x.op !== '=') return;
      const [c, v] = x.l.k === 'col' ? [x.l, x.r] : [x.r, x.l];
      if (c.k === 'col' && v.k === 'param' && String(v.n) === i) hits.push(c);
    });
    const [found] = hits;
    if (!found) return null;
    const refs: [string, string][] = [];
    walkSql(q.ast, x => {
      if (x.k === 'tref' && x.name !== null) refs.push([lc(x.alias ?? x.name), x.name]);
      if (x.k === 'update' || x.k === 'delete' || x.k === 'insert') refs.push([lc(x.alias ?? x.table), x.table]);
    });
    const colsOf = (tb: string): string[] =>
      (ctx.tables.get(tb) ?? [...ctx.tables].find(([n]) => lc(n) === lc(tb))?.[1])?.cols ?? [];
    const { table } = found;
    const cands =
      table === null || table === ''
        ? refs.filter(([, n]) => colsOf(n).some(c => lc(c) === lc(found.name)))
        : refs.filter(([a, n]) => a === lc(table) || lc(n) === lc(table));
    const tables = [...new Set(cands.map(([, n]) => n))];
    const [only] = tables;
    return only !== undefined && tables.length === 1 ? { table: only, col: found.name } : null;
  };
  // how a key of sign e is used on its paths from woken: 'ok', or { other: query } when every use is another table's key
  const usedAs = (e: number): 'ok' | 'none' | { other: Query } => {
    routes();
    const st = FLOWS?.get(e);
    if (!st) return 'none';
    let ok = false,
      other: Query | null = null;
    for (const u of st.uses) {
      const [sg, qi, i = ''] = u.split(':');
      if (Number(sg) !== e) continue;
      const q = ctx.queries[Number(qi)],
        c = q ? colOfParam(q, i) : null;
      const pkT = c ? O.pkOf(c.table) : null;
      if (q && c && !isTable(c.table) && pkT !== null && lc(pkT) === lc(c.col)) other ??= q;
      else ok = true;
    }
    if (ok && !st.unused) return 'ok';
    return other ? { other } : 'none';
  };
  for (const [q, w] of writes) {
    for (const wk of sameCommit(q.fn, q.at)) {
      if (toldWake.has(wk.node)) continue;
      const k = wk.node.args.find(a => a.label === 'key')?.value;
      if (!k) continue;
      const K = O.res(k, [], wk.fn),
        R = O.rowKey(q),
        ru = unsigned(R),
        enc = new Set(
          [...K].flatMap(a =>
            a !== Q && ru.has(a.slice(1))
              ? [...R].flatMap(b => (b !== Q && b.slice(1) === a.slice(1) ? [a[0] === b[0] ? 1 : -1] : []))
              : [],
          ),
        );
      const derived = enc.size === 0 && [...K].some(a => a.endsWith('~') && ru.has(a.slice(1, -1)));
      if (enc.size === 0 && !derived) continue;
      let why: string | null = null;
      if (derived) why = "is computed from this row's key but is not it: no timer's run reads the row by it";
      else {
        const u = [...enc].map(usedAs);
        if (!u.includes('ok')) {
          const [e = 1] = enc,
            o = u.flatMap(x => (typeof x === 'object' ? [x.other] : [])).at(0);
          why = o
            ? `is ${e < 0 ? "the row's key negated" : "the row's key"}, and woken uses a key of that sign as the key of another table (${o.fn.name}, line ${o.at.line}, reads ${O.tableOf(o)} by it)`
            : `is ${e < 0 ? "the row's key negated" : "the row's key"}, and no path a key of that sign takes from woken uses it in a query`;
        }
      }
      if (why === null) continue;
      toldWake.add(wk.node);
      const mv = [...w.moves][0]?.split('\u0000'),
        how = mv ? `moves a row from "${mv[0]}" to "${mv[1]}"` : `inserts a row in "${[...w.starts][0]}"`;
      problems.push({
        code: 'C78',
        at: q.at,
        message: `this write ${how}, and the timer set with it (${wk.fn.name}, line ${wk.node.line}) is keyed by \`${showExpr(k)}\`, which ${why}: the run it starts does not do what is left to do for this row`,
        hint: 'Key the timer by the row the write names, with the sign woken reads it back with (`key: id`, or `key: 0 - id` where woken reads `0 - key`).',
      });
    }
  }
  // a state whose rows a timer is set for, and that no timer's run moves a row out of
  for (const S of coveredStates) {
    const k = kind.get(S);
    if (k && !k.out.some(x => byTimer.has(x.q.fn.name)))
      problems.push({
        code: 'C79',
        at: m,
        message: `${label}: a timer is set for the rows that reach "${S}", but no timer's run moves a row out of "${S}" (its ways out: ${k.out
          .map(x => `${x.q.fn.name}, line ${x.q.at.line}`)
          .slice(0, 3)
          .join('; ')}): the timer's run finds the row and leaves it`,
        hint: `Let woken reach a move out of "${S}" for the row the timer is keyed by.`,
      });
  }
  return problems;
}
