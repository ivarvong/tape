// compiler/pipes.ts: `a |> f(b: 1)` is `f(first: a, b: 1)`.
// The piped value fills the callee's first parameter, as declared. Built-ins whose arguments are checked by name
// say which parameter comes first here; every other built-in lists its parameters in INTRINSICS.
import { type At, type FnDecl, type Program, eachExpr } from './ast.ts';
import { fail, stemOf } from './common.ts';
import { INTRINSICS } from './types.ts';

const PIPE_FIRST: Readonly<Record<string, string>> = {
  sql_exec: 'db',
  sql_first: 'db',
  sql_all: 'db',
  sql_move: 'db',
  decode: 'json',
  call: 'to',
  ask: 'to',
  now: 'clock',
  random: 'from',
  wake: 'timer',
};
export function resolvePipes(prog: Program): void {
  // the name of `name`'s first parameter, or null when it is a function value
  const firstOf = (name: string, f: FnDecl, at: At): string | null => {
    const fixed = PIPE_FIRST[name],
      builtIn = INTRINSICS.get(name);
    if (fixed) return fixed;
    if (builtIn) return builtIn[0] ?? fail(at, 'C49', `${name}() takes nothing, so nothing can be piped into it`, '');
    const dot = name.indexOf('.');
    if (dot > 0 && f.params.some(pm => pm.name === name.slice(0, dot))) return 'send'; // an interface method: repo.head(…)
    const own = prog.byFile.get(f.file)?.get(name),
      all = prog.defs.get(name) ?? [];
    let keys = own ? [own] : all.map(d => d.key);
    if (keys.length === 0 && dot > 0)
      for (const [fl, names] of prog.byFile) {
        const known = stemOf(fl) === name.slice(0, dot) ? names.get(name.slice(dot + 1)) : undefined;
        if (known) keys = [known];
      }
    const firsts = [...new Set(keys.map(k => prog.fns.get(k)?.params[0]?.name))];
    if (keys.length === 0) return null; // a function value (a parameter or a let): its argument is passed bare
    if (firsts.length !== 1)
      return fail(
        at,
        'C45',
        `${name} is defined in ${all.map(d => d.file).join(' and ')}`,
        `Say which one: ${all.map(d => `\`${stemOf(d.file)}.${name}(…)\``).join(' or ')}.`,
      );
    return firsts[0] ?? fail(at, 'C49', `${name} takes nothing, so nothing can be piped into it`, '');
  };
  for (const f of prog.fns.values())
    eachExpr(f.body, e => {
      const piped = e.k === 'call' ? e.args[0] : undefined;
      if (e.k !== 'call' || !piped?.piped || piped.label !== null) return;
      const first = firstOf(e.name, f, e),
        dup = first === null ? undefined : e.args.slice(1).find(a => a.label === first);
      if (dup)
        fail(
          dup,
          'C12',
          `argument ${first} is given twice`,
          `The value before |> is already ${e.name}'s first parameter, ${first}. Remove \`${first}:\` here, or do not pipe.`,
        );
      if (first === null) piped.pun = true;
      piped.label = first;
    });
}
