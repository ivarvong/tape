// Runs in workerd: the machines of a name's live versions are kept in its object's storage, with the compiler and
// the live versions they were made for. A new instance of the object (after an eviction, a deploy) reads them, and
// parses no source for them; another compiler, or another set of live versions, makes them again.
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import status from '../../apps/products/status/status.tape?raw';
import { COMPILER } from '../src/build.ts';
import { Name } from '../src/name.ts';
import { at, call, got } from './help.ts';

const stub = () => env.NAMES.get(env.NAMES.idFromName('ivar/planned'));
const kept = (): Promise<Record<string, unknown>[]> =>
  runInDurableObject(stub(), (_, state) =>
    state.storage.sql.exec('SELECT compiler, live, machines FROM _tape_machines').toArray(),
  );
const named = <T>(run: (name: Name) => T): Promise<T> =>
  runInDurableObject(stub(), o => {
    if (!(o instanceof Name)) throw new TypeError('not a Name');
    return run(o);
  });
const planned = (): Promise<unknown> => named(name => name.plan().machines);
const set = (column: 'compiler' | 'machines', value: string): Promise<void> =>
  runInDurableObject(stub(), (_, state) => {
    state.storage.sql.exec(`UPDATE _tape_machines SET ${column} = ?1`, value);
  });
/** A new instance of the object: what it held in memory is gone. */
const again = async (): Promise<void> => {
  try {
    await named(name => name.reset('test: a new instance'));
  } catch {
    // the reset
  }
};

describe('the machines of the live versions', () => {
  it('are kept with the compiler and the versions they were made for, and read by a new instance', async () => {
    expect(at(await got('/ivar/planned', { method: 'POST', body: status }), 'version')).toBe(1);
    const first = await planned();
    expect(Array.isArray(first) ? first.length : 0).toBe(2);
    expect(await kept()).toEqual([{ compiler: COMPILER, live: '1', machines: JSON.stringify(first) }]);
    // a new instance reads the row and does not make it again: a row changed by hand comes back as it is
    const one = Array.isArray(first) ? first.slice(0, 1) : [];
    await set('machines', JSON.stringify(one));
    await again();
    expect(await planned()).toEqual(one);
    // another compiler's row is made again, from the sources, and kept
    await set('compiler', 'another');
    await again();
    expect(await planned()).toEqual(first);
    expect(await kept()).toEqual([{ compiler: COMPILER, live: '1', machines: JSON.stringify(first) }]);
    // another set of live versions is too
    await set('machines', JSON.stringify(one));
    expect(at(await got('/ivar/planned', { method: 'POST', body: `${status}\n` }), 'version')).toBe(2);
    expect(await kept()).toEqual([{ compiler: COMPILER, live: '1,2', machines: JSON.stringify(first) }]);
    expect((await call('/ivar/planned/v/2/status.json')).status).toBe(200);
  });
});
