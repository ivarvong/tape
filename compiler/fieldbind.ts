// compiler/fieldbind.ts: a field matched by a pattern binds its own name, when nothing else does.
// `Some(value: Account(balance: b)) -> … value …` reads `value` as the field the pattern matched: the pass writes
// the field's pattern as `value = Account(balance: b)`. It does so for a field only when its arm (or the rest of
// the block, for a `let`) reads the name, no function has it, and nothing else binds it where the field's binding
// would be in scope: not a parameter, a `let` or a pattern around it or inside its arm, nor another field of that
// name. Otherwise the name is left as written,
// and a read of it is C16, whose fix says `value: name = Pattern`. A name the program binds itself always wins, so
// a program that compiled before means what it meant.
import { eachExpr, eachPattern, partsOf, patternsIn } from './ast.ts';
import { fail } from './common.ts';
import type { Block, CtorPat, Expr, FnDecl, Pattern, Program } from './ast.ts';
import { INTRINSICS } from './types.ts';

type Sub = CtorPat['subs'][number];
/** The fields of a pattern written `field: P` with a P that binds no name for the whole field. */
function candidates(p: Pattern): Sub[] {
  const out: Sub[] = [];
  eachPattern(p, q => {
    if (q.k !== 'ctor') return;
    for (const s of q.subs) if (!s.pun && s.pat.k !== 'bind' && s.pat.k !== 'as' && s.pat.k !== 'any') out.push(s);
  });
  return out;
}

/** The names a pattern binds itself: by a bare field, `name`, or `name = P`. */
function explicit(p: Pattern): string[] {
  const out: string[] = [];
  eachPattern(p, q => {
    if (q.k === 'bind' || q.k === 'as') out.push(q.name);
  });
  return out;
}

function bindFields(f: FnDecl, isFunction: (n: string) => boolean): void {
  // the names in scope: each bound by the program, or offered by a field matched by a pattern
  const open: { name: string; sub?: Sub }[] = f.params.map(pm => ({ name: pm.name })),
    used = new Set<Sub>(),
    clash = new Set<string>();
  // the names a pattern binds, entered into scope, and the fields it offers; gives how many it entered
  const enter = (names: readonly string[], offered: readonly Sub[]): number => {
    const mine = offered.filter(s => !isFunction(s.field));
    const all: { name: string; sub?: Sub }[] = [
      ...names.map(name => ({ name })),
      ...mine.map(sub => ({ name: sub.field, sub })),
    ];
    for (const [i, x] of all.entries()) {
      // a name bound where a field of that name is offered, or the other way round, or twice in one pattern
      const before = [...open, ...all.slice(0, i)].find(o => o.name === x.name);
      if (before && (before.sub || x.sub)) clash.add(x.name);
    }
    open.push(...all);
    return all.length;
  };
  const leave = (n: number): void => {
    open.length -= n;
  };
  const walk = (e: Expr): void => {
    if (e.k === 'var') {
      const sub = open.findLast(o => o.name === e.name)?.sub;
      if (sub) used.add(sub);
      return;
    }
    if (e.k === 'match' && e.subject) {
      walk(e.subject);
      for (const a of e.arms) {
        const n = enter(explicit(a.pat), candidates(a.pat));
        if (a.guard) walk(a.guard);
        walk(a.body);
        leave(n);
      }
      return;
    }
    if (e.k === 'lambda') {
      const n = enter(
        e.params.map(pm => pm.name),
        [],
      );
      walk(e.body);
      return leave(n);
    }
    if (e.k === 'block') return walkBlock(e);
    for (const part of partsOf(e)) walk(part);
  };
  const walkBlock = (b: Block): void => {
    let n = 0;
    for (const l of b.lets) {
      walk(l.value);
      n += l.pat ? enter(explicit(l.pat), candidates(l.pat)) : enter([l.name], []);
    }
    walk(b.result);
    leave(n);
  };
  walk(f.body);
  for (const s of used)
    if (!clash.has(s.field)) s.pat = { k: 'as', name: s.field, pat: s.pat, line: s.pat.line, file: s.pat.file };
}

/** A pattern written without its field's name (`Some("")`) is for the one field of its constructor; a constructor
 * with more than one is refused, with the fields to name. */
function namePositional(prog: Program, f: FnDecl): void {
  eachExpr(f.body, e => {
    for (const p of patternsIn(e))
      eachPattern(p, q => {
        if (q.k !== 'ctor' || prog.types.get(q.name)?.refine) return;
        for (const s of q.subs) {
          if (!s.positional) continue;
          const c = prog.ctors.get(q.name),
            fields = c?.decl.variants[c.vi]?.fields ?? [];
          const [only] = fields;
          if (only && fields.length === 1 && q.subs.length === 1) {
            s.field = only.name;
            delete s.positional;
            continue;
          }
          fail(
            q,
            'C10',
            `a pattern for a field of ${q.name} names the field`,
            c
              ? `${q.name} has the fields (${fields.map(x => x.name).join(', ')}): write \`${q.name}(${fields.map(x => `${x.name}: …`).join(', ')})\`, leaving out the ones not looked at. Only a constructor with one field takes its pattern unnamed, \`Some("")\`.`
              : `Write \`${q.name}(field: pattern)\`.`,
          );
        }
      });
  });
}

export function bindFieldNames(prog: Program): void {
  for (const f of prog.fns.values()) namePositional(prog, f);
  const isFunction = (n: string): boolean =>
    n === 'flags' || prog.fns.has(n) || INTRINSICS.has(n) || [...prog.byFile.values()].some(m => m.has(n));
  for (const f of prog.fns.values()) bindFields(f, isFunction);
}
