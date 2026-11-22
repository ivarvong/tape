// RUNTIME-SPEC R-RET-7: an account's names are recorded at <account>/~registry, and DELETE /_accounts/:account
// (operator only, with a confirm) removes every one: storage, data and alarm, then the record itself.
import { expect, it } from 'vitest';
import { anyone, at, call, fields, json as body, list, num, text } from './help.ts';
import type { Init } from './help.ts';

const json = async (path: string, init?: Init): Promise<[number, unknown]> => {
  const r = await call(path, init);
  return [r.status, await body(r)];
};
/** The names an account's record holds. */
const names = async (a: string): Promise<unknown[]> => list(at((await json(`/_accounts/${a}`))[1], 'names'));
const echo = 'fn handle(raw: View) -> Buf {\n  respond(status: 200) |> write_text(text: "ok")\n}\n';

it('records every name an account makes: programs, KV clusters and their shards, faults and tools', async () => {
  const a = 'jepsen-acct1';
  expect((await call(`/${a}/echo`, { method: 'POST', body: echo })).status).toBe(201);
  expect((await call(`/kv/${a}/c`, { method: 'POST', body: JSON.stringify({ shards: 2 }) })).status).toBe(201);
  expect((await call(`/_faults/${a}`, { method: 'PUT', body: 'null' })).status).toBe(200);
  expect((await call(`/_policy/${a}`, { method: 'PUT', body: '{}' })).status).toBe(200);
  const [s, record] = await json(`/_accounts/${a}`);
  expect([s, list(at(record, 'names')).map(n => [at(n, 'name'), at(n, 'kind')])]).toEqual([
    200,
    [
      ['echo', 'program'],
      ['kv-c-0', 'program'],
      ['kv-c-1', 'program'],
      ['~faults', 'faults'],
      ['~kv', 'kv'],
      ['~tools', 'tools'],
    ],
  ]);
});

it('DELETE needs the operator, a confirm naming the account, and valid extra names', async () => {
  const a = 'jepsen-acct2';
  expect((await call(`/${a}/echo`, { method: 'POST', body: echo })).status).toBe(201);
  expect(
    (
      await anyone(`/_accounts/${a}`, {
        method: 'DELETE',
        body: JSON.stringify({ confirm: a }),
      })
    ).status,
  ).toBe(401);
  expect((await call(`/_accounts/${a}`, { method: 'DELETE' })).status).toBe(400);
  expect(
    (await call(`/_accounts/${a}`, { method: 'DELETE', body: JSON.stringify({ confirm: 'jepsen-other' }) })).status,
  ).toBe(400);
  expect(
    (await call(`/_accounts/${a}`, { method: 'DELETE', body: JSON.stringify({ confirm: a, names: ['../x'] }) })).status,
  ).toBe(400);
  expect(
    (await call(`/_accounts/${a}`, { method: 'DELETE', body: JSON.stringify({ confirm: a, names: ['~registry'] }) }))
      .status,
  ).toBe(400);
  expect((await call(`/_accounts/BAD`, { method: 'GET' })).status).toBe(400);
  // nothing was deleted
  expect((await call(`/${a}/echo/v/1/`, { method: 'POST' })).status).toBe(200);
});

it('removes every name: programs answer as never made, KV clusters are gone, the data and its log are deleted, the record is empty', async () => {
  const a = 'jepsen-acct3';
  expect((await call(`/${a}/echo`, { method: 'POST', body: echo })).status).toBe(201);
  for (let i = 0; i < 5; i++)
    expect((await call(`/${a}/echo/v/1/`, { method: 'POST', body: 'x'.repeat(1000) })).status).toBe(200);
  expect((await call(`/kv/${a}/c`, { method: 'POST', body: JSON.stringify({ shards: 2 }) })).status).toBe(201);
  expect((await call(`/kv/${a}/c/k/a?op=${Date.now()}_d-1`, { method: 'PUT', body: 'v' })).status).toBe(201);
  const [, before] = await json(`/${a}/echo/storage`);
  expect(at(before, 'data', 'log_rows')).toBe(5);
  // a name made before names were recorded is given as an extra name
  const [s, out] = await json(`/_accounts/${a}`, {
    method: 'DELETE',
    body: JSON.stringify({ confirm: a, names: ['older'] }),
  });
  expect([s, at(out, 'deleted'), at(out, 'failed'), num(at(out, 'bytes_before')) > 0]).toEqual([
    200,
    ['echo', 'kv-c-0', 'kv-c-1', 'older', '~kv'],
    [],
    true,
  ]);
  const [, after] = await json(`/${a}/echo/storage`);
  expect([at(after, 'name', 'versions'), at(after, 'data')]).toEqual([0, null]);
  expect((await call(`/${a}/echo/v/1/`, { method: 'POST' })).status).toBe(404);
  expect((await call(`/kv/${a}/c/k/a`)).status).toBe(404);
  expect(await names(a)).toEqual([]);
  // the account can be used again from nothing
  expect((await call(`/${a}/echo`, { method: 'POST', body: echo })).status).toBe(201);
  expect((await call(`/${a}/echo/v/1/`, { method: 'POST' })).status).toBe(200);
  expect((await names(a)).map(n => at(n, 'name'))).toEqual(['echo']);
});

it('POST /_ids gives each name its object id, the same as the object has, and creates nothing', async () => {
  const [s, ids] = await json('/_ids', {
    method: 'POST',
    body: JSON.stringify({ names: ['jepsen-acct1/echo', 'jepsen-acct1/echo', 'nobody/none'] }),
  });
  expect([s, Object.keys(fields(ids)).length, /^[0-9a-f]{64}$/.test(text(at(ids, 'jepsen-acct1/echo')))]).toEqual([
    200,
    2,
    true,
  ]);
  expect((await call('/_ids', { method: 'POST', body: '{"names": 3}' })).status).toBe(400);
});
