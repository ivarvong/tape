// compiler/shadow.ts: which definition a name means when a program and std both have one.

import {
  type Expr,
  type FnDecl,
  type Pattern,
  type Program,
  type TypeAst,
  type TypeDecl,
  armParts,
  eachExpr,
  eachPattern,
  eachType,
  partsOf,
  patternsIn,
  typesIn,
} from './ast.ts';
import { fail, stemOf } from './common.ts';
import { INTRINSICS, type Type } from './types.ts';

// A program's own definition wins over std's of the same name, in the program's files
// std's code keeps its own: the std one is renamed `std.Name` (types and constructors) or reached by its file's
// stem (functions, `text.after`). The compiler's core types are read by name, so a program cannot reuse them (C01,
// C03). A call from a program's file takes, in order: its file's own, the program's, std's, a pure built-in; a call
// from std takes std's own, then std's, then the program's; std never reaches a program's `next` or `len`.
export const isStd = (file: string): boolean => file.startsWith('std/');
const CORE = new Set([
  'Option',
  'Some',
  'None',
  'Result',
  'Ok',
  'Err',
  'Move',
  'Moved',
  'Raced',
  'NoRow',
  'CallError',
  'Timeout',
  'Unreachable',
  'Rejected',
  'Skew',
  'Wake',
  // the decoders compiler/wire.ts writes name these (std/json.tape)
  'Json_Tree',
  'Json_Fit',
  'Json_Hit',
  'Json_Miss',
  'Rounding',
  'HalfEven',
  'HalfUp',
  'Down',
  'Up',
  'Floor',
  'Ceiling',
]);
export const SHADOWABLE = new Set([
  'len',
  'slice',
  'buf',
  'push',
  'append',
  'freeze',
  'size',
  'next',
  'wrapping_add',
  'wrapping_sub',
  'wrapping_mul',
  'float',
  'write_float',
  'trunc',
  'floor',
  'ceil',
  'sqrt',
  'abs',
  'min',
  'max',
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan2',
  'exp',
  'log',
  'pow',
  'scan_plain',
  'scan',
  'parse_float',
  'rescale',
  'round',
  'mul',
  'div',
  'dec',
  'to_int',
  'to_dec',
]);
type Kind = 'types' | 'ctors';
// the file that defines the type or constructor of this name, if one does
const definedIn = (prog: Program, kind: Kind, name: string): string | undefined =>
  kind === 'types' ? prog.types.get(name)?.file : prog.ctors.get(name)?.decl.file;
// std's definition of `name` is known as `q` from now on, and leaves the name to the program
function moveAside(prog: Program, kind: Kind, name: string, q: string): void {
  const type = kind === 'types' ? prog.types.get(name) : undefined,
    ctor = kind === 'ctors' ? prog.ctors.get(name) : undefined,
    variant = ctor?.decl.variants[ctor.vi];
  if (type) {
    prog.types.delete(name);
    prog.types.set(q, type);
    type.name = q;
  }
  if (ctor && variant) {
    prog.ctors.delete(name);
    prog.ctors.set(q, ctor);
    variant.name = q;
  }
}
/**
 * The name to register a type or constructor under, or null when it clashes. Where a program and std both define
 * one, std's becomes `std.Name`: the program's is registered under the plain name, whichever was read first.
 */
export function claim(prog: Program, kind: Kind, name: string, file: string): string | null {
  const before = definedIn(prog, kind, name);
  if (before === undefined) return name;
  if (isStd(before) === isStd(file) || CORE.has(name)) return null;
  const q = `std.${name}`;
  (prog.renamed ??= { types: new Map(), ctors: new Map() })[kind].set(name, q);
  if (!isStd(before)) return q;
  moveAside(prog, kind, name, q);
  return name;
}
export const clashHint = (what: string, name: string, file: string | undefined): string =>
  CORE.has(name)
    ? `${name} is std's, and the compiler reads it by name: choose another name.`
    : isStd(file ?? '')
      ? `std defines it for its own use, and so may a program only in a file of its own: choose another name for this ${what}.`
      : `${file} defines this ${what} too; ${what === 'type' ? 'type' : 'constructor'} names are unique across a program's files.`;
/**
 * The refined type a pattern `Name(…)` in `file` checks, or undefined when it is a constructor. In std's code a
 * program's refined type does not take the name from std's own constructor: std/http.tape's match on Content keeps
 * its Text beside a program's `type Text = View where …` (examples/tools/notes.tape).
 */
export function refinedPattern(prog: Program, name: string, file: string): TypeDecl | undefined {
  const t = prog.types.get(name);
  if (!t?.refine) return undefined;
  return isStd(file) && !isStd(t.file) && prog.ctors.has(name) ? undefined : t;
}
/** The std name a program's definition may have moved: the compiler's own uses of std's Step, Next and End. */
export const stdName = (prog: Program, kind: Kind, name: string): string => prog.renamed?.[kind].get(name) ?? name;
/** C76: a mismatch between the program's own type and the std one it shadows (`std.Step`): the hint names the clash. */
export function shadowedHint(a: Type, b: Type): string | null {
  const names = (t: Type): string[] => [t.name, ...t.args.flatMap(names)];
  const q = [...names(a), ...names(b)].find(n => n.startsWith('std.'));
  return q
    ? `${q} is std's ${q.slice(4)}, which this program's own ${q.slice(4)} shadows in the program's files: rename the program's ${q.slice(4)} to use std's here.`
    : null;
}

// std's own code goes on meaning std's definitions: each name in it that was moved aside is followed
function followRenames(prog: Program, renamed: NonNullable<Program['renamed']>): void {
  const ctor = (n: { name: string }): void => {
    n.name = renamed.ctors.get(n.name) ?? renamed.types.get(n.name) ?? n.name;
  };
  const type = (t: TypeAst): void =>
    eachType(t, x => {
      x.name = renamed.types.get(x.name) ?? x.name;
    });
  const body = (e: Expr): void =>
    eachExpr(e, x => {
      if (x.k === 'ctor') ctor(x);
      typesIn(x).forEach(type);
      for (const p of patternsIn(x))
        eachPattern(p, q => {
          if (q.k === 'ctor') ctor(q);
        });
    });
  for (const d of prog.types.values()) {
    if (!isStd(d.file)) continue;
    d.variants.forEach(v => v.fields.forEach(fl => type(fl.type)));
    if (d.refine) {
      type(d.refine.base);
      body(d.refine.pred);
    }
  }
  for (const f of prog.fns.values()) {
    if (!isStd(f.file)) continue;
    f.params.forEach(pm => type(pm.typeAst));
    type(f.retAst);
    body(f.body);
  }
}
/**
 * After every file is parsed: std's references follow its renamed definitions, and each call whose bare name means
 * more than one function (or a program's function and a built-in) is pointed at the one its file takes.
 */
export function shadow(prog: Program): void {
  if (prog.renamed) followRenames(prog, prog.renamed);
  for (const f of prog.fns.values())
    eachExpr(f.body, e => {
      if (e.k === 'call' && !e.name.includes('.')) e.name = pick(prog, e.name, f.file) ?? e.name;
    });
  privateCalls(prog);
}

// ---- private functions
// The function a name written in `file` means, as compiler/gen/module.ts find takes it once the calls are picked
// above: the file's own, else the only one of the name, else `file.name`; null for none, or two (C45 says which).
function meant(prog: Program, name: string, file: string): FnDecl | null {
  const own = prog.byFile.get(file)?.get(name);
  if (own !== undefined) return prog.fns.get(own) ?? null;
  const all = prog.defs.get(name) ?? [];
  const [only] = all;
  if (only) return all.length === 1 ? (prog.fns.get(only.key) ?? null) : null;
  const dot = name.indexOf('.');
  if (dot > 0)
    for (const [fl, names] of prog.byFile) {
      const known = stemOf(fl) === name.slice(0, dot) ? names.get(name.slice(dot + 1)) : undefined;
      if (known !== undefined) return prog.fns.get(known) ?? null;
    }
  return prog.fns.get(name) ?? null;
}
// what to use instead of std/json.tape's helpers, which read JSON one way for decode and the writers
const JSON_INSTEAD =
  '`decode(json: body, as: Order)` reads JSON into a type, `is_json(text: body)` says whether bytes are JSON, and `json_member(json: body, key: "id")` is the JSON of one member (decode that with `as: View`, `as: Int`, …)';
/** C94: a private function named from another file: its name, written as the program wrote it. */
function refusePrivate(g: FnDecl, written: string, at: { file: string; line: number }): never {
  const bare = written.slice(written.lastIndexOf('.') + 1);
  const yours = `or write a \`${bare}\` of your own in this file: a function a file defines is the one its calls take.`;
  return fail(
    at,
    'C94',
    `${bare} is private to ${g.file}: it may be called only there`,
    g.file === 'std/json.tape'
      ? `${JSON_INSTEAD}; ${yours}`
      : `Use a public function (docs/std.md lists std's), ${yours}`,
  );
}
/**
 * C94: a `private fn` is called, passed as a function value or matched as a function pattern only in its own file.
 * This reads the program as written, before the compiler writes anything of its own: decode's decoders (wire.ts,
 * in a file of their own), write_json, write_rows, the holes of a text and every other call the build makes of std
 * are made after it, so they are not refused. A name a local holds (a parameter, a `let`, a pattern's binding)
 * is that local, not the function.
 */
function privateCalls(prog: Program): void {
  const check = (name: string, file: string, at: { file: string; line: number }): void => {
    const g = meant(prog, name, file);
    if (g?.private && g.file !== file) refusePrivate(g, name, at);
  };
  const bindings = (p: Pattern, file: string, into: Set<string>): void =>
    eachPattern(p, q => {
      if (q.k === 'bind' || q.k === 'as') into.add(q.name);
      if (q.k === 'fn' && !into.has(q.name)) check(q.name, file, q);
    });
  const walk = (e: Expr, file: string, locals: ReadonlySet<string>): void => {
    if ((e.k === 'call' || e.k === 'var') && !locals.has(e.name)) check(e.name, file, e);
    if (e.k === 'block') {
      const scope = new Set(locals);
      for (const l of e.lets) {
        walk(l.value, file, scope);
        if (l.pat) bindings(l.pat, file, scope);
        else scope.add(l.name);
      }
      return walk(e.result, file, scope);
    }
    if (e.k === 'lambda') return walk(e.body, file, new Set([...locals, ...e.params.map(p => p.name)]));
    if (e.k === 'match' && e.subject) {
      walk(e.subject, file, locals);
      for (const a of e.arms) {
        const scope = new Set(locals);
        bindings(a.pat, file, scope);
        for (const part of armParts(a)) walk(part, file, scope);
      }
      return;
    }
    for (const part of partsOf(e)) walk(part, file, locals);
  };
  for (const f of prog.fns.values()) walk(f.body, f.file, new Set(f.params.map(p => p.name)));
  for (const t of prog.types.values()) if (t.refine) walk(t.refine.pred, t.file, new Set(['self']));
}
// The qualified name a call from `file` takes when its bare name is not enough; null to leave the call as written.
function pick(prog: Program, name: string, file: string): string | null {
  const all = prog.defs.get(name) ?? [],
    builtin = INTRINSICS.has(name),
    qualified = (d: { file: string } | undefined): string | null => (d ? `${stemOf(d.file)}.${name}` : null);
  if (!builtin && all.length < 2) return null;
  if (prog.byFile.get(file)?.has(name)) return all.length < 2 && !builtin ? null : qualified({ file });
  const mine = all.filter(d => isStd(d.file) === isStd(file)),
    other = all.filter(d => isStd(d.file) !== isStd(file)),
    tier = mine.length > 0 ? mine : other;
  if (builtin) return !isStd(file) && mine.length === 1 ? qualified(mine[0]) : null;
  return tier.length === 1 ? qualified(tier[0]) : null; // two in the tier: C45 says which
}
