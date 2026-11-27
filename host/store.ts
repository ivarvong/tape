// host/store.ts: the host's bookkeeping, outside the program's Sql. A program's Sql reaches only the tables that
// program created. Replies, timers, applied migrations and the effect log live here: in a Durable Object, in
// ctx.storage.kv (a hidden table the SQL API cannot read); in Node and the browser, in a memory map the program's
// connection never sees. Writes go through the same transaction as the program's SQL (transactionSync in workerd;
// a journal around sql.transaction here), so a trap mid-way keeps neither.
import type { Sql } from './log.ts';
import { cellText } from './log.ts';

export type Transaction = <T>(f: () => T) => T;
/** No transaction: the stretch just runs. */
export const direct: Transaction = f => f();

const bySql = new WeakMap<Sql, HostStore>();

const HOST_STORE = Symbol('HostStore');

/** The host's store: not a Sql, and not constructible except by durableStore and memoryStore. */
export type HostStore = {
  readonly kind: typeof HOST_STORE;
  get(key: string): unknown;
  put(key: string, value: unknown): void;
  delete(key: string): boolean;
  list(prefix: string): Iterable<[string, unknown]>;
  /** Compose this store into a SQL or storage transaction so both commit or roll back. */
  transact(outer: Transaction): Transaction;
};

type Kv = {
  get(key: string): unknown;
  put(key: string, value: unknown): void;
  delete(key: string): boolean;
  list(options?: { prefix?: string }): Iterable<[string, unknown]>;
};

/** The Durable Object's synchronous KV (ctx.storage.kv). Its writes join sql.exec in transactionSync. */
export function durableStore(kv: Kv): HostStore {
  return {
    kind: HOST_STORE,
    get: key => kv.get(key),
    put: (key, value) => {
      kv.put(key, value);
    },
    delete: key => kv.delete(key),
    list: prefix => kv.list({ prefix }),
    transact: outer => outer,
  };
}

/** An in-memory host store for Node and the browser. transact() journals mutations until the outer transaction
 * returns, and restores them if it throws, so the store and the program's SQL stay together. */
export function memoryStore(): HostStore {
  const data = new Map<string, unknown>();
  let depth = 0;
  const journal = new Map<string, { had: boolean; prev: unknown }>();
  const remember = (key: string): void => {
    if (depth > 0 && !journal.has(key)) journal.set(key, { had: data.has(key), prev: data.get(key) });
  };
  const store: HostStore = {
    kind: HOST_STORE,
    get: key => data.get(key),
    put: (key, value) => {
      remember(key);
      data.set(key, value);
    },
    delete: key => {
      remember(key);
      return data.delete(key);
    },
    list: prefix =>
      [...data.entries()].filter(([k]) => k.startsWith(prefix)).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    // Begin before `outer` runs and commit only after it returns, so a throw in the same
    // sql.transaction after the stretch (a storage fault at commit) rolls the store back too.
    transact: outer => f => {
      depth++;
      try {
        const r = outer(f);
        depth--;
        if (depth === 0) journal.clear();
        return r;
      } catch (e) {
        depth--;
        if (depth === 0) {
          for (const [key, { had, prev }] of journal) {
            if (had) data.set(key, prev);
            else data.delete(key);
          }
          journal.clear();
        }
        throw e;
      }
    },
  };
  return store;
}

// ---- records the host keeps

export type CallRecord = { status: string; body: string; message: string | null };
export type WakeRecord = { due: number; trace: string | null; span: string; tries: number };
export type MigrationRow = { version: number; name: string; hash: string; applied_at: number };
export type HostLogRow = {
  id: string;
  version: number;
  request: Uint8Array;
  effects: string;
  at: number;
  seq: number;
};

const CALL = 'call/';
const WAKE = 'wake/';
const MIGRATIONS = 'migrations';
const LOG_SEQ = 'log/seq';
const LOG_ID = 'log/id/';
const LOG_ORD = 'log/ord/';

const fieldsOf = (v: unknown): Record<string, unknown> | undefined => {
  if (typeof v !== 'object' || v === null) return undefined;
  return Object.fromEntries(Object.entries(v));
};

const asRecord = <T>(
  v: unknown,
  ok: (x: Record<string, unknown>) => x is T & Record<string, unknown>,
): T | undefined => {
  const row = fieldsOf(v);
  return row && ok(row) ? row : undefined;
};

const isCall = (r: Record<string, unknown>): r is CallRecord =>
  typeof r['status'] === 'string' &&
  typeof r['body'] === 'string' &&
  (r['message'] === null || typeof r['message'] === 'string');

const isWake = (r: Record<string, unknown>): r is WakeRecord =>
  typeof r['due'] === 'number' &&
  (r['trace'] === null || typeof r['trace'] === 'string') &&
  typeof r['span'] === 'string' &&
  typeof r['tries'] === 'number';

const isMigration = (r: Record<string, unknown>): r is MigrationRow =>
  typeof r['version'] === 'number' &&
  typeof r['name'] === 'string' &&
  typeof r['hash'] === 'string' &&
  typeof r['applied_at'] === 'number';

const bytesOf = (v: unknown): Uint8Array | undefined => {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return undefined;
};

const isLog = (r: Record<string, unknown>): r is Omit<HostLogRow, 'request'> & { request: Uint8Array } => {
  const request = bytesOf(r['request']);
  if (
    typeof r['id'] !== 'string' ||
    typeof r['version'] !== 'number' ||
    request === undefined ||
    typeof r['effects'] !== 'string' ||
    typeof r['at'] !== 'number' ||
    typeof r['seq'] !== 'number'
  )
    return false;
  r['request'] = request;
  return true;
};

export const getCall = (store: HostStore, key: string): CallRecord | undefined =>
  asRecord(store.get(CALL + key), isCall);

export const putCall = (store: HostStore, key: string, row: CallRecord): void => {
  store.put(CALL + key, row);
};

export const deleteCall = (store: HostStore, key: string): boolean => store.delete(CALL + key);

export const callRows = (store: HostStore): { key: string; status: string; body: string; message: string | null }[] =>
  [...store.list(CALL)].flatMap(([k, v]) => {
    const row = asRecord(v, isCall);
    return row ? [{ key: k.slice(CALL.length), ...row }] : [];
  });

export const getWake = (store: HostStore, key: number): WakeRecord | undefined =>
  asRecord(store.get(WAKE + String(key)), isWake);

export const putWake = (store: HostStore, key: number, row: WakeRecord): void => {
  store.put(WAKE + String(key), row);
};

export const deleteWake = (store: HostStore, key: number): boolean => store.delete(WAKE + String(key));

export const wakeRows = (
  store: HostStore,
): { key: number; due: number; trace: string | null; span: string; tries: number }[] =>
  [...store.list(WAKE)]
    .flatMap(([k, v]) => {
      const row = asRecord(v, isWake);
      const key = Number(k.slice(WAKE.length));
      return row && Number.isSafeInteger(key) ? [{ key, ...row }] : [];
    })
    .toSorted((a, b) => a.due - b.due || a.key - b.key);

export const dueWakes = (store: HostStore, now: number): number[] =>
  wakeRows(store)
    .filter(w => w.due <= now)
    .map(w => w.key);

export const nextWakeDue = (store: HostStore): number | null => {
  const [first] = wakeRows(store);
  return first === undefined ? null : first.due;
};

export const getMigrations = (store: HostStore): MigrationRow[] => {
  const v = store.get(MIGRATIONS);
  if (!Array.isArray(v)) return [];
  return v.flatMap(row => {
    if (typeof row !== 'object' || row === null) return [];
    const got = asRecord(row, isMigration);
    return got ? [got] : [];
  });
};

export const setMigrations = (store: HostStore, rows: readonly MigrationRow[]): void => {
  store.put(MIGRATIONS, [...rows]);
};

export const appendMigration = (store: HostStore, row: MigrationRow): void => {
  setMigrations(store, [...getMigrations(store), row]);
};

const padSeq = (n: number): string => n.toString(16).padStart(16, '0');

export const getLog = (store: HostStore, id: string): HostLogRow | undefined => asRecord(store.get(LOG_ID + id), isLog);

export const putLogRow = (store: HostStore, row: HostLogRow): void => {
  store.put(LOG_ID + row.id, row);
  store.put(LOG_ORD + padSeq(row.seq), row.id);
};

export const recordLog = (
  store: HostStore,
  version: number,
  request: Uint8Array,
  effects: string,
  at = Date.now(),
): string => {
  const prev = store.get(LOG_SEQ);
  const seq = (typeof prev === 'number' ? prev : 0) + 1;
  const id = crypto.randomUUID();
  store.put(LOG_SEQ, seq);
  putLogRow(store, { id, version, request, effects, at, seq });
  return id;
};

export const updateLogEffects = (store: HostStore, id: string, effects: string): void => {
  const row = getLog(store, id);
  if (row) putLogRow(store, { ...row, effects });
};

const logsInOrder = (store: HostStore): HostLogRow[] =>
  [...store.list(LOG_ORD)].flatMap(([, id]) => (typeof id === 'string' ? (getLog(store, id) ?? []) : []));

export const logStats = (store: HostStore): { rows: number; bytes: number } => {
  const rows = logsInOrder(store);
  return {
    rows: rows.length,
    bytes: rows.reduce((n, r) => n + r.request.byteLength + r.effects.length, 0),
  };
};

export const requestHeads = (store: HostStore, ids: readonly string[]): Record<string, string> => {
  const dec = new TextDecoder();
  const out: Record<string, string> = {};
  for (const id of ids) {
    const row = getLog(store, id);
    if (row) out[id] = dec.decode(row.request.subarray(0, 4096));
  }
  return out;
};

export const logsSince = (store: HostStore, since: number): HostLogRow[] =>
  logsInOrder(store).filter(r => r.at >= since);

/** Keep the newest `keep` logs; returns how many were removed and the newest `at` among them. */
export const pruneLogs = (store: HostStore, keep: number): { deleted: number; at: number | null } => {
  const rows = logsInOrder(store);
  const cut = rows.length - keep;
  if (cut <= 0) return { deleted: 0, at: null };
  const gone = rows.slice(0, cut);
  for (const r of gone) {
    store.delete(LOG_ID + r.id);
    store.delete(LOG_ORD + padSeq(r.seq));
  }
  const last = gone.at(-1);
  return { deleted: gone.length, at: last === undefined ? null : last.at };
};

const tableExists = (sql: Sql, name: string): boolean =>
  sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1", name).toArray().length > 0;

const columnsOf = (sql: Sql, table: string): Set<string> =>
  new Set(
    sql
      .exec(`SELECT name FROM pragma_table_info(?1)`, table)
      .toArray()
      .map(r => cellText(r['name'])),
  );

/** Copy host rows out of a program-visible SQLite (an object made before this split) into the store, then drop
 * those tables so a later program table of the same name is only the program's. */
export function importHostTables(sql: Sql, store: HostStore): void {
  if (tableExists(sql, '_calls')) {
    const cols = columnsOf(sql, '_calls');
    const hasMessage = cols.has('message');
    const q = hasMessage ? 'SELECT key, status, body, message FROM _calls' : 'SELECT key, status, body FROM _calls';
    for (const r of sql.exec(q).toArray()) {
      const key = cellText(r['key']);
      if (getCall(store, key) === undefined)
        putCall(store, key, {
          status: cellText(r['status']),
          body: cellText(r['body']),
          message: hasMessage && r['message'] !== undefined && r['message'] !== null ? cellText(r['message']) : null,
        });
    }
    sql.exec('DROP TABLE _calls');
  }
  if (tableExists(sql, '_wakes')) {
    const cols = columnsOf(sql, '_wakes');
    const hasTries = cols.has('tries');
    for (const r of sql.exec('SELECT key, due, trace, span FROM _wakes').toArray()) {
      const key = Number(r['key']);
      if (!Number.isSafeInteger(key) || getWake(store, key) !== undefined) continue;
      const tries = hasTries
        ? Number(sql.exec('SELECT tries FROM _wakes WHERE key = ?1', key).toArray()[0]?.['tries'])
        : 0;
      putWake(store, key, {
        due: Number(r['due']),
        trace: r['trace'] === undefined || r['trace'] === null ? null : cellText(r['trace']),
        span: cellText(r['span']),
        tries: Number.isFinite(tries) ? tries : 0,
      });
    }
    sql.exec('DROP TABLE _wakes');
  }
  if (tableExists(sql, 'schema_migrations') && getMigrations(store).length === 0) {
    setMigrations(
      store,
      sql
        .exec('SELECT version, name, hash, applied_at FROM schema_migrations ORDER BY version')
        .toArray()
        .flatMap(r => {
          const version = Number(r['version']);
          const applied_at = Number(r['applied_at']);
          if (!Number.isFinite(version) || !Number.isFinite(applied_at)) return [];
          return [{ version, name: cellText(r['name']), hash: cellText(r['hash']), applied_at }];
        }),
    );
    sql.exec('DROP TABLE schema_migrations');
  } else if (tableExists(sql, 'schema_migrations')) {
    sql.exec('DROP TABLE schema_migrations');
  }
  if (tableExists(sql, '_tape_log')) {
    const existing = new Set(logsInOrder(store).map(r => r.id));
    const rows = sql.exec('SELECT id, version, request, effects, at FROM _tape_log ORDER BY rowid').toArray();
    for (const r of rows) {
      const id = cellText(r['id']);
      if (existing.has(id)) continue;
      const request = bytesOf(r['request']);
      const version = Number(r['version']);
      const at = Number(r['at']);
      if (request === undefined || !Number.isFinite(version) || !Number.isFinite(at)) continue;
      const prev = store.get(LOG_SEQ);
      const seq = (typeof prev === 'number' ? prev : 0) + 1;
      store.put(LOG_SEQ, seq);
      putLogRow(store, { id, version, request, effects: cellText(r['effects']), at, seq });
    }
    sql.exec('DROP TABLE _tape_log');
  }
}

/** A transaction that rolls back both the program's SQL (a savepoint) and a memory host store. */
export const storeSavepoint = (sql: Sql, store: HostStore): Transaction =>
  store.transact(f => {
    sql.exec('SAVEPOINT tape_migrate');
    try {
      const r = f();
      sql.exec('RELEASE tape_migrate');
      return r;
    } catch (e) {
      sql.exec('ROLLBACK TO tape_migrate');
      sql.exec('RELEASE tape_migrate');
      throw e;
    }
  });

export const withStore = (store: HostStore, transaction: Transaction = direct): Transaction =>
  store.transact(transaction);

/** The host store for this database: the one passed in, or the same memory store for the same Sql object, so a
 * second instantiate on a Node database sees the migrations and replies the first one wrote. */
export function storeFor(sql: Sql | undefined, given?: HostStore): HostStore {
  if (given) return given;
  if (!sql) return memoryStore();
  const had = bySql.get(sql);
  if (had) return had;
  const made = memoryStore();
  bySql.set(sql, made);
  return made;
}
