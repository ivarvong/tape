// compiler/fuse.ts: `fold(list: range(from: a, to: b), from: z, by: f)` is a counting loop, so the build and the
// reference interpreter both run it as one: `fold_range(from: a, to: b, acc: z, by: f)` (std/list.tape), which
// makes no list. The arguments keep the order they were written in, so
// what they do happens in the same order; and a step is still one entry of a recursive function (LANGUAGE.md
// section 10): a fold over range(from: 0, to: n) takes n + 1 steps, as fold over a list of n items does, with no
// steps or memory spent making the list.
import type { Arg, Expr, Program } from './ast.ts';
import { eachExpr } from './ast.ts';
import { find } from './gen/module.ts';

export function fuseRanges(prog: Program): void {
  // is the call's name std/list.tape's function `base`, from this file?
  const isStd = (name: string, file: string, base: string): boolean => {
    if (name !== base && name !== `list.${base}`) return false;
    const f = find(prog, name, file);
    return f?.file === 'std/list.tape' && f.name.slice(f.name.lastIndexOf('.') + 1) === base;
  };
  const fuse = (file: string) => (e: Expr) => {
    if (e.k !== 'call') return;
    const list = e.args.find(a => a.label === 'list'),
      r = list?.value;
    if (!list || r?.k !== 'call' || !isStd(e.name, file, 'fold') || !isStd(r.name, file, 'range')) return;
    const renamed = (a: Arg): Arg =>
      a.label === 'from' ? { label: 'acc', value: a.value, line: a.line, file: a.file } : a;
    e.name = 'list.fold_range';
    e.args = e.args.flatMap(a => (a === list ? r.args : [renamed(a)]));
  };
  for (const f of prog.fns.values()) eachExpr(f.body, fuse(f.file));
}
