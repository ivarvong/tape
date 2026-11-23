// rules/flow.ts: what reaches what inside a program: a count traced to its write, a value under Moved, the
// functions a request can reach.
import type { Call, Expr as TapeExpr, FnDecl, Program } from '../compiler/ast.ts';
import type { Expr } from '../sql/ast.ts';
import { conjunctsOf } from '../sql.ts';
import type { CallSite, Query } from './types.ts';
import { treeOf } from './model.ts';
import { type Node, dec, lc, walk } from './syntax.ts';

type Calls = ReadonlyMap<string, CallSite[]>;
// what a call site passes for the parameter `name`: by its label, or as a bare name
const passed = (node: Call, name: string): TapeExpr | undefined =>
  node.args.find(a => a.label === name)?.value ??
  node.args.find(a => a.pun && a.value.k === 'var' && a.value.name === name)?.value;
import { casOn, writeOf } from './writes.ts';

// A witness guard: WHERE … ?k = 1 (or ?k > 0) at the top level, where ?k's argument is (traced through parameters)
// the count of a write that is itself guarded by compare-and-set on a column it changes.
export function witnessed(cs: readonly Expr[], q: Query, calls: Calls): boolean {
  for (const c of cs)
    if (
      c.k === 'bin' &&
      c.l.k === 'param' &&
      c.r.k === 'lit' &&
      ((c.op === '=' && c.r.v === 1) || (c.op === '>' && c.r.v === 0)) &&
      countOfGuarded(q.args[String(c.l.n)], q.fn, calls, 0)
    )
      return true;
  return underMoved(q.at, q.fn, calls, 0) || underClaim(q.at, q.fn, calls, 0);
}
// An INSERT … ON CONFLICT DO NOTHING (or INSERT OR IGNORE) whose row a step requires (`let Some(value: t) =
// sql_first(… RETURNING …) else …`, `let 1 = sql_exec(…) else …`) claims an op id: a second run of the request meets
// the first one's row, inserts nothing, and leaves through the else. What runs only after the claim runs once per
// op id (the ledger's debit after its transfer-id insert). The claim is in the write's own function, or every call
// of that function is after one (the webhook's credit helper, called once its delivery id is claimed): a claim in
// one caller says only that this call runs once, not that the function, called from elsewhere too, writes once.
function claims(e: TapeExpr | undefined): boolean {
  if (e?.k !== 'call' || (e.name !== 'sql_first' && e.name !== 'sql_exec')) return false;
  const qq = e.args.find(a => a.label === 'query')?.value;
  if (qq?.k !== 'str') return false;
  const ast = treeOf(dec(qq.bytes)).ast;
  return ast?.k === 'insert' && (ast.upsert?.action === 'nothing' || ast.or === 'IGNORE') && !!ast.cols;
}
function underClaim(node: Node, fn: FnDecl, calls: Calls, depth: number): boolean {
  if (depth > 4) return false;
  if (claimedArms(fn).has(node)) return true;
  const sites = calls.get(fn.name) ?? [];
  return sites.length > 0 && sites.every(({ from, node: n }) => underClaim(n, from, calls, depth + 1));
}
const CLAIMED = new WeakMap<FnDecl, Set<Node>>();
function claimedArms(fn: FnDecl): Set<Node> {
  const known = CLAIMED.get(fn);
  if (known) return known;
  const inside = new Set<Node>();
  CLAIMED.set(fn, inside);
  walk(fn.body, n => {
    if (n.k !== 'match' || !n.subject || !claims(n.subject)) return;
    const rows = n.subject.k === 'call' && n.subject.name === 'sql_exec';
    for (const a of n.arms)
      if ((rows && a.pat.k === 'int' && a.pat.v >= 1n) || (!rows && a.pat.k === 'ctor' && a.pat.name === 'Some'))
        walk(a.body, x => {
          inside.add(x);
        });
  });
  return inside;
}
// A write that runs only in the Moved arm of a match on a sql_move outcome runs once per move of that row: a second
// run (a retry) finds the row moved already, and takes Raced. The node is in such an arm in its function, or every
// call of the function is.
function underMoved(node: Node, fn: FnDecl, calls: Calls, depth: number): boolean {
  if (depth > 4) return false;
  if (movedArms(fn, calls).has(node)) return true;
  const sites = calls.get(fn.name) ?? [];
  return sites.length > 0 && sites.every(({ from, node: n }) => underMoved(n, from, calls, depth + 1));
}
const MOVED = new WeakMap<FnDecl, Set<Node>>();
function movedArms(fn: FnDecl, calls: Calls): Set<Node> {
  const known = MOVED.get(fn);
  if (known) return known;
  const inside = new Set<Node>();
  MOVED.set(fn, inside);
  walk(fn.body, n => {
    if (n.k !== 'match' || !n.subject || !moveSource(n.subject, fn, calls, 0)) return;
    for (const a of n.arms)
      if (a.pat.k === 'ctor' && a.pat.name === 'Moved')
        walk(a.body, x => {
          inside.add(x);
        });
  });
  return inside;
}
// An expression whose value is a sql_move outcome: the call itself, or a parameter every caller passes one for.
function moveSource(e: TapeExpr | undefined, fn: FnDecl, calls: Calls, depth: number): boolean {
  if (!e || depth > 4) return false;
  if (e.k === 'call' && e.name === 'sql_move') return true;
  if (e.k === 'var' && fn.params.some(p => p.name === e.name)) {
    const sites = calls.get(fn.name) ?? [];
    return (
      sites.length > 0 && sites.every(({ from, node }) => moveSource(passed(node, e.name), from, calls, depth + 1))
    );
  }
  return false;
}
function countOfGuarded(e: TapeExpr | undefined, fn: FnDecl, calls: Calls, depth: number): boolean {
  if (!e || depth > 4) return false;
  if (e.k === 'call' && e.name === 'sql_exec') {
    const qq = e.args.find(a => a.label === 'query')?.value;
    if (qq?.k !== 'str') return false;
    const s = writeOf(treeOf(dec(qq.bytes)).ast);
    return (
      s?.kind === 'update' &&
      s.assigns.some(
        a => !!casOn(conjunctsOf(s.where) ?? [], a.col, s.assigns, [lc(s.table), lc(s.alias)].filter(Boolean)),
      )
    );
  }
  if (e.k === 'var' && fn.params.some(p => p.name === e.name)) {
    const sites = calls.get(fn.name) ?? [];
    return (
      sites.length > 0 && sites.every(({ from, node }) => countOfGuarded(passed(node, e.name), from, calls, depth + 1))
    );
  }
  return false;
}

// The functions a request or a timer reaches: from handle and woken, through every call.
export function reachable(prog: Program, calls: Calls): Set<string> {
  const edges = new Map<string, Set<string>>();
  for (const [callee, sites] of calls)
    for (const { from } of sites) {
      const to = edges.get(from.name) ?? new Set<string>();
      to.add(callee);
      edges.set(from.name, to);
    }
  const roots = [...prog.fns.keys()].filter(n => /(^|\.)(handle|woken)$/.test(n)),
    seen = new Set(roots),
    todo = [...roots];
  while (todo.length > 0)
    for (const n of edges.get(todo.pop() ?? '') ?? [])
      if (!seen.has(n)) {
        seen.add(n);
        todo.push(n);
      }
  return seen;
}
