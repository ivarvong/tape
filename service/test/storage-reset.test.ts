// A Durable Object storage reset before the run's log begins (R-ANS-7). The log is written in the transaction of
// the writes, so a run that never logged committed nothing: the answer is 503, outcome "not_applied", and it names
// the request and a trace. The service answers that once. It does not run the request again. The injected fault
// throws once and then storage is healthy; a store that keeps failing is the facet rejection, which is `unknown`.
import { describe, expect, it } from 'vitest';
import { anyone, at, call, got, json } from './help.ts';

const RESET = 'Internal error in Durable Object storage caused object to be reset.';
const SOURCE = `migration 1 "n" {
  CREATE TABLE n(v INTEGER NOT NULL)
}
type N { N(v: Int) }
fn handle(raw: View, db: Sql) -> Response {
  match request(raw) {
    Request(method: Put) -> put(db)
    Request(method: Get) -> got(found: sql_first(db, row: N, query: "SELECT count(*) AS v FROM n"))
    _ -> empty(status: 405)
  }
}
fn put(db: Sql) -> Response {
  let _ = sql_first(db, row: N, repeat: True, query: "INSERT INTO n(v) VALUES (1) RETURNING v")
  empty(status: 201)
}
fn got(found: Option[N]) -> Response {
  match found {
    Some(value: N(v)) -> buf() |> write_int(value: v) |> respond(status: 200)
    None -> empty(status: 404)
  }
}
`;
const hex = (n: number): string =>
  [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');
const plan = {
  seed: 1,
  router: true,
  points: [{ hop: 'router', n: 0, kind: 'storage_reset' }],
};
const faults = (account: string, body: unknown): Promise<Response> =>
  call(`/_faults/${account}`, { method: 'PUT', body: JSON.stringify(body) });

describe('a storage reset before the log begins', () => {
  it('answers 503 not applied, with a request id and the client trace, and the write is absent', async () => {
    const account = 'jepsen-reset',
      name = 'n';
    expect((await call(`/${account}/${name}`, { method: 'POST', body: SOURCE })).status).toBe(201);
    expect((await faults(account, plan)).status).toBe(200);
    const trace = hex(16),
      client = hex(8);
    const put = await call(`/${account}/${name}/v/1/`, {
      method: 'PUT',
      headers: { traceparent: `00-${trace}-${client}-01` },
    });
    const body = await json(put);
    // one answer, the failure: a retry inside the request would have come back 201
    expect(put.status).toBe(503);
    expect(at(body, 'detail')).toBe(`nothing was applied: ${RESET}`);
    expect(at(body, 'reason')).toBe(RESET);
    expect(at(body, 'outcome')).toBe('not_applied');
    expect(at(body, 'transient')).toBe(true);
    expect(String(at(body, 'retry'))).toContain('cannot apply it twice');
    expect(put.headers.get('retry-after')).toBe('1');
    expect(put.headers.get('tape-outcome')).toBe('not_applied');
    expect(put.headers.get('tape-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(put.headers.get('traceparent')).toMatch(new RegExp(`^00-${trace}-[0-9a-f]{16}-01$`));
    const id = put.headers.get('tape-request-id') ?? '';
    const log = await got(`/${account}/${name}/log/1/${id}`);
    expect(at(log, 'effects', 0, 'failed', 'unstarted')).toBe(true);
    expect(at(log, 'effects', 0, 'failed', 'storage')).toBe(true);
    expect(at(log, 'effects', 0, 'trace')).toBe(trace);
    const page = await call(`/${account}/${name}/trace/1/${id}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('nothing was applied');
    // the plan's only fault was that PUT; this GET runs, and the row is not there
    const read = await call(`/${account}/${name}/v/1/`);
    expect([read.status, await read.text(), read.headers.get('tape-outcome')]).toEqual([200, '0', 'applied']);
    expect((await faults(account, null)).status).toBe(200);
    // the same request again, now that the object is up: it applies once
    expect((await call(`/${account}/${name}/v/1/`, { method: 'PUT' })).status).toBe(201);
    expect(await (await call(`/${account}/${name}/v/1/`)).text()).toBe('1');
  });

  it('a published GET carries the same headers and no signed trace link', async () => {
    const account = 'jepsen-resetpub',
      name = 'n';
    expect((await call(`/${account}/${name}`, { method: 'POST', body: SOURCE })).status).toBe(201);
    expect((await call(`/_public/${account}/${name}`, { method: 'PUT', body: '{"published":true}' })).status).toBe(200);
    expect((await faults(account, plan)).status).toBe(200);
    const trace = hex(16);
    const got503 = await anyone(`/p/${account}/${name}/`, {
      headers: { traceparent: `00-${trace}-${hex(8)}-01` },
    });
    const body = await json(got503);
    expect(got503.status).toBe(503);
    expect(at(body, 'outcome')).toBe('not_applied');
    expect(String(at(body, 'detail'))).toContain(RESET);
    expect(got503.headers.get('tape-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(got503.headers.get('tape-outcome')).toBe('not_applied');
    expect(got503.headers.get('traceparent')).toMatch(new RegExp(`^00-${trace}-[0-9a-f]{16}-01$`));
    expect(got503.headers.get('retry-after')).toBe('1');
    expect([got503.headers.get('tape-trace-url'), got503.headers.get('tape-otlp-url')]).toEqual([null, null]);
    expect((await faults(account, null)).status).toBe(200);
    const after = await anyone(`/p/${account}/${name}/`);
    expect([after.status, after.headers.get('tape-outcome'), await after.text()]).toEqual([200, 'applied', '0']);
    expect(after.headers.get('tape-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(after.headers.get('traceparent')).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(after.headers.get('tape-trace-url')).toBeNull();
  });

  it('a program rollback answers with its status and not_applied: the writes did not stay', async () => {
    const account = 'jepsen-resetback';
    const source = `migration 1 "n" {
  CREATE TABLE n(v INTEGER NOT NULL)
}
type N { N(v: Int) }
fn handle(raw: View, db: Sql) -> Response {
  match request(raw) {
    Request(method: Post) -> post(db)
    Request(method: Get) -> got(found: sql_first(db, row: N, query: "SELECT count(*) AS v FROM n"))
    _ -> empty(status: 405)
  }
}
fn post(db: Sql) -> Response {
  let _ = sql_exec(db, query: "INSERT INTO n(v) VALUES (1)", repeat: True)
  let 1 = sql_exec(db, query: "UPDATE n SET v = 2 WHERE v = 0") else -> rollback(out: empty(status: 200))
  empty(status: 500)
}
fn got(found: Option[N]) -> Response {
  match found {
    Some(value: N(v)) -> buf() |> write_int(value: v) |> respond(status: 200)
    None -> empty(status: 404)
  }
}
`;
    expect((await call(`/${account}/n`, { method: 'POST', body: source })).status).toBe(201);
    const rolled = await call(`/${account}/n/v/1/`, { method: 'POST' });
    expect([rolled.status, await rolled.text(), rolled.headers.get('tape-outcome')]).toEqual([200, '', 'not_applied']);
    expect(await (await call(`/${account}/n/v/1/`)).text()).toBe('0');
  });
});
