// Runs in workerd: a program's answer is a Response (issues #11 and #14), so bytes a request sent, answered as a
// body, are served as that body, with the status the program chose and no header, on the operator's route and on
// the public one. Before 25 November 2026 the host read a head out of the answer's first line, and the first of
// these was served as a 302 to evil.example.
import { describe, expect, it } from 'vitest';
import { anyone, at, call, got } from './help.ts';

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
