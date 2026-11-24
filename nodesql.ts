// A stand-in for ctx.storage.sql over node:sqlite, for fast local iteration only (the workerd suite is the test).
// exec(query, ...params) returns a cursor with raw(), toArray(), one(), rowsWritten and, for a statement that returns
// no columns, changes.
import './node25.ts';
import { DatabaseSync, type SQLOutputValue, type StatementSync } from 'node:sqlite';
import type { Cell, Sql } from './host/log.ts';
import type { Transaction } from './host/schema.ts';

type Row = Record<string, SQLOutputValue>;
/** a statement that makes a trigger, or a table with a foreign key (its ON DELETE actions): writes not a statement's own.
 * (A query that only reads sqlite_master for triggers, as the host's machine check does, is not one.) */
const AUXILIARY = /^\s*(CREATE|ALTER)\b[\s\S]*\b(TRIGGER|REFERENCES)\b/i;
const READ = /^\s*SELECT\b/i;
// changes() is the last INSERT, UPDATE or DELETE's count: after any other statement it is still that one's
const WRITE = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i;
/** The host's Sql, and more: it takes any cell as a parameter (a blob copied between databases). */
export type NodeSql = { exec: (query: string, ...params: Cell[]) => ReturnType<Sql['exec']>; transaction: Transaction };
export function nodeSql(): NodeSql {
  const db = new DatabaseSync(':memory:'),
    cache = new Map<string, StatementSync>(),
    // the rows a statement wrote: how far SQLite's count of rows written since the database opened moved while it
    // ran. changes() would be the last write's count, and stays so through the reads after it
    total = db.prepare('SELECT total_changes() AS n'),
    changed = (): number => Number(total.get()?.['n'] ?? 0);
  // Until a trigger or a foreign key is made (whose writes are not the statement's own), a statement's own count is
  // the rows it wrote: an INSERT, UPDATE or DELETE's changes from run(), or none for a SELECT. Then total_changes() is not asked before and after it,
  // two more statements for each one (11-14% of the time of the suite's SQL workloads, on both sides, in CPU
  // profiles of 2026-11-23). This is the stand-in only: Durable Object SQLite counts in its own way.
  let auxiliary = false;
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
      if (AUXILIARY.test(q)) auxiliary = true;
      const st = prep(q),
        cols = st.columns(),
        params = given.map(p => (p instanceof ArrayBuffer ? new Uint8Array(p) : p)),
        own = !auxiliary && ((cols.length === 0 && WRITE.test(q)) || READ.test(q)),
        before = own ? 0 : changed();
      const ran = cols.length > 0 ? null : st.run(...params);
      const rows: Row[] = ran ? [] : st.all(...params);
      const written = own ? Number(ran?.changes ?? 0) : changed() - before;
      const arrays = rows.map(r => cols.map(c => r[c.name] ?? null));
      return {
        rowsWritten: written,
        // sqlite3_changes() after the statement, what `SELECT changes()` would read next
        ...(ran ? { changes: Number(ran.changes) } : {}),
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
