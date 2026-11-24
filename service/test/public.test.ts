// Runs in workerd: content types from the status line (host.ts responseOf), and a published name's public route
// (/p/:account/:name/…): no token, the latest live version, `public` on the request line (std/http caller Anyone).
import { describe, expect, it } from 'vitest';
import page from './fixtures/page.tape?raw';
import redirect from './fixtures/redirect.tape?raw';
import hello from '../../examples/hello.tape?raw';
import { responseOf } from '../../host.ts';
import { tapeRequest } from '../src/web.ts';
import { anyone, at, call, got } from './help.ts';

const enc = new TextEncoder(),
  dec = new TextDecoder();
const head = (s: string): [number, string | undefined, string] => {
  const r = responseOf(enc.encode(s));
  return [r.status, r.type, dec.decode(r.body)];
};

describe('content types', () => {
  it('reads STATUS, or STATUS SP TYPE from a closed list, from the first line', () => {
    expect(head('201\n{}')).toEqual([201, 'text/plain; charset=utf-8', '{}']);
    expect(head('200 text/html\n<p>')).toEqual([200, 'text/html; charset=utf-8', '<p>']);
    expect(head('404 application/json\n{}')).toEqual([404, 'application/json', '{}']);
    // anything else is all body, as before: an unknown type, a header smuggled into the type, no status line
    expect(head('200 text/javascript\nx')).toEqual([200, 'text/plain; charset=utf-8', '200 text/javascript\nx']);
    expect(head('200 text/html; x: y\nx')).toEqual([200, 'text/plain; charset=utf-8', '200 text/html; x: y\nx']);
    expect(head('hello')).toEqual([200, 'text/plain; charset=utf-8', 'hello']);
    expect(head('99\nx')).toEqual([200, 'text/plain; charset=utf-8', '99\nx']);
  });

  it('serves the type the program chose', async () => {
    const v = await got('/ivar/page', { method: 'POST', body: page });
    expect(at(v, 'version')).toBe(1);
    const r = await call('/ivar/page/v/1/');
    expect([r.status, r.headers.get('content-type'), await r.text()]).toEqual([
      200,
      'text/html; charset=utf-8',
      '<p>operator 0</p>',
    ]);
    const j = await call('/ivar/page/v/1/n.json');
    expect([j.headers.get('content-type'), await j.json()]).toEqual(['application/json', { n: 0 }]);
    // an older program's plain status line is still text/plain
    await call('/ivar/hello', { method: 'POST', body: hello });
    expect((await call('/ivar/hello/v/1/hello/ada')).headers.get('content-type')).toBe('text/plain; charset=utf-8');
  });
});

describe('headers (0.3)', () => {
  it('reads the headers a program set from the status line, and refuses one it may not set', () => {
    const all = (s: string) => {
      const r = responseOf(enc.encode(s));
      return [r.status, r.headers, dec.decode(r.body)];
    };
    expect(all('302\rlocation: /x\n')).toEqual([302, [{ name: 'location', value: '/x' }], '']);
    expect(all('200 text/html\rx-a: 1\rx-a: 2\n<p>')).toEqual([
      200,
      [
        { name: 'x-a', value: '1' },
        { name: 'x-a', value: '2' },
      ],
      '<p>',
    ]);
    expect(all('200\rset-cookie: a=b\nx')[0]).toBe(500);
    expect(all('200\rcontent-type: text/javascript\nx')[0]).toBe(500);
    expect(all('200\r!invalid header value for x-bad\nx')).toEqual([
      500,
      [],
      'the program set a response header the host refuses: invalid header value for x-bad',
    ]);
  });

  it("serves a program's headers, passes the request headers it may read, and never a cookie", async () => {
    const up = await call('/ivar/redirect', { method: 'POST', body: redirect });
    expect(up.status).toBe(201);
    const r = await call('/ivar/redirect/v/1/go/abc', { redirect: 'manual' });
    expect([r.status, r.headers.get('location'), r.headers.get('x-content-type-options')]).toEqual([
      302,
      '/to/abc',
      'nosniff',
    ]);
    const e = await call('/ivar/redirect/v/1/echo', { headers: { 'idempotency-key': 'k7', cookie: 'a=b' } });
    expect([e.status, e.headers.get('x-echo'), await e.text()]).toEqual([200, 'k7', 'k7']);
    const bad = await call('/ivar/redirect/v/1/bad', { method: 'POST', body: 'a\r\nset-cookie: x=1' });
    expect([bad.status, bad.headers.get('set-cookie'), bad.headers.get('x-bad')]).toEqual([500, null, null]);
  });
});

describe('request headers', () => {
  it('passes a program the headers of an allow-list, and no other', async () => {
    const sent = {
      accept: 'text/html',
      'accept-language': 'en',
      'content-type': 'application/json',
      'if-match': '"1"',
      'if-none-match': '"2"',
      'if-modified-since': 'Tue, 24 Nov 2026 00:00:00 GMT',
      'idempotency-key': 'k1',
      // Standard Webhooks (Svix and others): the delivery's id, its time and its signature, which a program checks
      'webhook-id': 'msg_1',
      'webhook-timestamp': '1795478400',
      'webhook-signature': 'v1,K5oZfzN95Z9UVu1EsfQmfVNQhnkZ2pj9o9NDN/H/pI4=',
      'user-agent': 'Svix-Webhooks/1.24',
      'x-delivery-id': 'd1',
      // never: credentials, the client's address, where it came from, what a proxy adds, a name near an allowed one
      cookie: 'a=b',
      authorization: 'Bearer t',
      'proxy-authorization': 'Basic x',
      'x-forwarded-for': '203.0.113.9',
      'x-real-ip': '203.0.113.9',
      'cf-connecting-ip': '203.0.113.9',
      forwarded: 'for=203.0.113.9',
      referer: 'http://elsewhere/',
      origin: 'http://elsewhere',
      'webhook-secret': 's',
      'user-agent-x': 'y',
    };
    const bytes = await tapeRequest(
      new Request('http://tape/x', { method: 'POST', headers: sent, body: 'b' }),
      '/x',
      '',
    );
    const [first = '', ...lines] = (dec.decode(bytes ?? new Uint8Array()).split('\n')[0] ?? '').split('\r');
    expect(first).toBe('POST /x');
    expect(lines.toSorted()).toEqual(
      [
        'accept: text/html',
        'accept-language: en',
        'content-type: application/json',
        'idempotency-key: k1',
        'if-match: "1"',
        'if-modified-since: Tue, 24 Nov 2026 00:00:00 GMT',
        'if-none-match: "2"',
        'user-agent: Svix-Webhooks/1.24',
        'webhook-id: msg_1',
        'webhook-signature: v1,K5oZfzN95Z9UVu1EsfQmfVNQhnkZ2pj9o9NDN/H/pI4=',
        'webhook-timestamp: 1795478400',
        'x-delivery-id: d1',
      ].toSorted(),
    );
  });
});

describe('where a program is mounted', () => {
  it('says so in tape-base, on the operator route and the public one, whatever the client sends', async () => {
    const based = `fn handle(raw: View) -> Buf {
  let r = request(raw)
  let base = match header_of(request: r, name: "tape-base") {
    Some(value) -> value
    None -> "none"
  }
  respond(status: 200) |> append(view: base) |> append(view: " ") |> append(view: r.path)
}
`;
    expect((await call('/ivar/based', { method: 'POST', body: based })).status).toBe(201);
    expect((await call('/_public/ivar/based', { method: 'PUT', body: '{"published":true}' })).status).toBe(200);
    const said = async (r: Promise<Response>): Promise<string> => (await r).text();
    expect(await said(call('/ivar/based/v/1/a/b?x=1'))).toBe('http://tape/ivar/based/v/1 /a/b');
    expect(await said(anyone('/p/ivar/based/a/b?x=1'))).toBe('http://tape/p/ivar/based /a/b');
    expect(await said(anyone('/p/ivar/based'))).toBe('http://tape/p/ivar/based /');
    // the host's, first and only: a client's own tape-base is not passed
    expect(await said(anyone('/p/ivar/based/', { headers: { 'tape-base': 'http://elsewhere' } }))).toBe(
      'http://tape/p/ivar/based /',
    );
  });
});

describe('public route', () => {
  it('answers 404 until the operator publishes the name, and only with a token may it be published', async () => {
    await call('/ivar/pub', { method: 'POST', body: page });
    expect((await anyone('/p/ivar/pub/')).status).toBe(404);
    expect((await anyone('/p/ivar/nothing/')).status).toBe(404);
    expect((await anyone('/_public/ivar/pub', { method: 'PUT', body: '{"published":true}' })).status).toBe(401);
    expect((await call('/_public/ivar/nothing', { method: 'PUT', body: '{"published":true}' })).status).toBe(404);
    expect((await call('/_public/ivar/pub', { method: 'PUT', body: '{"published":"yes"}' })).status).toBe(400);
    const p = await got('/_public/ivar/pub', { method: 'PUT', body: '{"published":true}' });
    expect([at(p, 'published'), at(p, 'latest'), at(p, 'url')]).toEqual([true, 1, 'http://tape/p/ivar/pub/']);
    const r = await anyone('/p/ivar/pub/');
    expect([r.status, r.headers.get('content-type'), await r.text()]).toEqual([
      200,
      'text/html; charset=utf-8',
      '<p>anyone 0</p>',
    ]);
    // no trace link: a trace is the operator's
    expect([
      r.headers.get('tape-trace-url'),
      r.headers.get('tape-request-id'),
      r.headers.get('tape-supervisor-span'),
    ]).toEqual([null, null, null]);
  });

  it("runs the latest version, tells the program the caller, and keeps the operator's routes the operator's", async () => {
    await call('/ivar/pub2', { method: 'POST', body: page });
    await call('/_public/ivar/pub2', { method: 'PUT', body: '{"published":true}' });
    expect((await anyone('/p/ivar/pub2/visit', { method: 'POST', body: 'ada' })).status).toBe(201);
    expect(await (await anyone('/p/ivar/pub2/')).text()).toBe('<p>anyone 1</p>');
    expect((await anyone('/p/ivar/pub2/reset', { method: 'POST' })).status).toBe(403);
    expect((await call('/ivar/pub2/v/1/reset', { method: 'POST' })).status).toBe(200);
    // the operator's view of the same data
    expect(await (await call('/ivar/pub2/v/1/')).text()).toBe('<p>operator 1</p>');
    // a second version is what the public route runs next
    await call('/ivar/pub2', {
      method: 'POST',
      body: page.replace('\\(who(caller)) \\(n)', '\\(who(caller)) n=\\(n)'),
    });
    expect(await (await anyone('/p/ivar/pub2/')).text()).toBe('<p>anyone n=1</p>');
    // the request line cannot be forged from the path: a space in it arrives percent-encoded
    expect((await anyone('/p/ivar/pub2/reset%20x', { method: 'POST' })).status).toBe(404);
    expect((await anyone('/p/ivar/pub2/', { method: 'DELETE' })).status).toBe(405);
    // HEAD is GET without the body (RFC 9110 9.3.2): the program is asked GET, and the answer's status and type
    // are GET's. It answered 404 here, the program's fallback for a method it never names: every page of
    // apps/products did that to HEAD, which link previews and uptime checks send
    const headed = await anyone('/p/ivar/pub2/', { method: 'HEAD' });
    expect([headed.status, headed.headers.get('content-type'), await headed.text()]).toEqual([
      200,
      'text/html; charset=utf-8',
      '',
    ]);
    expect((await anyone('/p/ivar/pub2/visit', { method: 'POST', body: 'x'.repeat(64 * 1024 + 1) })).status).toBe(413);
    // unpublished: 404 again, and the operator's route still runs
    expect(at(await got('/_public/ivar/pub2', { method: 'PUT', body: '{"published":false}' }), 'published')).toBe(
      false,
    );
    expect((await anyone('/p/ivar/pub2/')).status).toBe(404);
    expect((await call('/ivar/pub2/v/2/')).status).toBe(200);
  });

  it('never publishes a KV shard or a tool, and needs a token for every other route', async () => {
    expect((await call('/_public/ivar/kv-x', { method: 'PUT', body: '{"published":true}' })).status).toBe(400);
    expect((await anyone('/p/ivar/tool-x/')).status).toBe(404);
    expect((await anyone('/ivar/pub/v/1/')).status).toBe(401);
  });
});
