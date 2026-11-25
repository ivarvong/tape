// A KV cluster whose shards hold a program written in the answer form from before 25 November 2026 (`-> Buf`,
// `respond(status:) |> …`, `method: "GET"`), as production clusters do. Today's compiler cannot rebuild that source,
// so each shard answers 503 rebuild_failed (name.ts #fresh) and runs nothing; the upgrade (RUNTIME-SPEC R-UPG) is the
// only way out for a cluster, and it must work from there and keep the data. The data is written the way it was in
// production, by the program while it ran (here through kv-50e0269.json, the same program in today's answer form,
// with the same tables and queries); then the stored version is put back to what production holds: the source of
// 50e0269 (test/fixtures/kv-50e0269-old.json, the fixture upgrade.test.ts used before the change) and a build made
// by another compiler.
import { exports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import now from './fixtures/kv-50e0269.json' with { type: 'json' };
import old from './fixtures/kv-50e0269-old.json' with { type: 'json' };
import type { Upload } from '../src/name.ts';
import { at, call, json as body, list } from './help.ts';

const enc = new TextEncoder();
const b64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), c => c.codePointAt(0) ?? 0);
type Fixture = Omit<Upload, 'plain' | 'traced'> & { plain: string; traced: string };
const built = (f: Fixture): Upload => ({ ...f, plain: b64(f.plain), traced: b64(f.traced) });
const value = async (a: string, c: string, k: string): Promise<unknown[]> => {
  const r = await call(`/kv/${a}/${c}/k/${k}`);
  const b = await body(r);
  return [r.status, at(b, 'value') ?? null, at(b, 'version') ?? null];
};

describe('upgrade: a cluster whose program cannot be rebuilt', () => {
  it('answers 503 rebuild_failed, and the upgrade moves it to the current program with its keys', async () => {
    const a = 'upg-stale',
      c = 'old',
      shards = 2;
    const meta = exports.Name.getByName(`${a}/~kv`);
    await meta.kvClaim(c, shards);
    for (let i = 0; i < shards; i++) {
      const name = `kv-${c}-${i}`,
        stub = exports.Name.getByName(`${a}/${name}`);
      expect(await stub.upload(a, name, built(now))).not.toHaveProperty('error');
      const placed = await stub.invoke(a, name, 1, enc.encode(`PUT /placement/${i}?shards=${shards}\n`));
      expect(placed.status).toBe(200);
    }
    await meta.kvReady(c);
    for (let i = 0; i < 6; i++)
      expect((await call(`/kv/${a}/${c}/k/k${i}`, { method: 'PUT', body: `v${i}` })).status).toBe(201);
    const keys = Array.from({ length: 6 }, (_, i) => `k${i}`),
      before = await Promise.all(keys.map(k => value(a, c, k)));
    expect(before.map(v => v[0])).toEqual(keys.map(() => 200));
    // what production holds: the old source, built by another compiler
    for (let i = 0; i < shards; i++)
      await runInDurableObject(exports.Name.getByName(`${a}/kv-${c}-${i}`), (_, state) => {
        state.storage.sql.exec('UPDATE _tape_versions SET source = ?1, compiler = NULL WHERE version = 1', old.source);
      });
    // today's compiler cannot build it: the shard says so, and runs nothing
    const stale = await call(`/kv/${a}/${c}/k/k0`);
    expect(stale.status).toBe(503);
    expect(at(await body(stale), 'code')).toBe('rebuild_failed');
    const dry = await call(`/kv/${a}/${c}/upgrade`, {
      method: 'POST',
      body: JSON.stringify({ confirm: c, dry_run: true }),
    });
    expect(dry.status).toBe(200);
    const up = await call(`/kv/${a}/${c}/upgrade`, { method: 'POST', body: JSON.stringify({ confirm: c }) });
    const done = await body(up);
    expect(up.status).toBe(200);
    expect(
      list(at(done, 'shards')).map(sh => [at(sh, 'state'), at(sh, 'from'), at(sh, 'to'), at(sh, 'retired')]),
    ).toEqual([
      ['upgraded', 1, 2, [1]],
      ['upgraded', 1, 2, [1]],
    ]);
    // the keys and their versions are kept, and the current program serves and takes writes
    expect(await Promise.all(keys.map(k => value(a, c, k)))).toEqual(before);
    const op = `?op=${Date.now()}_c1-1`;
    expect((await call(`/kv/${a}/${c}/k/k0${op}`, { method: 'PUT', body: 'w' })).status).toBe(200);
    expect((await value(a, c, 'k0')).slice(0, 2)).toEqual([200, 'w']);
  }, 60000);
});
