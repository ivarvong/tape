// compiler/pipes.ts: `a |> f(b: 1)` is `f(first: a, b: 1)`, and `f(a, b: 1)` is too.
// The piped value fills the callee's first parameter, as declared. Built-ins whose arguments are checked by name
// say which parameter comes first here; every other built-in lists its parameters in INTRINSICS.
//
// The one rule for an argument with no name: a bare name that is one of the callee's parameters passes that
// parameter (`f(at)` is `f(at: at)`); any other argument written first with no name passes the first parameter
// (`every_byte(self, keep: is_lower)` is `every_byte(v: self, keep: is_lower)`). Every argument after the first is
// named or a name of the callee's. A function of one parameter takes its argument bare, as before.
import { type At, type Expr, type FnDecl, type Program, eachExpr } from './ast.ts';
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
  // the functions `name` can mean from `file`. A bare name is the file's own, or every definition. `stem.name` is
  // that file's function: shadow qualifies a program's `scan` to `file.scan` when the name is also a built-in, and
  // the first argument is still the first parameter (`scan(raw, at: 0)` is `scan(v: raw, at: 0)`).
  const fnKeys = (name: string, file: string): readonly string[] => {
    const dot = name.indexOf('.');
    if (dot > 0) {
      let found: string | undefined;
      for (const [fl, names] of prog.byFile) {
        const known = stemOf(fl) === name.slice(0, dot) ? names.get(name.slice(dot + 1)) : undefined;
        if (known) found = known;
      }
      return found === undefined ? [] : [found];
    }
    const own = prog.byFile.get(file)?.get(name);
    return own ? [own] : (prog.defs.get(name) ?? []).map(d => d.key);
  };
  // the name of `name`'s first parameter, or null when it is a function value
  const firstOf = (name: string, f: FnDecl, at: At): string | null => {
    const fixed = PIPE_FIRST[name],
      builtIn = INTRINSICS.get(name);
    if (fixed) return fixed;
    if (builtIn)
      return (
        builtIn[0] ??
        fail(
          at,
          'C49',
          `${name}() takes nothing, so nothing can be piped into it`,
          `Call it on its own line: \`${name}()\`.`,
        )
      );
    const dot = name.indexOf('.');
    if (dot > 0 && f.params.some(pm => pm.name === name.slice(0, dot))) return 'send'; // an interface method: repo.head(…)
    const all = prog.defs.get(name) ?? [],
      keys = fnKeys(name, f.file);
    const firsts = [...new Set(keys.map(k => prog.fns.get(k)?.params[0]?.name))];
    if (keys.length === 0) return null; // a function value (a parameter or a let): its argument is passed bare
    if (firsts.length !== 1)
      return fail(
        at,
        'C45',
        `${name} is defined in ${all.map(d => d.file).join(' and ')}`,
        `Say which one: ${all.map(d => `\`${stemOf(d.file)}.${name}(…)\``).join(' or ')}.`,
      );
    return (
      firsts[0] ??
      fail(
        at,
        'C49',
        `${name} takes nothing, so nothing can be piped into it`,
        `Call it on its own line: \`${name}()\`.`,
      )
    );
  };
  // the names of the parameters a program writes at a call (the capabilities the compiler adds are not yet among
  // them), or null for a built-in checked by name, an interface method, or a function value. `caller` is the
  // enclosing function's parameters, so `repo.head(…)` stays a method when a file `repo` also defines `head`.
  const paramsOf = (name: string, file: string, caller: readonly string[]): readonly string[] | null => {
    if (PIPE_FIRST[name]) return null;
    const builtIn = INTRINSICS.get(name);
    if (builtIn) return builtIn;
    const dot = name.indexOf('.');
    if (dot > 0 && caller.includes(name.slice(0, dot))) return null;
    const lists = fnKeys(name, file).map(
      k =>
        prog.fns
          .get(k)
          ?.params.filter(pm => !pm.implicit)
          .map(pm => pm.name) ?? [],
    );
    const [one] = lists;
    return one !== undefined && lists.every(l => l.join() === one.join()) ? one : null;
  };
  // every function's body, and every refinement's condition (`where every_byte(self, keep: is_lower)`)
  const roots: [string, Expr, readonly string[]][] = [
    ...[...prog.fns.values()].map((f): [string, Expr, readonly string[]] => [
      f.file,
      f.body,
      f.params.map(pm => pm.name),
    ]),
    ...[...prog.types.values()].flatMap((t): [string, Expr, readonly string[]][] =>
      t.refine ? [[t.file, t.refine.pred, []]] : [],
    ),
  ];
  for (const [file, root, caller] of roots)
    eachExpr(root, e => {
      if (e.k !== 'call') return;
      const [first] = e.args;
      if (first && !first.piped && (first.label === null || first.pun)) {
        // written first with no name: the first parameter, unless it is a name of one of the parameters
        const params = paramsOf(e.name, file, caller);
        const [p0] = params ?? [];
        if (
          params &&
          params.length > 1 &&
          p0 !== undefined &&
          (first.label === null || !params.includes(first.label))
        ) {
          first.label = p0;
          delete first.pun;
        }
      }
    });
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
