// host/schema.ts: what the host does to the database before a program runs on it: its migrations, in order and
// at most once, and its machines, as triggers.
import type { Sql } from './log.ts';
import { cellText } from './log.ts';
import type { HostStore, Transaction } from './store.ts';
import { appendMigration, getMigrations, storeSavepoint } from './store.ts';

// Migrations: `migration N "name" { sql }` blocks, in order, each hashed with every one before it. The object
// keeps applied migrations in the host store (not in the program's Sql); migrate runs the ones it has not, in order, in one
// transaction, and returns them as effects ({ migrate, name, hash, statements, ms }). A stored migration whose hash
// differs from the chain's (it was edited after it ran, or the chains diverged) stops everything: it throws and
// runs nothing. A chain shorter than the stored one is an older program's, and runs nothing.

export type Link = { n: number; name: string; contract: boolean; statements: string[]; hash: string };
export type Migrated = {
  migrate: number;
  name: string;
  hash: string;
  contract: boolean;
  statements: string[];
  removed?: string[];
  ms: number;
};
export type { Transaction } from './store.ts';
export { direct } from './store.ts';

/**
 * The program's tables and columns as "table.column": what a migration may take away. Tables whose names begin
 * SQLite's own tables and the Durable Object KV table are not the program's.
 */
export const columns = (sql: Sql): Set<string> =>
  new Set(
    sql
      .exec(
        "SELECT m.name || '.' || p.name AS c FROM sqlite_master m, pragma_table_info(m.name) p WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite%' AND m.name NOT LIKE '_cf_%'",
      )
      .toArray()
      .map(r => cellText(r['c'])),
  );
// What one migration took away, judged by what its statements did to the tables, not by how they are written:
// a DROP, a RENAME (of a table or a column) and a table rebuilt without a column all remove something. A migration
// that removes something must be a contract, because a version still running may read or write what it removed.
export const removedBy = (before: ReadonlySet<string>, after: ReadonlySet<string>): string[] =>
  [...before].filter(c => !after.has(c));
export const removalError = (m: { n: number; name: string }, gone: readonly string[]): string =>
  `migration ${m.n} "${m.name}" removes ${gone.join(', ')}, which a version still running may read or write; mark it \`contract\` (migration ${m.n} "${m.name}" contract { … }) so it waits until those versions are retired`;

function runOne(sql: Sql, store: HostStore, m: Link): Migrated {
  const began = Date.now();
  const before = columns(sql);
  for (const st of m.statements) sql.exec(st);
  const removed = removedBy(before, columns(sql));
  if (removed.length > 0 && !m.contract) throw new Error(removalError(m, removed));
  appendMigration(store, { version: m.n, name: m.name, hash: m.hash, applied_at: Date.now() });
  const { name, hash, contract, statements } = m;
  const took = { ms: Date.now() - began };
  return { migrate: m.n, name, hash, contract, statements, ...(removed.length > 0 ? { removed } : {}), ...took };
}

export function migrate(
  sql: Sql,
  store: HostStore,
  chain: readonly Link[],
  { transaction = storeSavepoint(sql, store) }: { transaction?: Transaction } = {},
): Migrated[] {
  const done = getMigrations(store);
  done.forEach((d, i) => {
    const mine = chain[i];
    if (!mine || (mine.n === d.version && mine.hash === d.hash)) return;
    throw new Error(
      `migration ${d.version} "${d.name}" diverged: it ran with hash ${d.hash.slice(0, 12)}, this program's is ${mine.hash.slice(0, 12)}. Applied migrations are append-only: add a new one instead of editing it.`,
    );
  });
  return transaction(() => chain.slice(done.length).map(m => runOne(sql, store, m)));
}

// Machines (`machine table.column: State { From -> To }`, rules.ts C57-C61; a state is its constructor's text) as
// SQLite triggers, the run-time half of the check: a row inserted in a state other than a start state, or an UPDATE that changes the column by a move not
// listed, fails with RAISE(ABORT), and the request's transaction rolls back. Comparisons use IS, so a NULL state is
// a state like any other (and not a start). `starts`: the start states (the service allows those of every live
// version); `start` alone when there is one. The triggers do not see DELETE, or a write that does not change the
// column (a note on a finished order: the compiler's C58 is the check for that), and they are dropped while
// migrations run, since a migration may rebuild the table; installMachines puts them back.
export const MACHINE_PREFIX = '_tape_machine_';
export type MachineSpec = {
  table: string;
  column: string;
  start: string | null;
  starts?: (string | null)[];
  states?: string[];
  moves: (readonly [string, string] | string[])[];
};
const sqlText = (v: unknown): string => `'${String(v).replaceAll("'", "''")}'`;

export function machineTriggers(machines: readonly MachineSpec[]): string[] {
  return machines.flatMap(m => {
    const t = `"${m.table}"`;
    const c = `"${m.column}"`;
    const name = `${MACHINE_PREFIX}${m.table}_${m.column}`;
    const starts = m.starts ?? [m.start];
    const start = starts.map(v => `NEW.${c} IS ${sqlText(v)}`).join(' OR ');
    const moves =
      m.moves.map(([from, to]) => `(OLD.${c} IS ${sqlText(from)} AND NEW.${c} IS ${sqlText(to)})`).join(' OR ') || '0';
    return [
      `CREATE TRIGGER "${name}_start" BEFORE INSERT ON ${t} WHEN NOT (${start}) BEGIN SELECT RAISE(ABORT, ${sqlText(`machine ${m.table}.${m.column}: a row starts in ${starts.join(' or ')}`)}); END`,
      `CREATE TRIGGER "${name}_move" BEFORE UPDATE OF ${c} ON ${t} WHEN OLD.${c} IS NOT NEW.${c} AND NOT (${moves}) BEGIN SELECT RAISE(ABORT, ${sqlText(`machine ${m.table}.${m.column}: that move is not declared (${m.moves.map(([a, b]) => `${a} -> ${b}`).join(', ')})`)}); END`,
    ];
  });
}
/** The machine triggers now in the database, by name. */
export const machineTriggersIn = (sql: Sql): string[] =>
  sql
    .exec(
      `SELECT name FROM sqlite_master WHERE type = 'trigger' AND substr(name, 1, ${MACHINE_PREFIX.length}) = '${MACHINE_PREFIX}' ORDER BY name`,
    )
    .toArray()
    .map(r => cellText(r['name']));
export function dropMachines(sql: Sql): void {
  for (const n of machineTriggersIn(sql)) sql.exec(`DROP TRIGGER IF EXISTS "${n}"`);
}
/** Replace whatever machine triggers there are with these machines'. Returns the statements it ran. */
export function installMachines(sql: Sql, machines: readonly MachineSpec[]): string[] {
  dropMachines(sql);
  const statements = machineTriggers(machines);
  for (const st of statements) sql.exec(st);
  return statements;
}
