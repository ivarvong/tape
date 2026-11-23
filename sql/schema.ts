// sql/schema.ts: the schema that CREATE, ALTER and DROP statements build.
// The tables a list of statements builds, applied in order as SQLite would apply them. Errors are the statements
// SQLite would refuse (a table made twice, a column added twice, a NOT NULL column added with no default …).
import { unreachable } from '../compiler/ast.ts';
import type { Affinity, ColDef, Column, Schema, Statement, Table, Unique } from './ast.ts';
import { lc } from './tokens.ts';

export function affinity(type: string | null | undefined): Affinity {
  const u = (type ?? '').toUpperCase();
  if (u.includes('INT')) return 'int';
  if (/CHAR|CLOB|TEXT/.test(u)) return 'text';
  if (u === '' || u.includes('BLOB')) return 'blob';
  if (/REAL|FLOA|DOUB/.test(u)) return 'real';
  return 'numeric';
}
export function newSchema(): Schema {
  return { tables: new Map(), indexes: new Map() };
}
export function cloneSchema(sc: Schema): Schema {
  const tables = new Map(
    [...sc.tables].map(([k, t]): [string, Table] => [
      k,
      {
        ...t,
        cols: t.cols.map(c => ({ ...c })),
        pk: [...t.pk],
        uniques: t.uniques.map(u => ({ ...u, cols: [...u.cols] })),
        checks: [...t.checks],
      },
    ]),
  );
  return { tables, indexes: new Map([...sc.indexes].map(([k, x]) => [k, { ...x, cols: [...x.cols] }])) };
}
// a column's facts, from its definition
export function columnOf(d: ColDef): Column {
  return {
    name: d.name,
    type: d.type,
    aff: affinity(d.type),
    notNull: d.notNull,
    default: d.default,
    pk: d.pk,
    checks: d.checks,
  };
}
// apply one parsed statement to the schema; returns an error message, or null
/** Apply one statement to the schema, as SQLite would. Gives what SQLite would refuse it with, or null. */
export function applyToSchema(sc: Schema, ast: Statement): string | null {
  const T = (n: string): Table | undefined => sc.tables.get(lc(n));
  const colIn = (t: Table, c: string): Column | undefined => t.cols.find(x => lc(x.name) === lc(c));
  switch (ast.k) {
    case 'create_table': {
      if (T(ast.table)) return ast.ifNot ? null : `table ${ast.table} already exists`;
      const cols = ast.cols.map(columnOf),
        seen = new Set<string>();
      for (const c of cols) {
        if (seen.has(lc(c.name))) return `duplicate column name: ${c.name}`;
        seen.add(lc(c.name));
      }
      let pk = cols.filter(c => c.pk).map(c => c.name);
      if (pk.length > 1) return `table ${ast.table} has more than one primary key`;
      const uniques: Unique[] = [],
        checks = cols.flatMap(c => c.checks);
      for (const d of ast.cols) if (d.unique) uniques.push({ cols: [d.name], index: null });
      for (const k of ast.constraints) {
        if (k.kind === 'pk') {
          if (pk.length > 0) return `table ${ast.table} has more than one primary key`;
          pk = k.cols;
        }
        if (k.kind === 'unique') uniques.push({ cols: k.cols, index: null });
        if (k.kind === 'check') {
          checks.push(k.expr);
          continue;
        }
        for (const c of k.cols)
          if (!cols.some(x => lc(x.name) === lc(c)))
            return `no such column ${c} in ${k.kind === 'pk' ? 'PRIMARY KEY' : k.kind === 'unique' ? 'UNIQUE' : 'FOREIGN KEY'} of ${ast.table}`;
      }
      if (ast.withoutRowid && pk.length === 0) return `PRIMARY KEY missing on table ${ast.table} (WITHOUT ROWID)`;
      pk = pk.map(c => cols.find(x => lc(x.name) === lc(c))?.name ?? c);
      // the rowid alias: a single INTEGER (exactly that type name) PRIMARY KEY column of a rowid table, not DESC
      const one = pk.length === 1 ? cols.find(x => x.name === pk[0]) : null;
      const rowid =
        !ast.withoutRowid &&
        one &&
        one.type.toUpperCase() === 'INTEGER' &&
        ast.cols.find(d => d.name === one.name)?.pkDir !== 'DESC'
          ? one.name
          : null;
      // SQLite (sqlite.org/lang_createtable.html#the_primary_key): a PRIMARY KEY column may hold NULL unless it is
      // the rowid, declared NOT NULL, or of a WITHOUT ROWID or a STRICT table
      for (const c of cols)
        if (c.name === rowid || ((ast.withoutRowid || ast.strict) && pk.includes(c.name))) c.notNull = true;
      if (ast.strict)
        for (const c of cols)
          if (!/^(INT|INTEGER|REAL|TEXT|BLOB|ANY)$/i.test(c.type))
            return `unknown datatype for ${ast.table}.${c.name}: "${c.type}" (STRICT)`;
      sc.tables.set(lc(ast.table), {
        name: ast.table,
        cols,
        pk,
        uniques,
        checks,
        rowid,
        withoutRowid: ast.withoutRowid,
        strict: ast.strict,
      });
      return null;
    }
    case 'create_index': {
      if (sc.indexes.has(lc(ast.name)) || T(ast.name)) return ast.ifNot ? null : `index ${ast.name} already exists`;
      const t = T(ast.table);
      if (!t) return `no such table: ${ast.table}`;
      const cols: (string | null)[] = [];
      for (const ic of ast.cols) {
        if (ic.expr.k === 'col' && !ic.expr.table) {
          const c = colIn(t, ic.expr.name);
          if (!c) return `no such column: ${ic.expr.name} (in index ${ast.name} on ${ast.table})`;
          cols.push(c.name);
        } else cols.push(null); // an expression: not a key of plain columns
      }
      const ix = { name: ast.name, table: t.name, cols, unique: ast.unique, partial: !!ast.where };
      sc.indexes.set(lc(ast.name), ix);
      const plain = cols.filter(c => c !== null);
      if (ast.unique && !ix.partial && plain.length === cols.length) t.uniques.push({ cols: plain, index: ast.name });
      return null;
    }
    case 'alter': {
      const t = T(ast.table);
      if (!t) return `no such table: ${ast.table}`;
      if (ast.action === 'rename_table') {
        if (T(ast.to)) return `there is already another table or index with this name: ${ast.to}`;
        sc.tables.delete(lc(ast.table));
        t.name = ast.to;
        sc.tables.set(lc(ast.to), t);
        for (const ix of sc.indexes.values()) if (lc(ix.table) === lc(ast.table)) ix.table = ast.to;
        return null;
      }
      if (ast.action === 'rename_column') {
        const c = colIn(t, ast.from);
        if (!c) return `no such column: "${ast.from}"`;
        if (colIn(t, ast.to)) return `duplicate column name: ${ast.to}`;
        const r = <N extends string | null>(x: N): N | string => (x && lc(x) === lc(ast.from) ? ast.to : x);
        c.name = ast.to;
        t.pk = t.pk.map(r);
        t.uniques.forEach(u => {
          u.cols = u.cols.map(r);
        });
        if (t.rowid) t.rowid = r(t.rowid);
        for (const ix of sc.indexes.values()) if (lc(ix.table) === lc(t.name)) ix.cols = ix.cols.map(r);
        return null;
      }
      if (ast.action === 'add_column') {
        const d = ast.col,
          c = columnOf(d);
        if (colIn(t, c.name)) return `duplicate column name: ${c.name}`;
        if (d.pk) return 'Cannot add a PRIMARY KEY column';
        if (d.unique) return 'Cannot add a UNIQUE column';
        if (d.notNull && (d.default === undefined || (d.default.k === 'lit' && d.default.v === null)))
          return 'Cannot add a NOT NULL column with default value NULL';
        if (d.default && d.default.paren) return 'Cannot add a column with non-constant default';
        if (d.default?.k === 'fn' && d.default.kwfn) return 'Cannot add a column with non-constant default';
        t.cols.push(c);
        t.checks.push(...c.checks);
        return null;
      }
      if (ast.action === 'drop_column') {
        const c = colIn(t, ast.col);
        if (!c) return `no such column: "${ast.col}"`;
        if (t.pk.some(x => lc(x) === lc(c.name))) return `cannot drop PRIMARY KEY column: "${c.name}"`;
        if (t.uniques.some(u => !u.index && u.cols.some(x => lc(x) === lc(c.name))))
          return `cannot drop UNIQUE column: "${c.name}"`;
        const ix = [...sc.indexes.values()].find(
          x => lc(x.table) === lc(t.name) && x.cols.some(y => y !== null && lc(y) === lc(c.name)),
        );
        if (ix) return `error in index ${ix.name} after drop column: no such column: ${c.name}`;
        if (t.cols.length === 1) return `cannot drop column "${c.name}": no other columns exist`;
        t.cols = t.cols.filter(x => x !== c);
        return null;
      }
      return null;
    }
    case 'drop': {
      if (ast.what === 'table') {
        const t = T(ast.name);
        if (!t) return ast.ifExists ? null : `no such table: ${ast.name}`;
        sc.tables.delete(lc(ast.name));
        for (const [k, ix] of sc.indexes) if (lc(ix.table) === lc(t.name)) sc.indexes.delete(k);
        return null;
      }
      const ix = sc.indexes.get(lc(ast.name));
      if (!ix) return ast.ifExists ? null : `no such index: ${ast.name}`;
      sc.indexes.delete(lc(ast.name));
      const t = T(ix.table);
      if (t) t.uniques = t.uniques.filter(u => lc(u.index ?? '') !== lc(ix.name));
      return null;
    }
    case 'select':
    case 'insert':
    case 'update':
    case 'delete':
      return null;
    default:
      return unreachable(ast, 'statement');
  }
}
