// sim/checks.ts: what must hold in a world. The invariants the programs declare, and the rows of every table, which
// the duplicate rule compares.
import type { Sql } from '../host.ts';
import { nodeSql } from '../nodesql.ts';
import type { NodeSql } from '../nodesql.ts';
import { messageOf, programOf } from './world.ts';
import type { World } from './world.ts';
import { cellText } from '../host/log.ts';

const TABLES = "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'";
const more = (n: number): string => (n > 1 ? ` and ${n - 1} more` : '');

/** Every table of `from`, copied into `into` under `schema` with its declared types, so a number stays the integer it was. */
function copy(into: NodeSql, from: Sql, schema: string): void {
  for (const t of from.exec(TABLES).toArray()) {
    const table = `"${cellText(t['name'])}"`;
    const info = from.exec(`PRAGMA table_info(${table})`).toArray();
    const cols = info.map(c => cellText(c['name']));
    const typed = info.map(
      c => `"${cellText(c['name'])}" ${/^[A-Za-z ]*$/.test(cellText(c['type'])) ? cellText(c['type']) : ''}`,
    );
    into.exec(`CREATE TABLE ${schema}${table}(${typed.join(', ')})`);
    const insert = `INSERT INTO ${schema}${table} VALUES (${cols.map(() => '?').join(', ')})`;
    for (const r of from.exec(`SELECT * FROM ${table}`).toArray()) into.exec(insert, ...cols.map(c => r[c] ?? null));
  }
}

// An invariant `with` other programs: their tables are copied beside this program's (as pay.ledger) and the SELECT
// run there.
function across(world: World, name: string, v: { name: string; with?: string[]; sql: string }): string[] {
  const scratch = nodeSql();
  copy(scratch, programOf(world, name).sql, '');
  for (const o of v.with ?? []) {
    scratch.exec(`ATTACH DATABASE ':memory:' AS "${o}"`);
    copy(scratch, programOf(world, o).sql, `"${o}".`);
  }
  try {
    const rows = scratch.exec(v.sql).toArray();
    if (rows.length === 0) return [];
    return [`${name}: invariant "${v.name}" does not hold: ${JSON.stringify({ ...rows[0] })}${more(rows.length)}`];
  } catch (e) {
    return [`${name}: invariant "${v.name}" cannot be run: ${messageOf(e)}`];
  }
}

// The invariants the programs declare (`invariant "name" { SELECT … }`): the ones that hold after every commit,
// and with settled the ones that hold once nothing is left to happen. One that names a program that is not here
// (it is stood in for) cannot be run and is passed over.
export function declared(world: World, settled: boolean): string[] {
  const programs = Object.entries(world.programs);
  const own = programs.flatMap(([name, p]) =>
    p.app
      .invariants({ settled })
      .filter(v => !settled || v.settled)
      .map(v => `${name}: invariant "${v.name}" does not hold: ${JSON.stringify(v.rows[0])}${more(v.rows.length)}`),
  );
  const shared = programs.flatMap(([name, p]) =>
    p.app
      .declared()
      .filter(v => (v.with?.length ?? 0) > 0 && v.settled === settled && (v.with ?? []).every(o => o in world.programs))
      .flatMap(v => across(world, name, v)),
  );
  return [...own, ...shared];
}

const OWN_TABLES =
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name <> 'schema_migrations' ORDER BY name";
export type Rows = Record<string, string[]>;
/** Every row of every table the programs made, as text, by `program.table`. */
export function rowsOf(world: World): Rows {
  const out: Rows = {};
  for (const [name, p] of Object.entries(world.programs))
    for (const t of p.sql.exec(OWN_TABLES).toArray()) {
      const table = cellText(t['name']);
      out[`${name}.${table}`] = p.sql
        .exec(`SELECT * FROM "${table}" ORDER BY 1`)
        .toArray()
        .map(r => JSON.stringify(r));
    }
  return out;
}

/** The first table whose rows differ, and how; null when none does. */
export function firstChange(before: Rows, after: Rows): { table: string; detail: string } | null {
  for (const [table, rows] of Object.entries(after)) {
    const old = before[table] ?? [];
    if (rows.length !== old.length) return { table, detail: `${old.length} rows became ${rows.length}` };
    const i = rows.findIndex((r, k) => r !== old[k]);
    if (i >= 0) return { table, detail: `row ${i + 1} was ${old[i]?.slice(0, 110)} and is ${rows[i]?.slice(0, 110)}` };
  }
  return null;
}
