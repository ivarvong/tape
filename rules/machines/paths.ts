// rules/machines/paths.ts: the values a program's own text gives a state on each path to a query.
//
// Values are traced through call sites: a parameter's value on each path from a root (handle, an exported method,
// woken, or a function nothing calls, whose parameters are unknown) to the query, as a set of environments, found
// by fixpoint over the call graph. The values of one path stay together, so move(from: "a", to: "b") and
// move(from: "c", to: "d") are the moves a->b and c->d, not every pairing. More than 256 environments for one
// function count as unknown.
//
// The program's own matches narrow a value on the path to a call or a query: in the arm `"canceled" -> …` of
// `match state` (or `state == "canceled" -> …` of a condition match) state is "canceled", and in the arms after a
// guardless one of them it is not. A value known only to exclude states is, as the state a WHERE compares the
// column with, each declared state it does not exclude: the column holds only declared states (the triggers). A
// path whose narrowing contradicts its environment (a "canceled" arm reached with state "active") does not happen.
// What it does not check: a state compared by a function the value goes through (`is_done(state)`), a match on a
// record's field (`Sub(state: "canceled")`), or a value that is not a parameter or a name the match binds.
import { eachPattern, partsOf } from '../../compiler/ast.ts';
import type { Call, Expr, FnDecl, Match, Pattern, Program } from '../../compiler/ast.ts';
import type { Expr as SqlExpr, Schema } from '../../sql/ast.ts';
import type { ProgramSchema } from '../../sql/program.ts';
import { queriesOf, sqlModel, tablesOf } from '../model.ts';
import { argFor, dec } from '../syntax.ts';
import type { CallSite, Query, RuleContext } from '../types.ts';

export const ENV_LIMIT = 256;

/** What is known of a text on one path: the text, nothing (null), or only texts it is not. */
export type Known = string | null | { readonly not: readonly string[] };
/** A function's parameters on one path to it. */
export type Env = Readonly<Record<string, Known>>;
/** What the matches around a node say of a name: it is this text, or it is none of these. */
export type Narrowing = { readonly eq: string } | { readonly not: readonly string[] };
export type Narrowings = ReadonlyMap<string, Narrowing>;
/** A function's environments by their text; `too`: there were more than ENV_LIMIT, so its parameters are unknown. */
export type Envs = { list: Map<string, Env>; too: boolean };

/** One reading of a program for the machine rules. `foreign`: read under a machine another version declares. */
export type MachineContext = RuleContext & {
  schema: Schema;
  model: ProgramSchema;
  narrow: WeakMap<Call, Narrowings>;
  envs: Map<string, Envs>;
  foreign?: true;
};
/** A machine as it is checked: the program's own declaration, or the union of every version's (rules/plan.ts). */
export type MachineDecl = {
  readonly table: string;
  readonly column: string;
  readonly start: string | null;
  readonly states: readonly string[];
  readonly moves: readonly { readonly from: string; readonly to: string }[];
  readonly file?: string;
  readonly line?: number;
};

export function machineContext(prog: Program): MachineContext {
  const { queries, calls } = queriesOf(prog);
  const model = sqlModel(prog);
  const narrowing = narrowings(prog);
  return {
    prog,
    queries,
    calls,
    tables: tablesOf(prog),
    schema: model.schema,
    model,
    narrow: narrowing,
    envs: environments(prog, calls, narrowing),
  };
}

/** A path that does not happen: its narrowing and its environment disagree. */
export const IMPOSSIBLE: unique symbol = Symbol('impossible');
export type Impossible = typeof IMPOSSIBLE;

const excluded = (v: Known): readonly string[] => (v !== null && typeof v === 'object' ? v.not : []);

function narrowed(v: Known, n: Narrowing): Known | Impossible {
  if ('eq' in n) {
    if (typeof v === 'string') return v === n.eq ? v : IMPOSSIBLE;
    return excluded(v).includes(n.eq) ? IMPOSSIBLE : n.eq;
  }
  if (typeof v === 'string') return n.not.includes(v) ? IMPOSSIBLE : v;
  return { not: [...new Set([...excluded(v), ...n.not])].toSorted() };
}

const isParam = (fn: FnDecl, name: string): boolean => fn.params.some(p => p.name === name);

/** A Tape expression's text on one path: a string literal, or a parameter bound on this path. */
export function textValue(e: Expr | undefined, fn: FnDecl, env: Env, nar: Narrowings | undefined): Known | Impossible {
  if (e?.k === 'str') return dec(e.bytes);
  if (e?.k !== 'var') return null;
  const base = isParam(fn, e.name) ? (env[e.name] ?? null) : null;
  const n = nar?.get(e.name);
  return n ? narrowed(base, n) : base;
}

/** An environment as it reaches a node: null when the node's narrowing rules it out. */
export function reaching(env: Env, fn: FnDecl, nar: Narrowings | undefined): Env | null {
  if (!nar) return env;
  const out: Record<string, Known> = { ...env };
  for (const [name, n] of nar) {
    if (!isParam(fn, name)) continue;
    const v = narrowed(env[name] ?? null, n);
    if (v === IMPOSSIBLE) return null;
    out[name] = v;
  }
  return out;
}

// ---- what the matches around each call say

const bound = (p: Pattern): Set<string> => {
  const names = new Set<string>();
  eachPattern(p, n => {
    if ((n.k === 'bind' || n.k === 'as') && n.name) names.add(n.name);
  });
  return names;
};
const without = (ctx: Narrowings, names: Iterable<string>): Narrowings => {
  const c = new Map(ctx);
  for (const n of names) c.delete(n);
  return c;
};
function add(ctx: Narrowings, name: string, n: Narrowing): Narrowings {
  const had = ctx.get(name);
  const both: Narrowing = !had || 'eq' in n ? n : 'eq' in had ? had : { not: [...new Set([...had.not, ...n.not])] };
  return new Map(ctx).set(name, both);
}
const literal = (e: Expr): string | null => (e.k === 'str' ? dec(e.bytes) : null);
/** `name == "text"`, either way round. */
function equates(c: Expr): [string, string] | null {
  if (c.k !== 'bin' || c.op !== '==') return null;
  const l = literal(c.l);
  const r = literal(c.r);
  if (c.l.k === 'var' && r !== null) return [c.l.name, r];
  if (c.r.k === 'var' && l !== null) return [c.r.name, l];
  return null;
}

function narrowMatch(e: Match, ctx: Narrowings, out: WeakMap<Call, Narrowings>): void {
  if (e.subject) narrow(e.subject, ctx, out);
  const subject = e.subject?.k === 'var' ? e.subject.name : null;
  const seen = new Map<string, Set<string>>(); // name -> texts excluded by earlier arms
  for (const a of e.arms) {
    const after = [...seen].reduce((c, [name, not]) => add(c, name, { not: [...not] }), ctx);
    const is: [string, string] | null =
      'pat' in a
        ? subject !== null && a.pat.k === 'str'
          ? [subject, dec(a.pat.bytes)]
          : null
        : a.cond
          ? equates(a.cond)
          : null;
    const inArm = 'pat' in a ? without(after, bound(a.pat)) : after;
    const test = 'pat' in a ? a.guard : a.cond;
    if (test) narrow(test, inArm, out);
    narrow(a.body, is ? add(inArm, is[0], { eq: is[1] }) : inArm, out);
    if (is && !('pat' in a && a.guard)) seen.set(is[0], new Set([...(seen.get(is[0]) ?? []), is[1]]));
  }
}

function narrow(e: Expr, ctx: Narrowings, out: WeakMap<Call, Narrowings>): void {
  if (e.k === 'call') out.set(e, ctx);
  if (e.k === 'match') return narrowMatch(e, ctx, out);
  if (e.k === 'lambda')
    return narrow(
      e.body,
      without(
        ctx,
        e.params.map(p => p.name),
      ),
      out,
    );
  if (e.k !== 'block') return partsOf(e).forEach(part => narrow(part, ctx, out));
  let c = ctx;
  for (const l of e.lets) {
    narrow(l.value, c, out);
    c = without(c, l.pat ? bound(l.pat) : [l.name]);
  }
  narrow(e.result, c, out);
}

/** For every call: what the matches around it say about names. */
function narrowings(prog: Program): WeakMap<Call, Narrowings> {
  const out = new WeakMap<Call, Narrowings>();
  for (const f of prog.fns.values()) narrow(f.body, new Map(), out);
  return out;
}

// ---- each function's environments

const unknown = (f: FnDecl): Env => Object.fromEntries(f.params.map(p => [p.name, null]));
const unknownOnly = (f: FnDecl): Map<string, Env> => new Map([['', unknown(f)]]);

/** What a call site gives its callee on one of the caller's paths; null when that path does not reach the call. */
function passed(site: CallSite, callee: FnDecl, from: Env, around: WeakMap<Call, Narrowings>): Env | null {
  const nar = around.get(site.node);
  const env = reaching(from, site.from, nar);
  if (!env) return null;
  const out: Record<string, Known> = {};
  for (const p of callee.params) {
    const v = textValue(argFor(site.node, callee, p.name), site.from, env, nar);
    if (v === IMPOSSIBLE) return null;
    out[p.name] = v;
  }
  return out;
}

/** Adds what f's call sites give it on the paths found so far; true when something was new. */
function grow(
  f: FnDecl,
  all: Map<string, Envs>,
  calls: ReadonlyMap<string, readonly CallSite[]>,
  around: WeakMap<Call, Narrowings>,
): boolean {
  const mine = all.get(f.name);
  if (!mine || mine.too) return false;
  let changed = false;
  for (const site of calls.get(f.name) ?? [])
    for (const from of all.get(site.from.name)?.list.values() ?? []) {
      const env = passed(site, f, from, around);
      const key = JSON.stringify(env);
      if (!env || mine.list.has(key)) continue;
      mine.list.set(key, env);
      changed = true;
      if (mine.list.size <= ENV_LIMIT) continue;
      mine.list = unknownOnly(f);
      mine.too = true;
      return true;
    }
  return changed;
}

function environments(
  prog: Program,
  calls: ReadonlyMap<string, readonly CallSite[]>,
  around: WeakMap<Call, Narrowings>,
): Map<string, Envs> {
  const fns = [...prog.fns.values()];
  const called = (f: FnDecl): boolean => (calls.get(f.name) ?? []).length > 0;
  const all = new Map(
    fns.map((f): [string, Envs] => [f.name, { list: called(f) ? new Map<string, Env>() : unknownOnly(f), too: false }]),
  );
  while (fns.map(f => grow(f, all, calls, around)).includes(true));
  // a function only a cycle calls (nothing outside reaches it) has no environment: its parameters are unknown
  for (const f of fns) {
    const mine = all.get(f.name);
    if (mine && mine.list.size === 0) mine.list = unknownOnly(f);
  }
  return all;
}

// ---- SQL operands

/** A SQL operand's text on one path: a text literal, ?n traced to its argument, or null. */
export function sqlValue(node: SqlExpr, q: Query, env: Env, nar: Narrowings | undefined): Known {
  if (node.k === 'lit') return node.type === 'text' ? String(node.v) : null;
  if (node.k !== 'param') return null;
  const v = textValue(q.args[node.n], q.fn, env, nar);
  return v === IMPOSSIBLE ? null : v;
}

export const showNode = (q: { readonly raw: string }, n: SqlExpr): string =>
  n.k === 'lit'
    ? n.type === 'text'
      ? `'${String(n.v).replaceAll("'", "''")}'`
      : String(n.v)
    : n.k === 'param'
      ? `?${n.n}`
      : q.raw.slice(n.s, n.e);
