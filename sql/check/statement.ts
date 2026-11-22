// sql/check/statement.ts: the statements that write (INSERT, UPDATE, DELETE) and the ones that build the schema
// (CREATE TABLE, CREATE INDEX, ALTER TABLE): what they store against what the columns hold.
import type {
  Alter,
  Assign,
  ColFacts,
  CreateIndex,
  CreateTable,
  Delete,
  Expr,
  Frame,
  Insert,
  ResultCol,
  ResultColumn,
  Source,
  TableFacts,
  Ty,
  Update,
  Upsert,
} from '../ast.ts';
import { applyToSchema, cloneSchema, columnOf } from '../schema.ts';
import { lc } from '../tokens.ts';
import { AFF_T, type Check, type Stack, TY, colType, isNumber, show, sourceOf } from './context.ts';
import { resultColumn, select, ty } from './query.ts';

type Stored = { e: Expr | null; t: Ty };
const NO_AGGREGATE = { agg: false };
const columnNamed = (t: TableFacts, name: string): ColFacts | undefined => t.cols.find(c => lc(c.name) === lc(name));

// A value stored into a column: of its kind, and not NULL when the column is NOT NULL.
function store(k: Check, table: TableFacts, col: ColFacts, v: Stored, how: string): void {
  const want = AFF_T[col.aff],
    where = `${how} ${table.name}.${col.name}`,
    what = v.e ? `\`${k.text(v.e)}\`, ` : '',
    wrongKind = (want !== 'text' && isNumber(want) && v.t.t === 'text') || (want === 'text' && isNumber(v.t.t)),
    isRowid = col.rowid === true || (table.rowid !== null && lc(table.rowid) === lc(col.name));
  k.constrain(v.e, want, where);
  if (wrongKind)
    k.err(
      'type',
      `${where}, declared ${col.type === '' ? 'with no type' : col.type}, ${what}which is ${show(v.t.t)}`,
      v.e ?? undefined,
    );
  if (col.notNull && v.t.null && !isRowid) {
    const fails = v.t.t === 'null' ? 'is NULL: the statement always fails' : 'may be NULL: the statement then fails';
    k.err('type', `${where}, which is NOT NULL, ${what}which ${fails}`, v.e ?? undefined);
  }
}
// the table a statement writes: one the program has, and not SQLite's own
function target(k: Check, name: string, at: { s: number }): TableFacts | null {
  const t = k.table(name);
  if (!t) k.err('name', `no such table: ${name}`, at);
  else if (t.builtin) k.err('name', `${name} is SQLite's own table: it may be read, not written`, at);
  return t && !t.builtin ? t : null;
}
function returning(k: Check, list: ResultCol[] | null, t: TableFacts, frame: Frame): ResultColumn[] | null {
  const [own] = frame;
  if (!list) return null;
  return list.flatMap(c => {
    if (!c.star) return [resultColumn(k, c, ty(k, c.expr, [frame], NO_AGGREGATE), false)];
    return own ? t.cols.map(col => ({ name: col.name, ...colType(own, col) })) : [];
  });
}
function assigns(k: Check, set: readonly Assign[], t: TableFacts, stack: Stack): void {
  const seen = new Set<string>();
  for (const a of set) {
    const col = columnNamed(t, a.col);
    if (!col) {
      k.err('name', `no such column: ${a.col} (in the SET list of ${t.name})`, a);
      continue;
    }
    if (seen.has(lc(col.name))) k.err('name', `${col.name} is set twice`, a);
    seen.add(lc(col.name));
    store(k, t, col, { e: a.expr, t: ty(k, a.expr, stack, NO_AGGREGATE) }, 'this sets');
  }
}

// ---- INSERT
// the columns an INSERT gives values for: those it names, or all of the table's
function insertColumns(k: Check, ast: Insert, t: TableFacts): ColFacts[] {
  if (!ast.cols) return t.cols;
  const cols: ColFacts[] = [];
  for (const name of ast.cols) {
    const col = columnNamed(t, name);
    if (!col) {
      k.err('name', `table ${t.name} has no column named ${name}`, ast);
      continue;
    }
    if (cols.includes(col)) k.err('name', `${col.name} is named twice in the column list`, ast);
    cols.push(col);
  }
  return cols;
}
// one row of values against the columns they go into
function storeRow(k: Check, ast: Insert, t: TableFacts, cols: ColFacts[], vals: Stored[], at: { s: number }): void {
  if (vals.length !== cols.length) {
    const expected = ast.cols
      ? `the column list names ${cols.length}`
      : `table ${t.name} has ${cols.length} columns, and`;
    k.err('name', `${expected} ${vals.length} values were supplied`, at);
    return;
  }
  vals.forEach((v, i) => {
    const col = cols[i];
    if (col) store(k, t, col, v, 'this inserts into');
  });
}
// a NOT NULL column left out, with no DEFAULT: every such INSERT fails (unless it is the rowid)
function leftOut(k: Check, ast: Insert, t: TableFacts, cols: ColFacts[]): void {
  const noDefault = (c: ColFacts): boolean =>
    c.default === undefined || (c.default.k === 'lit' && c.default.v === null);
  for (const c of t.cols)
    if ((!cols.includes(c) || ast.defaults) && c.notNull && noDefault(c) && lc(c.name) !== lc(t.rowid ?? ''))
      k.err(
        'type',
        `this INSERT leaves out ${t.name}.${c.name}, which is NOT NULL and has no DEFAULT: it always fails`,
        ast,
      );
}
// ON CONFLICT (target): a PRIMARY KEY or UNIQUE set of the table, unless it has a WHERE (a partial index's)
function conflictTarget(k: Check, u: Upsert, t: TableFacts): void {
  if (!u.target) {
    if (u.action === 'update')
      k.err('name', 'ON CONFLICT DO UPDATE needs the conflict target: ON CONFLICT(column) DO UPDATE', u);
    return;
  }
  const named = u.target.map(c => columnNamed(t, c)?.name),
    isKey = (key: string[]): boolean =>
      key.length > 0 && key.length === named.length && key.every(c => named.includes(c));
  if (named.some(x => !x)) k.err('name', `ON CONFLICT names a column ${t.name} does not have`, u);
  else if (!u.targetWhere && ![t.pk, ...t.uniques.map(x => x.cols)].some(isKey))
    k.err(
      'name',
      `ON CONFLICT(${u.target.join(', ')}) does not match a PRIMARY KEY or UNIQUE constraint of ${t.name}`,
      u,
    );
}
function upsert(k: Check, ast: Insert, u: Upsert, t: TableFacts, frame: Frame): void {
  conflictTarget(k, u, t);
  if (u.targetWhere) ty(k, u.targetWhere, [frame], {});
  // in DO UPDATE, `excluded.column` is the row that was not inserted
  const excluded: Source = {
    name: 'excluded',
    alias: null,
    table: t,
    cols: t.cols,
    nullable: false,
    qualifierOnly: true,
    excluded: true,
  };
  const scope = k.inScope(u, [sourceOf(t, ast.alias, { byName: true }), excluded]);
  assigns(k, u.set, t, [scope]);
  if (u.where) ty(k, u.where, [scope], NO_AGGREGATE);
}
export function insert(k: Check, ast: Insert): ResultColumn[] | null {
  const t = target(k, ast.table, ast);
  if (!t) return null;
  const frame = k.inScope(ast, [sourceOf(t, ast.alias, { byName: true })]),
    cols = insertColumns(k, ast, t);
  for (const row of ast.values ?? [])
    storeRow(
      k,
      ast,
      t,
      cols,
      row.map(v => ({ e: v, t: ty(k, v, [], NO_AGGREGATE) })),
      row,
    );
  const from = ast.select,
    given = from ? select(k, from) : null;
  if (from && given) {
    const vals = given.map((c, i): Stored => {
      const item = from.cols[i];
      return { e: item && !item.star ? item.expr : null, t: TY(c.t, c.null) };
    });
    storeRow(k, ast, t, cols, vals, from);
  }
  leftOut(k, ast, t, cols);
  if (ast.upsert) upsert(k, ast, ast.upsert, t, frame);
  return returning(k, ast.returning, t, frame);
}

// ---- UPDATE, DELETE
export function update(k: Check, ast: Update): ResultColumn[] | null {
  const t = target(k, ast.table, ast);
  if (!t) return null;
  const frame = k.inScope(ast, [sourceOf(t, ast.alias)]);
  assigns(k, ast.set, t, [frame]);
  if (ast.where) ty(k, ast.where, [frame], NO_AGGREGATE);
  return returning(k, ast.returning, t, frame);
}
export function del(k: Check, ast: Delete): ResultColumn[] | null {
  const t = target(k, ast.table, ast);
  if (!t) return null;
  const frame = k.inScope(ast, [sourceOf(t, ast.alias)]);
  if (ast.where) ty(k, ast.where, [frame], NO_AGGREGATE);
  return returning(k, ast.returning, t, frame);
}

// ---- the statements that build the schema
// a literal DEFAULT, stored into its column
const storeDefault = (k: Check, t: TableFacts, col: ColFacts, value: Expr | undefined): void => {
  if (value?.k === 'lit') store(k, t, col, { e: value, t: ty(k, value, [], {}) }, 'the DEFAULT of');
};
/** CHECK constraints and DEFAULT values, against the table itself (made on a copy of the schema). */
export function createTable(k: Check, ast: CreateTable): void {
  const scratch = cloneSchema(k.schema),
    refused = applyToSchema(scratch, ast),
    t = scratch.tables.get(lc(ast.table));
  if (refused || !t) return;
  const frame = [sourceOf(t, null)];
  for (const c of t.checks) ty(k, c, [frame], {});
  for (const d of ast.cols) {
    const col = t.cols.find(c => c.name === d.name);
    if (col) storeDefault(k, t, col, d.default);
  }
}
export function createIndex(k: Check, ast: CreateIndex): void {
  const t = k.table(ast.table);
  if (!t) return;
  const frame = [sourceOf(t, null)];
  for (const c of ast.cols) ty(k, c.expr, [frame], {});
  if (ast.where) ty(k, ast.where, [frame], {});
}
/** ADD COLUMN: its DEFAULT, and its CHECKs against the table as it will be (a copy with the column added). */
export function alter(k: Check, ast: Alter): void {
  const t = ast.action === 'add_column' ? k.table(ast.table) : undefined;
  if (ast.action !== 'add_column' || !t) return;
  storeDefault(k, t, columnOf(ast.col), ast.col.default);
  const scratch = cloneSchema(k.schema),
    made = applyToSchema(scratch, ast) ? undefined : scratch.tables.get(lc(ast.table));
  if (made) for (const c of ast.col.checks) ty(k, c, [[sourceOf(made, null)]], {});
}
