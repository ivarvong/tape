// GET /:account/:name/storage: what a name holds, and the request log's share
import { it, expect } from 'vitest';
import { anyNumber, at, call, got, num } from './help.ts';

/** A number in what /storage answered. */
const size = (storage: unknown, ...path: string[]): number => num(at(storage, ...path));
it("a name's storage grows by a log row per request, reads included, and the log holds the request bytes", async () => {
  const src = 'fn handle(raw: View) -> Response {\n  buf() |> write_text(text: "ok") |> respond(status: 200)\n}\n';
  expect((await call('/store/echo', { method: 'POST', body: src })).status).toBe(201);
  expect(await got('/store/none/storage')).toEqual({
    name: { bytes: anyNumber, versions: 0 },
    data: null,
  });
  const before = await got('/store/echo/storage');
  const body = 'x'.repeat(4096);
  for (let i = 0; i < 5; i++) expect((await call('/store/echo/v/1/', { method: 'POST', body })).status).toBe(200);
  const after = await got('/store/echo/storage');
  expect([
    at(before, 'name', 'versions'),
    size(after, 'data', 'log_rows') - size(before, 'data', 'log_rows'),
    size(after, 'data', 'log_bytes') - size(before, 'data', 'log_bytes') >= 5 * 4096,
    size(after, 'data', 'bytes') >= size(after, 'data', 'log_bytes'),
  ]).toEqual([1, 5, true, true]);
});
