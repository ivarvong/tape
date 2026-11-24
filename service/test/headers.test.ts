// Runs in workerd: every response the Worker gives, a 401 and a 404 too, carries the headers that keep it from being
// sniffed, framed or indexed; the API's answers and trace pages are sandboxed, and so is a program's own HTML.
import { describe, expect, it } from 'vitest';
import page from './fixtures/page.tape?raw';
import hello from '../../examples/hello.tape?raw';
import { anyone, call } from './help.ts';

const API_CSP = "default-src 'none'; frame-ancestors 'none'; sandbox";
const TRACE_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; sandbox";

const headersOf = (r: Response): Record<string, string | null> => ({
  nosniff: r.headers.get('x-content-type-options'),
  frame: r.headers.get('x-frame-options'),
  robots: r.headers.get('x-robots-tag'),
  referrer: r.headers.get('referrer-policy'),
});
const BASE = { nosniff: 'nosniff', frame: 'DENY', robots: 'noindex', referrer: 'no-referrer' };

describe('security headers', () => {
  it('are on a 401, a 404, a 405, a 400 and an operator JSON answer', async () => {
    const answers = [
      await anyone('/'),
      await anyone('/ivar/hello'),
      await anyone('/p/ivar/nothing/'),
      await anyone('/p/ivar/nothing/', { method: 'PUT' }),
      await call('/nobody'),
      await call('/BAD/name'),
      await call('/ivar/nothing'),
    ];
    expect(answers.map(r => r.status)).toEqual([401, 401, 404, 405, 404, 400, 200]);
    for (const r of answers) {
      expect(headersOf(r)).toEqual(BASE);
      expect(r.headers.get('content-security-policy')).toBe(API_CSP);
    }
  });

  it('are on a trace page, which may use only its own inline style', async () => {
    await call('/ivar/hello', { method: 'POST', body: hello });
    const r = await call('/ivar/hello/v/1/hello/ada');
    const link = r.headers.get('tape-trace-url') ?? '';
    expect(link).toMatch(/^http:\/\/tape\/t\//);
    const t = await anyone(link.replace('http://tape', ''));
    expect([t.status, t.headers.get('content-type')]).toEqual([200, 'text/html; charset=utf-8']);
    expect(headersOf(t)).toEqual(BASE);
    expect(t.headers.get('content-security-policy')).toBe(TRACE_CSP);
    // a bad signature is a JSON 401, sandboxed like the API
    const bad = await anyone(link.replace(/sig=[0-9a-f]+/, `sig=${'0'.repeat(64)}`));
    expect([bad.status, bad.headers.get('content-security-policy')]).toEqual([401, API_CSP]);
  });

  it("sandbox a program's own HTML, on its operator route and its public route", async () => {
    await call('/ivar/hpage', { method: 'POST', body: page });
    await call('/_public/ivar/hpage', { method: 'PUT', body: '{"published":true}' });
    for (const r of [await call('/ivar/hpage/v/1/'), await anyone('/p/ivar/hpage/')]) {
      expect([r.status, r.headers.get('content-type')]).toEqual([200, 'text/html; charset=utf-8']);
      expect(headersOf(r)).toEqual(BASE);
      const csp = r.headers.get('content-security-policy') ?? '';
      expect(csp.split('; ')).toEqual(expect.arrayContaining(["default-src 'none'", "frame-ancestors 'none'"]));
      expect(csp).toMatch(/(^|; )sandbox( |;|$)/);
      expect(csp).not.toMatch(/allow-scripts|allow-same-origin|script-src/);
      // a page may show an image of its own (another of the program's routes, an Svg) or a data: URL, and no
      // other: nothing is fetched from another origin
      expect(csp.split('; ').filter(d => d.startsWith('img-src'))).toEqual(["img-src 'self' data:"]);
    }
  });
});
