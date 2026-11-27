// SQLite-backed Durable Object storage: a synchronous KV write (ctx.storage.kv) and a SQL write
// (ctx.storage.sql.exec) in the same object must commit or roll back together. The host will store
// idempotent replies and the effect log in KV, and the program's tables in SQL; a handler that traps
// mid-way must leave neither. Cloudflare documents this as one transaction:
//   https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
//   https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
// This file is the local proof, in the service's workerd/miniflare harness, before host state moves
// into KV. If a path here fails, that move must not ship.
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const stub = (n: string) => env.NAMES.get(env.NAMES.idFromName(`atomicity/${n}`));

type Observed = {
  rows: unknown[];
  ok: unknown;
  fail: unknown;
};

const prepare = (name: string): Promise<void> =>
  runInDurableObject(stub(name), (_, state) => {
    state.storage.sql.exec('CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY, n INTEGER NOT NULL)');
  });

const observe = (name: string): Promise<Observed> =>
  runInDurableObject(stub(name), (_, state) => ({
    rows: state.storage.sql.exec('SELECT id, n FROM items ORDER BY id').toArray(),
    ok: state.storage.kv.get('reply:ok'),
    fail: state.storage.kv.get('reply:fail'),
  }));

describe('SQL and storage.kv in one Durable Object', () => {
  it('transactionSync commits both when the callback returns', async () => {
    await prepare('tx-ok');
    await runInDurableObject(stub('tx-ok'), (_, state) => {
      state.storage.transactionSync(() => {
        state.storage.sql.exec("INSERT INTO items(id, n) VALUES ('ok', 1)");
        state.storage.kv.put('reply:ok', 'committed');
      });
    });
    expect(await observe('tx-ok')).toEqual({ rows: [{ id: 'ok', n: 1 }], ok: 'committed', fail: undefined });
  });

  it('transactionSync rolls both back when the callback throws mid-way', async () => {
    await prepare('tx-fail');
    await runInDurableObject(stub('tx-fail'), (_, state) => {
      state.storage.transactionSync(() => {
        state.storage.sql.exec("INSERT INTO items(id, n) VALUES ('ok', 1)");
        state.storage.kv.put('reply:ok', 'committed');
      });
      let threw = false;
      try {
        state.storage.transactionSync(() => {
          state.storage.sql.exec("INSERT INTO items(id, n) VALUES ('fail', 1)");
          state.storage.kv.put('reply:fail', 'should-rollback');
          throw new Error('trap mid-way');
        });
      } catch (e) {
        threw = e instanceof Error && e.message === 'trap mid-way';
      }
      if (!threw) throw new Error('the mid-way throw was not observed');
    });
    expect(await observe('tx-fail')).toEqual({ rows: [{ id: 'ok', n: 1 }], ok: 'committed', fail: undefined });
  });

  it('implicit write coalescing (no transactionSync) commits both when the handler returns', async () => {
    await prepare('coalesce-ok');
    await runInDurableObject(stub('coalesce-ok'), (_, state) => {
      state.storage.sql.exec("INSERT INTO items(id, n) VALUES ('ok', 1)");
      state.storage.kv.put('reply:ok', 'committed');
    });
    expect(await observe('coalesce-ok')).toEqual({ rows: [{ id: 'ok', n: 1 }], ok: 'committed', fail: undefined });
  });

  // Without transactionSync, a throw from runInDurableObject still leaves both writes (observed in this
  // harness). The host therefore uses transactionSync for every stretch, not implicit coalescing alone.
  it('implicit write coalescing alone does not roll back a throw from runInDurableObject', async () => {
    await prepare('coalesce-fail');
    await expect(
      runInDurableObject(stub('coalesce-fail'), (_, state) => {
        state.storage.sql.exec("INSERT INTO items(id, n) VALUES ('fail', 1)");
        state.storage.kv.put('reply:fail', 'should-rollback');
        throw new Error('trap mid-way');
      }),
    ).rejects.toThrow('trap mid-way');
    expect(await observe('coalesce-fail')).toEqual({
      rows: [{ id: 'fail', n: 1 }],
      ok: undefined,
      fail: 'should-rollback',
    });
  });

  it('program SQL can see the hidden KV table name but cannot read its content', async () => {
    await prepare('hidden');
    const seen = await runInDurableObject(stub('hidden'), (_, state) => {
      state.storage.kv.put('secret', 'host-only');
      const names = state.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE name LIKE '%kv%' OR name LIKE '%cf%' ORDER BY name")
        .toArray()
        .map(r => r['name']);
      const read = (table: string): string => {
        try {
          const rows = state.storage.sql.exec(`SELECT * FROM ${table}`).toArray();
          return `readable:${JSON.stringify(rows)}`;
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
      };
      return { names, cf_kv: read('__cf_kv'), cf_KV: read('_cf_KV'), kv: state.storage.kv.get('secret') };
    });
    expect(seen.kv).toBe('host-only');
    expect(seen.names).toContain('_cf_KV');
    expect(seen.cf_kv).not.toMatch(/host-only/);
    expect(seen.cf_KV).not.toMatch(/host-only/);
    expect(seen.cf_kv).not.toMatch(/^readable:/);
    expect(seen.cf_KV).not.toMatch(/^readable:/);
  });
});
