// Runs in workerd: a stored build is a cache of its version's source. A version built by another compiler (here a
// real build by the compiler at 93137b6, which imports env.json, gone from the host since) is built again from
// its source the first time it is loaded, once, and serves; the listing says it was rebuilt. A source today's
// compiler cannot build answers 503 rebuild_failed with the diagnostics, and its stale build never runs.
// (fixtures/greet-93137b6.json was written by building fixtures/greet.tape with that commit's compiler.)
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import greet from './fixtures/greet.tape?raw';
import old from './fixtures/greet-93137b6.json' with { type: 'json' };
import { at, call, got, json, list } from './help.ts';

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
    expect([r.status, at(body, 'error')]).toEqual([503, 'rebuild_failed']);
    expect(JSON.stringify(at(body, 'errors'))).toContain('respond_with');
    // the other version still serves
    const v2 = await hello('/ivar/gone/v/2/');
    expect([v2.status, await v2.text()]).toEqual([200, 'hello ada']);
  });
});
