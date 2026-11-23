// Tools for agents (src/tools.ts): capabilities granted by policy and checked at upload, a manifest with JSON
// Schemas, calls with signed trace links, and the same over MCP.
import { describe, expect, it } from 'vitest';
import price from '../../examples/tools/price.tape?raw';
import notes from '../../examples/tools/notes.tape?raw';
import convert from '../../examples/tools/convert.tape?raw';
import fx from '../../examples/tools/fx.tape?raw';
import ledger from '../../examples/tools/ledger.tape?raw';
import stamp from '../../examples/tools/stamp.tape?raw';
import { anyone, at, json as body, list, text } from './help.ts';
import type { Init } from './help.ts';

type Ask = (path: string, init?: Init) => Promise<Response>;
const as =
  (token: string): Ask =>
  (path, init) =>
    anyone(path, { ...init, headers: { authorization: `Bearer ${token}`, ...init?.headers } });
const operator = as('test-token');
const json = async (res: Response): Promise<{ status: number; body: unknown }> => ({
  status: res.status,
  body: await body(res),
});
/** The value of an OTLP attribute among a span's or a resource's. */
const attribute = (holder: unknown, key: string): unknown =>
  at(
    list(at(holder, 'attributes')).find(a => at(a, 'key') === key),
    'value',
  );

/** A signed link, opened without a token. */
const fetched = (link: string): Promise<Response> => anyone(new URL(link).pathname + new URL(link).search);

describe('tools', () => {
  it('accepts what the policy grants, refuses the rest with the reason, and calls tools with trace links', async () => {
    const A = 'agents';
    const agent = as(text(at(await body(await operator(`/_agent/${A}`)), 'token')));
    // no policy: only pure tools
    expect((await json(await agent(`/tools/${A}/notes`, { method: 'POST', body: notes }))).body).toEqual({
      tool: 'notes',
      error: 'capability not granted',
      hint: 'An operator grants capabilities with PUT /_policy/:account, for example {"sql": true}; nothing was stored.',
      problems: ['Sql is not granted: export fn put takes db: Sql'],
      granted: [],
    });
    // the agent cannot set the policy, or reach the program routes
    expect((await agent(`/_policy/${A}`, { method: 'PUT', body: '{"sql":true}' })).status).toBe(401);
    expect((await agent(`/${A}/fx`, { method: 'POST', body: fx })).status).toBe(401);
    expect((await agent(`/tools/other/price`, { method: 'POST', body: price })).status).toBe(401);
    expect((await operator(`/_policy/${A}`, { method: 'PUT', body: '{"sql":true,"remote":["fx"]}' })).status).toBe(200);
    expect((await operator(`/${A}/fx`, { method: 'POST', body: fx })).status).toBe(201);

    // a pure tool: no capabilities, and its module imports nothing (it decodes its JSON itself)
    const p = await json(await agent(`/tools/${A}/price`, { method: 'POST', body: price }));
    expect(p.status).toBe(201);
    const tool = at(p.body, 'tools', 0);
    expect(tool).toMatchObject({
      name: 'price_quote',
      capabilities: { pure: true, sql: false, remote: [], imports: [] },
      description:
        'Price a basket: unit price times quantity, less an optional discount, plus tax on what is left (rounded down).',
    });
    expect(at(tool, 'inputSchema', 'properties', 'qty')).toMatchObject({ type: 'integer', minimum: 1, maximum: 100 });
    expect(at(tool, 'inputSchema', 'required')).toEqual(['unit_cents', 'qty', 'tax_percent']);
    const q = await json(
      await agent(`/tools/${A}/price/quote`, {
        method: 'POST',
        body: '{"unit_cents":1999,"qty":3,"discount_percent":10,"tax_percent":8}',
      }),
    );
    expect(q.body).toMatchObject({
      ok: true,
      output: { subtotal_cents: 5997, discount_cents: 599, tax_cents: 431, total_cents: 5829 },
    });
    expect(at(q.body, 'trace_url')).toMatch(/\/t\/agents\/tool-price\/1\//);
    const page = await (await fetched(`${text(at(q.body, 'trace_url'))}&format=text`)).text();
    expect(page).toContain('quote');
    // a message outside the schema is refused by the tool itself, with a trace
    const bad = await json(
      await agent(`/tools/${A}/price/quote`, { method: 'POST', body: '{"unit_cents":1999,"qty":0,"tax_percent":8}' }),
    );
    expect([bad.status, at(bad.body, 'ok')]).toEqual([422, false]);
    expect(at(bad.body, 'error')).toMatch(/qty/);

    // a Sql tool: its own database, kept across calls
    expect((await agent(`/tools/${A}/notes`, { method: 'POST', body: notes })).status).toBe(201);
    const note = async (method: string, message: string): Promise<unknown> =>
      at(await body(await agent(`/tools/${A}/notes/${method}`, { method: 'POST', body: message })), 'output');
    expect(await note('put', '{"key":"a","text":"one"}')).toEqual({ key: 'a', revision: 1 });
    expect(await note('put', '{"key":"a","text":"two"}')).toEqual({ key: 'a', revision: 2 });
    expect(await note('get', '{"key":"a"}')).toEqual({ key: 'a', text: 'two', revision: 2 });

    // a Remote tool: it may ask fx, because the policy lists fx
    expect((await agent(`/tools/${A}/convert`, { method: 'POST', body: convert })).status).toBe(201);
    const c = await json(
      await agent(`/tools/${A}/convert/convert`, { method: 'POST', body: '{"usd_cents":10000,"to":"EUR"}' }),
    );
    expect(at(c.body, 'output')).toEqual({ amount: 9200, currency: 'EUR', per_hundred: 92 });
    const otlp = await body(await fetched(text(at(c.body, 'otlp_url'))));
    expect(
      list(at(otlp, 'resourceSpans')).map(r => at(attribute(at(r, 'resource'), 'service.name'), 'stringValue')),
    ).toEqual(['agents/tool-convert', 'agents/fx']);
    // the tool's own span is an RPC server span carrying the whole message, and lasts at least 1 µs
    const root = list(at(otlp, 'resourceSpans', 0, 'scopeSpans', 0, 'spans')).find(
      sp => text(at(sp, 'parentSpanId')) === '',
    );
    expect([
      at(attribute(root, 'rpc.method'), 'stringValue'),
      at(attribute(root, 'tape.message'), 'stringValue'),
      attribute(root, 'url.path'),
      BigInt(text(at(root, 'endTimeUnixNano'))) > BigInt(text(at(root, 'startTimeUnixNano'))),
    ]).toEqual(['convert', '{"usd_cents":10000,"to":"EUR"}', undefined, true]);

    // refused: Remote payments and the Clock are not granted; nothing is stored
    const l = await json(await agent(`/tools/${A}/ledger`, { method: 'POST', body: ledger }));
    expect(l).toEqual({
      status: 403,
      body: {
        tool: 'ledger',
        error: 'capability not granted',
        problems: ['Remote payments is not granted: export fn pay takes payments: Remote, the program named payments'],
        granted: ['sql', 'remote:fx'],
        hint: 'An operator grants capabilities with PUT /_policy/:account, for example {"remote": ["payments"]}; nothing was stored.',
      },
    });
    expect(at(await body(await agent(`/tools/${A}/stamp`, { method: 'POST', body: stamp })), 'problems')).toEqual([
      'Clock is not granted: export fn stamp takes clock: Clock',
    ]);
    expect((await operator(`/${A}/tool-ledger`)).status).toBe(200);
    expect(await body(await operator(`/${A}/tool-ledger`))).toEqual([]);
    // a program cannot take a tool's name
    expect((await operator(`/${A}/tool-x`, { method: 'POST', body: fx })).status).toBe(400);

    // the manifest
    const m = await body(await agent(`/tools/${A}`));
    expect(list(at(m, 'tools')).map(t => [at(t, 'name'), at(t, 'granted')])).toEqual([
      ['convert_convert', true],
      ['notes_put', true],
      ['notes_get', true],
      ['price_quote', true],
    ]);

    // MCP: initialize, list, call
    /** What an MCP method answered: the result of its JSON-RPC reply. */
    const rpc = async (method: string, params: unknown): Promise<unknown> => {
      const res = await agent(`/mcp/${A}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      return at(await body(res), 'result');
    };
    expect(
      await rpc('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 't', version: '0' },
      }),
    ).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} } });
    expect(
      (await agent(`/mcp/${A}`, { method: 'POST', body: '{"jsonrpc":"2.0","method":"notifications/initialized"}' }))
        .status,
    ).toBe(202);
    const listed = list(at(await rpc('tools/list', {}), 'tools'));
    expect(
      at(
        listed.find(t => at(t, 'name') === 'price_quote'),
        'annotations',
      ),
    ).toEqual({
      readOnlyHint: true,
      openWorldHint: false,
    });
    const called = await rpc('tools/call', { name: 'convert_convert', arguments: { usd_cents: 250, to: 'GBP' } });
    expect(called).toMatchObject({
      isError: false,
      structuredContent: { amount: 197, currency: 'GBP', per_hundred: 79 },
    });
    expect(at(called, '_meta', 'tape/trace_url')).toMatch(/tool-convert/);
    expect(
      await rpc('tools/call', { name: 'convert_convert', arguments: { usd_cents: 250, to: 'XXX' } }),
    ).toMatchObject({ isError: true, content: [{ type: 'text', text: 'no rate for that currency' }] });

    // revoking Remote fx stops the tool at once: at the call, and at the hop to fx
    await operator(`/_policy/${A}`, { method: 'PUT', body: '{"sql":true}' });
    expect(
      (await json(await agent(`/tools/${A}/convert/convert`, { method: 'POST', body: '{"usd_cents":1,"to":"EUR"}' })))
        .status,
    ).toBe(403);
  }, 30000);

  it('refuses a tool with a handle function, and one whose schema statements need Sql', async () => {
    const res = await json(
      await operator('/tools/agents2/h', { method: 'POST', body: 'fn handle(raw: View) -> Buf {\n  buf()\n}\n' }),
    );
    expect(res).toEqual({
      status: 400,
      body: {
        tool: 'h',
        error:
          'tool h exports no function; a tool is `export fn name(capabilities…, message: Type) -> Result[Reply, View]`',
      },
    });
    const schemaOnly =
      'schema "CREATE TABLE t(a INTEGER)"\ntype A { A(a: Int) }\nexport fn echo(message: A) -> Result[A, View] {\n  Ok(value: message)\n}\n';
    expect(
      at(await body(await operator('/tools/agents2/echo', { method: 'POST', body: schemaOnly })), 'problems'),
    ).toEqual(['Sql is not granted: it declares schema statements, which run on its database']);
  }, 30000);

  it('refuses a tool that sets timers: no policy grants Timer', async () => {
    await operator('/_policy/agents3', {
      method: 'PUT',
      body: JSON.stringify({ sql: true, clock: true, entropy: true }),
    });
    const later =
      'export fn woken(timer: Timer, message: Wake) -> Result[Wake, View] {\n  Ok(value: Wake(key: wake(timer, after: 10, key: message.key)))\n}\n';
    expect(await json(await operator('/tools/agents3/later', { method: 'POST', body: later }))).toEqual({
      status: 403,
      body: {
        tool: 'later',
        error: 'capability not granted',
        problems: ['Timer is not granted: export fn woken takes timer: Timer'],
        granted: ['sql', 'clock', 'entropy'],
        hint: 'A tool runs only when an agent calls it, so no policy grants Timer: take the timer out, or upload it as a program (POST /:account/:name); nothing was stored.',
      },
    });
  }, 30000);
});
