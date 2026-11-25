// compiler/tidy.ts: a call run for what it does is written as a step of its own (C83-C85).
//
// Three ways of running a call for what it does that a step replaces. Each hides the order of effects: in a name
// nobody reads, in an argument list, or in arithmetic. Refused like the other rules (built anyway under rules: false).
//   C83  `let name = call(…)` and the name is never read        -> a step: `do call(…)`, or what its value needs
//   C84  a call passed to a parameter its function never reads   -> that step on the line before, and drop the parameter
//   C85  a call multiplied by the literal 0                      -> that step
// The step is `do call(…)` for a call whose value is Done (wake, a function that only does something); `let 1 =
// sql_exec(…) else -> …` or `let _ = sql_exec(…)` for a count of rows; `let _ = …` for another Int; a match for the
// rest. "A call" here is one that does something: sql_*, wake, call, ask, now, random, rollback, or a function that
// reaches one. A parameter or a name that is never read and holds no such call is dead, not hidden work.
import { type At, type Call, type Expr, type FnDecl, type Program, type TypeAst, eachExpr, partsOf } from './ast.ts';
import type { Problem } from './common.ts';
import { stdName } from './shadow.ts';
import { CAPABILITIES } from './types.ts';

const EFFECTS = [
  'sql_exec',
  'sql_first',
  'sql_all',
  'sql_move',
  'wake',
  'call',
  'ask',
  'random',
  'now',
  'rollback',
  'secret',
];
// what each effect gives but wake, whose value is Done, the one `do` runs (C82)
const GIVES: Readonly<Record<string, string>> = {
  sql_exec: 'Int',
  sql_first: 'an Option',
  sql_all: 'Rows',
  sql_move: 'a Move',
  call: 'a Result',
  ask: 'a Result',
  random: 'Int',
  now: 'Int',
  rollback: 'a Response',
  secret: 'an Option',
};
const typeText = (t: TypeAst): string => (t.args.length > 0 ? `${t.name}[${t.args.map(typeText).join(', ')}]` : t.name);
/** How to run `name` as a step of its own: `do` for a Done, or, for a value `do` does not run, what to do with it. */
function runIt(r: Reading, name: string): string {
  const gives = r.gives.get(name);
  if (gives === undefined) return `\`do ${name}(…)\``;
  if (name === 'sql_exec')
    return '`let 1 = sql_exec(…) else -> …` when the row must be there or the guard must hold, or `let _ = sql_exec(…)` when the count does not matter';
  if (name === 'sql_first' || name === 'sql_all')
    return `\`let _ = sql_exec(…)\`, for a statement whose rows are not read`;
  if (gives === 'Int') return `\`let _ = ${name}(…)\`, which drops its Int on purpose`;
  return `a match on what ${name} gives (${gives}, which \`do\` does not run: C82), with an arm for each outcome`;
}
/** What tidy reads a program through: the functions that do something, and what each function reads. */
type Reading = {
  doing: Set<string>;
  /** a function that does something and gives a value other than Done, which `do` does not run (C82): what it gives */
  gives: Map<string, string>;
  reads: Map<FnDecl, Set<string>>;
  /** function -> the parameters it never reads (capabilities aside) */
  unread: Map<string, Set<string>>;
};
// the first expression in e, outermost first, that `is` holds of
function firstIn<T extends Expr>(e: Expr, is: (e: Expr) => e is T): T | null {
  if (is(e)) return e;
  for (const part of partsOf(e)) {
    const found = firstIn(part, is);
    if (found) return found;
  }
  return null;
}
// the functions that do something: an effect of the host's, or a function that reaches one
function doingOf(prog: Program): Set<string> {
  const doing = new Set(EFFECTS),
    reaches = (f: FnDecl): boolean => !!firstIn(f.body, (e): e is Call => e.k === 'call' && doing.has(e.name));
  for (let grew = true; grew;) {
    const more = [...prog.fns.values()].filter(f => !doing.has(f.name) && reaches(f));
    grew = more.length > 0;
    for (const f of more) doing.add(f.name);
  }
  return doing;
}
function reading(prog: Program): Reading {
  const caps = new Set([...CAPABILITIES, ...prog.interfaces.keys()]),
    reads = new Map<FnDecl, Set<string>>(),
    unread = new Map<string, Set<string>>();
  for (const f of prog.fns.values()) {
    const names = new Set<string>();
    eachExpr(f.body, e => {
      if (e.k === 'var') names.add(e.name);
    });
    reads.set(f, names);
    const dead = f.params.filter(p => !names.has(p.name) && !caps.has(p.typeAst.name)).map(p => p.name);
    if (dead.length > 0 && !f.exported && f.name !== 'handle') unread.set(f.name, new Set(dead));
  }
  const gives = new Map(Object.entries(GIVES));
  const done = stdName(prog, 'types', 'Done');
  for (const f of prog.fns.values()) if (f.retAst.name !== done) gives.set(f.name, typeText(f.retAst));
  return { doing: doingOf(prog), gives, reads, unread };
}
// the problems at one expression of f
function problemsAt(r: Reading, f: FnDecl, e: Expr): Problem[] {
  const out: Problem[] = [],
    bad = (code: string, at: At, message: string, hint: string): void => {
      out.push({ code, file: at.file, line: at.line, message, hint });
    },
    doer = (x: Expr): Call | null => firstIn(x, (y): y is Call => y.k === 'call' && r.doing.has(y.name)),
    zero = (x: Expr): boolean => x.k === 'int' && x.v === 0n;
  if (e.k === 'block')
    for (const l of e.lets)
      if (l.name && !l.do && !r.reads.get(f)?.has(l.name) && l.value.k === 'call' && r.doing.has(l.value.name))
        bad(
          'C83',
          l,
          `${l.name} is never read: ${l.value.name} is run for what it does`,
          `Write ${runIt(r, l.value.name)}.`,
        );
  const hidden = e.k === 'bin' && e.op === '*' && (zero(e.l) || zero(e.r)) ? doer(e) : null;
  if (hidden)
    bad(
      'C85',
      e,
      `this is multiplied by 0: ${hidden.name} is run for what it does, and its value thrown away`,
      `Run it as a step of its own, on the line before: ${runIt(r, hidden.name)}.`,
    );
  const never = e.k === 'call' ? r.unread.get(e.name) : undefined;
  if (e.k === 'call' && never)
    for (const a of e.args) {
      const c = a.label && never.has(a.label) ? doer(a.value) : null;
      if (c)
        bad(
          'C84',
          a.value,
          `${c.name} is passed as ${a.label}, which ${e.name} never reads: it is run for what it does, before ${e.name}`,
          `Run it as a step of its own, on the line before: ${runIt(r, c.name)}, and remove the parameter ${a.label} from ${e.name}.`,
        );
    }
  return out;
}
export function tidy(prog: Program): Problem[] {
  const r = reading(prog),
    found: Problem[] = [];
  for (const f of prog.fns.values())
    if (!f.file.startsWith('std/'))
      eachExpr(f.body, e => {
        found.push(...problemsAt(r, f, e));
      });
  return found;
}
