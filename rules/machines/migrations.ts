// rules/machines/migrations.ts: C70. The schema statements and migrations run while the machine's triggers are
// dropped (host.ts instantiate), so nothing at run time checks them: every value they write into the column is a
// declared state, a literal (or the same column copied from a table being rebuilt), and a row they insert without
// it starts in a DEFAULT that is a declared state.
import type { Program } from '../../compiler/ast.ts';
import type { Expr, Insert, Statement, Table } from '../../sql/ast.ts';
import type { ProgramSchema } from '../../sql/program.ts';
import { comparisonsOf, tablesNamed } from '../statecol.ts';
import { lc } from '../syntax.ts';
import type { Report } from '../types.ts';
import { writeOf } from '../writes.ts';
import { showNode } from './paths.ts';
import type { MachineDecl } from './paths.ts';

type Place = { readonly file?: string; readonly line?: number };
/** One statement that runs with the triggers off: where it is, and what to call it. */
type Ran = { readonly st: string; readonly at: Place; readonly what: string };
type Run = {
  readonly m: MachineDecl;
  readonly label: string;
  readonly states: ReadonlySet<string>;
  readonly table: Table | undefined;
  readonly bad: Report;
};

function ranOf(prog: Program): Ran[] {
  const user = [...prog.byFile.keys()].find(f => !f.startsWith('std/')) ?? '';
  return [
    ...prog.schema.map(st => ({ st, at: { file: user, line: 1 }, what: 'a schema statement' })),
    ...prog.migrations.flatMap(mg => mg.statements.map(st => ({ st, at: mg, what: `migration ${mg.n} "${mg.name}"` }))),
  ];
}

function say(run: Run, { at, what }: Ran, why: string): void {
  const { m, label } = run;
  run.bad(
    'C70',
    at,
    `${what} ${why}; it runs while the triggers of ${label} are off, so nothing at run time would stop it, and the row is left outside the machine`,
    `Write one of the declared states (${m.states.map(x => `'${x}'`).join(', ')}) as a literal, or declare the state.`,
  );
}

/** A value written into the column: a declared state as a literal, or the same column copied (a table rebuilt). */
function value(run: Run, ran: Ran, v: Expr, how: string): void {
  const { m } = run;
  const col = m.column;
  if (v.k === 'lit' && v.type === 'text') {
    if (!run.states.has(String(v.v)))
      say(run, ran, `${how} ${m.table}.${col} as "${v.v}", which is not a declared state`);
    return;
  }
  if (v.k === 'col' && lc(v.name) === lc(col)) return;
  say(run, ran, `${how} ${m.table}.${col} as \`${showNode({ raw: ran.st }, v)}\`, which is not a literal state`);
}

// a literal it compares with the column is a state (C61), in a migration as anywhere; only in a statement over
// the machine's table (a CHECK of another table's own `state` is that table's)
function misspelt(run: Run, { at, what }: Ran, ast: Statement): void {
  const { m, label } = run;
  const col = m.column;
  const over = ast.k === 'create_table' ? new Set([lc(ast.table)]) : tablesNamed(ast);
  if (!over.has(lc(m.table))) return;
  for (const v of comparisonsOf(ast, m, null))
    if (v.k === 'lit' && v.type === 'text' && !run.states.has(String(v.v)))
      run.bad(
        'C61',
        at,
        `${what} compares ${m.table}.${col} with "${v.v}", which is not one of the states of ${label} (${m.states.map(x => `"${x}"`).join(', ')}): no row is in it, so this never matches`,
        'Use one of the declared states, or declare the state with a move into it.',
      );
}

function insertedAt(run: Run, ran: Ran, ast: Insert, i: number): void {
  const { m } = run;
  const col = m.column;
  if (ast.values) {
    for (const row of ast.values) {
      const v = row[i];
      if (v) value(run, ran, v, 'inserts');
    }
    return;
  }
  if (!ast.select) return;
  const c = ast.select.cols[i];
  if (!c || c.star) say(run, ran, `inserts ${m.table}.${col} from \`SELECT *\``);
  else value(run, ran, c.expr, 'inserts');
}

function defaulted(run: Run, ran: Ran): void {
  const col = run.m.column;
  const d = run.table?.cols.find(c => lc(c.name) === lc(col))?.default;
  if (d && d.k === 'lit' && d.type === 'text' && run.states.has(String(d.v))) return;
  say(
    run,
    ran,
    `inserts rows without ${col}, whose DEFAULT is ${d ? showNode({ raw: '' }, d) : 'NULL'}, not a declared state`,
  );
}

function writes(run: Run, ran: Ran, ast: Statement): void {
  const { m } = run;
  const col = m.column;
  const s = writeOf(ast);
  if (!s || s.kind === 'delete' || lc(s.table) !== lc(m.table)) return;
  if (s.kind === 'update') {
    const a = s.assigns.find(x => lc(x.col) === lc(col));
    if (a) value(run, ran, a.expr, 'sets');
    return;
  }
  if (ast.k !== 'insert') return;
  const cols = s.cols ?? run.table?.cols.map(c => c.name) ?? [];
  const i = cols.findIndex(c => lc(c) === lc(col));
  if (s.replace) say(run, ran, 'replaces rows (REPLACE)');
  if (i >= 0) insertedAt(run, ran, ast, i);
  else defaulted(run, ran);
  const a = s.upsert?.find(x => lc(x.col) === lc(col));
  if (a && !(a.expr.k === 'col' && lc(a.expr.table) === 'excluded')) value(run, ran, a.expr, 'sets');
}

/** C70 (and C61 in the statements it reads): what the schema statements and migrations leave in the column. */
export function migrationWrites(m: MachineDecl, prog: Program, model: ProgramSchema, bad: Report): void {
  const run: Run = {
    m,
    label: `machine ${m.table}.${m.column}`,
    states: new Set(m.states),
    table: model.schema.tables.get(lc(m.table)),
    bad,
  };
  for (const ran of ranOf(prog)) {
    const ast = model.asts.get(ran.st);
    if (!ast) continue;
    misspelt(run, ran, ast);
    writes(run, ran, ast);
  }
}
