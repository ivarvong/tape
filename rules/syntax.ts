// rules/syntax.ts: what every rule uses to read a program: its text helpers, a walk over its syntax tree, the
// function a call names and the argument a call gives a parameter.

import type { Call, Expr, FnDecl, Pattern, Program } from '../compiler/ast.ts';

export const dec = (b: ArrayLike<number>): string => new TextDecoder().decode(new Uint8Array(b));
export const lc = (s: string | null | undefined): string => (s ?? '').toLowerCase();
export function stripComments(s: string): string {
  return s.replaceAll(/\/\*[\s\S]*?\*\//g, ' ').replaceAll(/--[^\n]*/g, ' ');
}
/** Anything in a function's body with a kind: an expression or a pattern. */
export type Node = Expr | Pattern;
/**
 * f on every node under n, outermost first, in the order written. It walks what it is given without knowing its
 * shape, so it also reaches the patterns of a match; a pass that reads only expressions uses eachExpr (ast.ts).
 */
const isNode = (n: object): n is Node => 'k' in n && typeof n.k === 'string';
export function walk(n: unknown, f: (n: Node) => void): void {
  if (typeof n !== 'object' || n === null) return;
  if (Array.isArray(n)) {
    for (const x of n) walk(x, f);
    return;
  }
  if (isNode(n)) f(n);
  for (const [k, v] of Object.entries(n))
    if (k !== 'line' && k !== 'file' && typeof v === 'object' && v !== null) walk(v, f);
}
// The function a call names, as the compiler finds it (compiler.ts `find`): the caller's file's own, else the only
// one of that name, else `file.name`. A program's function that std also names is kept as `file.name`, so reading
// the call by its bare name would take std's, and leave the program's own unchecked.
export function calleeOf(prog: Program, name: string, from: { file: string }): string | null {
  const own = prog.byFile?.get(from.file)?.get(name);
  if (own) return own;
  const all = prog.defs?.get(name);
  if (all?.length === 1 && all[0]) return all[0].key;
  const dot = name.indexOf('.');
  if (dot > 0)
    for (const [fl, names] of prog.byFile ?? []) {
      const known =
        fl.replace(/^.*\//, '').replace(/\.tape$/, '') === name.slice(0, dot) && names.get(name.slice(dot + 1));
      if (typeof known === 'string') return known;
    }
  return prog.fns.has(name) ? name : null;
}
// The argument a call site passes for a parameter: by label, or bare to a one-parameter function.
export function argFor(node: Call, fn: FnDecl, name: string): Expr | undefined {
  if (fn.params.length === 1 && node.args.length === 1) return node.args[0]?.value;
  return node.args.find(a => a.label === name)?.value;
}
