// Runs in workerd: /mcp, /v1/compile, /v1/run and /v1/feedback are the hosted compiler and runner (docs/mcp.md,
// mcp/src), served in this Worker with its own bindings: there is no MCP service binding (until 2026-11-22 it was a
// Worker of its own, tape-mcp). They need no token, refuse a request with an Origin, and come back with the headers
// every answer of this Worker has. /mcp/:account is still an account's tools, behind its agent token. mcp/test/ checks
// the tools in depth in workerd; this checks that this Worker serves them.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { anyone, call, fields } from './help.ts';

const API_CSP = "default-src 'none'; frame-ancestors 'none'; sandbox";
const client = { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.7', 'user-agent': 'mcp-route' };

describe('the hosted compiler and runner, in this Worker', () => {
  it('serves /mcp with no MCP binding: initialize and tools/list, with no token', async () => {
    expect('MCP' in env).toBe(false);
    const init = await anyone('/mcp', {
      method: 'POST',
      headers: client,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } },
      }),
    });
    expect(init.status).toBe(200);
    // serverInfo.version is the deploy's tape-version, so a client can tell a new deploy
    expect(fields(fields(await init.json())['result'])).toMatchObject({
      serverInfo: { name: 'tape', version: init.headers.get('tape-version') },
    });
    for (const [k, v] of Object.entries({
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'content-security-policy': API_CSP,
      'tape-version': 'dev',
      'tape-compiler': 'dev',
    }))
      expect([k, init.headers.get(k)]).toEqual([k, v]);
    const list = await anyone('/mcp', {
      method: 'POST',
      headers: client,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    const tools = fields(fields(await list.json())['result'])['tools'];
    expect(Array.isArray(tools) ? tools.map(t => fields(t)['name']) : tools).toEqual([
      'compile',
      'run',
      'test',
      'feedback',
    ]);
  });

  it('compiles hello.tape at /v1/compile, and runs it at /v1/run in a Dynamic Worker', async () => {
    const c = await anyone('/v1/compile', { method: 'POST', headers: client, body: '{}' });
    expect([c.status, fields(await c.json())['ok']]).toEqual([200, true]);
    const r = await anyone('/v1/run', {
      method: 'POST',
      headers: client,
      body: JSON.stringify({ requests: ['GET /hello/ada'] }),
    });
    const out = fields(await r.json());
    expect([r.status, out['ok']]).toEqual([200, true]);
    expect(JSON.stringify(out['results'])).toContain('ada');
  });

  it('refuses a request with an Origin, even with the operator token, and drains its body', async () => {
    for (const path of ['/mcp', '/v1/compile', '/v1/run', '/v1/test', '/v1/feedback']) {
      const r = await call(path, { method: 'POST', headers: { ...client, origin: 'https://a.example' }, body: '{}' });
      expect([path, r.status, fields(await r.json())['error']]).toEqual([path, 403, 'origin_refused']);
      expect(r.headers.get('content-security-policy')).toBe(API_CSP);
    }
  });

  it('serves nothing else: /mcp/:account is the tools, /v1 and the like are the API', async () => {
    for (const path of ['/mcp/ivar', '/mcp/', '/v1', '/v1/', '/v1/runs', '/v1/compile/x', '/v1/feedbacks', '/MCP']) {
      const r = await anyone(path, { method: 'POST', body: '{}' });
      expect([path, r.status]).toEqual([path, 401]);
    }
  });
});
