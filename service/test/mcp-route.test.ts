// Runs in workerd: /mcp, /v1/compile, /v1/run and /v1/feedback are the hosted compiler and runner (docs/mcp.md), another Worker,
// tape-mcp, reached through the MCP service binding. They need no token; the request reaches tape-mcp as it came
// (its client address, which tape-mcp hashes, and its Origin, which tape-mcp refuses), and the answer comes back with
// the headers every answer of this Worker has. Here tape-mcp is an echo (vitest.config.ts). /mcp/:account is still
// an account's tools, behind its agent token.
import { describe, expect, it } from 'vitest';
import { anyone, call, fields } from './help.ts';

const API_CSP = "default-src 'none'; frame-ancestors 'none'; sandbox";
const echoed = async (
  r: Response,
): Promise<{ method: string; url: string; headers: Record<string, string>; body: string }> => {
  const j = fields(await r.json());
  return {
    method: String(j['method']),
    url: String(j['url']),
    headers: Object.fromEntries(Object.entries(fields(j['headers'])).map(([k, v]) => [k, String(v)])),
    body: String(j['body']),
  };
};

describe('the hosted compiler and runner, through the MCP binding', () => {
  it('passes /mcp, /v1/compile, /v1/run and /v1/feedback to tape-mcp without a token, as they came', async () => {
    for (const path of ['/mcp', '/v1/compile', '/v1/run', '/v1/feedback']) {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', path });
      const r = await anyone(`${path}?q=1`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': '198.51.100.7',
          origin: 'https://a.example',
          'user-agent': 'mcp-route-test',
        },
        body,
      });
      expect(r.status).toBe(299);
      const e = await echoed(r);
      expect(e.method).toBe('POST');
      expect(new URL(e.url).pathname + new URL(e.url).search).toBe(`${path}?q=1`);
      expect(e.body).toBe(body);
      expect(e.headers).toMatchObject({
        'content-type': 'application/json',
        'cf-connecting-ip': '198.51.100.7',
        origin: 'https://a.example',
        'user-agent': 'mcp-route-test',
      });
      expect(e.headers['authorization']).toBeUndefined();
      // tape-mcp's own headers are kept, and the ones every answer of this Worker has are added
      expect(r.headers.get('tape-mcp-version')).toBe('echo');
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
      expect(r.headers.get('x-frame-options')).toBe('DENY');
      expect(r.headers.get('content-security-policy')).toBe(API_CSP);
      expect(r.headers.get('tape-version')).not.toBeNull();
    }
  });

  it('passes any method, and the operator token unchanged', async () => {
    const get = await anyone('/mcp');
    expect([get.status, (await echoed(get)).method]).toEqual([299, 'GET']);
    const op = await call('/v1/run', { method: 'POST', body: '{}' });
    expect([op.status, (await echoed(op)).headers['authorization']]).toEqual([299, 'Bearer test-token']);
  });

  it('passes nothing else: /mcp/:account is the tools, /v1 and the like are the API', async () => {
    for (const path of ['/mcp/ivar', '/mcp/', '/v1', '/v1/', '/v1/runs', '/v1/compile/x', '/v1/feedbacks', '/MCP']) {
      const r = await anyone(path, { method: 'POST', body: '{}' });
      expect([path, r.status]).toEqual([path, 401]);
      expect(r.headers.get('tape-mcp-version')).toBeNull();
    }
  });
});
