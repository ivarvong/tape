// tape-mcp in workerd: the Worker as it is deployed, with the real Loader running each program in a Dynamic Worker
// and the real rate-limit binding. mcp/test.ts checks the tools in depth in Node; this checks that the same answers
// come back from workerd, where the program cannot be compiled by the Worker itself.
import { env, exports } from 'cloudflare:workers';
import { createExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index.ts';
import hello from '../../examples/hello.tape?raw';
import limits from './limits.tape?raw';
import clock from './clock.tape?raw';

type Fields = Record<string, unknown>;
const isFields = (v: unknown): v is Fields => typeof v === 'object' && v !== null && !Array.isArray(v);
const F = (v: unknown): Fields => (isFields(v) ? v : {});
const L = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const headers = {
  'content-type': 'application/json',
  'cf-connecting-ip': '198.51.100.4',
  'user-agent': 'workerd-test',
};

const post = async (
  path: string,
  body: unknown,
  extra: Record<string, string> = {},
): Promise<{ status: number; res: Response; json: Fields }> => {
  const res = await exports.default.fetch(`https://tape-mcp${path}`, {
    method: 'POST',
    headers: { ...headers, ...extra },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, res, json: F(text === '' ? {} : JSON.parse(text)) };
};
let id = 0;
const rpc = async (method: string, params: unknown = {}): Promise<Fields> =>
  F((await post('/mcp', { jsonrpc: '2.0', id: ++id, method, params })).json['result']);
const call = async (name: string, args: unknown): Promise<{ out: Fields; isError: boolean }> => {
  const r = await rpc('tools/call', { name, arguments: args });
  return { out: F(r['structuredContent']), isError: r['isError'] === true };
};
const results = (out: Fields): Fields[] => L(out['results']).map(F);

describe('tape-mcp in workerd', () => {
  it('cannot compile Wasm itself, which is why programs run in a Dynamic Worker', async () => {
    await expect(WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))).rejects.toThrow();
  });

  it('answers the MCP handshake and lists two tools', async () => {
    const init = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'x', version: '1' },
    });
    expect(init).toMatchObject({
      protocolVersion: '2025-06-18',
      serverInfo: { name: 'tape' },
      capabilities: { tools: {} },
    });
    const tools = L((await rpc('tools/list'))['tools']).map(F);
    expect(tools.map(t => t['name'])).toEqual(['compile', 'run', 'feedback']);
    expect(String(tools[1]?.['description'])).toContain('Hello again, ada #2!');
  });

  it('compiles hello.tape, and refuses it without repeat: True with C54 and its fix', async () => {
    expect((await call('compile', {})).out).toMatchObject({ ok: true, diagnostics: [], statements: 1 });
    const { out } = await call('compile', {
      files: [{ name: 'hello.tape', text: hello.replace('        repeat: True,\n', '') }],
    });
    expect(out['ok']).toBe(false);
    const [c54, ...more] = L(out['diagnostics']).map(F);
    expect(more).toEqual([]);
    expect([c54?.['code'], c54?.['file'], c54?.['line']]).toEqual(['C54', 'hello.tape', 11]);
    expect(String(c54?.['fix'])).toContain('repeat');
  });

  it('runs hello twice in a Dynamic Worker: the bodies, the named effects, replayed, and OTLP', async () => {
    const { out, isError } = await call('run', { requests: ['GET /hello/ada', 'GET /hello/ada'], trace: 'full' });
    expect(isError).toBe(false);
    const [a, b] = results(out);
    expect([a?.['status'], a?.['body'], b?.['status'], b?.['body']]).toEqual([
      200,
      'Hello, ada',
      200,
      'Hello again, ada #2!',
    ]);
    for (const [i, r] of [a, b].entries()) {
      expect(r?.['replayed']).toBe(true);
      expect(L(r?.['effects'])).toEqual([
        {
          kind: 'sql',
          query: 'INSERT INTO greeted(name, n) VALUES (:name, 1) ON CONFLICT(name) DO UPDATE SET n = n + 1 RETURNING n',
          params: { ':name': 'ada' },
          rows_returned: 1,
          rows: [[i + 1]],
          // an upsert changes one row each time, an insert and then an update (SQLite's changes())
          rows_written: 1,
        },
      ]);
      const span = F(L(F(L(F(L(F(r?.['trace'])['resourceSpans'])[0])['scopeSpans'])[0])['spans'])[0]);
      expect(span['traceId']).toMatch(/^[0-9a-f]{32}$/);
      expect(span['spanId']).toMatch(/^[0-9a-f]{16}$/);
      expect(span['startTimeUnixNano']).toMatch(/^\d+$/);
      expect(span['name']).toBe('GET /hello/ada');
    }
    // a second call is a fresh database: ada is greeted for the first time again
    const again = await call('run', { requests: ['GET /hello/ada'] });
    expect(results(again.out)[0]?.['body']).toBe('Hello, ada');
  });

  it("runs on the run's own clock in the Dynamic Worker: at_ms moves now(), and a due timer runs before the request", async () => {
    const at = (request: string, at_ms: number): Fields => ({ request, at_ms });
    const { out } = await call('run', {
      files: [{ name: 'clock.tape', text: clock }],
      requests: [
        at('POST /hit', 1000),
        at('POST /later/7', 1000),
        at('GET /window', 60_500),
        at('GET /fired', 61_000),
        at('GET /window', 61_000),
      ],
    });
    const rs = results(out);
    // a hit at 1000; the window at 60500 holds it, at 61000 it does not; the timer set at 1000 for 5000 ms has run
    expect(rs.map(r => [r['request'], r['body']])).toEqual([
      ['POST /hit', '{"n":1}'],
      ['POST /later/7', ''],
      ['woken {"key":7}', '{"n":1}'],
      ['GET /window', '{"n":1}'],
      ['GET /fired', expect.stringMatching(/^\[\{"key":7,"at":\d+\}\]$/)],
      ['GET /window', '{"n":0}'],
    ]);
    expect(rs.map(r => r['at_ms'])).toEqual([1000, 1000, 60_500, 60_500, 61_000, 61_000]);
    expect(F(rs[2]?.['woken'])).toEqual({ key: 7, due_ms: 6000 });
    const nowOf = (r: Fields | undefined): number =>
      Number(
        F(
          L(r?.['effects'])
            .map(F)
            .find(e => e['kind'] === 'now'),
        )['now'],
      );
    expect(nowOf(rs[3]) - nowOf(rs[0])).toBe(59_500);
    expect(out['timers']).toEqual({ fired: 1, pending: 0 });
    // and the summary is the default trace
    expect(F(rs[0]?.['trace'])['spans']).toEqual([expect.objectContaining({ name: 'POST /hit', status: 'ok' })]);
  });

  it("keeps Tape's budget and the body limit inside the Dynamic Worker", async () => {
    const { out } = await call('run', {
      files: [{ name: 'limits.tape', text: limits }],
      requests: [
        'GET /spin',
        'GET /div/',
        'GET /big',
        'GET /dice',
        'GET /dice',
        'GET /huge',
        'GET /huge',
        'GET /hello',
      ],
    });
    const [spin, div, big, d1, d2, huge, huge2, after] = results(out);
    // the 64 MB arena, filled twice (and each replayed), still leaves the Dynamic Worker standing
    expect([huge?.['error'], huge2?.['error'], huge?.['replayed'], after?.['status']]).toEqual([
      'trap 1: out of memory',
      'trap 1: out of memory',
      true,
      404,
    ]);
    expect([spin?.['status'], spin?.['error'], spin?.['replayed']]).toEqual([
      500,
      'trap 2: reduction budget exceeded',
      true,
    ]);
    expect(div?.['error']).toContain('division by zero');
    expect([big?.['truncated'], big?.['body_bytes'], String(big?.['body']).length]).toEqual([true, 70000, 65536]);
    expect(d1?.['body']).not.toBe(d2?.['body']);
    // seeded: the same draws on every call
    const second = await call('run', {
      files: [{ name: 'limits.tape', text: limits }],
      requests: ['GET /dice', 'GET /dice'],
    });
    expect(results(second.out).map(r => r['body'])).toEqual([d1?.['body'], d2?.['body']]);
  });

  it('stores a feedback report in R2, one object, without the address; refuses past its own rate limit', async () => {
    const before = (await env.FEEDBACK.list()).objects.length;
    const r = await rpc('tools/call', {
      name: 'feedback',
      arguments: {
        text: 'negative literals do not parse',
        kind: 'missing',
        files: [{ name: 'hello.tape', text: hello }],
        expected: '-1 is a number',
      },
    });
    const out = F(r['structuredContent']);
    expect(out).toMatchObject({ ok: true });
    const fid = String(out['id']);
    const day = new Date().toISOString().slice(0, 10).replaceAll('-', '/');
    const obj = await env.FEEDBACK.get(`${day}/${fid}.json`);
    expect(obj).not.toBeNull();
    const text = (await obj?.text()) ?? '';
    const body = F(JSON.parse(text));
    expect(body).toMatchObject({
      id: fid,
      kind: 'missing',
      text: 'negative literals do not parse',
      expected: '-1 is a number',
      actual: null,
      requests: null,
      reproduced: { ok: true, diagnostic_codes: [] },
      server: { tape_mcp_version: 'test-version', user_agent: 'workerd-test' },
    });
    expect(F(body['server'])['ip_hash']).toMatch(/^[0-9a-f]{16}$/);
    expect(text).not.toContain('198.51.100.4');
    expect((await env.FEEDBACK.list()).objects.length).toBe(before + 1);
    // the same as plain JSON
    const http = await post('/v1/feedback', { text: 'as JSON' });
    expect([http.status, http.json['ok']]).toEqual([200, true]);
    // its own limiter: TIGHT allows two a minute
    const req = (): Request =>
      new Request('https://tape-mcp/v1/feedback', {
        method: 'POST',
        headers: { ...headers, 'cf-connecting-ip': '198.51.100.99' },
        body: '{"text":"x"}',
      });
    if (!env.TIGHT) throw new Error('vitest.config.ts gives no TIGHT limiter');
    const tight = { ...env, FEEDBACK_RATE: env.TIGHT };
    const codes: unknown[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await worker.fetch(req(), tight, createExecutionContext());
      codes.push(res.status === 200 ? 200 : F(await res.json())['error']);
    }
    expect(codes).toEqual([200, 200, 'feedback_rate_limited']);
  });

  it('names the version that answered, a refusal too (tape-mcp-version)', async () => {
    expect((await post('/v1/compile', {})).res.headers.get('tape-mcp-version')).toBe('test-version');
    expect((await post('/mcp', {}, { origin: 'https://a.example' })).res.headers.get('tape-mcp-version')).toBe(
      'test-version',
    );
  });

  it('answers JSON with nosniff and a sandbox CSP, and refuses pages, other types and bad JSON', async () => {
    const ok = await post('/v1/compile', {});
    expect(ok.status).toBe(200);
    expect(ok.res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(ok.res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(ok.res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(ok.res.headers.get('access-control-allow-origin')).toBeNull();
    expect((await post('/mcp', {}, { origin: 'https://a.example' })).status).toBe(403);
    expect((await post('/v1/run', '{}', { 'content-type': 'text/plain' })).status).toBe(415);
    const bad = await post('/mcp', '{"jsonrpc":');
    expect([bad.status, F(bad.json['error'])['code']]).toEqual([400, -32700]);
    expect((await post('/v1/run', { requests: Array.from({ length: 21 }, () => 'GET /') })).json).toMatchObject({
      ok: false,
      error: 'too_many_requests',
    });
  });

  it('refuses everything when the kill switch is on or IP_SALT is missing, and over the real rate limit', async () => {
    const req = (): Request => new Request('https://tape-mcp/v1/compile', { method: 'POST', headers, body: '{}' });
    const off = await worker.fetch(req(), { ...env, KILL_SWITCH: 'on' }, createExecutionContext());
    expect([off.status, F(await off.json())['error']]).toEqual([503, 'disabled']);
    const { IP_SALT: _salt, ...unsalted } = env;
    const bare = await worker.fetch(req(), unsalted, createExecutionContext());
    expect([bare.status, F(await bare.json())['error']]).toEqual([503, 'misconfigured']);
    const tight = env.TIGHT;
    if (!tight) throw new Error('vitest.config.ts gives no TIGHT limiter');
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++)
      statuses.push((await worker.fetch(req(), { ...env, RATE: tight }, createExecutionContext())).status);
    expect(statuses).toEqual([200, 200, 429, 429]);
  });
});
