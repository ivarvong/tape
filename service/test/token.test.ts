// Runs in workerd: a Worker whose TOKEN secret is missing or empty (a version uploaded without it) opens nothing. It
// once compared the request with `Bearer ${undefined}`, so "Bearer undefined" was the operator's token.
import { env } from 'cloudflare:workers';
import { createExecutionContext } from 'cloudflare:test';
import { expect, it } from 'vitest';
import worker from '../src/index.ts';

it('answers 401 to every credential when the token is missing or empty', async () => {
  for (const token of [undefined, '']) {
    const own: Cloudflare.Env = { ...env };
    Reflect.set(own, 'TOKEN', token);
    for (const given of ['Bearer undefined', 'Bearer ', 'Bearer null', '']) {
      const r = await worker.fetch(
        new Request('http://tape/ivar/x', given === '' ? {} : { headers: { authorization: given } }),
        own,
        createExecutionContext(),
      );
      expect([token, given, r.status]).toEqual([token, given, 401]);
    }
  }
});
