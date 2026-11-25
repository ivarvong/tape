// Runs in workerd: a program's answer is a Response (issues #11 and #14), so bytes a request sent, answered as a
// body, are served as that body, with the status the program chose and no header, on the operator's route and on
// the public one. Before 25 November 2026 the host read a head out of the answer's first line, and the first of
// these was served as a 302 to evil.example.
import { describe, expect, it } from 'vitest';
import { anyString, anyone, at, call, got } from './help.ts';

const ECHO = `fn handle(raw: View) -> Response {
  buf() |> append(view: request(raw).body) |> respond(status: 200)
}
`;
const PAYLOADS = [
  '302\rlocation: https://evil.example/\n',
  '200 text/html\n<script>alert(1)</script>',
  '200\rcache-control: public, max-age=31536000\nx',
  '42\nhi',
  '199\n',
];

describe('an answer is a Response', () => {
  it('serves the bytes a request sent as the body, 200 text/plain, with no header they name', async () => {
    expect(at(await got('/ivar/echo', { method: 'POST', body: ECHO }), 'version')).toBe(1);
    expect((await call('/_public/ivar/echo', { method: 'PUT', body: '{"published":true}' })).ok).toBe(true);
    for (const body of PAYLOADS)
      for (const r of [
        await call('/ivar/echo/v/1/', { method: 'POST', body }),
        await anyone('/p/ivar/echo/', { method: 'POST', body }),
      ]) {
        expect([r.status, r.headers.get('content-type'), r.headers.get('location'), await r.text()]).toEqual([
          200,
          'text/plain; charset=utf-8',
          null,
          body,
        ]);
        expect(r.headers.get('cache-control') ?? '').not.toContain('max-age=31536000');
      }
  });
});

// The service's own failures are application/problem+json (RFC 9457, issue #17), as a program's `problem` is: one
// shape a client parses, with what it acts on as members beside type, title, status and detail.
const BAD_STATUS = `fn handle(raw: View) -> Response {
  empty(status: len(request(raw).body) + 600)
}
`;
describe('an error is a problem', () => {
  it("answers each of the service's own failures as application/problem+json, its members kept", async () => {
    expect(at(await got('/ivar/badstatus', { method: 'POST', body: BAD_STATUS }), 'version')).toBe(1);
    expect(at(await got('/ivar/echo', { method: 'POST', body: ECHO }), 'version')).toBeGreaterThanOrEqual(1);
    const cases: [string, () => Promise<Response>, number, Record<string, unknown>][] = [
      ['no token', () => anyone('/ivar/echo/v/1/'), 401, { detail: 'unauthorized' }],
      ['no such route', () => call('/ivar'), 404, { title: 'Not Found', detail: 'no such route' }],
      ['an unpublished name', () => anyone('/p/ivar/nobody/'), 404, { detail: 'no such page' }],
      ['a method', () => call('/_public/ivar/echo', { method: 'POST' }), 405, { detail: 'PUT or GET' }],
      [
        'a public body over the cap',
        () => anyone('/p/ivar/echo/', { method: 'POST', body: 'x'.repeat(65537) }),
        413,
        { detail: "a public request's body is at most 65536 bytes" },
      ],
      [
        'a refused upload',
        () => call('/ivar/broken', { method: 'POST', body: 'fn handle(raw: View) -> Response {\n  nope()\n}\n' }),
        400,
        { detail: 'does not compile', errors: [expect.objectContaining({ code: 'C22' })] },
      ],
      ['no such version', () => call('/ivar/echo/v/9/'), 404, { detail: 'no such version', outcome: 'not_applied' }],
      [
        'an answer the host refuses',
        () => call('/ivar/badstatus/v/1/', { method: 'POST', body: '' }),
        500,
        { detail: 'the program answered a response the host refuses: status 600 is outside 200 to 599' },
      ],
    ];
    for (const [what, send, status, members] of cases) {
      const r = await send();
      const body: unknown = await r.json();
      expect([what, r.status, r.headers.get('content-type')]).toEqual([what, status, 'application/problem+json']);
      expect(body).toMatchObject({ type: 'about:blank', title: anyString, status, ...members });
    }
  });
});
