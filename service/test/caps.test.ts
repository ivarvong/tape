// Runs in workerd: a body over its cap is refused with 413 as it streams, without being read whole: a public
// route's request (64 KB), an operator's request to a version (1 MiB), and an upload's source (1 MiB).
import { describe, expect, it } from 'vitest';
import page from './fixtures/page.tape?raw';
import { anyone, call } from './help.ts';

/** A body sent in chunks with no content-length: `n` bytes, and how many were pulled before the answer came. */
const chunked = (n: number): { body: ReadableStream<Uint8Array>; pulled: () => number } => {
  let sent = 0;
  const chunk = new Uint8Array(8 * 1024).fill(97);
  return {
    body: new ReadableStream({
      pull(c) {
        if (sent >= n) {
          c.close();
          return;
        }
        c.enqueue(chunk);
        sent += chunk.length;
      },
    }),
    pulled: () => sent,
  };
};

describe('body caps', () => {
  it('refuse a public body over 64 KB sent without a content-length, before reading it all', async () => {
    await call('/ivar/capped', { method: 'POST', body: page });
    await call('/_public/ivar/capped', { method: 'PUT', body: '{"published":true}' });
    const big = chunked(16 * 1024 * 1024);
    const r = await anyone('/p/ivar/capped/visit', { method: 'POST', body: big.body });
    expect(r.status).toBe(413);
    expect(big.pulled()).toBeLessThan(1024 * 1024);
    // at the cap is fine
    const ok = chunked(64 * 1024);
    expect((await anyone('/p/ivar/capped/visit', { method: 'POST', body: ok.body })).status).toBe(201);
  });

  it("refuse an operator's request body over 1 MiB, and an upload over 1 MiB, without reading it all", async () => {
    await call('/ivar/capv', { method: 'POST', body: page });
    const big = chunked(64 * 1024 * 1024);
    const r = await call('/ivar/capv/v/1/visit', { method: 'POST', body: big.body });
    expect(r.status).toBe(413);
    expect(big.pulled()).toBeLessThan(4 * 1024 * 1024);
    const src = chunked(64 * 1024 * 1024);
    const u = await call('/ivar/capu', { method: 'POST', body: src.body });
    expect(u.status).toBe(413);
    expect(src.pulled()).toBeLessThan(4 * 1024 * 1024);
    // a content-length over the cap is refused before any of it is read
    const said = await call('/ivar/capu', {
      method: 'POST',
      headers: { 'content-length': String(2 * 1024 * 1024) },
      body: 'x'.repeat(2 * 1024 * 1024),
    });
    expect(said.status).toBe(413);
    const tool = chunked(64 * 1024 * 1024);
    const t = await call('/tools/ivar/big', { method: 'POST', body: tool.body });
    expect(t.status).toBe(413);
  });
});
