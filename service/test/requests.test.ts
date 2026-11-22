// GET /:account/:name/requests: the routed requests a name's router records hold, newest first, with signed
// trace links; operator only. And who a request was for (buyerOf), read from its path or its run's request.
import { describe, expect, it } from 'vitest';
import page from './fixtures/page.tape?raw';
import { buyerOf, targetOf } from '../src/index.ts';
import { anyone, at, call, fields, got, json, list, text } from './help.ts';

describe('buyerOf', () => {
  it('reads the buyer from the path, the query, a form body or a JSON body', () => {
    expect(buyerOf('/p/ivar/tix/users/ivar/tickets', null)).toBe('ivar');
    expect(buyerOf('/ivar/tix/v/5/users/a%20b/tickets', null)).toBe('a b');
    expect(buyerOf('/p/ivar/tix/me', 'GET /me?buyer=ivar public\n')).toBe('ivar');
    expect(buyerOf('/p/ivar/tix/buy', 'POST /buy public\nkey=k1&tier=1&buyer=Iv+ar&qty=2')).toBe('Iv ar');
    expect(buyerOf('/ivar/tix/v/5/holds', 'POST /holds\n{"key":"k","tier":1,"buyer":"ivar \\"v\\"","qty":2}')).toBe(
      'ivar "v"',
    );
    expect(buyerOf('/p/ivar/tix/', 'GET / public\n')).toBe(null);
    expect(buyerOf('/p/ivar/tix/', null)).toBe(null);
    expect(targetOf('GET /me?buyer=ivar public\n')).toBe('/me?buyer=ivar');
  });
});

describe('GET /:account/:name/requests', () => {
  it('lists operator and public requests with their status, buyer and a trace link that opens', async () => {
    expect((await call('/ivar/rq', { method: 'POST', body: page })).status).toBe(201);
    expect((await call('/_public/ivar/rq', { method: 'PUT', body: JSON.stringify({ published: true }) })).status).toBe(
      200,
    );
    const t0 = Date.now();
    expect((await anyone('/p/ivar/rq/')).status).toBe(200);
    expect(
      (
        await anyone('/p/ivar/rq/visit', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'buyer=ada',
        })
      ).status,
    ).toBeLessThan(500);
    expect((await call('/ivar/rq/v/1/n.json')).status).toBe(200);
    // operator only
    expect((await anyone('/ivar/rq/requests')).status).toBe(401);
    const r = await call(`/ivar/rq/requests?since=${new Date(t0 - 1).toISOString()}`);
    expect(r.status).toBe(200);
    const listed = list(at(await json(r), 'requests')).map(fields);
    expect(listed.map(x => [x['method'], x['path'], x['via'], x['status']])).toEqual([
      ['GET', '/ivar/rq/v/1/n.json', 'operator', 200],
      ['POST', '/p/ivar/rq/visit', 'public', 201],
      ['GET', '/p/ivar/rq/', 'public', 200],
    ]);
    expect([listed[1]?.['buyer'], listed[1]?.['target']]).toEqual(['ada', '/visit']);
    for (const x of listed) {
      expect(x['took_ms']).toBeGreaterThanOrEqual(0);
      expect(Date.parse(text(x['began']))).toBeGreaterThanOrEqual(t0 - 1);
    }
    /** A signed link's path and query, for a request to this Worker. */
    const local = (link: unknown): string => new URL(text(link)).pathname + new URL(text(link)).search;
    // the signed link opens without the token; the OTLP one too
    const html = await anyone(local(listed[2]?.['trace_url']));
    expect([html.status, html.headers.get('content-type')]).toEqual([200, 'text/html; charset=utf-8']);
    expect((await anyone(local(listed[2]?.['otlp_url']))).status).toBe(200);
    // on the public route, /requests is the program's own path (its 404), not this listing
    expect((await anyone('/p/ivar/rq/requests')).status).toBe(404);
    // limit and since
    expect(list(at(await got('/ivar/rq/requests?limit=1'), 'requests')).length).toBe(1);
    expect(at(await got(`/ivar/rq/requests?since=${Date.now() + 60000}`), 'requests')).toEqual([]);
    expect((await call('/ivar/rq/requests?limit=0')).status).toBe(400);
    expect((await call('/ivar/rq/requests?since=soon')).status).toBe(400);
  });
});
