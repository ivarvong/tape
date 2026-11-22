// sql/parse/write.ts: INSERT, UPDATE and DELETE.
import type { Assign, Delete, Expr, Insert, OnConflict, Select, Update, Upsert, ValuesRow } from '../ast.ts';
import { type Cursor, column, keyColumn } from './cursor.ts';
import { expr, resultCol, select } from './query.ts';

const ON_CONFLICT = ['REPLACE', 'IGNORE', 'ABORT', 'FAIL', 'ROLLBACK'] as const satisfies readonly OnConflict[];
// REPLACE, IGNORE, … after OR
function conflictWord(c: Cursor): OnConflict {
  const word = ON_CONFLICT.find(w => c.peek().v === w);
  if (!word) return c.fail('expected REPLACE, IGNORE, ABORT, FAIL or ROLLBACK');
  c.skip();
  return word;
}
const returning = (c: Cursor) => (c.eatKw('RETURNING') ? c.list(resultCol) : null);
const where = (c: Cursor): Expr | null => (c.eatKw('WHERE') ? expr(c) : null);

// ---- INSERT
export function insert(c: Cursor): Insert {
  const s = c.peek().s,
    replace = !!c.eatKw('REPLACE');
  if (!replace) c.kw('INSERT');
  const or: OnConflict | null = replace ? 'REPLACE' : c.eatKw('OR') ? conflictWord(c) : null;
  c.kw('INTO');
  const table = c.tableName(),
    alias = c.alias(false),
    cols = c.isOp('(') ? c.parenList(column) : null,
    source = insertSource(c),
    upsert = c.isKw('ON') && c.isKw('CONFLICT', 1) ? upsertClause(c) : null,
    rest = { or, replace, table, alias, cols, ...source, upsert, returning: returning(c) };
  return { k: 'insert', ...c.span(s), ...rest };
}
// what an INSERT inserts: DEFAULT VALUES, rows of VALUES, or a SELECT
function insertSource(c: Cursor): { values: ValuesRow[] | null; select: Select | null; defaults: boolean } {
  if (c.eatKw('DEFAULT')) {
    c.kw('VALUES');
    return { values: null, select: null, defaults: true };
  }
  if (c.eatKw('VALUES')) return { values: c.list(valuesRow), select: null, defaults: false };
  if (c.isKw('SELECT')) return { values: null, select: select(c), defaults: false };
  if (c.isKw('WITH')) c.refuse('a WITH clause (common table expression)');
  return c.fail('expected VALUES, SELECT or DEFAULT VALUES');
}
function valuesRow(c: Cursor): ValuesRow {
  const s = c.peek().s;
  return Object.assign(c.parenList(expr), { s });
}
// ON CONFLICT [(target) [WHERE …]] DO NOTHING | DO UPDATE SET … [WHERE …]
function upsertClause(c: Cursor): Upsert {
  const s = c.peek().s;
  c.skip(2);
  const target = c.isOp('(') ? c.parenList(keyColumn) : null,
    targetWhere = target ? where(c) : null;
  c.kw('DO');
  const nothing = !!c.eatKw('NOTHING');
  if (!nothing) {
    c.kw('UPDATE');
    c.kw('SET');
  }
  const set = nothing ? [] : assignments(c),
    cond = nothing ? null : where(c),
    upsert: Upsert = nothing
      ? { k: 'upsert', ...c.span(s), target, targetWhere, action: 'nothing', set, where: cond }
      : { k: 'upsert', ...c.span(s), target, targetWhere, action: 'update', set, where: cond };
  if (c.isKw('ON') && c.isKw('CONFLICT', 1)) c.refuse('a second ON CONFLICT clause');
  return upsert;
}

// ---- SET
function assignments(c: Cursor): Assign[] {
  return c.list(assignment).flat();
}
// `col = expr`, or `(a, b) = (x, y)` as one assignment for each column
function assignment(c: Cursor): Assign[] {
  const s = c.peek().s;
  if (c.isOp('(')) return rowAssignment(c, s);
  const col = column(c);
  if (c.isOp('.')) c.refuse('a qualified column in a SET list');
  c.op('=');
  const value = expr(c);
  return [{ k: 'assign', ...c.span(s), col, expr: value }];
}
function rowAssignment(c: Cursor, s: number): Assign[] {
  const cols = c.parenList(column);
  c.op('=');
  const rs = c.peek().s;
  if (!c.eatOp('(')) c.refuse('a row-value SET whose value is not a parenthesised list', c.peek());
  if (c.isKw('SELECT')) c.refuse('a row-value SET from a subquery');
  const vals = c.list(expr);
  c.op(')');
  if (vals.length !== cols.length)
    c.fail(`the SET list names ${cols.length} columns and gives ${vals.length} values`, c.last());
  const span = c.span(s);
  return vals.flatMap((value, i): Assign[] => {
    const col = cols[i];
    return col === undefined ? [] : [{ k: 'assign', ...span, col, expr: value, row: true, rs }];
  });
}

// ---- UPDATE, DELETE
export function update(c: Cursor): Update {
  const s = c.peek().s;
  c.kw('UPDATE');
  const or = c.eatKw('OR') ? conflictWord(c) : null,
    table = c.tableName(),
    alias = c.alias(true);
  if (c.isAnyKw('INDEXED', 'NOT')) c.refuse('INDEXED BY');
  c.kw('SET');
  const set = assignments(c);
  if (c.isKw('FROM')) c.refuse('UPDATE … FROM: name the other table in a subquery');
  const rest = { or, table, alias, set, where: where(c), returning: returning(c) };
  if (c.isAnyKw('ORDER', 'LIMIT')) c.refuse(`UPDATE … ${c.peek().v}`);
  return { k: 'update', ...c.span(s), ...rest };
}
export function del(c: Cursor): Delete {
  const s = c.peek().s;
  c.kw('DELETE');
  c.kw('FROM');
  const table = c.tableName(),
    alias = c.alias(true);
  if (c.isAnyKw('INDEXED', 'NOT')) c.refuse('INDEXED BY');
  const rest = { table, alias, where: where(c), returning: returning(c) };
  if (c.isAnyKw('ORDER', 'LIMIT')) c.refuse(`DELETE … ${c.peek().v}`);
  return { k: 'delete', ...c.span(s), ...rest };
}
