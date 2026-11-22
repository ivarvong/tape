// Runs in workerd: a tokenless request for a name nobody made (or published) answers 404 and stores nothing. Only
// one object, the list of published names, is asked; no object of the account is made.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import page from './fixtures/page.tape?raw';
import { anyone, at, call, got } from './help.ts';
import { PUBLISHED } from '../src/index.ts';

/** The ids of the Name objects that have storage, as the test pool lists their files. (cloudflare:test's
 * listDurableObjectIds throws on the files of a facet, whose names are not ids.) */
const listed = async (): Promise<string[]> => {
  const loop: unknown = Reflect.get(env, '__VITEST_POOL_WORKERS_LOOPBACK_SERVICE');
  if (typeof loop !== 'object' || loop === null || !('fetch' in loop) || typeof loop.fetch !== 'function')
    throw new TypeError('no loopback service');
  const r: unknown = await Reflect.apply(loop.fetch, loop, ['http://placeholder/durable-objects?binding_name=NAMES']);
  if (!(r instanceof Response)) throw new TypeError('not a response');
  const ids: unknown = await r.json();
  if (!Array.isArray(ids)) throw new TypeError('not a list');
  return ids.filter((id): id is string => typeof id === 'string' && /^[0-9a-f]{64}$/.test(id));
};

describe('a tokenless request for a name nobody made', () => {
  it('answers 404 and stores nothing, for an account nobody made either', async () => {
    const before = await listed();
    const answers = await Promise.all([
      anyone('/p/nobody/x'),
      anyone('/p/nobody/x/deep/path?q=1'),
      anyone('/p/nobody2/y', { method: 'POST', body: 'hi' }),
      anyone('/p/nobody/x', { method: 'HEAD' }),
    ]);
    expect(answers.map(r => r.status)).toEqual([404, 404, 404, 404]);
    const after = await listed();
    const list = env.NAMES.idFromName(PUBLISHED).toString();
    const made = after.filter(id => !before.includes(id) && id !== list);
    const named = Object.fromEntries(
      ['nobody/x', 'nobody2/y', 'nobody/~registry', 'nobody2/~registry'].map(n => [
        env.NAMES.idFromName(n).toString(),
        n,
      ]),
    );
    expect(made.map(id => named[id] ?? id)).toEqual([]);
  });

  it('answers 404 for a name in an account that exists but was never made, and stores nothing for it', async () => {
    await call('/ivar/made', { method: 'POST', body: page });
    await call('/_public/ivar/made', { method: 'PUT', body: '{"published":true}' });
    expect((await anyone('/p/ivar/made/')).status).toBe(200);
    const before = await listed();
    expect((await anyone('/p/ivar/never-made/')).status).toBe(404);
    const after = await listed();
    expect(after.filter(id => !before.includes(id))).toEqual([]);
  });

  it('serves a name only while it is published, and a name unpublished stores nothing new when asked', async () => {
    await call('/ivar/onoff', { method: 'POST', body: page });
    expect((await anyone('/p/ivar/onoff/')).status).toBe(404);
    await call('/_public/ivar/onoff', { method: 'PUT', body: '{"published":true}' });
    expect((await anyone('/p/ivar/onoff/')).status).toBe(200);
    await call('/_public/ivar/onoff', { method: 'PUT', body: '{"published":false}' });
    expect((await anyone('/p/ivar/onoff/')).status).toBe(404);
    const v = await got('/_public/ivar/onoff');
    expect(at(v, 'published')).toBe(false);
  });
});
