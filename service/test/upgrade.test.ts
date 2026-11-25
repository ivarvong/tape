// RUNTIME-SPEC R-UPG: a KV cluster made with an older examples/kv.tape moved to the current one. The old programs
// are the ones production clusters ran (test/fixtures/kv-<rev>.json; built by their own revision's compiler, the
// hashes were those of demo/users, 5f0a10a7..., and demo/after44527, d1ed4b1f...), uploaded the way the router of
// that revision did, so the data, the old rules and the upgrade are as they would be in production. Since a
// program's answer is a Response (25 November 2026), a build of the old compilers answers text the host no longer
// reads (a 500, and in production, where the compiler differs, the rebuild fails: 503 rebuild_failed until the
// cluster is upgraded). So each fixture's source is that program with its answers in the new form, its `?N`
// placeholders named `:pN` and its method a Method, built by today's compiler with the rules off, as the service
// rebuilds a version today's rules refuse: every route, query and rule of the old program as it was.
import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import k50 from './fixtures/kv-50e0269.json' with { type: 'json' };
import k46 from './fixtures/kv-4676e6d.json' with { type: 'json' };
import { build } from '../src/index.ts';
import kvSource from '../../examples/kv.tape?raw';
import type { Upload } from '../src/name.ts';
import { isRefusal } from '../src/build.ts';
import { at, call, json as body, list } from './help.ts';

const enc = new TextEncoder();
const put = (path: string, value: string, q = ''): Promise<Response> =>
  call(`${path}${q}`, { method: 'PUT', body: value });
type Answer = { status: number; body: unknown };
const json = async (r: Response): Promise<Answer> => ({ status: r.status, body: await body(r) });
const b64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), c => c.codePointAt(0) ?? 0);
/** A program an older revision built, as the fixture file holds it: the two modules in base64. */
type Fixture = Omit<Upload, 'plain' | 'traced'> & { plain: string; traced: string };
const built = (f: Fixture): Upload => ({ ...f, plain: b64(f.plain), traced: b64(f.traced) });
const upgrade = (a: string, c: string, extra?: Record<string, unknown>): Promise<Response> =>
  call(`/kv/${a}/${c}/upgrade`, { method: 'POST', body: JSON.stringify({ confirm: c, ...extra }) });
const now = (): number => Date.now();
/** A cluster's description, or a key's answer, read through the router. */
const read = async (path: string): Promise<unknown> => body(await call(path));
/** The shards an upgrade reported. */
const shardsOf = (answer: Answer): unknown[] => list(at(answer.body, 'shards'));

// a cluster as the router of that revision made it: v1 the old program, then its placement
async function oldCluster(account: string, cluster: string, shards: number, fixture: Fixture): Promise<void> {
  const meta = exports.Name.getByName(`${account}/~kv`);
  await meta.kvClaim(cluster, shards);
  for (let i = 0; i < shards; i++) {
    const name = `kv-${cluster}-${i}`,
      stub = exports.Name.getByName(`${account}/${name}`);
    const row = await stub.upload(account, name, built(fixture));
    expect(row).not.toHaveProperty('error');
    const res = await stub.invoke(account, name, 1, enc.encode(`PUT /placement/${i}?shards=${shards}\n`));
    expect(res.status).toBe(200);
  }
  await meta.kvReady(cluster);
}
// every key's state, read through the router
const state = async (a: string, c: string, keys: readonly string[]): Promise<Record<string, unknown[]>> =>
  Object.fromEntries(
    await Promise.all(
      keys.map(async (k): Promise<[string, unknown[]]> => {
        const r = await json(await call(`/kv/${a}/${c}/k/${k}`));
        return [k, [r.status, at(r.body, 'value') ?? null, at(r.body, 'version')]];
      }),
    ),
  );

describe('upgrade: a cluster made with an older examples/kv.tape', () => {
  const revisions: [string, Fixture, string][] = [
    ['50e0269', k50, 'ddc82d7b'],
    ['4676e6d', k46, '9c4a356b'],
  ];
  for (const [rev, fixture, hash] of revisions) {
    it(`${rev}: keys, values, versions and tombstones are kept; the current rules apply after`, async () => {
      const a = `upg-${rev}`,
        c = 'old';
      expect(fixture.hash.startsWith(hash)).toBe(true);
      await oldCluster(a, c, 2, fixture);
      // the old rules: an unconditional PUT without an op id is accepted (C54 did not exist)
      expect((await put(`/kv/${a}/${c}/k/a`, 'x')).status).toBe(201);
      expect((await put(`/kv/${a}/${c}/k/a`, 'y')).status).toBe(200);
      expect((await put(`/kv/${a}/${c}/k/b`, 'p', '?if=0')).status).toBe(201);
      expect((await call(`/kv/${a}/${c}/k/b`, { method: 'DELETE' })).status).toBe(200);
      for (let i = 0; i < 6; i++) await put(`/kv/${a}/${c}/k/k${i}`, `v${i}`, '?if=0');
      const keys = ['a', 'b', ...Array.from({ length: 6 }, (_, i) => `k${i}`)],
        before = await state(a, c, keys);
      expect(before['a']).toEqual([200, 'y', 2]);
      expect(before['b']).toEqual([404, null, 2]);
      const desc = await read(`/kv/${a}/${c}`);
      expect([at(desc, 'program', 'current'), at(desc, 'program', 'version')]).toEqual([false, 1]);

      const dry = await json(await upgrade(a, c, { dry_run: true }));
      expect(dry.status).toBe(200);
      expect(shardsOf(dry).map(sh => at(sh, 'state'))).toEqual(['ready', 'ready']);
      expect(await state(a, c, keys)).toEqual(before); // a dry run changes nothing
      expect((await json(await upgrade(a, 'other'))).status).toBe(404);
      expect((await call(`/kv/${a}/${c}/upgrade`, { method: 'POST', body: '{}' })).status).toBe(400);

      const up = await json(await upgrade(a, c));
      expect(up.status).toBe(200);
      expect(shardsOf(up).map(sh => [at(sh, 'state'), at(sh, 'from'), at(sh, 'to'), at(sh, 'retired')])).toEqual([
        ['upgraded', 1, 2, [1]],
        ['upgraded', 1, 2, [1]],
      ]);
      expect(await state(a, c, keys)).toEqual(before);
      const after = await read(`/kv/${a}/${c}`);
      expect([at(after, 'program', 'current'), at(after, 'program', 'version'), at(after, 'live')]).toEqual([
        true,
        2,
        7,
      ]);
      // the current rules: an unconditional PUT needs an op id; an op id needs its t; versions continue
      expect((await put(`/kv/${a}/${c}/k/a`, 'z')).status).toBe(428);
      expect((await put(`/kv/${a}/${c}/k/a`, 'z', '?op=c1-1')).status).toBe(400);
      const op = `?op=${now()}_c1-1`;
      expect(await json(await put(`/kv/${a}/${c}/k/a`, 'z', op))).toEqual({
        status: 200,
        body: { key: 'a', version: 3 },
      });
      expect(await json(await put(`/kv/${a}/${c}/k/a`, 'z', op))).toEqual({
        status: 200,
        body: { key: 'a', version: 3 },
      });
      expect(at(await body(await put(`/kv/${a}/${c}/k/b`, 'q', '?if=2')), 'version')).toBe(3); // the tombstone kept its version
      // a request for v1, as a router from before this change sends: the version is retired, nothing runs
      const stub = exports.Name.getByName(`${a}/kv-${c}-0`);
      const v1 = await stub.invoke(a, `kv-${c}-0`, 1, enc.encode('PUT /k/a\nw'));
      expect(v1.status).toBe(410);
      // again: nothing to do
      const again = await json(await upgrade(a, c));
      expect(shardsOf(again).map(sh => at(sh, 'state'))).toEqual(['current', 'current']);
    }, 60000);
  }

  it('4676e6d: a timed op id the old program stored, recent enough to be resent, holds the upgrade back (R-UPG-2)', async () => {
    const a = 'upg-held',
      c = 'old';
    await oldCluster(a, c, 1, k46);
    // a client of today against the old cluster: its op id lands in table ops, which the current program does not read
    const op = `?op=${now()}_c3-1`;
    expect((await put(`/kv/${a}/${c}/k/x`, 'v', op)).status).toBe(201);
    const r = await json(await upgrade(a, c));
    expect(r.status).toBe(409);
    expect(at(r.body, 'shards', 0, 'legacy')).toMatchObject({ table: true, rows: 1, timed: 1, timed_recent: 1 });
    // nothing was changed: still v1, and the resend is still a replay there
    expect(at(await read(`/kv/${a}/${c}`), 'program', 'version')).toBe(1);
    expect(await json(await put(`/kv/${a}/${c}/k/x`, 'v', op))).toEqual({
      status: 201,
      body: { key: 'x', version: 1 },
    });
    // an op id older than the window plus the allowance does not hold it: the current program refuses its resend (410)
    const old = `?op=${now() - 3600000 - 300000 - 60000}_c3-2`;
    const b = 'upg-old-op';
    await oldCluster(b, c, 1, k46);
    expect((await put(`/kv/${b}/${c}/k/x`, 'v', old)).status).toBe(201);
    expect((await json(await upgrade(b, c))).status).toBe(200);
    expect((await json(await put(`/kv/${b}/${c}/k/x`, 'v', old))).status).toBe(410);
    expect(at(await read(`/kv/${b}/${c}/k/x`), 'version')).toBe(1);
  }, 60000);

  it('4676e6d: writes and resends during the upgrade apply at most once, and every acknowledged one exactly once', async () => {
    const a = 'upg-skew',
      c = 'old';
    await oldCluster(a, c, 2, k46);
    // clients of the old cluster's era: untimed op ids, each sent twice, some before, some during, some after
    const ops = Array.from({ length: 200 }, (_, i) => ({ key: `k${i % 4}`, op: `c${i}-1` }));
    type Op = { key: string; op: string };
    const sent: (Op & Answer)[] = [];
    const send = async (o: Op): Promise<void> => {
      const r = await put(`/kv/${a}/${c}/k/${o.key}`, `v-${o.op}`, `?op=${o.op}`);
      sent.push({ ...o, ...(await json(r)) });
    };
    await Promise.all(ops.slice(0, 20).map(send));
    // the upgrade starts; four clients keep sending new ops until it has answered, then every op is sent again
    const upgrading = { done: false };
    let next = 20;
    const up = upgrade(a, c).then(r => {
      upgrading.done = true;
      return r;
    });
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        for (let o = ops[next++]; !upgrading.done && o !== undefined; o = ops[next++]) await send(o);
      }),
    );
    const u = await json(await up);
    expect(u.status).toBe(200);
    await Promise.all(ops.slice(0, next).map(send));
    // per key: the version is the number of distinct op ids acknowledged (2xx); no op id acknowledged with two versions
    for (const k of ['k0', 'k1', 'k2', 'k3']) {
      const acked = sent.filter(o => o.key === k && (o.status === 200 || o.status === 201));
      const byOp = Map.groupBy(acked, o => o.op);
      for (const same of byOp.values()) expect(new Set(same.map(o => at(o.body, 'version'))).size).toBe(1);
      expect(at(await read(`/kv/${a}/${c}/k/${k}`), 'version')).toBe(byOp.size);
    }
    // what was not acknowledged was refused without running: by the current program (an untimed op id, 400) or
    // while the shard upgraded (503, not applied). Both programs answered, so the upgrade fell among the writes.
    const statuses = Map.groupBy(sent, o => o.status);
    console.log(
      `UPGRADE-SKEW ${JSON.stringify(Object.fromEntries([...statuses].map(([k, v]) => [k, v.length])))} sent ${sent.length} ops ${next}`,
    );
    expect([...statuses.keys()].every(st => [200, 201, 400, 503].includes(st))).toBe(true);
    expect((statuses.get(503) ?? []).every(o => at(o.body, 'outcome') === 'not_applied')).toBe(true);
    expect(sent.some(o => o.status === 400) && sent.some(o => o.status === 200 || o.status === 201)).toBe(true);
  }, 60000);

  it('4676e6d: without the R-UPG-2 check, a resend of a timed op the old program stored applies twice (why the check exists)', async () => {
    const a = 'upg-plant',
      c = 'old',
      name = `kv-${c}-0`,
      stub = exports.Name.getByName(`${a}/${name}`);
    await oldCluster(a, c, 1, k46);
    const op = `?op=${now()}_c5-1`;
    expect(at(await body(await put(`/kv/${a}/${c}/k/x`, 'v', op)), 'version')).toBe(1);
    // the steps of kvUpgrade with its check left out
    const b = build(kvSource);
    if (isRefusal(b)) throw new Error(b.error);
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', b.plain))]
      .map(x => x.toString(16).padStart(2, '0'))
      .join('');
    expect(await stub.upload(a, name, { ...b, source: kvSource, hash })).toMatchObject({ version: 2 });
    expect(await stub.retire(a, name, 1)).toMatchObject({ retired: 1 });
    // the resend is not found in key_ops, so it is applied again: the op committed twice
    expect(await json(await put(`/kv/${a}/${c}/k/x`, 'v', op))).toEqual({
      status: 200,
      body: { key: 'x', version: 2 },
    });
  }, 60000);
});
