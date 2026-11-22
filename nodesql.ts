// A stand-in for ctx.storage.sql over node:sqlite, for fast local iteration only (the workerd suite is the test).
// exec(query, ...params) returns a cursor with raw(), toArray(), one() and rowsWritten.
import './node25.ts';
import { DatabaseSync, type SQLOutputValue, type StatementSync } from 'node:sqlite';
import type { Cell, Sql } from './host/log.ts';
import type { Transaction } from './host/schema.ts';

type Row = Record<string, SQLOutputValue>;
/** The host's Sql, and more: it takes any cell as a parameter (a blob copied between databases). */
export type NodeSql = { exec: (query: string, ...params: Cell[]) => ReturnType<Sql['exec']>; transaction: Transaction };
export function nodeSql(): NodeSql {
  const db = new DatabaseSync(':memory:'),
    cache = new Map<string, StatementSync>(),
    changes = db.prepare('SELECT changes()');
  const prep = (q: string): StatementSync => {
    const made = cache.get(q) ?? db.prepare(q);
    cache.set(q, made);
    return made;
  };
  return {
    // like ctx.storage.transactionSync: undo everything f wrote if it throws
    transaction<T>(f: () => T): T {
      db.exec('BEGIN');
      try {
        const r = f();
        db.exec('COMMIT');
        return r;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    exec(q: string, ...given: Cell[]) {
      const st = prep(q),
        cols = st.columns(),
        params = given.map(p => (p instanceof ArrayBuffer ? new Uint8Array(p) : p));
      const rows: Row[] = cols.length > 0 ? st.all(...params) : (st.run(...params), []);
      const written = Number(Object.values(changes.get() ?? {})[0] ?? 0);
      const arrays = rows.map(r => cols.map(c => r[c.name] ?? null));
      return {
        rowsWritten: written,
        raw: () => arrays.values(),
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw new Error('one(): not exactly one row');
          return rows[0];
        },
      };
    },
  };
}
