// Runs in workerd: the sharded KV service (kv.js and examples/kv.tape): creating clusters, routing, versions and
// compare-and-set, limits and errors, and the router's hash agreeing with the shards'.
import { describe, expect, it } from 'vitest';
import { fnv1a, shardOf, forget, remember } from '../src/kv.ts';
import { docOf } from '../jepsen/traces.ts';
import type { Doc, RawSpan } from '../jepsen/traces.ts';
import { anyone, at, call, got, json, list, num, text } from './help.ts';

const create = (cluster: string, shards: number, account = 'kvt'): Promise<Response> =>
  call(`/kv/${account}/${cluster}`, { method: 'POST', body: JSON.stringify({ shards }) });
// an unconditional write names its operation (?op=, else 428): every write here gets one unless the test says
let ops = 0;
const T0 = Date.now(); // R-RET-1: an op id is <t>_<id>
const opped = (q: string): string =>
  /[?&](if|op)=/.test(q) ? q : `${q}${q === '' ? '?' : '&'}op=${Date.now()}_t${++ops}`;
const put = (path: string, value: string | Uint8Array<ArrayBuffer>, q = ''): Promise<Response> =>
  call(`${path}${opped(q)}`, { method: 'PUT', body: value });
const bare = (path: string, value: string, q = ''): Promise<Response> =>
  call(`${path}${q}`, { method: 'PUT', body: value });
/** One field of each shard in a cluster's description. */
const perShard = (info: unknown, field: string): unknown[] => list(at(info, 'shard_stats')).map(sh => at(sh, field));
const enc = new TextEncoder();
/** What a search found; the test fails when it found nothing. */
const must = <T>(found: T | undefined): T => {
  if (found === undefined) throw new Error('not found');
  return found;
};
/** Every span of an OTLP document. */
const flat = (doc: Doc): RawSpan[] => doc.resourceSpans.flatMap(r => r.scopeSpans.flatMap(sc => sc.spans));

describe('kv: clusters', () => {
  it('needs the operator token', async () => {
    expect((await anyone('/kv/kvt/a', { method: 'POST', body: '{"shards":1}' })).status).toBe(401);
  });

  it('creates a cluster of N shards once; the same N again is 200, another N is 409', async () => {
    const made = await create('c4', 4);
    const body = await json(made);
    expect([made.status, at(body, 'shards'), at(body, 'state'), at(body, 'program', 'version')]).toEqual([
      201,
      4,
      'ready',
      1,
    ]);
    expect(at(body, 'program', 'hash')).toMatch(/^[0-9a-f]{64}$/);
    const again = await create('c4', 4);
    expect([again.status, at(await json(again), 'created_at')]).toEqual([200, at(body, 'created_at')]);
    const other = await create('c4', 8);
    expect([other.status, at(await json(other), 'shards')]).toEqual([409, 4]);
    // every shard runs the same program, placed as shard i of 4
    const info = await got('/kv/kvt/c4');
    expect(list(at(info, 'shard_stats')).map(sh => [at(sh, 'name'), at(sh, 'shard'), at(sh, 'shards')])).toEqual(
      [0, 1, 2, 3].map(i => [`kv-c4-${i}`, i, 4]),
    );
    const versions = await Promise.all([0, 1, 2, 3].map(i => got(`/kvt/kv-c4-${i}`)));
    expect(new Set(versions.map(v => at(v, 0, 'hash')))).toEqual(new Set([at(body, 'program', 'hash')]));
    expect(
      list(at(await got('/kv/kvt'), 'clusters')).map(c => [at(c, 'cluster'), at(c, 'shards'), at(c, 'state')]),
    ).toContainEqual(['c4', 4, 'ready']);
  });

  it('refuses bad sizes and names', async () => {
    for (const body of ['{"shards":0}', '{"shards":65}', '{"shards":2.5}', '{"shards":"4"}', '{}', 'nope'])
      expect((await call('/kv/kvt/bad', { method: 'POST', body })).status).toBe(400);
    expect((await create('x'.repeat(59), 1)).status).toBe(400);
    expect((await create('Upper', 1)).status).toBe(400);
    expect((await create('ok', 1, 'Bad Account')).status).toBe(400);
    expect((await call('/kv/kvt/never/k/a')).status).toBe(404);
    expect((await call('/kv/kvt/never')).status).toBe(404);
  });

  it('keeps kv- names for shards: no upload or retirement through the program routes', async () => {
    await create('guard', 1);
    expect(
      (await call('/kvt/kv-guard-0', { method: 'POST', body: 'fn handle(raw: View) -> Buf { respond(status: 200) }' }))
        .status,
    ).toBe(400);
    expect((await call('/kvt/kv-guard-0/v/1', { method: 'DELETE' })).status).toBe(400);
  });

  it('concurrent creates of one cluster make it once', async () => {
    const all = await Promise.all([1, 2, 3].map(() => create('race', 3)));
    expect(all.map(r => r.status).toSorted((x, y) => x - y)).toEqual([200, 200, 201]);
    const versions = await Promise.all([0, 1, 2].map(i => got(`/kvt/kv-race-${i}`)));
    expect(versions.map(v => list(v).length)).toEqual([1, 1, 1]);
  });
});

describe('kv: keys', () => {
  it('versions every write; reads see the latest; deletes leave a tombstone that keeps the version', async () => {
    await create('basic', 2);
    const k = '/kv/kvt/basic/k/user:1';
    let r = await call(k);
    expect([r.status, await json(r)]).toEqual([404, { error: 'no such key', key: 'user:1', version: 0 }]);
    r = await put(k, 'ann');
    expect([r.status, await json(r)]).toEqual([201, { key: 'user:1', version: 1 }]);
    expect(r.headers.get('kv-shard')).toBe(`${shardOf('user:1', 2)}/2`);
    expect(r.headers.get('tape-trace-url')).toMatch(/\/t\/kvt\/kv-basic-[01]\/r\/[0-9a-f]{16}\?exp=/);
    expect(r.headers.get('server-timing')).toMatch(/^shard;desc="kv-basic-[01]";dur=\d+$/);
    r = await put(k, 'bob');
    expect([r.status, at(await json(r), 'version')]).toEqual([200, 2]);
    r = await call(k);
    expect([r.status, await json(r)]).toEqual([200, { key: 'user:1', value: 'bob', version: 2 }]);
    r = await call(k, { method: 'DELETE' });
    expect([r.status, at(await json(r), 'version')]).toEqual([200, 3]);
    r = await call(k);
    expect([r.status, at(await json(r), 'version')]).toEqual([404, 3]);
    expect((await call(k, { method: 'DELETE' })).status).toBe(404);
    r = await put(k, 'cat');
    expect([r.status, at(await json(r), 'version')]).toEqual([200, 4]);
  });

  it('compare-and-set: ?if=<version> writes only at that version; ?if=0 only when absent', async () => {
    await create('cas', 3);
    const k = '/kv/kvt/cas/k/counter';
    expect((await put(k, '1', '?if=0')).status).toBe(201);
    let r = await put(k, '1', '?if=0');
    expect([r.status, await json(r)]).toEqual([
      409,
      { error: 'version mismatch', key: 'counter', version: 1, expected: 0 },
    ]);
    expect((await put(k, '2', '?if=1')).status).toBe(200);
    r = await put(k, '3', '?if=1');
    expect([r.status, at(await json(r), 'version')]).toEqual([409, 2]);
    r = await call(`${k}?if=1`, { method: 'DELETE' });
    expect(r.status).toBe(409);
    expect((await call(`${k}?if=2`, { method: 'DELETE' })).status).toBe(200);
    expect((await put(k, 'again', '?if=3')).status).toBe(200);
    // twenty racing increments, each read-then-CAS: exactly the ones that saw the latest version win
    await put('/kv/kvt/cas/k/n', '0');
    const inc = async (): Promise<void> => {
      for (;;) {
        const cur = await got('/kv/kvt/cas/k/n');
        const w = await put('/kv/kvt/cas/k/n', String(Number(at(cur, 'value')) + 1), `?if=${num(at(cur, 'version'))}`);
        if (w.status === 200) return;
        expect(w.status).toBe(409);
      }
    };
    await Promise.all(Array.from({ length: 20 }, inc));
    expect(await got('/kv/kvt/cas/k/n')).toEqual({ key: 'n', value: '20', version: 21 });
  }, 30000); // ~400 requests serialized on one shard, each storing its trace before it answers

  it('spreads keys over the shards as fnv1a mod N, and each shard holds only its own', async () => {
    await create('spread', 4);
    const keys = Array.from({ length: 200 }, (_, i) => `k${i}`);
    await Promise.all(keys.map(k => put(`/kv/kvt/spread/k/${k}`, 'v')));
    const info = await got('/kv/kvt/spread');
    const want = [0, 1, 2, 3].map(i => keys.filter(k => shardOf(k, 4) === i).length);
    expect(perShard(info, 'keys')).toEqual(want);
    expect(at(info, 'live')).toBe(200);
    for (const n of want) expect(n).toBeGreaterThan(30);
    // a key sent to the wrong shard directly is refused by the shard itself
    const wrong = (shardOf('k0', 4) + 1) % 4,
      r = await put(`/kvt/kv-spread-${wrong}/v/1/k/k0`, 'x');
    expect(r.status).toBe(421);
  });

  it('agrees with examples/kv.tape on the hash (the shard refuses any key the router misplaces)', async () => {
    expect([fnv1a(enc.encode('')), fnv1a(enc.encode('a')), fnv1a(enc.encode('foobar'))]).toEqual([
      2166136261, 3826002220, 3214735720,
    ]);
    await create('agree', 7);
    const keys = Array.from({ length: 300 }, (_, i) => `key-${i}:${'x'.repeat(i % 40)}%2F${i * 7919}`);
    const codes = await Promise.all(keys.map(async k => (await put(`/kv/kvt/agree/k/${k}`, 'v')).status));
    expect(new Set(codes)).toEqual(new Set([201]));
  });

  it('refuses bad keys, values, queries and methods with typed errors', async () => {
    await create('limits', 2);
    const b = '/kv/kvt/limits/k/';
    const cases: [Promise<Response>, number][] = [
      [call(`${b}${'k'.repeat(257)}`), 400],
      [call(`${b}a%20b`), 404], // percent-encoded is a fine key
      [call(`${b}a'b`), 400],
      [put(`${b}big`, 'a'.repeat(65537)), 413],
      [put(`${b}bad`, new Uint8Array([0x61, 0xff])), 400],
      [put(`${b}q`, 'v', '?if=x'), 400],
      [put(`${b}q`, 'v', '?other=1'), 400],
      [call(`${b}q?if=1`), 400],
      [call(`${b}q`, { method: 'POST', body: 'v' }), 405],
      [call('/kv/kvt/limits', { method: 'DELETE' }), 405],
    ];
    for (const [r, status] of cases) {
      const res = await r;
      expect(res.status).toBe(status);
      expect(typeof at(await json(res), 'error')).toBe('string');
    }
    const max = await put(`${b}max`, 'é'.repeat(32768));
    expect(max.status).toBe(201);
    expect(text(at(await got(`${b}max`), 'value')).length).toBe(32768);
  });

  it("joins the caller's trace when it sends traceparent, and answers with the shard's span", async () => {
    await create('traced', 1);
    const trace = '4bf92f3577b34da6a3ce929d0e0e4736',
      parent = '00f067aa0ba902b7';
    const r = await put('/kv/kvt/traced/k/a', 'v', '');
    expect(r.headers.get('traceparent')).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    const joined = await call('/kv/kvt/traced/k/a', { headers: { traceparent: `00-${trace}-${parent}-01` } });
    expect(joined.headers.get('traceparent')).toMatch(new RegExp(`^00-${trace}-[0-9a-f]{16}-01$`));
    const link = new URL(joined.headers.get('tape-otlp-url') ?? '');
    const spans = flat(docOf(await json(await anyone(link.pathname + link.search))));
    const root = must(spans.find(sp => sp.parentSpanId === parent));
    expect([root.traceId, root.name]).toEqual([trace, 'GET /kv/{account}/{cluster}/k/{key}']);
    // router -> shard call -> supervisor -> run, every span in the client's trace
    const child = (of: RawSpan, name = ''): RawSpan =>
      must(spans.find(sp => sp.parentSpanId === of.spanId && sp.name.includes(name)));
    const invoke = child(root, 'invoke'),
      supervisor = child(invoke),
      run = child(supervisor);
    expect([invoke.kind, supervisor.kind, run.name, spans.every(sp => sp.traceId === trace)]).toEqual([
      3,
      2,
      'GET /k/a',
      true,
    ]);
    // the query it ran is an event on the run's span, with its text
    expect(
      run.events
        .flatMap(e => e.attributes)
        .some(
          a =>
            a.key === 'db.query.text' &&
            (a.value.stringValue ?? '').includes('SELECT key, value, version, live FROM kv'),
        ),
    ).toBe(true);
  });

  it('reads the shard count from ~kv once per isolate and keeps it (clusters never change)', async () => {
    await create('cached', 2);
    forget();
    expect((await put('/kv/kvt/cached/k/a', 'v')).status).toBe(201);
    expect((await call('/kv/kvt/cached/k/a')).status).toBe(200);
  });
});

describe('kv: correctness regressions', () => {
  const setFaults = (account: string, p: Record<string, number> | null): Promise<Response> =>
    call(`/_faults/${account}`, {
      method: 'PUT',
      body: JSON.stringify(p === null ? null : { seed: 3, p, tail: [1, 2] }),
    });
  it('an unconditional write retried after an unknown outcome: without an op id it is refused (428, nothing written); with ?op= it applies exactly once', async () => {
    expect((await create('once', 2, 'jepsen-once')).status).toBe(201);
    // Before RI (C54) a blind PUT was accepted, and its retry after a lost reply applied twice (version 2). Now the
    // shard refuses it before writing, so there is nothing to apply twice.
    const blind = await bare('/kv/jepsen-once/once/k/plain', 'v');
    expect(blind.status).toBe(428);
    expect((await call('/kv/jepsen-once/once/k/plain')).status).toBe(404);
    // the reply is lost after the write committed (the shard is reset before it answers)
    await setFaults('jepsen-once', { reset_callee_after: 1 });
    const keyed = await bare('/kv/jepsen-once/once/k/keyed', 'v', `?op=${T0}_client7-1`);
    expect(keyed.status).toBe(503);
    await setFaults('jepsen-once', null);
    // the client retries what it does not know happened: the retry answers the first write's reply
    const keyed2 = await bare('/kv/jepsen-once/once/k/keyed', 'v', `?op=${T0}_client7-1`);
    expect([keyed2.status, await json(keyed2)]).toEqual([201, { key: 'keyed', version: 1 }]);
    expect(at(await got('/kv/jepsen-once/once/k/keyed'), 'version')).toBe(1);
    // a write that was not applied stores nothing, so its retry is decided again
    expect((await put('/kv/jepsen-once/once/k/keyed', 'x', `?op=${T0}_client7-2&if=5`)).status).toBe(409);
    expect((await put('/kv/jepsen-once/once/k/keyed', 'x', `?op=${T0}_client7-2&if=1`)).status).toBe(200);
    expect((await put('/kv/jepsen-once/once/k/keyed', 'x', `?op=${T0}_client7-2&if=1`)).status).toBe(200);
    expect(await got('/kv/jepsen-once/once/k/keyed')).toEqual({ key: 'keyed', value: 'x', version: 2 });
  });

  it('an op id names one write to one key: reused on another key it is another write, whichever shard that key is on', async () => {
    // Found by check 20 in production: reuse on another key was 422 when that key was on the same shard and applied
    // when it was not, so the answer depended on the hash. Now it is the same on both.
    expect((await create('opkeys', 4)).status).toBe(201);
    const shard = (k: string): number => shardOf(k, 4),
      keys = Array.from({ length: 40 }, (_, i) => `k${i}`);
    const first = 'k0',
      same = must(keys.find(k => k !== first && shard(k) === shard(first))),
      other = must(keys.find(k => shard(k) !== shard(first)));
    expect((await put(`/kv/kvt/opkeys/k/${first}`, 'a', `?op=${T0}_reused`)).status).toBe(201);
    const r = [
      await put(`/kv/kvt/opkeys/k/${same}`, 'b', `?op=${T0}_reused`),
      await put(`/kv/kvt/opkeys/k/${other}`, 'c', `?op=${T0}_reused`),
    ];
    expect(await Promise.all(r.map(async x => [x.status, at(await json(x), 'version')]))).toEqual([
      [201, 1],
      [201, 1],
    ]);
    // and each is still exactly once under its id: a retry of each answers its own first reply
    const again = [
      await put(`/kv/kvt/opkeys/k/${first}`, 'z', `?op=${T0}_reused`),
      await put(`/kv/kvt/opkeys/k/${same}`, 'z', `?op=${T0}_reused`),
      await put(`/kv/kvt/opkeys/k/${other}`, 'z', `?op=${T0}_reused`),
    ];
    expect(await Promise.all(again.map(async x => [x.status, at(await json(x), 'version')]))).toEqual([
      [201, 1],
      [201, 1],
      [201, 1],
    ]);
    expect(at(await got(`/kv/kvt/opkeys/k/${same}`), 'value')).toBe('b');
  });

  it('a router with the wrong shard count in its cache cannot misplace a key: the shard refuses it (421), and the count is read again', async () => {
    expect((await create('cache4', 4)).status).toBe(201);
    // a key that the wrong count (2) sends to a shard that does not own it under the real count (4)
    const key = must(Array.from({ length: 200 }, (_, i) => `k${i}`).find(k => shardOf(k, 2) !== shardOf(k, 4)));
    remember('kvt', 'cache4', 2);
    const r = await put(`/kv/kvt/cache4/k/${key}`, 'v');
    expect([r.status, at(await json(r), 'error')]).toEqual([
      421,
      expect.stringContaining(`belongs to shard ${shardOf(key, 4)}`),
    ]);
    // nothing was written anywhere, and the next request routes with the count read again from ~kv
    const again = await put(`/kv/kvt/cache4/k/${key}`, 'v');
    expect([again.status, again.headers.get('kv-shard')]).toEqual([201, `${shardOf(key, 4)}/4`]);
    const stats = await got('/kv/kvt/cache4');
    expect(perShard(stats, 'keys')).toEqual([0, 1, 2, 3].map(i => (i === shardOf(key, 4) ? 1 : 0)));
    expect(at(stats, 'program', 'current')).toBe(true);
  });
});
