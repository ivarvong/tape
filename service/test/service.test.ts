// Runs in workerd: upload, invoke, isolation between versions, logs, traces, and the refusals.
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import hello from '../../examples/hello.tape?raw';
import example from '../../examples/tickets.tape?raw';
import payments from '../../examples/payments.tape?raw';
import inventory from '../../examples/inventory.tape?raw';
import shipping from '../../examples/shipping.tape?raw';
import fulfillment from '../../examples/fulfillment.tape?raw';
import { docOf } from '../jepsen/traces.ts';
import type { Attr, RawEvent, RawResource, RawSpan } from '../jepsen/traces.ts';
import { anyone, at, call, fields, got, json, list, num, pause, roomy, text } from './help.ts';
import type { Fields } from '../jepsen/json.ts';
import type { Init } from './help.ts';

// the box office with room in its first charge's budget (help.ts roomy): no outcome below is the machine's speed
const tickets = roomy(example);

const upload = (name: string, source: string): Promise<unknown> =>
  got(`/ivar/${name}`, { method: 'POST', body: source });
/** A signed link (a URL, or a header's value), opened without the token. */
const opened = (link: unknown, more = ''): Promise<Response> => {
  const url = new URL(`${text(link)}${more}`);
  return anyone(url.pathname + url.search);
};
const linkedJson = async (link: unknown): Promise<unknown> => json(await opened(link));
/** Upload each program to an account, each as its first version. */
const uploadAll = async (account: string, programs: Readonly<Record<string, string>>): Promise<void> => {
  for (const [name, source] of Object.entries(programs))
    expect(at(await got(`/${account}/${name}`, { method: 'POST', body: source }), 'version')).toBe(1);
};
/** The rows a route answered with. */
const rows = async (path: string): Promise<Fields[]> => list(await got(path)).map(fields);
/** One column of those rows by another: stock by sku, balance by card. */
const table = async (path: string, key: string, value: string): Promise<Record<string, unknown>> =>
  Object.fromEntries((await rows(path)).map(r => [text(r[key]), r[value]]));
/** Asks until the answer passes ok: waits for an event (a timer run, a step finished elsewhere), not for a time a
 * loaded machine may not keep. Bounded by asks, not ms; on an idle machine the first few pass. */
const eventually = async <T>(ask: () => Promise<T>, ok: (v: T) => boolean, asks = 1200): Promise<T> => {
  let v = await ask();
  for (let i = 0; !ok(v); i++) {
    if (i >= asks) throw new Error(`still not so after ${asks} asks: ${JSON.stringify(v)}`);
    // oxlint-disable-next-line no-await-in-loop -- one ask at a time is the point
    await pause(50);
    // oxlint-disable-next-line no-await-in-loop -- one ask at a time is the point
    v = await ask();
  }
  return v;
};
/** Waits until the account's fault plan has held a reply (slow_reply logged): the call it holds has been sent. */
const heldReply = (account: string): Promise<unknown> =>
  eventually(
    () => got(`/_faults/${account}`),
    v => list(at(v, 'faults')).some(f => at(f, 'kind') === 'slow_reply'),
  );
/** examples/fulfillment.tape with its timers set an hour out: a test that resumes a stalled order by hand
 * (POST /advance) is not raced by the order's own 1 s timer when the machine is slow between the two. */
const parked = (source: string): string => {
  const policy = 'Backoff(first: 1000, factor: 2, most: 30000, tries: 5)';
  if (!source.includes(policy)) throw new Error(`examples/fulfillment.tape no longer has ${policy}`);
  return source.replace(policy, 'Backoff(first: 3600000, factor: 2, most: 3600000, tries: 5)');
};
/** The codes of a list of problems. */
const codes = (problems: unknown): unknown[] => list(problems).map(p => at(p, 'code'));
/** What a search found; the test fails when it found nothing. */
const must = <T>(found: T | undefined, what = 'it'): T => {
  if (found === undefined) throw new Error(`no ${what}`);
  return found;
};
/** The services an OTLP document has spans of, in order, and the spans of one. */
const serviceOf = (r: RawResource): string =>
  r.resource.attributes.find(a => a.key === 'service.name')?.value.stringValue ?? '';
const servicesOf = (o: unknown): string[] => docOf(o).resourceSpans.map(serviceOf);
const spansOf = (o: unknown, service: string): RawSpan[] =>
  docOf(o)
    .resourceSpans.filter(r => serviceOf(r) === service)
    .flatMap(r => r.scopeSpans[0]?.spans ?? []);
/** The n-th span of a service. */
const spanOf = (o: unknown, service: string, n = 0): RawSpan => must(spansOf(o, service)[n], `span ${n} of ${service}`);
/** An attribute of a span or an event, as text. */
const attrOf = (of: { attributes: readonly Attr[] }, key: string): string =>
  of.attributes.find(a => a.key === key)?.value.stringValue ?? '';
/** The names of a span's events, and the events of one name. */
const eventsOf = (sp: RawSpan, name: string): RawEvent[] => sp.events.filter(e => e.name === name);

describe('tape service', () => {
  it('refuses a request without the token', async () => {
    expect((await anyone('/ivar/x')).status).toBe(401);
  });

  it('cannot compile Wasm from bytes at runtime, which is why programs go through the Worker Loader', async () => {
    const empty = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
    await expect(WebAssembly.compile(empty)).rejects.toThrow();
  });

  it("uploads versions that share the name's data", async () => {
    const v1 = await upload('hello', hello);
    expect(at(v1, 'version')).toBe(1);
    expect(await (await call('/ivar/hello/v/1/hello/ada')).text()).toBe('Hello, ada');
    const again = await call('/ivar/hello/v/1/hello/ada');
    expect([again.status, await again.text()]).toEqual([200, 'Hello again, ada #2!']);
    const v2 = await upload('hello', hello);
    expect([at(v2, 'version'), at(v2, 'hash')]).toEqual([2, at(v1, 'hash')]);
    expect(await (await call('/ivar/hello/v/2/hello/ada')).text()).toBe('Hello again, ada #3!');
    expect((await rows('/ivar/hello')).map(v => [v['version'], v['live']])).toEqual([
      [1, true],
      [2, true],
    ]);
  });

  it("records each request's effect log and traces it from that log", async () => {
    await upload('tickets', tickets);
    const sold = await call('/ivar/tickets/v/1/buy', {
      method: 'POST',
      body: '{"key":"b1","section":"floor","qty":2,"card":"ann-4242"}',
    });
    // no program named payments in this account yet: the charge is rejected, the sale voided, the seats freed
    expect([sold.status, await sold.text()]).toEqual([402, '{"error":"there is no program named payments"}']);
    const id = sold.headers.get('tape-request-id');
    const log = await got(`/ivar/tickets/log/1/${id}`);
    expect(at(log, 'effects', 0, 'build')).toBeTruthy();
    const trace = await (await call(`/ivar/tickets/trace/1/${id}`)).text();
    expect(trace).toContain('declined'); // a function of examples/tickets.tape, by name
  });

  it('traces a run that loops over a long body up to TRACE_SITES arms, and says where it stopped', async () => {
    // a 60 KB CSV through apps/products/csv2chart made 2.2 million trace events: the page and the OTLP link ran
    // the Worker out of memory (1101). The trace keeps the first 100,000 and the write after them.
    const loop = `schema "CREATE TABLE IF NOT EXISTS seen(n INTEGER NOT NULL)"

fn handle(raw: View, db: Sql) -> Response {
  let n = count(v: request(raw).body, at: 0, k: 0)
  let _ = sql_exec(query: "INSERT INTO seen(n) VALUES (:n)", repeat: True, n)
  buf() |> append(view: "\\(n)") |> respond(status: 200)
}

fn count(v: View, at: Int, k: Int) -> Int {
  match {
    at >= len(v) -> k
    v[at] == 120 -> count(v, at: at + 1, k: k + 1)
    else -> count(v, at: at + 1, k)
  }
}
`;
    await uploadAll('ivar', { looped: loop });
    const res = await call('/ivar/looped/v/1/', { method: 'POST', body: 'x'.repeat(60_000) });
    expect([res.status, await res.text()]).toEqual([200, '60000']);
    const page = await opened(res.headers.get('tape-trace-url'), '&format=text');
    expect(page.status).toBe(200);
    const lines = await page.text();
    expect(lines).toMatch(/the trace stops here: \d+ more arms tried were not kept/);
    expect(lines).toContain('sql 0 [60000] → 1 written');
    expect((await opened(res.headers.get('tape-otlp-url'))).status).toBe(200);
  });

  it('signs a trace URL into every response; the page opens without the token until it expires', async () => {
    await upload('pages', hello);
    const res = await call('/ivar/pages/v/1/hello/ada'),
      link = res.headers.get('tape-trace-url') ?? '';
    expect(link).toMatch(/^http:\/\/tape\/t\/ivar\/pages\/r\/[0-9a-f]{16}\?exp=\d+&sig=[0-9a-f]{64}$/);
    const page = await opened(link);
    expect([page.status, page.headers.get('content-type')]).toEqual([200, 'text/html; charset=utf-8']);
    const html = await page.text();
    for (const part of ['GET /hello/ada', 'Hello, ada', '✓', 'start   build', 'sql 0']) expect(html).toContain(part);
    expect(await (await opened(`${link}&format=text`)).text()).toContain('✓');
    const tampered = link.replace(/sig=./, s => (s.endsWith('0') ? 'sig=1' : 'sig=0')),
      expired = link.replace(/exp=\d+/, 'exp=1');
    for (const bad of [tampered, expired, link.replace('/ivar/pages/', '/ivar/pagez/'), link.split('?')[0]])
      expect((await opened(bad)).status).toBe(401);
  });

  it('calls another program in the same account: the latest version of payments charges the card', async () => {
    await upload('payments', payments);
    await upload('box', tickets);
    const buy = (body: string): Promise<Response> => call('/ivar/box/v/1/buy', { method: 'POST', body });
    const paid = await buy('{"key":"b2","section":"balcony","qty":2,"card":"ann-4242"}');
    expect(paid.status).toBe(201);
    expect(await json(paid)).toMatchObject({ section: 'balcony', qty: 2, amount: 90 });
    expect((await buy('{"key":"b3","section":"floor","qty":4,"card":"ann-4242"}')).status).toBe(409);
    const declined = await buy('{"key":"b4","section":"balcony","qty":2,"card":"bob-0001"}');
    expect([declined.status, at(await json(declined), 'error')]).toEqual([402, 'card declined: not enough funds']);
    const trace = await (await opened(declined.headers.get('tape-trace-url'))).text();
    expect(trace).toContain('call payments.charge within 2000 ms → rejected');
  });

  it('retries a timed-out charge with the same key: payments answers from its stored reply, and both sides show it', async () => {
    await upload('payments', payments);
    await upload('retry', example.replace('within: 50', 'within: 1')); // the first attempt cannot answer in 1 ms
    const first = await call('/ivar/retry/v/1/buy', {
      method: 'POST',
      body: '{"key":"b5","section":"balcony","qty":2,"card":"bob-0001"}',
    });
    expect([first.status, at(await json(first), 'error')]).toEqual([
      504,
      'payments did not answer in time; the seats stay held',
    ]);
    const second = await call('/ivar/retry/v/1/retry/1', { method: 'POST' });
    expect(second.status).toBe(402); // bob has 50 and the sale is 90: the original reply, given again
    const page = async (res: Response, f = ''): Promise<string> =>
      (await opened(res.headers.get('tape-trace-url'), f)).text();
    expect(await page(first, '&format=text')).toMatch(
      /payments v\d+ ran charge at .* for key ivar\/retry\/charge\/\{"sale":1\} and answered rejected/,
    );
    expect(await page(second, '&format=text')).toMatch(
      /answered rejected from the reply it stored for key ivar\/retry\/charge\/\{"sale":1\}: charge did not run again/,
    );
    const o = await linkedJson(first.headers.get('tape-otlp-url'));
    const root = spanOf(o, 'ivar/retry'),
      client = spanOf(o, 'ivar/retry', 1),
      server = spanOf(o, 'ivar/payments');
    expect(servicesOf(o)).toEqual(['tape-router', 'ivar/retry supervisor', 'ivar/retry', 'ivar/payments']);
    // the whole request: the router's span (the root here: no client traceparent), its call, the supervisor, the run
    const router = spanOf(o, 'tape-router'),
      invoke = spanOf(o, 'tape-router', 1),
      supervisor = spanOf(o, 'ivar/retry supervisor');
    expect([router.parentSpanId, invoke.parentSpanId, supervisor.parentSpanId, root.parentSpanId]).toEqual([
      undefined,
      router.spanId,
      invoke.spanId,
      supervisor.spanId,
    ]);
    expect([root.traceId, root.spanId, client.spanId].map(x => x.length)).toEqual([32, 16, 16]);
    expect([client.parentSpanId, server.parentSpanId, server.traceId, client.kind, server.kind]).toEqual([
      root.spanId,
      client.spanId,
      root.traceId,
      3,
      2,
    ]);
    expect(attrOf(must(eventsOf(root, 'db.query')[1], 'second query'), 'db.query.text')).toContain('UPDATE sections');
    expect(BigInt(root.endTimeUnixNano) >= BigInt(root.startTimeUnixNano)).toBe(true);
    const dedup = await linkedJson(second.headers.get('tape-otlp-url'));
    expect([servicesOf(dedup).length, spanOf(dedup, 'ivar/retry', 1).events[0]?.name]).toEqual([
      4,
      'tape.call.deduplicated',
    ]);
    // the callee's spans are timed by its supervisor across the facet call, so they have a start and an end of their own
    const stored = spanOf(dedup, 'ivar/payments');
    expect([stored.name, stored.parentSpanId, stored.kind]).toEqual([
      'payments charge (stored reply)',
      spanOf(dedup, 'ivar/retry', 1).spanId,
      2,
    ]);
    for (const sp of [server, stored]) expect(BigInt(sp.endTimeUnixNano) >= BigInt(sp.startTimeUnixNano)).toBe(true);
  });

  // The fixtures below are about migrations, not retries, so their INSERTs count every attempt (the opt-out from
  // C55); the people fixture needs two rows with the same email.
  it("migrates the name's data forward: additive at once, edited refused, contract held until older versions retire", async () => {
    const v1 = `migration 1 "notes" {
  CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT NOT NULL)
}
type Count { Count(n: Int) }
fn handle(raw: View, db: Sql) -> Response {
  match request(raw) {
    Request(method: Post, path: "/notes", body) -> count(found: sql_first(db, row: Count, repeat: True, query: "INSERT INTO notes(body) VALUES (:body) RETURNING id AS n", body))
    Request(method: Get, path: "/notes") -> count(found: sql_first(db, row: Count, query: "SELECT count(*) AS n FROM notes"))
    _ -> append(buf: buf(), view: "no such route") |> respond(status: 404)
  }
}
fn count(found: Option[Count]) -> Response {
  match found {
    Some(value: Count(n)) -> write_int(out: buf(), value: n) |> respond(status: 200)
    None -> empty(status: 500)
  }
}
`;
    const v2 = v1
      .replace(
        'type Count',
        'migration 2 "pins" {\n  ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;\n  CREATE INDEX notes_pinned ON notes(pinned)\n}\ntype Count',
      )
      .replace(
        '    _ -> append',
        '    Request(method: Get, path: "/unpinned") -> count(found: sql_first(db, row: Count, query: "SELECT count(*) AS n FROM notes WHERE pinned = 0"))\n    _ -> append',
      );
    const first = await upload('notes', v1);
    expect(await (await opened(at(first, 'migrated'), '&format=text')).text()).toContain('migration 1 "notes"');
    await call('/ivar/notes/v/1/notes', { method: 'POST', body: 'milk' });
    // a misspelt column is refused by the compiler (C68, from the schema the migrations build), before any data is touched
    const typo = at(
      await upload('notes', v2.replace('/unpinned', '/unpinned/nope').replace('pinned = 0', 'pinnd = 0')),
      'errors',
      0,
    );
    expect([at(typo, 'code'), at(typo, 'message')]).toEqual(['C68', expect.stringContaining('pinnd')]);
    const second = await upload('notes', v2);
    expect([at(second, 'version'), at(second, 'live'), at(second, 'held')]).toEqual([2, [1, 2], null]); // a refused upload takes no number
    const run = await opened(at(second, 'migrated'), '&format=text');
    expect(await run.text()).toContain('ALTER TABLE notes ADD COLUMN pinned');
    expect(await (await call('/ivar/notes/v/2/unpinned')).text()).toBe('1'); // v1's note, kept and migrated
    expect(await (await call('/ivar/notes/v/1/notes', { method: 'POST', body: 'eggs' })).text()).toBe('2'); // v1 still runs
    const otlp = await linkedJson(text(at(second, 'migrated')).replace('/t/', '/otlp/'));
    expect(list(at(otlp, 'resourceSpans', 0, 'scopeSpans', 0, 'spans', 0, 'events')).map(e => at(e, 'name'))).toEqual([
      'db.migration',
      'db.migration',
    ]);
    const edited = await (
      await call('/ivar/notes', { method: 'POST', body: v2.replace('body TEXT NOT NULL)', 'body TEXT)') })
    ).json();
    expect(at(edited, 'problem')).toMatch(/^migration 1 "notes" was changed after v2 shipped it/);
    const v4 = v2.replace(
      'type Count',
      'migration 3 "drop the pin index" contract {\n  DROP INDEX notes_pinned\n}\ntype Count',
    );
    const third = await upload('notes', v4);
    expect(at(third, 'held')).toBe(
      'migration 3 "drop the pin index" is a contract and waits until v1, v2 are retired (DELETE /:account/:name/v/:version)',
    );
    const heldRun = await call('/ivar/notes/v/3/notes');
    const heldBody = await json(heldRun);
    expect([
      heldRun.status,
      at(heldBody, 'outcome'),
      heldRun.headers.get('tape-outcome'),
      heldRun.headers.get('retry-after'),
    ]).toEqual([409, 'not_applied', 'not_applied', null]);
    await call('/ivar/notes/v/1', { method: 'DELETE' });
    const released = await got('/ivar/notes/v/2', { method: 'DELETE' });
    expect([at(released, 'live'), at(released, 'held')]).toEqual([[3], null]);
    expect(await (await opened(at(released, 'migrated'), '&format=text')).text()).toContain('DROP INDEX notes_pinned');
    expect(await (await call('/ivar/notes/v/3/notes')).text()).toBe('2');
    expect((await call('/ivar/notes/v/1/notes')).status).toBe(410);
  });

  it('refuses a migration that would break a live version; the compiler refuses the forms that used to need it (C51, C52)', async () => {
    const v1 = `migration 1 "notes" {
  CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT NOT NULL);
  CREATE TABLE tags(note INTEGER NOT NULL, tag TEXT NOT NULL)
}
type Count { Count(n: Int) }
fn handle(raw: View, db: Sql) -> Response {
  count(found: sql_first(db, row: Count, repeat: True, query: "INSERT INTO tags VALUES (1, 'x') RETURNING note AS n"))
}
fn count(found: Option[Count]) -> Response {
  match found {
    Some(value: Count(n)) -> write_int(out: buf(), value: n) |> respond(status: 200)
    None -> empty(status: 500)
  }
}
`;
    const join = 'SELECT count(body) AS n FROM notes JOIN tags ON tags.note = notes.id',
      ins = "INSERT INTO tags VALUES (1, 'x') RETURNING note AS n";
    // Before C52 a query over two tables with a bare `body` was accepted, and only this check caught the migration
    // that later added tags.body (it made v1's query ambiguous). Now the compiler refuses the query itself.
    const bare = await call('/ivar/gaps', {
      method: 'POST',
      body: v1.replace(`repeat: True, query: "${ins}"`, `query: "${join}"`),
    });
    expect([bare.status, codes(at(await json(bare), 'errors'))]).toEqual([400, ['C52']]);
    // Before C51 a rename passed as an expansion when written so the keyword check missed it; now it is refused
    const rename = await call('/ivar/gaps', {
      method: 'POST',
      body: v1 + 'migration 2 "tidy" {\n  ALTER TABLE main . notes RENAME COLUMN body TO text\n}\n',
    });
    expect([rename.status, codes(at(await json(rename), 'errors'))]).toEqual([400, ['C51']]);
    expect(at(await upload('gaps', v1), 'version')).toBe(1);
    // additive, allowed by C51, fine for the new version, but v1's INSERT without a column list now has too few values
    const v2 =
      v1.replace('INSERT INTO tags VALUES', 'INSERT INTO tags(note, tag) VALUES') +
      'migration 2 "tag bodies" {\n  ALTER TABLE tags ADD COLUMN body TEXT\n}\n';
    const adds = await upload('gaps', v2);
    expect([at(adds, 'status'), at(adds, 'error')]).toEqual([409, 'it would break v1, which is still live']);
    expect(at(adds, 'problems', 0, 'reason')).toContain('2 values');
    expect(at(adds, 'problems', 0)).toMatchObject({ version: 1, query: ins });
    // the refusal is recorded like a request: a signed page and OTLP spans for the check that ran and was rolled back
    const page = await (await opened(at(adds, 'checked'), '&format=text')).text();
    expect(page).toContain('migration 2 "tag bodies"');
    expect(page).toMatch(/prepare v1: \d+ of \d+ statements/);
    const spans = docOf(await linkedJson(at(adds, 'checked_otlp'))).resourceSpans[0]?.scopeSpans[0]?.spans ?? [];
    expect(spans.map(x => x.name)).toEqual([
      'check v2 against ivar/gaps',
      'migrate 2 "tag bodies"',
      'prepare v1',
      'prepare v2',
    ]);
    expect([0, 2, 3].map(i => spans[i]?.status.code)).toEqual([2, 2, 0]);
    // nothing was stored, and v1 still answers
    expect((await rows('/ivar/gaps')).map(v => v['version'])).toEqual([1]);
    expect((await call('/ivar/gaps/v/1/')).status).toBe(200);
    // the same additive change is accepted once it no longer breaks anyone: retire v1 first
    expect(at(await got('/ivar/gaps/v/1', { method: 'DELETE' }), 'retired')).toBe(1);
    expect(at(await upload('gaps', v2), 'version')).toBe(2);
  });

  it('checks an upload against the data as it stands, not only its shape', async () => {
    const v1 = `migration 1 "people" {
  CREATE TABLE people(id INTEGER PRIMARY KEY, email TEXT NOT NULL)
}
type Count { Count(n: Int) }
fn handle(raw: View, db: Sql) -> Response {
  match request(raw) {
    Request(method: Post, path: "/people", body) -> count(found: sql_first(db, row: Count, repeat: True, query: "INSERT INTO people(email) VALUES (:body) RETURNING id AS n", body))
    _ -> count(found: sql_first(db, row: Count, query: "SELECT count(*) AS n FROM people"))
  }
}
fn count(found: Option[Count]) -> Response {
  match found {
    Some(value: Count(n)) -> write_int(out: buf(), value: n) |> respond(status: 200)
    None -> empty(status: 500)
  }
}
`;
    expect(at(await upload('people', v1), 'version')).toBe(1);
    for (const e of ['a@x', 'a@x']) await call('/ivar/people/v/1/people', { method: 'POST', body: e });
    // fine on an empty table, and against the schema alone; not on this data, which has the same email twice
    const unique = await upload(
      'people',
      // with the index the INSERT gives a whole unique key, so it no longer says it repeats (C88)
      v1.replace('repeat: True, ', '') +
        'migration 2 "one per email" {\n  CREATE UNIQUE INDEX people_email ON people(email)\n}\n',
    );
    expect([at(unique, 'status'), at(unique, 'error')]).toEqual([409, 'it does not fit the data as it stands']);
    expect(at(unique, 'problems', 0)).toMatchObject({
      version: 2,
      migration: 2,
      statement: 'CREATE UNIQUE INDEX people_email ON people(email)',
    });
    expect(at(unique, 'problems', 0, 'reason')).toContain('UNIQUE constraint failed');
    // rolled back: no index, no version, both rows still there
    expect((await rows('/ivar/people')).map(v => v['version'])).toEqual([1]);
    expect(await (await call('/ivar/people/v/1/')).text()).toBe('2');
    // an upload that passes has a signed page for its check too
    const ok = await upload('people', v1 + 'migration 2 "names" {\n  ALTER TABLE people ADD COLUMN name TEXT\n}\n');
    expect(at(ok, 'version')).toBe(2);
    expect(await (await opened(at(ok, 'checked'), '&format=text')).text()).toContain('prepare v1:');
  });

  it('refuses schema statements beside migrations (C53); the same tables in migrations only work on a fresh name', async () => {
    // Before C53 this was accepted, and it relied on the schema running first; whether a migration's CREATE TABLE
    // then made anything depended on the name's history.
    const src = `schema "CREATE TABLE IF NOT EXISTS sales(id INTEGER PRIMARY KEY, qty INTEGER NOT NULL)"
migration 1 "refunds" {
  ALTER TABLE sales ADD COLUMN refunded INTEGER NOT NULL DEFAULT 0
}
type Count { Count(n: Int) }
fn handle(raw: View, db: Sql) -> Response {
  count(found: sql_first(db, row: Count, query: "SELECT count(*) AS n FROM sales WHERE refunded = 0"))
}
fn count(found: Option[Count]) -> Response {
  match found {
    Some(value: Count(n)) -> write_int(out: buf(), value: n) |> respond(status: 200)
    None -> empty(status: 500)
  }
}
`;
    const both = await call('/ivar/fresh', { method: 'POST', body: src });
    expect([both.status, codes(at(await json(both), 'errors'))]).toEqual([400, ['C53']]);
    const v1 = await upload(
      'fresh',
      src.replace(
        'schema "CREATE TABLE IF NOT EXISTS sales(id INTEGER PRIMARY KEY, qty INTEGER NOT NULL)"\nmigration 1 "refunds" {\n',
        'migration 1 "sales" {\n  CREATE TABLE sales(id INTEGER PRIMARY KEY, qty INTEGER NOT NULL)\n}\nmigration 2 "refunds" {\n',
      ),
    );
    expect([at(v1, 'version'), at(v1, 'migrated', 'error')]).toEqual([1, undefined]);
    const res = await call('/ivar/fresh/v/1/');
    expect([res.status, await res.text()]).toEqual([200, '0']);
  });

  it('a retried /buy with the same key is the same sale: the seats are taken once and the card charged once (C54, C55)', async () => {
    // Before: no key, so a client that got no answer and sent /buy again took the seats twice and made two sales.
    await upload('payments', payments);
    await upload('again', tickets);
    const buy = (body: Record<string, unknown>): Promise<Response> =>
      call('/ivar/again/v/1/buy', { method: 'POST', body: JSON.stringify(body) });
    const one = { key: 'k-1', section: 'balcony', qty: 2, card: 'ann-4242' };
    const balance = async (): Promise<number> =>
        num((await table('/ivar/payments/v/1/cards', 'card', 'balance'))['ann-4242']),
      before = await balance();
    const first = await buy(one),
      firstBody = await json(first);
    const both = await Promise.all([buy(one), buy(one)]);
    expect([first.status, ...both.map(r => r.status)]).toEqual([201, 201, 201]);
    for (const r of both) expect(at(await json(r), 'id')).toBe(at(firstBody, 'id'));
    expect((await table('/ivar/again/v/1/sections', 'name', 'seats'))['balcony']).toBe(8);
    expect(before - (await balance())).toBe(90); // charged once
    const reused = await buy({ ...one, qty: 1 });
    expect(reused.status).toBe(422);
    expect((await buy({ section: 'balcony', qty: 1, card: 'ann-4242' })).status).toBe(400);
  });

  it('says when a live version would be refused today: the listing (?rules), an upload beside it, and it keeps running', async () => {
    const ok = 'fn handle(raw: View, db: Sql) -> Response {\n  empty(status: 200)\n}\n';
    expect(at(await upload('stale', ok), 'version')).toBe(1);
    // a version stored before the rules: its source is replaced in place, as a program uploaded before C55 would be
    const old =
      'schema "CREATE TABLE IF NOT EXISTS n(id INTEGER PRIMARY KEY, x INTEGER)"\nfn handle(raw: View, db: Sql) -> Response {\n  done(n: sql_exec(db, query: "INSERT INTO n(x) VALUES (1)"))\n}\nfn done(n: Int) -> Response {\n  buf() |> write_int(value: n) |> respond(status: 200)\n}\n';
    expect((await call('/ivar/stale', { method: 'POST', body: old })).status).toBe(400);
    await runInDurableObject(env.NAMES.get(env.NAMES.idFromName('ivar/stale')), (_, state) =>
      state.storage.sql.exec('UPDATE _tape_versions SET source = ?1 WHERE version = 1', old),
    );
    const listed = await got('/ivar/stale?rules');
    expect(list(listed).map(v => [at(v, 'version'), at(v, 'live'), codes(at(v, 'rules', 'fails'))])).toEqual([
      [1, true, ['C55']],
    ]);
    expect(at(listed, 0, 'rules', 'note')).toContain('keeps running');
    expect(at(await got('/ivar/stale'), 0, 'rules')).toBe(undefined); // only when asked
    const v2 = await upload('stale', ok.replace('200', '201'));
    expect([
      at(v2, 'version'),
      list(at(v2, 'live_failing_rules')).map(r => [at(r, 'version'), codes(at(r, 'problems'))]),
    ]).toEqual([2, [[1, ['C55']]]]);
    expect(at(v2, 'live_failing_rules_note')).toContain('v1 is still live and would be refused');
    expect((await call('/ivar/stale/v/1/')).status).toBe(200); // not broken: it runs as it was built
    expect((await call('/ivar/stale/v/1', { method: 'DELETE' })).status).toBe(200);
    expect(at(await upload('stale', ok), 'live_failing_rules')).toBe(undefined);
  });

  it('machines across versions: the triggers allow what every live version does, are made again on retire, and refuse what they cannot read', async () => {
    const S = `schema "CREATE TABLE IF NOT EXISTS s(id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, state TEXT NOT NULL DEFAULT 'pending')"\n`;
    const M =
      'type SaleState { Pending Paid Declined }\nmachine s.state: SaleState {\n  Pending -> Paid\n  Pending -> Declined\n}\n';
    const routes = (machine: string, lines: readonly string[]): string =>
      `${S}${machine}fn handle(raw: View, db: Sql) -> Response {\n  match request(raw) {\n${lines.join('\n')}\n    Request(method: Get, path: "/triggers") -> buf() |> append(view: sql_first(db, row: Text, query: "SELECT coalesce(group_concat(sql, ' ; '), '') AS text FROM sqlite_master WHERE type = 'trigger'") |> shown) |> respond(status: 200)\n    _ -> empty(status: 404)\n  }\n}\ntype Text { Text(text: View) }\nfn shown(found: Option[Text]) -> View {\n  match found {\n    Some(value: Text(text)) -> text\n    None -> ""\n  }\n}\nfn done(n: Int) -> Response {\n  buf() |> write_int(value: n) |> respond(status: 200)\n}\ntype Sold { Sold(id: Int) }\nfn moved(m: Move[Sold]) -> Response {\n  match m {\n    Moved(value) -> buf() |> write_int(value: 1) |> respond(status: 200)\n    Raced(now) -> empty(status: 409)\n    NoRow -> empty(status: 404)\n  }\n}\n`;
    const make =
      '    Request(method: Post, path: "/new/" ++ key) -> done(n: sql_exec(db, query: "INSERT INTO s(key) VALUES (:key) ON CONFLICT(key) DO NOTHING", key))';
    const pay =
      '    Request(method: Post, path: "/pay/" ++ key) -> done(n: sql_exec(db, query: "UPDATE s SET state = \'paid\' WHERE key = :key AND state = \'pending\'", key))';
    // with the machine, the compare-and-set is a sql_move (C62): its outcome tells a lost race from a missing row
    const payMove =
      '    Request(method: Post, path: "/pay/" ++ key) -> moved(m: sql_move(db, row: Sold, query: "UPDATE s SET state = \'paid\' WHERE key = :key AND state = \'pending\' RETURNING id", key))';
    const voids =
      '    Request(method: Post, path: "/void/" ++ key) -> done(n: sql_exec(db, query: "UPDATE s SET state = \'void\' WHERE key = :key AND state = \'paid\'", key))';
    const free =
      '    Request(method: Post, path: "/set/" ++ key) -> done(n: sql_exec(db, query: "UPDATE s SET state = :state WHERE key = :key AND state = \'paid\'", state: "x" ++ key, key))';
    const answered = async (path: string, init?: Init): Promise<[number, string]> => {
      const r = await call(`/ivar/mach${path}`, init);
      return [r.status, await r.text()];
    };
    // v1 has no machine; it pays and voids
    expect(at(await upload('mach', routes('', [make, pay, voids])), 'version')).toBe(1);
    expect([
      (await answered('/v/1/new/a', { method: 'POST' }))[0],
      await answered('/v/1/pay/a', { method: 'POST' }),
      await answered('/v/1/triggers'),
    ]).toEqual([200, [200, '1'], [200, '']]);
    // v2 declares the machine, which has no void: v1's move is allowed while v1 is live, and listed
    const untyped = await call('/ivar/mach', { method: 'POST', body: routes(M, [make, pay]) });
    expect([untyped.status, codes(at(await json(untyped), 'errors'))]).toEqual([400, ['C62']]);
    const v2 = await upload('mach', routes(M, [make, payMove]));
    expect([
      at(v2, 'version'),
      at(v2, 'machines', 'installed'),
      list(at(v2, 'live_failing_rules')).map(r => [at(r, 'version'), codes(at(r, 'problems'))]),
    ]).toEqual([2, ['_tape_machine_s_state_move', '_tape_machine_s_state_start'], [[1, ['C59']]]]);
    expect(at(v2, 'live_failing_rules', 0, 'problems', 0, 'message')).toContain(
      'under machine s.state (declared by v2)',
    );
    const listed = await got('/ivar/mach?rules');
    expect(
      list(listed).map(v => [
        at(v, 'version'),
        at(v, 'rules') === 'passes' ? 'passes' : codes(at(v, 'rules', 'fails')),
      ]),
    ).toEqual([
      [1, ['C59']],
      [2, 'passes'],
    ]);
    const [, both] = await answered('/v/2/triggers');
    expect([both.includes('NEW."state" IS \'paid\''), both.includes('NEW."state" IS \'void\'')]).toEqual([true, true]);
    expect(await answered('/v/1/void/a', { method: 'POST' })).toEqual([200, '1']); // not broken
    // v2's typed compare-and-set: Moved, then Raced for the same row, then NoRow for a key with no row
    await answered('/v/2/new/b', { method: 'POST' });
    expect([
      await answered('/v/2/pay/b', { method: 'POST' }),
      (await answered('/v/2/pay/b', { method: 'POST' }))[0],
      (await answered('/v/2/pay/nobody', { method: 'POST' }))[0],
    ]).toEqual([[200, '1'], 409, 404]);
    // a version beside them whose state writes cannot be read is refused, naming it
    const v3 = await call('/ivar/mach', { method: 'POST', body: routes('', [make, free]) });
    const v3body = await json(v3);
    expect([v3.status, list(at(v3body, 'problems')).map(p => [at(p, 'version'), at(p, 'code')])]).toEqual([
      409,
      [[3, 'C60']],
    ]);
    // the row in 'void' is a state v2's machine does not declare: once v1 is retired, a new version with that machine
    // is refused by the data check
    const retired = await call('/ivar/mach/v/1', { method: 'DELETE' });
    expect([retired.status, list(at(await json(retired), 'machines', 'installed')).length]).toEqual([200, 2]);
    const [, only] = await answered('/v/2/triggers');
    expect([only.includes('NEW."state" IS \'paid\''), only.includes("'void'")]).toEqual([true, false]); // made again without v1's move
    const v4 = await call('/ivar/mach', {
      method: 'POST',
      body: routes(M, [make, payMove]).replace('fn done', '// v4\nfn done'),
    });
    const v4body = await json(v4);
    expect([v4.status, at(v4body, 'error'), list(at(v4body, 'problems')).map(p => at(p, 'reason'))]).toEqual([
      409,
      'it does not fit the data as it stands',
      [
        'machine s.state: 1 row is in "void", which machine s.state does not declare (pending, paid, declined); it can make no move',
      ],
    ]);
  });

  it('runs a durable workflow: steps resume after a timeout without repeating, and a refusal compensates', async () => {
    // an account of its own: other tests have a payments. parked: the stalled order below is resumed by hand, and its
    // own timer (1 s in the example) would race that on a slow machine
    await uploadAll('wf', { inventory, payments, shipping, fulfill: parked(fulfillment) });
    const order = (body: Record<string, unknown>, wait = ''): Promise<Response> =>
      call(`/wf/fulfill/v/1/orders${wait}`, { method: 'POST', body: JSON.stringify(body) });
    const state = async (): Promise<Record<string, unknown>> => ({
      stock: await table('/wf/inventory/v/1/stock', 'sku', 'remaining'),
      cards: await table('/wf/payments/v/1/cards', 'card', 'balance'),
      labels: (await rows('/wf/shipping/v/1/labels')).length,
    });
    expect(await state()).toEqual({
      stock: { desk: 2, lamp: 5 },
      cards: { 'ann-4242': 300, 'bob-0001': 50 },
      labels: 0,
    });

    // happy path: reserve, charge, label, in one request
    const happy = await order({ key: 'o11', sku: 'lamp', qty: 1, card: 'ann-4242', address: '1 Main St' });
    expect(happy.status).toBe(201);
    expect(await json(happy)).toMatchObject({ id: 1, state: 'done', amount: 40, label: 1, steps: 3, note: '' });
    expect(await state()).toEqual({
      stock: { desk: 2, lamp: 4 },
      cards: { 'ann-4242': 260, 'bob-0001': 50 },
      labels: 1,
    });

    // a client that waits 1 ms per step: reserve times out, but it ran; the order stays in `reserving`
    const slow = await order({ key: 'o12', sku: 'lamp', qty: 2, card: 'ann-4242', address: '2 Main St' }, '/wait/1');
    expect(slow.status).toBe(202);
    expect(await json(slow)).toMatchObject({
      id: 2,
      state: 'reserving',
      steps: 0,
      note: '',
      stall: 'inventory.reserve did not answer in time; attempt 2 in 3600000 ms',
      retries: 1,
    });
    // the reservation happened: the caller stopped waiting after 1 ms, so it may still be running; wait for it
    expect(at(await eventually(state, v => at(v, 'stock', 'lamp') !== 4), 'stock', 'lamp')).toBe(2);
    // resume: reserve is answered from the stored reply (stock is not taken again), charge and label run
    const resumed = await call('/wf/fulfill/v/1/advance/2', { method: 'POST' });
    expect(resumed.status).toBe(201);
    expect(await json(resumed)).toMatchObject({ id: 2, state: 'done', amount: 80, label: 2, steps: 3 });
    expect(await state()).toEqual({
      stock: { desk: 2, lamp: 2 },
      cards: { 'ann-4242': 180, 'bob-0001': 50 },
      labels: 2,
    });
    const page = await (await opened(resumed.headers.get('tape-trace-url'), '&format=text')).text();
    expect(page).toMatch(
      /call inventory\.reserve once \{"order":2\} -> ok .*answered ok from the reply it stored for key wf\/fulfill\/reserve\/\{"order":2\}: reserve did not run again/,
    );
    expect(page).toMatch(/call payments\.charge once \{"order":2\} -> ok .*ran charge/);
    expect(page).toMatch(/call shipping\.label once \{"order":2\} -> ok .*ran label/);
    // resuming a finished order does nothing
    expect((await call('/wf/fulfill/v/1/advance/2', { method: 'POST' })).status).toBe(201);
    expect(at(await state(), 'cards', 'ann-4242')).toBe(180);

    // no carrier for the address: charged, then refunded, then the stock released
    const nowhere = await order({ key: 'o13', sku: 'desk', qty: 1, card: 'ann-4242', address: 'Atlantis' });
    expect(nowhere.status).toBe(200);
    expect(await json(nowhere)).toMatchObject({
      id: 3,
      state: 'failed',
      amount: 150,
      label: 0,
      steps: 5,
      note: 'no carrier delivers to that address',
    });
    expect(await state()).toEqual({
      stock: { desk: 2, lamp: 2 },
      cards: { 'ann-4242': 180, 'bob-0001': 50 },
      labels: 2,
    });
    const o = await linkedJson(nowhere.headers.get('tape-otlp-url'));
    const clients = spansOf(o, 'wf/fulfill').filter(x => x.kind === 3);
    expect(clients.map(x => [x.name, x.status.code])).toEqual([
      ['inventory/reserve', 0],
      ['payments/charge', 0],
      ['shipping/label', 2],
      ['payments/refund', 0],
      ['inventory/release', 0],
    ]);
    // one after another: each call starts (measured when it was sent) no earlier than the one before it ended
    for (const [i, later] of clients.entries())
      expect(BigInt(later.startTimeUnixNano) >= BigInt(clients[i - 1]?.endTimeUnixNano ?? 0)).toBe(true);

    // card declined: the stock is released, nothing was charged
    const declined = await order({ key: 'o14', sku: 'lamp', qty: 2, card: 'bob-0001', address: '3 Main St' });
    expect(await json(declined)).toMatchObject({
      id: 4,
      state: 'failed',
      steps: 3,
      note: 'card declined: not enough funds',
    });
    // not enough stock: nothing to undo
    const none = await order({ key: 'o15', sku: 'desk', qty: 9, card: 'ann-4242', address: '4 Main St' });
    expect([none.status, at(await json(none), 'state')]).toEqual([409, 'failed']);
    expect(await state()).toEqual({
      stock: { desk: 2, lamp: 2 },
      cards: { 'ann-4242': 180, 'bob-0001': 50 },
      labels: 2,
    });
    expect(at(await got('/wf/fulfill/v/1/orders/4'), 'state')).toBe('failed');
  });

  it('a retried POST /orders with the same key is the same order: one reservation, one charge (C55)', async () => {
    await uploadAll('wfk', { inventory, payments, shipping, fulfill: fulfillment });
    const order = (body: Record<string, unknown>): Promise<Response> =>
      call('/wfk/fulfill/v/1/orders', { method: 'POST', body: JSON.stringify(body) });
    const one = { key: 'once-1', sku: 'lamp', qty: 1, card: 'ann-4242', address: '1 Main St' };
    const first = await order(one),
      again = await order(one);
    expect([first.status, again.status]).toEqual([201, 201]);
    expect([at(await json(first), 'id'), at(await json(again), 'id')]).toEqual([1, 1]);
    expect((await table('/wfk/inventory/v/1/stock', 'sku', 'remaining')).lamp).toBe(4);
    expect((await table('/wfk/payments/v/1/cards', 'card', 'balance'))['ann-4242']).toBe(260);
    expect((await order({ ...one, qty: 2 })).status).toBe(422);
    expect((await order({ sku: 'lamp', qty: 1, card: 'ann-4242', address: '1 Main St' })).status).toBe(400);
  });

  it('a step that timed out resumes by itself: its timer (a Durable Object alarm) runs woken, no POST /advance', async () => {
    await uploadAll('timer', { inventory, payments, shipping, fulfill: fulfillment });
    const slow = await call('/timer/fulfill/v/1/orders/wait/1', {
      method: 'POST',
      body: '{"key":"b6","sku":"lamp","qty":2,"card":"ann-4242","address":"2 Main St"}',
    });
    expect([slow.status, await json(slow)]).toMatchObject([
      202,
      {
        id: 1,
        state: 'reserving',
        retries: 1,
        stall: 'inventory.reserve did not answer in time; attempt 2 in 1000 ms',
      },
    ]);
    const set = await got('/timer/fulfill/wakes');
    expect([list(at(set, 'set')).map(w => at(w, 'key')), at(set, 'alarm') !== null, at(set, 'runs')]).toEqual([
      [1],
      true,
      [],
    ]);
    const setter = await linkedJson(slow.headers.get('tape-otlp-url'));
    expect(
      must(eventsOf(spanOf(setter, 'timer/fulfill'), 'tape.timer.set')[0], 'timer event').attributes.find(
        a => a.key === 'tape.wake.after_ms',
      )?.value,
    ).toEqual({ intValue: '1000' });
    const order = await eventually(
      () => got('/timer/fulfill/v/1/orders/1'),
      v => at(v, 'state') === 'done',
    );
    expect(order).toMatchObject({ state: 'done', amount: 80, steps: 3, retries: 0, stall: '' });
    expect((await table('/timer/inventory/v/1/stock', 'sku', 'remaining')).lamp).toBe(3); // reserved once
    const after = await got('/timer/fulfill/wakes');
    expect([
      at(after, 'set'),
      at(after, 'alarm'),
      list(at(after, 'runs')).map(r => [at(r, 'key'), at(r, 'status'), num(at(r, 'late_ms')) >= 0]),
    ]).toEqual([[], null, [[1, 'ok', true]]]);
    const page = await (await opened(at(after, 'runs', 0, 'trace_url'), '&format=text')).text();
    expect(page).toMatch(/woken/);
    expect(page).toMatch(
      /call inventory\.reserve once \{"order":1\} -> ok .*answered ok from the reply it stored for key timer\/fulfill\/reserve\/\{"order":1\}: reserve did not run again/,
    );
    // the woken run is a child of the request that set the timer: one trace in Jaeger
    const woke = must(
        docOf(await linkedJson(at(after, 'runs', 0, 'otlp_url'))).resourceSpans[0]?.scopeSpans[0]?.spans[0],
        'woken run',
      ),
      first = spanOf(setter, 'timer/fulfill');
    expect([woke.traceId, woke.parentSpanId, woke.kind, woke.name]).toEqual([
      first.traceId,
      first.spanId,
      5,
      'fulfill woken by timer 1',
    ]);
  });

  it("woken is run by the program's own timers; another program cannot call it", async () => {
    await call('/timer2/fulfill', { method: 'POST', body: fulfillment });
    const caller =
      'type Got { Got(id: Int) }\nfn handle(raw: View, fulfill: Remote) -> Response {\n  match call(to: fulfill, method: "woken", send: Wake(key: 1), reply: Got, within: 2000, once: raw) {\n    Ok(value) -> empty(status: 200)\n    Err(error: Rejected(reason)) -> buf() |> append(view: reason) |> respond(status: 403)\n    Err(error) -> empty(status: 500)\n  }\n}\n';
    expect(at(await got('/timer2/caller', { method: 'POST', body: caller }), 'version')).toBe(1);
    const res = await call('/timer2/caller/v/1/');
    expect([res.status, await res.text()]).toEqual([
      403,
      "fulfill.woken is run by fulfill's own timers, not called by other programs",
    ]);
  });

  // Found by the Jepsen-style runs (test/jepsen.test.ts); each is the smallest sequence that shows it.
  describe('under faults (jepsen-* accounts)', () => {
    const faults = (a: string, p: Readonly<Record<string, number>> | null): Promise<Response> =>
      call(`/_faults/${a}`, { method: 'PUT', body: JSON.stringify(p && { seed: 1, p }) });
    const cards = (a: string): Promise<Record<string, unknown>> => table(`/${a}/payments/v/1/cards`, 'card', 'balance');

    it('faults are refused for any other account, and an account without a plan is untouched', async () => {
      expect((await faults('ivar', { lost: 1 })).status).toBe(400);
      expect(await got('/_faults/jepsen-none')).toEqual({ plan: null, faults: [], counts: {} });
    });

    it('a callee whose commit fails is unreachable, not a refusal: the caller keeps the hold and the key (S2)', async () => {
      // before: the storage failure answered Rejected, so the caller compensated, and a retry of the same key that
      // succeeded later charged the card for a sale (or an order) already given up
      const a = 'jepsen-r-storage';
      await uploadAll(a, { payments, tickets });
      await faults(a, { storage_error: 1 });
      const res = await call(`/${a}/tickets/v/1/buy`, {
        method: 'POST',
        body: '{"key":"b8","section":"floor","qty":1,"card":"ann-4242"}',
      });
      expect(res.status).toBe(503);
      expect((await cards(a))['ann-4242']).toBe(300);
      await faults(a, null);
      const again = await call(`/${a}/tickets/v/1/retry/1`, { method: 'POST' });
      expect(again.status).toBe(201);
      expect((await cards(a))['ann-4242']).toBe(180);
    });

    it('a reply lost after the callee committed is an unknown outcome, not a refusal', async () => {
      // before: the exception became Rejected, so the box office voided the sale and freed the seats while the
      // card stayed charged (300 -> 180 for a ticket the buyer never got)
      for (const kind of ['lost', 'reset_callee_after']) {
        const a = `jepsen-r-${kind.replaceAll('_', '')}`;
        await uploadAll(a, { payments, tickets });
        await faults(a, { [kind]: 1 });
        const res = await call(`/${a}/tickets/v/1/buy`, {
          method: 'POST',
          body: '{"key":"b7","section":"floor","qty":1,"card":"ann-4242"}',
        });
        expect([kind, res.status]).toEqual([kind, 504]);
        expect((await cards(a))['ann-4242']).toBe(180);
        await faults(a, null);
        const retried = await call(`/${a}/tickets/v/1/retry/1`, { method: 'POST' });
        expect(retried.status).toBe(201);
        expect((await cards(a))['ann-4242']).toBe(180);
        expect(await got(`/${a}/tickets/v/1/sales/1`)).toMatchObject({ state: 'paid' });
      }
    });

    it("a timer whose run fails on storage is kept and run later, not lost as a trap's is", async () => {
      // before: any failure but a cut removed the timer, so a transient storage error lost the work for good
      const a = 'jepsen-r-wakestorage';
      const source = `schema "CREATE TABLE IF NOT EXISTS hits(id INTEGER PRIMARY KEY, n INTEGER NOT NULL)"
type Hit { Hit(n: Int) }
export fn woken(db: Sql, timer: Timer, message: Wake) -> Result[Hit, View] {
  let Wake(key) = message
  let _ = sql_exec(
    query: "INSERT INTO hits(id, n) VALUES (:key, 1) ON CONFLICT(id) DO UPDATE SET n = n + 1",
    key,
    repeat: True
  )
  Ok(value: Hit(n: key))
}
fn handle(raw: View, db: Sql, timer: Timer) -> Response {
  do wake(after: 0, key: 1)
  empty(status: 202)
}
`;
      const up = await call(`/${a}/ticker`, { method: 'POST', body: source });
      expect([up.status, up.ok ? '' : await up.text()]).toEqual([201, '']);
      await faults(a, { storage_error: 1 });
      expect((await call(`/${a}/ticker/v/1/`, { method: 'POST' })).status).toBe(202);
      const wakes = (): Promise<unknown> => got(`/${a}/ticker/wakes`);
      let w = await eventually(wakes, v => list(at(v, 'runs')).length > 0);
      await faults(a, null);
      // every run so far failed (more than one when the machine is slow enough that the 1 s retry came before the
      // faults stopped), and the timer is kept
      const failedRuns = list(at(w, 'runs')).map(r => [at(r, 'key'), at(r, 'status')]);
      expect(failedRuns.length).toBeGreaterThan(0);
      expect(failedRuns).toEqual(failedRuns.map(() => [1, 'failed']));
      expect(list(at(w, 'set')).map(s => at(s, 'key'))).toEqual([1]);
      // tried again after its wait, with no fault: it runs once and its timer goes
      w = await eventually(wakes, v => list(at(v, 'set')).length === 0);
      const statuses = list(at(w, 'runs')).map(r => at(r, 'status'));
      expect([at(w, 'set'), statuses]).toEqual([[], ['ok', ...statuses.slice(1).map(() => 'failed')]]);
      expect(statuses.length).toBeGreaterThan(1);
      expect(list(at(await got(`/_faults/${a}`), 'faults')).map(f => [at(f, 'site'), at(f, 'kind')])).toContainEqual([
        'wake>ticker#1',
        'storage_error',
      ]);
    });

    it('two retries that both hear a refusal give the seats back once', async () => {
      // before: both voided the sale and both added the seats back (floor 3 -> 4 after selling none)
      const a = 'jepsen-r-doublefree';
      await uploadAll(a, { payments, tickets });
      await faults(a, { drop: 1 }); // the charge runs and is refused (no such card); its reply never arrives
      expect(
        (
          await call(`/${a}/tickets/v/1/buy`, {
            method: 'POST',
            body: '{"key":"b8","section":"floor","qty":1,"card":"nobody"}',
          })
        ).status,
      ).toBe(504);
      await faults(a, null);
      const both = await Promise.all([1, 2].map(() => call(`/${a}/tickets/v/1/retry/1`, { method: 'POST' })));
      expect(both.map(r => r.status).toSorted((x, y) => x - y)).toEqual([402, 402]);
      expect((await table(`/${a}/tickets/v/1/sections`, 'name', 'seats'))['floor']).toBe(3);
    });

    it('a step that stalls after another request finished the order leaves the order as it is', async () => {
      // before: the slow request wrote "did not answer in time" onto a done order and answered 202
      const a = 'jepsen-r-stalenote';
      await uploadAll(a, { inventory, payments, shipping, fulfill: fulfillment });
      // the first call (the slow request's reserve) has its reply held 8 s, past its 4 s budget; the advance below
      // finishes the order inside that budget with seconds to spare, and its calls are not faulted (later
      // positions)
      await call(`/_faults/${a}`, {
        method: 'PUT',
        body: JSON.stringify({ seed: 1, points: [{ hop: 'call', n: 0, kind: 'slow_reply', ms: 8000 }] }),
      });
      const slow = call(`/${a}/fulfill/v/1/orders/wait/4000`, {
        method: 'POST',
        body: '{"key":"b9","sku":"lamp","qty":1,"card":"ann-4242","address":"1 Main St"}',
      });
      await heldReply(a); // the reserve has been sent, and its reply will be held
      await faults(a, null);
      expect((await call(`/${a}/fulfill/v/1/advance/1`, { method: 'POST' })).status).toBe(201);
      const late = await slow;
      expect(await json(late)).toMatchObject({ state: 'done', note: '', stall: '' });
      expect(await got(`/${a}/fulfill/v/1/orders/1`)).toMatchObject({
        state: 'done',
        note: '',
        stall: '',
        steps: 3,
      });
    });
  });

  it('two advances of one order racing: the one that loses the transition shows the order, not 404', async () => {
    // before: the slower request's compare-and-set found the order moved on, and it answered "no such order"
    const a = 'jepsen-r-phantom',
      faults = (p: unknown): Promise<Response> => call(`/_faults/${a}`, { method: 'PUT', body: JSON.stringify(p) });
    await uploadAll(a, { inventory, payments, shipping, fulfill: fulfillment });
    // the first call (the slow request's reserve) has its reply held 3 s, inside its 20 s budget: the advance below
    // moves the order on before that reply arrives, with seconds to spare, and its own calls are not faulted
    await faults({ seed: 1, points: [{ hop: 'call', n: 0, kind: 'slow_reply', ms: 3000 }] });
    const slow = call(`/${a}/fulfill/v/1/orders/wait/20000`, {
      method: 'POST',
      body: '{"key":"b10","sku":"lamp","qty":1,"card":"ann-4242","address":"1 Main St"}',
    });
    await heldReply(a); // reserve has been sent; its reply will be held
    await faults(null);
    expect((await call(`/${a}/fulfill/v/1/advance/1`, { method: 'POST' })).status).toBe(201); // the stored reserve reply, then charge and label
    const late = await slow;
    expect([late.status, at(await json(late), 'state')]).toEqual([201, 'done']);
    expect(at(await got(`/${a}/payments/v/1/cards`), 0, 'balance')).toBe(260); // charged once
  });

  it('binds an Int parameter as an integer (workerd binds every JavaScript number as REAL)', async () => {
    const ints =
      'schema "CREATE TABLE IF NOT EXISTS t(k TEXT NOT NULL)"\ntype R { R(s: View, h: Int, ty: View) }\nfn handle(raw: View, db: Sql) -> Response {\n  show(found: sql_first(db, row: R, query: "SELECT \'k\' || :n AS s, :m * 3 AS h, typeof(:m) AS ty", n: 5, m: 5))\n}\nfn show(found: Option[R]) -> Response {\n  match found {\n    Some(value: R(s, h, ty)) -> append(buf: append(buf: write_int(out: buf(), value: h), view: s), view: ty) |> respond(status: 200)\n    None -> empty(status: 500)\n  }\n}\n';
    expect(await upload('intparams', ints)).toMatchObject({ version: 1 });
    expect(await (await call('/ivar/intparams/v/1/')).text()).toBe('15k5integer'); // before the host's CAST: 15k5.0real
  });

  it('refuses a program that does not compile, and SQL that does not fit its schema', async () => {
    const bad = await (
      await call('/ivar/bad', { method: 'POST', body: 'fn handle(raw: View) -> Response {\n  coumt\n}\n' })
    ).json();
    expect(at(bad, 'errors', 0, 'code')).toBe('C16');
    const sql =
      'schema "CREATE TABLE t(a INTEGER)"\ntype A { A(b: Int) }\nfn handle(raw: View, db: Sql) -> Response {\n  f(found: sql_first(db, row: A, query: "SELECT b FROM nope"))\n}\nfn f(found: Option[A]) -> Response {\n  empty(status: 200)\n}\n';
    const res = await call('/ivar/badsql', { method: 'POST', body: sql });
    expect(res.status).toBe(400);
    const e = at(await json(res), 'errors', 0); // the compiler's, now: the table does not exist in the schema
    expect([at(e, 'code'), at(e, 'message')]).toEqual(['C68', expect.stringContaining('nope')]);
  });
});
