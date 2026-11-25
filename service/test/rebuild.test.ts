// Runs in workerd: a stored build is a cache of its version's source. A version built by another compiler (here a
// real build by the compiler at 93137b6, which imports env.json, gone from the host since) is built again from
// its source the first time it is loaded, once, and serves; the listing says it was rebuilt. A source today's
// compiler cannot build answers 503 rebuild_failed with the diagnostics, and its stale build never runs.
// (fixtures/greet-93137b6.json was written by building fixtures/greet.tape with that commit's compiler.)
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import alarm from './fixtures/alarm.tape?raw';
import greet from './fixtures/greet.tape?raw';
import old from './fixtures/greet-93137b6.json' with { type: 'json' };
import { anyone, at, call, got, json, list } from './help.ts';

const bytesOf = (b64: string): Uint8Array => Uint8Array.from(atob(b64), c => c.codePointAt(0) ?? 0);
const stub = (n: string) => env.NAMES.get(env.NAMES.idFromName(n));
/** Puts the old compiler's builds in place of a version's (and, when it is there, forgets which compiler made it). */
const stale = (n: string, version: number, source?: string): Promise<void> =>
  runInDurableObject(stub(n), (_, state) => {
    const { sql } = state.storage;
    sql.exec(
      'UPDATE _tape_versions SET plain = ?2, traced = ?3, sites = ?4 WHERE version = ?1',
      version,
      bytesOf(old.plain),
      bytesOf(old.traced),
      JSON.stringify(old.sites),
    );
    if (source !== undefined) sql.exec('UPDATE _tape_versions SET source = ?2 WHERE version = ?1', version, source);
    try {
      sql.exec('UPDATE _tape_versions SET compiler = NULL WHERE version = ?1', version);
    } catch {
      // a build without the column: nothing records the compiler
    }
  });
const hello = (path: string): Promise<Response> => call(path, { method: 'POST', body: '{"name":"ada"}' });

describe('a stored build is a cache of the source', () => {
  it('rebuilds a version an older compiler built, once, and serves it', async () => {
    expect(old.imports).toEqual(['env.json']);
    expect(at(await got('/ivar/greet', { method: 'POST', body: greet }), 'version')).toBe(1);
    await stale('ivar/greet', 1);
    // a second version loads the name's code again, with v1's stored build in it
    expect(at(await got('/ivar/greet', { method: 'POST', body: `${greet}\n` }), 'version')).toBe(2);
    const r = await hello('/ivar/greet/v/1/');
    expect([r.status, await r.text()]).toEqual([200, 'hello ada']);
    const v1 = list(await got('/ivar/greet'))[0];
    expect(at(v1, 'rebuilt_from')).toBe('unknown');
    const when = at(v1, 'rebuilt_at');
    expect(typeof when).toBe('number');
    // once: the rebuild is stored, so the next load reads it
    const again = await hello('/ivar/greet/v/1/');
    expect([again.status, await again.text()]).toEqual([200, 'hello ada']);
    expect(at(list(await got('/ivar/greet'))[0], 'rebuilt_at')).toBe(when);
    const v2 = await hello('/ivar/greet/v/2/');
    expect([v2.status, await v2.text()]).toEqual([200, 'hello ada']);
  });

  it('answers 503 rebuild_failed, with the diagnostics, for a source today’s compiler cannot build', async () => {
    expect(at(await got('/ivar/gone', { method: 'POST', body: greet }), 'version')).toBe(1);
    // a source an older compiler took, which this one refuses (here: a name it does not know)
    await stale('ivar/gone', 1, greet.replace('respond(status: 200)', 'respond_with(status: 200)'));
    expect(at(await got('/ivar/gone', { method: 'POST', body: `${greet}\n` }), 'version')).toBe(2);
    const r = await hello('/ivar/gone/v/1/');
    const body = await json(r);
    expect([r.status, at(body, 'error'), at(body, 'outcome'), at(body, 'transient'), r.headers.get('retry-after')]).toEqual([
      503,
      'rebuild_failed',
      'not_applied',
      undefined,
      null,
    ]);
    expect(JSON.stringify(at(body, 'errors'))).toContain('respond_with');
    // the other version still serves
    const v2 = await hello('/ivar/gone/v/2/');
    expect([v2.status, await v2.text()]).toEqual([200, 'hello ada']);
  });

  it('keeps a timer of a version that cannot be rebuilt, logs no error, and tries again later', async () => {
    expect(at(await got('/ivar/alarm', { method: 'POST', body: alarm }), 'version')).toBe(1);
    const set = await call('/ivar/alarm/v/1/set', { method: 'POST' });
    expect([set.status, await set.text()]).toEqual([202, 'set']);
    expect(list(at(await got('/ivar/alarm/wakes'), 'set')).map(w => at(w, 'key'))).toEqual([1]);
    // the version as an older compiler left it: its build stale, its source one this compiler refuses
    await stale('ivar/alarm', 1, alarm.replace('respond(status: 202)', 'respond_with(status: 202)'));
    const errors = vi.spyOn(console, 'error');
    const before = Date.now();
    // the alarm, run as the runtime runs it (runDurableObjectAlarm would delete the alarm it sets again)
    await runInDurableObject(stub('ivar/alarm'), async instance => {
      const run: unknown = Reflect.get(instance, 'alarm');
      if (typeof run !== 'function') throw new TypeError('the object has no alarm');
      await Reflect.apply(run, instance, []);
    });
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
    // the timer is kept, and the alarm set again, an hour on
    const wakes = await got('/ivar/alarm/wakes');
    expect(list(at(wakes, 'set')).map(w => at(w, 'key'))).toEqual([1]);
    expect(Date.parse(String(at(wakes, 'alarm')))).toBeGreaterThanOrEqual(before + 3_500_000);
    expect(at(wakes, 'runs')).toEqual([]);
    const r = await call('/ivar/alarm/v/1/');
    expect([r.status, at(await json(r), 'error')]).toEqual([503, 'rebuild_failed']);
  });
});

describe('POST /_rebuild', () => {
  it('rebuilds every stale live version of every account it lists, before any request, and says how many', async () => {
    expect(at(await got('/rbw/one', { method: 'POST', body: greet }), 'version')).toBe(1);
    expect(at(await got('/rbw/two', { method: 'POST', body: greet }), 'version')).toBe(1);
    expect(at(await got('/rbw/two', { method: 'POST', body: `${greet}\n` }), 'version')).toBe(2);
    await stale('rbw/one', 1);
    await stale('rbw/two', 1);
    expect((await anyone('/_rebuild', { method: 'POST', body: '{}' })).status).toBe(401);
    const r = await got('/_rebuild', { method: 'POST', body: '{"concurrency": 2}' });
    // the account was listed when it uploaded; other tests' accounts are walked too, so only this one's are counted
    const mine = await got('/rbw/one');
    expect(at(list(mine)[0], 'rebuilt_from')).toBe('unknown');
    expect(at(list(await got('/rbw/two'))[0], 'rebuilt_from')).toBe('unknown');
    expect([at(r, 'errors'), at(r, 'older')]).toEqual([[], 0]);
    // the versions it could not build are named, with the compiler's first error: here the other tests' refused sources
    const failures = list(at(r, 'failures'));
    expect(failures.length).toBe(at(r, 'failed'));
    for (const f of failures) expect(String(at(f, 'code'))).toMatch(/^C\d+$/);
    expect(Number(at(r, 'rebuilt'))).toBeGreaterThanOrEqual(2);
    expect(Number(at(r, 'names'))).toBeGreaterThanOrEqual(2);
    // a second walk finds nothing stale, and names the published names (ship.sh sends each one request: warm.ts)
    expect((await call('/_public/rbw/two', { method: 'PUT', body: '{"published": true}' })).status).toBe(200);
    const second = await got('/_rebuild', { method: 'POST', body: '{}' });
    expect(at(second, 'rebuilt')).toBe(0);
    expect(list(at(second, 'published'))).toContain('rbw/two');
    expect(list(at(second, 'published'))).not.toContain('rbw/one');
    // and the first request runs the build it made, without building again
    const when = at(list(await got('/rbw/one'))[0], 'rebuilt_at');
    const h = await hello('/rbw/one/v/1/');
    expect([h.status, await h.text()]).toEqual([200, 'hello ada']);
    expect(at(list(await got('/rbw/one'))[0], 'rebuilt_at')).toBe(when);
  });
});
