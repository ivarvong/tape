// rules/machines.ts: every write of a machine's column against the moves it declares (C57-C62, C70).
//
// `machine table.column: State { From -> To … }` declares the states a row's column may take, the constructors of
// the fieldless sum State, and the moves between them; the first state named is where every row starts. The column
// holds each state as its constructor's text (compiler/fieldless.ts: `From` is 'from'), and the rules below read the
// SQL in those texts. Every query of the program is read against each machine (not only the writes a request
// reaches: a move is wrong whoever makes it):
//
//   C57 declaration   the machine names a table and column the program has, once, and each move goes somewhere
//                     else; its type is a fieldless sum, and its constructors are the states its moves name
//   C58 guard         an UPDATE of the table (or an upsert's DO UPDATE), and a DELETE of its rows, says which state
//                     it expects: a top-level `AND column = …` or `AND column IN (…)` in its WHERE. Without one it
//                     also writes onto (or removes) a row another request has moved on (J3: a note written onto a
//                     finished order; a cancelled order deleted after it was paid). Not inside an OR.
//   C59 move          every move a write makes is declared: for each state its guard accepts and each value it sets,
//                     from != to implies "from" -> "to" is a declared move. An INSERT starts in the first state, by
//                     the value it inserts or by the column's DEFAULT.
//   C60 not analysed  a write of the column whose states this reader cannot follow: a value that is not a literal or
//                     a parameter traced to literals on every call path, a CASE or subquery, REPLACE (which resets a
//                     row), INSERT … SELECT, several rows at once, a statement the parser does not take. Such a write
//                     is refused, not passed: the rule proves only what it can read.
//   C61 state         a literal compared with the column, anywhere (WHERE, CASE, a SELECT, a migration), is one of the
//                     states: a misspelt state matches nothing, and the write it guards silently never happens.
//   C70 triggers off  the schema statements and migrations leave every row in a declared state
//                     (rules/machines/migrations.ts).
//
// Columns are resolved by sql.ts against the schema (an alias, a subquery's own table, excluded.column), so a
// comparison of another table's column of the same name is not taken for this one. How a value is followed to the
// literals it can be is in rules/machines/paths.ts.
import type { Machine, Program } from '../compiler/ast.ts';
import { fieldlessOf, storedText } from '../compiler/fieldless.ts';
import { checkMachine } from './machines/check.ts';
import { migrationWrites } from './machines/migrations.ts';
import { machineContext } from './machines/paths.ts';
import type { MachineContext } from './machines/paths.ts';
import { wayOut } from './timers.ts';
import type { Report } from './types.ts';

export { checkMachine } from './machines/check.ts';
export type { MachineReading, Wrote } from './machines/check.ts';
export { machineContext } from './machines/paths.ts';
export type { MachineContext, MachineDecl } from './machines/paths.ts';

/** What is wrong with the machine's type (C57), or null: its constructors are its states, every one. */
function mistyped(m: Machine, prog: Program): string | null {
  const d = prog.types.get(m.type);
  const ctors = fieldlessOf(prog, m.type);
  if (!d) return `there is no type ${m.type}: declare it with a constructor for each state`;
  if (!ctors) return `${m.type} is not a sum whose constructors have no fields, so its values cannot be stored as text`;
  const stranger = m.ctors.find(x => !ctors.includes(x));
  if (stranger !== undefined) return `${stranger} is not a constructor of ${m.type} (${ctors.join(', ')})`;
  const unmoved = ctors.find(x => !m.ctors.includes(x));
  if (unmoved !== undefined)
    return `${unmoved} is a constructor of ${m.type}, and no move of the machine names it: a row could hold a state no move reaches or leaves`;
  const same = ctors.find((x, i) => ctors.findIndex(y => storedText(y) === storedText(x)) !== i);
  if (same !== undefined) return `two constructors of ${m.type} are stored as '${storedText(same)}'`;
  return null;
}

/** What is wrong with the declaration itself (C57), or null. `seen`: the columns that already have a machine. */
function misdeclared(m: Machine, prog: Program, ctx: MachineContext, seen: ReadonlySet<string>): string | null {
  const t = ctx.tables.get(m.table);
  const named = (text: string): string => m.ctors.find(x => storedText(x) === text) ?? text;
  const self = m.moves.find(x => x.from === x.to);
  const twice = m.moves.find((x, i) => m.moves.findIndex(y => y.from === x.from && y.to === x.to) !== i);
  if (!t) return `there is no table ${m.table}`;
  if (!t.cols.includes(m.column)) return `${m.table} has no column ${m.column}`;
  if (seen.has(`${m.table}.${m.column}`)) return `${m.table}.${m.column} already has a machine`;
  if (m.moves.length === 0) return 'it declares no moves';
  if (self) return `${named(self.from)} -> ${named(self.to)} is not a move: it goes nowhere`;
  if (twice) return `${named(twice.from)} -> ${named(twice.to)} is declared twice`;
  return mistyped(m, prog);
}

type Finding = { code: string; at?: { file?: string; line?: number }; message: string; hint: string };

// C77 reads the moves the writes make; a write C58 or C59 refuses (no guard, an undeclared move) is not one of
// them, nor is a write C60 cannot read, so a machine with any of those is left to them (no cascade). An arm of a
// timer's run that leaves rows of two machines (holds and their tickets) is one finding.
function checkOne(m: Machine, prog: Program, ctx: MachineContext, once: Set<string>, bad: Report): void {
  const r = checkMachine(m, ctx);
  for (const p of r.problems) bad(p.code, { file: p.file, line: p.line }, p.message, p.hint);
  migrationWrites(m, prog, ctx.model, bad);
  if (r.problems.some(p => ['C58', 'C59', 'C60'].includes(p.code))) return;
  const found: Finding[] = wayOut(m, ctx, r.writes);
  for (const p of found) {
    const at = `${p.code}:${p.at?.file}:${p.at?.line}`;
    if (p.code === 'C79' && once.has(at)) continue;
    once.add(at);
    bad(p.code, p.at, p.message, p.hint);
  }
}

/** C57, then the checks of each machine against the program that declares it. */
export function machineRules(prog: Program, bad: Report): void {
  if (!prog.machines?.length) return;
  const ctx = machineContext(prog);
  const seen = new Set<string>();
  const once = new Set<string>();
  for (const m of prog.machines) {
    const key = `${m.table}.${m.column}`;
    const wrong = misdeclared(m, prog, ctx, seen);
    seen.add(key);
    if (wrong === null) checkOne(m, prog, ctx, once, bad);
    else
      bad(
        'C57',
        m,
        `machine ${key}: ${m.type}: ${wrong}`,
        'A machine is `machine table.column: State { From -> To … }`, one per column, over a table the program declares, with `type State { From To … }`: each line is one move to another state, every constructor of the type is a state some move names, and the first state named is where rows start.',
      );
  }
}
