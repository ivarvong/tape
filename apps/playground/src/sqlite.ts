// apps/playground/src/sqlite.ts: the page's SQLite. It stands where nodesql.ts stands in Node (the build maps
// every import of nodesql.ts here), over sql.js (SQLite compiled to Wasm, vendor/), and behaves as nodesql.ts does
// over node:sqlite, so a request run in the page writes the same effect log as `tape` on the command line.
//
// One difference had to be undone. node:sqlite binds every JavaScript number as REAL (`SELECT typeof(?1)` with 7
// is 'real'); sql.js binds an integer that fits in 32 bits as INTEGER and any other number as REAL. So each `?N`
// that is given a number is read as `(?N * 1.0)`: REAL, the same value, and (an arithmetic result) no affinity,
// as a bound parameter has none. test.ts runs every preset through both and compares the logs.
import type { Cell, Sql } from '../../../host/log.ts';
import type { Transaction } from '../../../host/schema.ts';

/** sql.js's Database and Statement, as far as this file uses them. */
type SqlJsStatement = {
  bind: (values: unknown[]) => boolean;
  step: () => boolean;
  get: () => unknown[];
  getColumnNames: () => string[];
  reset: () => void;
  free: () => void;
};
type SqlJsDatabase = {
  prepare: (sql: string) => SqlJsStatement;
  exec: (sql: string) => unknown;
  export: () => Uint8Array;
  close: () => void;
};
export type SqlJs = { Database: new (file?: Uint8Array) => SqlJsDatabase };
export type InitSqlJs = (config: { wasmBinary: ArrayBuffer }) => Promise<SqlJs>;

/**
 * The host's Sql, and more, as nodesql.ts has it; and close(), which frees the database's memory in sql.js's heap
 * (the page drops a database and lets it go; a Worker that makes one per call must free each: mcp/).
 */
export type NodeSql = {
  exec: (query: string, ...params: Cell[]) => ReturnType<Sql['exec']>;
  transaction: Transaction;
  close: () => void;
};

let SQL: SqlJs | null = null;

/** Start SQLite: sql.js's loader and the bytes of its Wasm (fetched by the page, checked against their hash). */
export async function loadSqlite(init: InitSqlJs, wasm: ArrayBuffer): Promise<void> {
  SQL ??= await init({ wasmBinary: wasm });
}
export const sqliteReady = (): boolean => SQL !== null;

/**
 * Where the parameters of a statement are (`?N`, or a bare `?`): [offset, length, number]. Quoted text ('…', "…", `…`, […]) and
 * comments are skipped, so a `?1` inside them is not one.
 */
export function parameters(sql: string): [number, number, number][] {
  const found: [number, number, number][] = [];
  let largest = 0;
  for (let i = 0; i < sql.length;) {
    const c = sql[i] ?? '';
    const close = c === "'" ? "'" : c === '"' ? '"' : c === '`' ? '`' : c === '[' ? ']' : null;
    if (close !== null) {
      // a doubled quote inside quoted text is one quote; the scan reads it as a close and an open
      const end = sql.indexOf(close, i + 1);
      i = end < 0 ? sql.length : end + 1;
    } else if (c === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length : end + 1;
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 2;
    } else if (c === '?') {
      // `?N` is parameter N; a bare `?` is one more than the largest number given so far (SQLite's rule)
      let j = i + 1;
      while (j < sql.length && /[0-9]/.test(sql[j] ?? '')) j++;
      const n = j > i + 1 ? Number(sql.slice(i + 1, j)) : largest + 1;
      largest = Math.max(largest, n);
      found.push([i, j - i, n]);
      i = j;
    } else i++;
  }
  return found;
}

/** The statement as sql.js must run it to bind the numbers among `params` as node:sqlite does: as REAL. */
export function realBound(sql: string, params: readonly unknown[]): string {
  let out = '',
    at = 0;
  for (const [from, length, n] of parameters(sql)) {
    if (typeof params[n - 1] !== 'number') continue;
    out += `${sql.slice(at, from)}(${sql.slice(from, from + length)} * 1.0)`;
    at = from + length;
  }
  return at === 0 ? sql : out + sql.slice(at);
}

const cell = (v: unknown): unknown => (v instanceof ArrayBuffer ? new Uint8Array(v) : v);
/** A value sql.js read back, as a Cell: it gives a number, text, bytes or null (undefined for a missing column). */
const asCell = (v: unknown): Cell => {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'bigint' || v instanceof Uint8Array) return v;
  throw new Error(`sql.js gave a value that is not a cell: ${typeof v}`);
};

// sql.js keeps every open database as an open file, and Emscripten's file table holds 4096: the 4094th database
// not closed is "unable to open database file". The simulator makes a database for each program of each run and
// one for each check of an invariant `with` another program, and closes none (node:sqlite's are collected), so
// Simulate on Orders + stock and on Fulfillment failed within their first 300 runs, and on any example after
// enough of them (24 November 2026). So at most OPEN_MAX databases are open at once: past that the one used
// longest ago, outside a transaction, is put away as its file's bytes (collected with it if nothing asks again)
// and opened from them when it is next asked.
export const OPEN_MAX = 64;
type Held = { db: SqlJsDatabase | null; file: Uint8Array | null; cache: Map<string, SqlJsStatement>; busy: number };
/** the databases open now, the one used longest ago first */
const held = new Set<Held>();
function putAway(h: Held): void {
  if (!h.db) return;
  for (const st of h.cache.values()) st.free();
  h.cache.clear();
  h.file = h.db.export();
  h.db.close();
  h.db = null;
  held.delete(h);
}

/** A fresh, empty in-memory database with nodeSql()'s interface. */
export function nodeSql(): NodeSql {
  if (!SQL) throw new Error('SQLite has not loaded in this page yet');
  const sqljs = SQL;
  const me: Held = { db: null, file: null, cache: new Map(), busy: 0 },
    cache = me.cache;
  /** this database, open, and the last one used */
  const open = (): SqlJsDatabase => {
    me.db ??= me.file ? new sqljs.Database(me.file) : new sqljs.Database();
    me.file = null;
    held.delete(me);
    held.add(me);
    if (held.size > OPEN_MAX)
      for (const h of held)
        if (h !== me && h.busy === 0) {
          putAway(h);
          break;
        }
    return me.db;
  };
  open();
  // the rows a statement wrote, as nodesql.ts counts them: how far total_changes() moved while it ran
  // (getRowsModified() is changes(), the last write's count, which a read after it leaves as it was)
  const changed = (): number => {
    const st = prep('SELECT total_changes()');
    try {
      st.step();
      return Number(st.get()[0] ?? 0);
    } finally {
      st.reset();
    }
  };
  const prep = (q: string): SqlJsStatement => {
    const db = open();
    const made = cache.get(q) ?? db.prepare(q);
    cache.set(q, made);
    return made;
  };
  return {
    close() {
      for (const st of cache.values()) st.free();
      cache.clear();
      me.db?.close();
      me.db = null;
      me.file = null;
      held.delete(me);
    },
    // like ctx.storage.transactionSync: undo everything f wrote if it throws
    transaction<T>(f: () => T): T {
      const db = open();
      me.busy++;
      try {
        db.exec('BEGIN');
        try {
          const r = f();
          db.exec('COMMIT');
          return r;
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      } finally {
        me.busy--;
      }
    },
    exec(q: string, ...given: Cell[]) {
      const params = given.map(cell),
        st = prep(realBound(q, params)),
        before = changed();
      const arrays: Cell[][] = [];
      let cols: string[];
      try {
        st.bind(params);
        while (st.step()) arrays.push(st.get().map(asCell));
        cols = st.getColumnNames();
      } finally {
        st.reset();
      }
      const written = changed() - before;
      const rows = arrays.map(a => Object.fromEntries(cols.map((c, i): [string, Cell] => [c, a[i] ?? null])));
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
