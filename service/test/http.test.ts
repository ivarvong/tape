// Runs in workerd: a program's outbound HTTP (issue #13 part 3). The Worker sends a program's fetch only to a host on
// the name's list (PUT /_http/:account/:name), https, on the default port, with redirects not followed; anything
// else is Err(Rejected("host not allowed: …")) and nothing is sent. What would be sent is seen by replacing the
// Worker's network (outbound.ts `network`) with one that keeps each request: a refused fetch leaves it empty. The
// secret the program puts in a header is in no page about the run.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { network } from '../src/outbound.ts';
import { anyone, at, call, got, json, text } from './help.ts';

const KEY = 'sk_live_51HxQ9vKp0tTq7xyz';
const PROGRAM = `fn handle(raw: View, secrets: Secrets, http: Http) -> Response {
  let key = value_or(given: secret(name: "stripe"), otherwise: "")
  let auth = Cons(head: Header(name: "authorization", value: "Bearer " ++ key), tail: Nil)
  let url = request(raw).body
  match fetch(to: http, method: Post, url, headers: auth, body: "amount=7", within: 5000, key: Some(value: "refund-7")) {
    Ok(value: HttpReply(status, headers, body)) -> buf() |> write_int(value: status) |> append(view: " ") |> append(view: body) |> respond(status: 200)
    Err(error: Rejected(reason)) -> buf() |> append(view: reason) |> respond(status: 502)
    Err(error: Timeout) -> empty(status: 504)
    Err(_) -> empty(status: 503)
  }
}
`;
type Seen = { url: string; method: string; headers: Record<string, string>; body: string; redirect: string };
let seen: Seen[] = [];
let answer: () => Response = () => new Response('refunded', { status: 201 });
const real = network.fetch;
beforeEach(() => {
  seen = [];
  answer = () => new Response('refunded', { status: 201 });
  network.fetch = async (r: Request): Promise<Response> => {
    seen.push({
      url: r.url,
      method: r.method,
      headers: Object.fromEntries(r.headers),
      body: await r.text(),
      redirect: r.redirect,
    });
    return answer();
  };
});
afterEach(() => {
  network.fetch = real;
});
const opened = async (link: string | null, more = ''): Promise<string> => {
  const url = new URL(`${link ?? ''}${more}`);
  return (await anyone(url.pathname + url.search)).text();
};
const fetchTo = (url: string): Promise<Response> => call('/web/pay/v/1/', { method: 'POST', body: url });

describe('outbound HTTP', () => {
  it('the operator lists exact hosts; anything else is refused', async () => {
    expect(await got('/_http/web/pay')).toMatchObject({ hosts: [] });
    for (const bad of [
      ['*.stripe.com'],
      ['10.0.0.1'],
      ['[::1]'],
      ['API.stripe.com'],
      ['localhost'],
      ['metadata.internal'],
      ['stripe'],
      'x',
    ])
      expect((await call('/_http/web/pay', { method: 'PUT', body: JSON.stringify({ hosts: bad }) })).status).toBe(400);
    const set = await got('/_http/web/pay', { method: 'PUT', body: '{"hosts": ["api.stripe.com", "api.stripe.com"]}' });
    expect(set).toMatchObject({ hosts: ['api.stripe.com'] });
    expect((await anyone('/_http/web/pay')).status).toBe(401);
    expect((await call('/_http/web/tool-x', { method: 'PUT', body: '{"hosts": []}' })).status).toBe(400);
  });

  it('sends a request to a listed host, with its key, not following a redirect; no page holds the secret', async () => {
    expect(at(await got('/web/pay', { method: 'POST', body: PROGRAM }), 'version')).toBe(1);
    await call('/_secrets/web/pay/stripe', { method: 'PUT', body: KEY });
    await call('/_http/web/pay', { method: 'PUT', body: '{"hosts": ["api.stripe.com"]}' });
    const r = await fetchTo('https://api.stripe.com/v1/refunds');
    expect([r.status, await r.text()]).toEqual([200, '201 refunded']);
    const sentHeaders: unknown = expect.objectContaining({
      authorization: `Bearer ${KEY}`,
      'idempotency-key': 'refund-7',
    });
    expect(seen).toEqual([
      {
        url: 'https://api.stripe.com/v1/refunds',
        method: 'POST',
        headers: sentHeaders,
        body: 'amount=7',
        redirect: 'manual',
      },
    ]);
    const pages = [
      await opened(r.headers.get('tape-trace-url')),
      await opened(r.headers.get('tape-trace-url'), '&format=text'),
      await opened(r.headers.get('tape-otlp-url')),
      await (await call(`/web/pay/log/1/${r.headers.get('tape-request-id') ?? ''}`)).text(),
    ].join('\n');
    expect(pages).toContain('fetch POST https://api.stripe.com/v1/refunds');
    expect(pages).toContain('http.client.request');
    expect(pages).toContain('Bearer [secret stripe]');
    expect(pages).not.toContain(KEY);
    // a redirect is the reply: its 3xx, and nothing sent to where it points
    seen = [];
    answer = () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } });
    const moved = await fetchTo('https://api.stripe.com/v1/refunds');
    expect(await moved.text()).toBe('302 ');
    expect(seen.map(s => s.url)).toEqual(['https://api.stripe.com/v1/refunds']);
  });

  it('a host not on the list, another port, http, or a reply over 1 MB: refused, and nothing is sent', async () => {
    expect(at(await got('/web/pay2', { method: 'POST', body: PROGRAM }), 'version')).toBe(1);
    await call('/_http/web/pay2', { method: 'PUT', body: '{"hosts": ["api.stripe.com"]}' });
    for (const [url, why] of [
      ['https://evil.example/steal', 'host not allowed: evil.example is not on this program'],
      ['https://api.stripe.com.evil.example/', 'host not allowed: api.stripe.com.evil.example'],
      ['https://api.stripe.com:8443/', 'only the default https port'],
      ['http://api.stripe.com/', 'only https URLs are fetched'],
      ['https://169.254.169.254/latest/meta-data', 'host not allowed: 169.254.169.254'],
      ['https://user:pw@api.stripe.com/', 'a URL with a user or a password'],
    ] as const) {
      const r = await fetchTo(url);
      const reason: unknown = expect.stringContaining(why);
      expect([r.status, await r.text()]).toEqual([502, reason]);
    }
    expect(seen).toEqual([]);
    // no list at all: the same
    expect(at(await got('/web/pay3', { method: 'POST', body: PROGRAM }), 'version')).toBe(1);
    const none = await call('/web/pay3/v/1/', { method: 'POST', body: 'https://api.stripe.com/' });
    expect(text(await none.text())).toContain('host not allowed');
    expect(seen).toEqual([]);
    answer = () => new Response(new Uint8Array(1024 * 1024 + 1));
    const big = await fetchTo('https://api.stripe.com/');
    expect([big.status, await big.text()]).toEqual([502, "a reply's body is at most 1048576 bytes"]);
  });

  it('a tool may not fetch: no policy grants Http', async () => {
    await call('/_policy/webt', { method: 'PUT', body: '{"sql": true, "clock": true, "entropy": true}' });
    const tool = `export fn peek(http: Http, message: Ask) -> Result[Ask, View] {\n  match fetch(to: http, method: Get, url: "https://api.stripe.com/", headers: Nil, body: "", within: 100, key: None) {\n    Ok -> Ok(value: message)\n    Err -> Err(error: "no")\n  }\n}\n\ntype Ask {\n  Ask(n: Int)\n}\n`;
    const r = await call('/tools/webt/peek', { method: 'POST', body: tool });
    expect([r.status, at(await json(r), 'error')]).toEqual([403, 'capability not granted']);
  });
});
