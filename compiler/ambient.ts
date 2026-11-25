// compiler/ambient.ts: capabilities used by name, added as parameters.
//
// A function may use a capability (Sql, a Remote, Timer, Clock, Entropy, Secrets, Http, an interface) by the name an entry point
// declares it under, without listing it as a parameter. The compiler adds it: each function gets, as parameters,
// the capabilities its body reads and those of every function it calls; each call passes them on by name. Entry
// points (`handle` and exported functions) are where the host grants capabilities, so they must still declare every
// one they use, directly or through their callees: a missing one is C72, naming the call path. A capability is
// therefore still a value with a static type, and every use of one is still reachable from a declared grant.
import {
  type Arg,
  type Call,
  type Expr,
  type FnDecl,
  type Pattern,
  type Program,
  type TypeAst,
  armParts,
  eachExpr,
  eachPattern,
  partsOf,
} from './ast.ts';
import { type Problem, fail, stemOf } from './common.ts';
import { CAPABILITIES, INTRINSICS, key } from './types.ts';

/** The capabilities a program names: name -> type. A name declared with two types is not ambient. */
type Named = Map<string, TypeAst>;
type Site = { node: Call; key: string };
type Scan = { free: Set<string>; calls: Site[] };
const shortName = (f: FnDecl): string => f.name.slice(f.name.lastIndexOf('.') + 1);
const passes = (node: Call, name: string): boolean => node.args.some(a => a.label === name);
// `name: name`, written where the call is
const byName = (name: string, at: Call, extra: Partial<Arg> = {}): Arg => ({
  label: name,
  value: { k: 'var', name, line: at.line, file: at.file },
  line: at.line,
  file: at.file,
  ...extra,
});

function named(prog: Program): Named {
  const isCap = (t: TypeAst): boolean => CAPABILITIES.includes(t.name) || prog.interfaces.has(t.name),
    types = new Map<string, TypeAst | null>();
  for (const f of prog.fns.values())
    for (const pm of f.params) {
      if (!isCap(pm.typeAst)) continue;
      const had = types.get(pm.name);
      if (had === undefined) types.set(pm.name, pm.typeAst);
      else if (had && key(had) !== key(pm.typeAst)) types.set(pm.name, null);
    }
  return new Map([...types].flatMap(([n, t]): [string, TypeAst][] => (t ? [[n, t]] : [])));
}

// A built-in that takes a capability (sql_*'s db, now's clock, random's from, wake's timer, secret's from) is given the one
// capability of that type, when the program names exactly one.
const BUILTIN_CAP: ReadonlyMap<string, readonly [label: string, type: string]> = new Map([
  ['sql_exec', ['db', 'Sql']],
  ['sql_first', ['db', 'Sql']],
  ['sql_all', ['db', 'Sql']],
  ['sql_move', ['db', 'Sql']],
  ['now', ['clock', 'Clock']],
  ['random', ['from', 'Entropy']],
  ['wake', ['timer', 'Timer']],
  ['secret', ['from', 'Secrets']],
]);
function fillBuiltIns(prog: Program, types: Named): void {
  const only = (type: string): string | null => {
    const names = [...types].filter(([, t]) => t.name === type).map(([n]) => n);
    return names.length === 1 ? (names[0] ?? null) : null;
  };
  for (const f of prog.fns.values()) {
    if (f.file.startsWith('std/')) continue;
    eachExpr(f.body, e => {
      const takes = e.k === 'call' ? BUILTIN_CAP.get(e.name) : undefined;
      if (e.k !== 'call' || !takes || passes(e, takes[0])) return;
      const name = only(takes[1]);
      if (name) e.args.unshift({ ...byName(name, e), label: takes[0] });
    });
  }
}

// the function a call from f means, by the name it is known by. A built-in's name left bare by shadow.ts is the
// built-in: a program's own `next` is called `file.next` from its files, and std's fold_rows never reaches it (it
// was taken for the program's, so std's fold_rows was given the capabilities of a program's `next`).
function target(prog: Program, f: FnDecl, name: string): string | null {
  if (INTRINSICS.has(name)) return null;
  const own = prog.byFile.get(f.file)?.get(name),
    all = prog.defs.get(name) ?? [],
    dot = name.indexOf('.');
  if (own) return own;
  if (all.length > 0) return all.length === 1 ? (all[0]?.key ?? null) : null;
  if (dot <= 0) return null;
  for (const [file, names] of prog.byFile) {
    const known = stemOf(file) === name.slice(0, dot) ? names.get(name.slice(dot + 1)) : undefined;
    if (known) return known;
  }
  return null;
}
const binders = (p: Pattern, into: Set<string>): Set<string> => {
  eachPattern(p, q => {
    if (q.k === 'bind' || q.k === 'as') into.add(q.name);
  });
  return into;
};
// the capability names a body reads free, and the calls it makes
function scan(prog: Program, types: Named, f: FnDecl): Scan {
  const out: Scan = { free: new Set(), calls: [] };
  const call = (e: Call, bound: Set<string>): void => {
    const dot = e.name.indexOf('.'),
      head = dot > 0 ? e.name.slice(0, dot) : null;
    // an interface method: repo.head(…). A capability that is not an interface has no methods: `http.until(…)` in
    // std/http.tape is its own until (shadow.ts names it by its file), not a use of a program's `http: Http`
    if (head && (bound.has(head) || prog.interfaces.has(types.get(head)?.name ?? ''))) {
      if (!bound.has(head)) out.free.add(head);
    } else if (!bound.has(e.name)) {
      const k = target(prog, f, e.name);
      if (k) out.calls.push({ node: e, key: k });
    }
    for (const a of e.args) go(a.value, bound);
  };
  const go = (e: Expr, bound: Set<string>): void => {
    switch (e.k) {
      case 'var':
        if (!bound.has(e.name) && types.has(e.name)) out.free.add(e.name);
        return;
      case 'call':
        return call(e, bound);
      case 'block': {
        let b = new Set(bound);
        for (const l of e.lets) {
          go(l.value, b);
          b = l.pat ? binders(l.pat, new Set(b)) : new Set(b).add(l.name);
        }
        return go(e.result, b);
      }
      case 'match':
        if (e.subject) go(e.subject, bound);
        for (const a of e.arms) {
          const b = 'pat' in a ? binders(a.pat, new Set(bound)) : bound;
          for (const part of armParts(a)) go(part, b);
        }
        return;
      case 'lambda':
        return go(e.body, new Set([...bound, ...e.params.map(pm => pm.name)]));
      default:
        for (const part of partsOf(e)) go(part, bound);
    }
  };
  go(f.body, new Set(f.params.map(pm => pm.name)));
  return out;
}

/** For each function, each capability it needs and the call path that needs it. */
type Needs = Map<string, Map<string, string[]>>;
function needs(prog: Program, info: ReadonlyMap<string, Scan>): Needs {
  const need: Needs = new Map(
    [...prog.fns].map(([k, f]) => [k, new Map([...(info.get(k)?.free ?? [])].map(n => [n, [shortName(f)]]))]),
  );
  // a function needs what the functions it calls need, unless the call passes it or the function declares it
  for (let changed = true; changed;) {
    changed = false;
    for (const [k, f] of prog.fns) {
      const mine = need.get(k) ?? new Map<string, string[]>();
      for (const c of info.get(k)?.calls ?? [])
        for (const [n, path] of need.get(c.key) ?? []) {
          if (passes(c.node, n) || mine.has(n) || f.params.some(pm => pm.name === n)) continue;
          mine.set(n, [shortName(f), ...path]);
          changed = true;
        }
    }
  }
  return need;
}
// each function takes what it needs as parameters; an entry point must have declared it
function addParameters(prog: Program, types: Named, need: Needs): void {
  for (const [k, f] of prog.fns) {
    const missing = [...(need.get(k) ?? [])].filter(([n]) => !f.params.some(pm => pm.name === n)),
      [first] = missing;
    if (first && (f.name === 'handle' || f.exported))
      fail(
        f,
        'C72',
        `${f.name} uses the capability ${first[0]} (${first[1].join(' → ')}) but does not declare it`,
        `An entry point is where the host grants capabilities: add \`${first[0]}: ${types.get(first[0])?.name}\` to ${f.name}'s parameters.`,
      );
    for (const [n] of missing) {
      const typeAst = types.get(n);
      if (typeAst) f.params.push({ name: n, typeAst, implicit: true });
    }
    f.reached = new Map(missing.filter(([n]) => types.has(n)));
  }
}

/** The clause a function's signature must carry: the capabilities it takes by name, in alphabetical order; empty for
 * one that takes none, and for an entry point, which declares each as a parameter. */
export const clauseOf = (f: FnDecl): string[] =>
  f.name === 'handle' || f.exported ? [] : [...(f.reached?.keys() ?? [])].toSorted();
const written = (names: readonly string[]): string => `\`uses ${names.join(', ')}\``;

/**
 * C101: a function's signature says which capabilities it reaches. Every function but an entry point that uses a
 * capability by name, itself or through a function it calls, writes `uses` and those names after its result type,
 * in alphabetical order; one that reaches none writes no clause, and an entry point never does (the host grants
 * capabilities there, as parameters). The clause is checked, not compiled: it changes no byte of the module. Run by
 * the build after ambient (a fragment read by a tool has no program to infer from); `tape fmt` writes the clause.
 */
export function clauses(prog: Program): Problem[] {
  const found: Problem[] = [];
  for (const f of prog.fns.values()) {
    const name = shortName(f),
      want = clauseOf(f),
      has = f.uses ?? [],
      at = { file: f.file, line: f.line, code: 'C101' };
    if (f.name === 'handle' || f.exported) {
      if (f.uses)
        found.push({
          ...at,
          message: `${name} is an entry point, and writes ${written(has)}: an entry point declares its capabilities as parameters`,
          hint: `Remove ${written(has)}. The host grants capabilities where a request enters, so each one ${name} uses is a parameter (\`db: Sql\`); every other function says what it reaches with \`uses\`.`,
        });
      continue;
    }
    if (has.join(',') === want.join(',')) continue;
    const fix =
      want.length === 0
        ? `Remove ${written(has)}: \`fn ${name}(…) -> ${key(f.retAst)} {\`.`
        : `Write ${written(want)} after ${name}'s result type: \`fn ${name}(…) -> ${key(f.retAst)} uses ${want.join(', ')} {\`. \`tape fmt\` writes it.`;
    const other = has.find(n => !want.includes(n)),
      first = want.find(n => !has.includes(n)),
      param = has.find(n => !want.includes(n) && f.params.some(pm => pm.name === n && !pm.implicit));
    const message = first
      ? `${name} uses the capability ${first} (${(f.reached?.get(first) ?? [name]).join(' → ')}), and its signature does not say so`
      : param
        ? `${name} names ${param} in its \`uses\`, and ${param} is its parameter: its signature says so already`
        : other
          ? `${name} names ${other} in its \`uses\`, and does not reach it by name`
          : `${name} writes ${written(has)}: a clause names each capability once, in alphabetical order`;
    found.push({ ...at, message, hint: fix });
  }
  return found;
}
// A built-in that takes a capability when the program has none of that type: no entry point was granted one, so
// no function can have it. Refused at the call, with the parameter to add (written bare, `now(clock)` was then
// "unknown name clock", whose fix, `let clock = …`, cannot make a Clock). Run by the build after ambient, not by
// parseProgram, which tools use on fragments.
export function granted(prog: Program): void {
  const types = named(prog);
  for (const f of prog.fns.values()) {
    if (f.file.startsWith('std/')) continue;
    eachExpr(f.body, e => {
      const takes = e.k === 'call' ? BUILTIN_CAP.get(e.name) : undefined;
      if (e.k !== 'call' || !takes) return;
      const [label, type] = takes;
      if ([...types.values()].some(t => t.name === type)) return;
      // the capability left out, or passed as a bare name (`now(clock)`, `db: db`) that nothing declares
      const given =
        e.args.find(a => a.label === label) ?? (e.name === 'now' || e.name === 'random' ? e.args[0] : undefined);
      if (given && !(given.value.k === 'var' && !types.has(given.value.name) && given.value.name === label)) return;
      const entry = [...prog.fns.values()].find(g => g.name === 'handle' || g.exported)?.name ?? 'handle';
      fail(
        e,
        'C72',
        `${e.name} needs ${/^[AEIOU]/.test(type) ? 'an' : 'a'} ${type}, and no entry point declares one`,
        `The host grants capabilities to an entry point: add \`${label}: ${type}\` to ${entry}'s parameters, and ${e.name} and every function ${entry} calls use it by name.`,
      );
    });
  }
}

export function ambient(prog: Program): void {
  const types = named(prog);
  if (types.size === 0) return;
  fillBuiltIns(prog, types);
  const info = new Map([...prog.fns].map(([k, f]) => [k, scan(prog, types, f)]));
  addParameters(prog, types, needs(prog, info));
  // each call passes on, by name, what the function it calls was given
  for (const { calls } of info.values())
    for (const c of calls)
      for (const pm of prog.fns.get(c.key)?.params ?? [])
        if (pm.implicit && !passes(c.node, pm.name)) c.node.args.push(byName(pm.name, c.node));
}
