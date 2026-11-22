// rules/declared.ts: what a program declares, and each statement read on its own (C51-C53, C63, C66-C68).
import { eachExpr } from '../compiler/ast.ts';
import type { Program } from '../compiler/ast.ts';
import type { Source } from '../sql/ast.ts';
import type { SchemaAt } from '../sql/program.ts';
import { analysisOf } from './model.ts';
import { movePlan } from './move.ts';
import { lc, stripComments } from './syntax.ts';
import type { Reading } from './types.ts';

const userFile = (prog: Program): string => [...prog.byFile.keys()].find(f => !f.startsWith('std/')) ?? '';
/** A statement on one line, cut to fit a message. */
export const short = (s: string): string => {
  const x = s.replaceAll(/\s+/g, ' ').trim();
  return x.length > 70 ? x.slice(0, 70) + '…' : x;
};

// C67: every statement parses; C68: the schema builds as SQLite would build it
function unreadable({ prog, model, queries, bad }: Reading): void {
  const user = userFile(prog);
  const migration = (at: SchemaAt) => ('migration' in at ? prog.migrations.find(m => m.n === at.migration) : undefined);
  const stAt = (at: SchemaAt) => ('migration' in at ? migration(at) : { file: user, line: 1 });
  const stWhat = (at: SchemaAt): string =>
    'migration' in at ? `migration ${at.migration} "${migration(at)?.name}"` : `schema statement ${at.schema + 1}`;
  for (const e of model.errors)
    bad(
      e.kind === 'subset' || e.kind === 'syntax' ? 'C67' : 'C68',
      stAt(e.at),
      `${stWhat(e.at)}: ${e.message}: "${short(e.statement)}"`,
      e.kind === 'subset'
        ? "Write it in the SQL the checker reads: CREATE TABLE, CREATE INDEX, ALTER TABLE, DROP, INSERT, UPDATE, DELETE on the program's own tables."
        : 'Each statement runs against the tables the statements before it made.',
    );
  for (const q of queries)
    if (q.error)
      bad(
        'C67',
        q.at,
        `${q.via} cannot take this query: ${q.error.message}`,
        "Write it in the SQL the checker reads: one SELECT, INSERT, UPDATE or DELETE on the program's own tables, without WITH, triggers, schema names or window functions.",
      );
}

// C53: one way to declare tables
function declaredTwice({ prog, bad }: Reading): void {
  if (prog.schema.length === 0 || prog.migrations.length === 0) return;
  bad(
    'C53',
    { file: userFile(prog), line: 1 },
    `this program declares tables with ${prog.schema.length} schema statement${prog.schema.length > 1 ? 's' : ''} and with ${prog.migrations.length} migration${prog.migrations.length > 1 ? 's' : ''}: on a name whose data is new, the schema runs first and a migration's CREATE TABLE then fails, or creates nothing`,
    'Declare the tables in migrations only: move each `schema` statement into migration 1 (or a new migration), and remove the `schema` lines.',
  );
}

// C51: the forms a migration that is not a contract may take
function contracts({ prog, model, bad }: Reading): void {
  for (const m of prog.migrations) {
    if (m.contract) continue;
    for (const st of m.statements) {
      const ast = model.asts.get(st);
      if (!ast) continue; // C67 already
      const adds =
        ast.k === 'create_table' ||
        ast.k === 'create_index' ||
        (ast.k === 'alter' && ast.action === 'add_column') ||
        (ast.k === 'insert' && !ast.or && (ast.cols !== null || ast.select !== null));
      if (adds) continue;
      bad(
        'C51',
        m,
        `migration ${m.n} "${m.name}" is not a contract, but "${short(stripComments(st))}" is not one of the forms such a migration may take: it may remove or rename what a live version still reads`,
        'A migration that only adds takes CREATE TABLE, CREATE INDEX, ALTER TABLE t ADD COLUMN and INSERT INTO. Anything else (DROP, RENAME, UPDATE, DELETE, a rebuilt table) is `migration n "name" contract { … }`, which waits until the versions that predate it are retired.',
      );
    }
  }
}

// C52: qualified columns where more than one table is in scope
function unqualified({ model, queries, bad }: Reading): void {
  if (model.errors.length > 0) return;
  for (const q of queries) {
    if (!q.ast) continue;
    const a = analysisOf(q.raw, q.ast, model.schema);
    const bare = new Set<string>();
    const outer = new Set<string>();
    let from: Source[] | null = null;
    for (const [node, ref] of a.refs) {
      if (ref.qualified) continue;
      if (ref.depth > 0) {
        outer.add(node.name);
        continue;
      }
      const frame = [...a.frames.values()].find(f => f.includes(ref.source));
      const named = frame?.filter(s => !s.qualifierOnly) ?? [];
      if (named.length < 2) continue;
      bare.add(node.name);
      from ??= named;
    }
    if (bare.size > 0 && from)
      bad(
        'C52',
        q.at,
        `this query reads ${from.length} tables (${from.map(x => x.name ?? x.alias).join(', ')}) and leaves ${[...bare].join(', ')} unqualified: a column a later migration adds to another of them makes it ambiguous, or quietly changes what it means`,
        `Write table.column (or alias.column) for every column, for example ${from[0]?.alias ?? from[0]?.name}.${[...bare][0]}.`,
      );
    else if (outer.size > 0)
      bad(
        'C52',
        q.at,
        `a subquery here names ${[...outer].join(', ')} of the query around it without its table: a column of that name added later to the subquery's own table would take its place, silently`,
        `Qualify it with the outer table's name (or alias): ${[...outer].map(n => `table.${n}`).join(', ')}.`,
      );
  }
}

// C63: sql_move names one row by a whole unique key, so Raced and NoRow are told apart for that row
function moveKeys({ prog, queries, tables, bad }: Reading): void {
  for (const q of queries) {
    if (q.via !== 'sql_move') continue;
    const plan = movePlan(q.raw, prog.machines);
    if (plan.error !== undefined) continue; // the compiler refuses the statement itself (C63)
    const t = tables.get(plan.table);
    if (!t) continue; // C68 refuses the table
    if ([t.pk, ...t.uniques].some(u => u.length > 0 && u.every(c => plan.keyCols.some(k => lc(k) === lc(c))))) continue;
    bad(
      'C63',
      q.at,
      `this sql_move names the ${plan.table} row by ${plan.keyCols.join(', ')}, which is not a whole unique key of ${plan.table} (${[...new Set([t.pk, ...t.uniques].filter(u => u.length).map(u => u.join(', ')))].join('; ') || 'it has none but its rowid'}): when it moves no row, the row read back may be another one`,
      `Name the row by its key: \`WHERE ${(t.pk.length > 0 ? t.pk : (t.uniques[0] ?? ['id'])).map((c, i) => `${c} = ?${i + 1}`).join(' AND ')} AND …\`.`,
    );
  }
}

// C66: a private type's constructors build values only in the file that declares it. Anywhere else its values
// can be matched on and passed along, not made, so a value of it is a witness that the declaring file made it
// (CallError: only the host says a call was refused, timed out or found nothing; J1)
function privateTypes({ prog, bad }: Reading): void {
  for (const f of prog.fns.values())
    eachExpr(f.body, n => {
      if (n.k !== 'ctor') return;
      const c = prog.ctors.get(n.name);
      if (!c?.decl.private || n.file === c.decl.file) return;
      bad(
        'C66',
        n,
        `${n.name} is a constructor of private type ${c.decl.name}, which only ${c.decl.file} may build: a ${c.decl.name} made anywhere else would claim what only that file can know`,
        c.decl.name === 'CallError'
          ? 'A CallError comes only from a call: match on the one you got and pass it on, or answer with a reason of your own (a View, a type of your own).'
          : `Get a ${c.decl.name} from the functions ${c.decl.file} defines, or pass on one you were given.`,
      );
    });
}

export function declaredRules(r: Reading): void {
  unreadable(r);
  declaredTwice(r);
  contracts(r);
  unqualified(r);
  moveKeys(r);
  privateTypes(r);
}
