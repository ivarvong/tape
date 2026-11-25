// Runs in workerd: a program's secrets (issue #13 part 2). The operator sets one (PUT /_secrets/...), the program
// reads it with secret(from:, name:), and the value is in no answer the service gives about the run: the log, the
// trace page (HTML and text), the OTLP spans and the request listing are searched byte for byte. A run logged before
// a rotation still replays (the version it read is kept); one whose version was deleted fails its replay closed.
import { describe, expect, it } from 'vitest';
import { anyNumber, anyone, at, call, fields, got, json, list, text } from './help.ts';

const VALUE = 'sk_live_9f8e7d6c5b4a3210';
// reads the secret; answers its length, writes it into a row and, at /echo, answers it (a program's own choice,
// which the trace page and its spans still do not show)
const PROGRAM = `migration 1 "kept" {
  CREATE TABLE kept(id INTEGER PRIMARY KEY, v TEXT NOT NULL)
}

fn handle(raw: View, db: Sql, secrets: Secrets) -> Response {
  let key = value_or(given: secret(name: "stripe"), otherwise: "")
  match request(raw) {
    Request(path: "/echo") -> buf() |> append(view: key) |> respond(status: 200)
    Request(path: "/keep") -> {
      let _ = sql_exec(query: "INSERT INTO kept(v) VALUES (:key)", key, repeat: True)
      empty(status: 204)
    }
    _ -> buf() |> write_int(value: len(key)) |> respond(status: 200)
  }
}
`;
const opened = async (link: string | null, more = ''): Promise<string> => {
  const url = new URL(`${link ?? ''}${more}`);
  return (await anyone(url.pathname + url.search)).text();
};
/** Every page the service gives about one run: the trace (HTML, text), its OTLP, its log, the request listing. */
const pages = async (res: Response, account: string, name: string): Promise<string> => {
  const trace = res.headers.get('tape-trace-url'),
    otlp = res.headers.get('tape-otlp-url'),
    id = res.headers.get('tape-request-id') ?? '';
  return [
    await opened(trace),
    await opened(trace, '&format=text'),
    await opened(otlp),
    await (await call(`/${account}/${name}/log/1/${id}`)).text(),
    await (await call(`/${account}/${name}/trace/1/${id}`)).text(),
    await (await call(`/${account}/${name}/requests`)).text(),
  ].join('\n');
};

describe('secrets', () => {
  it('are set by the operator and listed without their values', async () => {
    const put = await call('/_secrets/sec/one/stripe', { method: 'PUT', body: VALUE });
    expect(put.status).toBe(201);
    const set = await json(put);
    expect(set).toMatchObject({ account: 'sec', name: 'one', secret: 'stripe', version: 1, bytes: VALUE.length });
    expect(JSON.stringify(set)).not.toContain(VALUE);
    expect(
      at(await json(await call('/_secrets/sec/one/stripe', { method: 'PUT', body: `${VALUE}-2` })), 'version'),
    ).toBe(2);
    const listed = await got('/_secrets/sec/one');
    expect(JSON.stringify(listed)).not.toContain(VALUE);
    expect(list(at(listed, 'secrets')).map(fields)).toEqual([
      { name: 'stripe', version: 2, at: anyNumber, bytes: VALUE.length + 2, kept: [1, 2] },
    ]);
    // the operator's token only; a name, a size and a method the route refuses
    expect((await anyone('/_secrets/sec/one')).status).toBe(401);
    expect((await anyone('/_secrets/sec/one/stripe', { method: 'PUT', body: VALUE })).status).toBe(401);
    expect((await call('/_secrets/sec/one/Stripe', { method: 'PUT', body: VALUE })).status).toBe(400);
    expect((await call('/_secrets/sec/one/x', { method: 'PUT', body: 'short' })).status).toBe(400);
    expect((await call('/_secrets/sec/one/x', { method: 'PUT', body: 'x'.repeat(4097) })).status).toBe(413);
    expect((await call('/_secrets/sec/one/x', { method: 'POST', body: VALUE })).status).toBe(405);
    expect((await call('/_secrets/sec/tool-a/x', { method: 'PUT', body: VALUE })).status).toBe(400);
    expect(await got('/_secrets/sec/one/stripe', { method: 'DELETE' })).toMatchObject({ deleted: 2 });
    expect(at(await got('/_secrets/sec/one'), 'secrets')).toEqual([]);
    // the counter goes on: a version is never another value's
    expect(at(await json(await call('/_secrets/sec/one/stripe', { method: 'PUT', body: VALUE })), 'version')).toBe(3);
  });

  it('are read by the program, and no page about the run holds the value', async () => {
    expect(at(await got('/sec/two', { method: 'POST', body: PROGRAM }), 'version')).toBe(1);
    expect((await call('/_secrets/sec/two/stripe', { method: 'PUT', body: VALUE })).status).toBe(201);
    const length = await call('/sec/two/v/1/');
    expect([length.status, await length.text()]).toEqual([200, String(VALUE.length)]);
    const all = await pages(length, 'sec', 'two');
    expect(all).toMatch(/secret +stripe -> version 1/);
    expect(all).toContain('tape.secret.name');
    expect(all).not.toContain(VALUE);
    // the program put it in a row and in its answer: the client gets what the program answered, and the pages
    // about the run show neither
    const kept = await call('/sec/two/v/1/keep');
    expect(kept.status).toBe(204);
    const echo = await call('/sec/two/v/1/echo');
    expect(await echo.text()).toBe(VALUE);
    for (const r of [kept, echo]) {
      const shown = await pages(r, 'sec', 'two');
      expect(shown).not.toContain(VALUE);
      expect(shown).toContain('[secret stripe]');
    }
  });

  it('a run logged before a rotation still replays; one whose version was deleted fails closed', async () => {
    expect(at(await got('/sec/three', { method: 'POST', body: PROGRAM }), 'version')).toBe(1);
    await call('/_secrets/sec/three/stripe', { method: 'PUT', body: VALUE });
    const before = await call('/sec/three/v/1/');
    expect(await before.text()).toBe(String(VALUE.length));
    await call('/_secrets/sec/three/stripe', { method: 'PUT', body: `${VALUE}-rotated` });
    expect(await (await call('/sec/three/v/1/')).text()).toBe(String(VALUE.length + 8));
    const replayed = await opened(before.headers.get('tape-trace-url'), '&format=text');
    expect(replayed).toContain('secret stripe -> version 1');
    expect(replayed).toContain('✓  13');
    expect(replayed).not.toContain('no longer held');
    await call('/_secrets/sec/three/stripe', { method: 'DELETE' });
    const gone = await opened(before.headers.get('tape-trace-url'), '&format=text');
    expect(gone).toContain('the secret stripe at version 1, which this run read, is no longer held');
    expect(gone).not.toContain(VALUE);
    // and with no secret, the program reads None
    expect(await (await call('/sec/three/v/1/')).text()).toBe('0');
  });

  it('a tool may not read one: no policy grants Secrets', async () => {
    await call('/_policy/sect', { method: 'PUT', body: '{"sql": true, "clock": true, "entropy": true}' });
    const tool = `export fn peek(secrets: Secrets, message: Ask) -> Result[Seen, View] {\n  Ok(value: Seen(n: len(value_or(given: secret(name: "stripe"), otherwise: ""))))\n}\n\ntype Ask {\n  Ask(n: Int)\n}\n\ntype Seen {\n  Seen(n: Int)\n}\n`;
    const r = await call('/tools/sect/peek', { method: 'POST', body: tool });
    const body = await json(r);
    expect([r.status, at(body, 'error')]).toEqual([403, 'capability not granted']);
    expect(text(at(body, 'hint'))).toContain('no policy grants Secrets or Http');
  });
});
