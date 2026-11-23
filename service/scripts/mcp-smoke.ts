// mcp-smoke.ts: what a deployed hosted compiler and runner (mcp/src, docs/mcp.md) must answer, at an MCP URL.
//   node scripts/mcp-smoke.ts <mcp-url> [--pin <worker>=<version-id>] [--mcp-version <version-id>]
// <mcp-url> is https://tape.ivar.workers.dev/mcp (served in the tape Worker); /v1/run and /v1/compile are beside it. With --pin every
// request carries Cloudflare-Workers-Version-Overrides for that Worker. With --mcp-version every answer must name that
// version (the tape-mcp-version header: the tape Worker's version id). Eight calls of tape-mcp's 60 a minute, one of feedback's 5. Exits 1 if any check fails.
//
// Checks: initialize (serverInfo tape, the instructions); tools/list is [compile, run, feedback]; a feedback report
// (stored under smoke/: delete with node mcp/scripts/feedback.ts --delete-smoke); run with no files and
// GET /hello/ada twice: 200 "Hello, ada" then 200 "Hello again, ada #2!", both replayed, with an OTLP trace (MCP,
// trace: "full") and the default line trace (/v1/run: line 25 taken, then line 26);
// compile of hello.tape without `repeat: True,` is C54 at line 11; the same run as plain JSON at /v1/run; a request
// with an Origin is 403 origin_refused; every answer is JSON, nosniff, no-store and sandboxed.
import '../../node25.ts';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const url = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')) ?? '';
const opt = (name: string): string | null => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? null : (args[i + 1] ?? null);
};
const pin = opt('pin'),
  mcpVersion = opt('mcp-version');
if (!/^https?:\/\/[^/]+\/mcp$/.test(url) || (pin !== null && !/^[a-z0-9-]+=[0-9a-f-]{36}$/.test(pin))) {
  console.error(
    'usage: node scripts/mcp-smoke.ts <https://host/mcp> [--pin <worker>=<version-id>] [--mcp-version <id>]',
  );
  process.exit(2);
}
const base = url.slice(0, -'/mcp'.length);
const hello = readFileSync(new URL('../../examples/hello.tape', import.meta.url), 'utf8');

let failed = 0,
  passed = 0;
const check = (ok: boolean, what: string): void => {
  if (ok) passed++;
  else {
    failed++;
    console.log(`  FAIL ${what}`);
  }
};
type J = Record<string, unknown>;
const obj = (v: unknown): J => (typeof v === 'object' && v !== null && !Array.isArray(v) ? { ...v } : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/** A value as text, for a message. */
const str = (v: unknown): string => (typeof v === 'string' ? v : (JSON.stringify(v) ?? 'undefined'));
const post = async (
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ r: Response; j: J }> => {
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'tape-mcp-smoke',
      // a deploy's: its feedback report is stored under smoke/, apart from real ones
      'x-tape-synthetic': 'deploy-smoke',
      ...(pin === null ? {} : { 'cloudflare-workers-version-overrides': pin.replace('=', '="') + '"' }),
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let j: J = {};
  try {
    j = obj(JSON.parse(text));
  } catch {
    check(false, `${path}: the answer is not JSON: ${text.slice(0, 120)}`);
  }
  const h = (n: string): string => r.headers.get(n) ?? '';
  check(h('content-type').startsWith('application/json'), `${path}: content-type ${h('content-type')}`);
  check(h('x-content-type-options') === 'nosniff', `${path}: nosniff`);
  check(h('cache-control') === 'no-store', `${path}: cache-control ${h('cache-control')}`);
  check(
    /^default-src 'none';.*\bsandbox$/.test(h('content-security-policy')),
    `${path}: CSP ${h('content-security-policy')}`,
  );
  if (mcpVersion !== null)
    check(h('tape-mcp-version') === mcpVersion, `${path}: tape-mcp-version ${h('tape-mcp-version') || '-'}`);
  return { r, j };
};
let id = 0;
const rpc = (method: string, params: unknown = {}): Promise<{ r: Response; j: J }> =>
  post('/mcp', { jsonrpc: '2.0', id: ++id, method, params });
const tool = async (name: string, a: unknown): Promise<J> => {
  const { r, j } = await rpc('tools/call', { name, arguments: a });
  check(r.status === 200, `tools/call ${name}: ${r.status}`);
  return obj(obj(j['result'])['structuredContent']);
};

console.log(`mcp smoke ${url}${pin === null ? '' : ` pinned ${pin}`}`);
const init = await rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'tape-mcp-smoke', version: '1' },
});
const result = obj(init.j['result']);
check(init.r.status === 200, `initialize: ${init.r.status}`);
check(obj(result['serverInfo'])['name'] === 'tape', `initialize: serverInfo ${JSON.stringify(result['serverInfo'])}`);
check(str(result['instructions'] ?? '').includes('TERMS.md'), 'initialize: the instructions');
const list = await rpc('tools/list');
const names = arr(obj(list.j['result'])['tools']).map(t => obj(t)['name']);
check(JSON.stringify(names) === '["compile","run","feedback"]', `tools/list: ${JSON.stringify(names)}`);

// trace: 'full', the OTLP; the default (lines) on /v1/run
const twice = { requests: ['GET /hello/ada', 'GET /hello/ada'], trace: 'full' };
const sees = (where: string, ran: J, trace: 'full' | 'lines' = 'full'): string => {
  const rs = arr(ran['results']).map(obj);
  check(ran['ok'] === true, `${where}: ok ${String(ran['ok'])}`);
  check(rs.length === 2, `${where}: ${rs.length} results`);
  check(
    rs[0]?.['status'] === 200 && rs[0]['body'] === 'Hello, ada',
    `${where}: first ${str(rs[0]?.['status'])} ${str(rs[0]?.['body'])}`,
  );
  check(
    rs[1]?.['status'] === 200 && rs[1]['body'] === 'Hello again, ada #2!',
    `${where}: second ${str(rs[1]?.['status'])} ${str(rs[1]?.['body'])}`,
  );
  check(
    rs.every(x => x['replayed'] === true),
    `${where}: replayed`,
  );
  if (trace === 'full')
    check(
      rs.every(x => arr(obj(x['trace'])['resourceSpans']).length > 0),
      `${where}: OTLP traces`,
    );
  else
    check(
      str(rs[0]?.['trace']).includes('✓ hello.tape:25') && str(rs[1]?.['trace']).includes('✓ hello.tape:26'),
      `${where}: line traces ${JSON.stringify(rs.map(x => x['trace'])).slice(0, 200)}`,
    );
  return rs.map(x => `${str(x['status'])} ${JSON.stringify(x['body'])} replayed ${str(x['replayed'])}`).join(', ');
};
const ran = sees('run hello twice', await tool('run', twice));
const without = hello.replace(/^\s*repeat: True,\n/m, '');
check(without !== hello, 'hello.tape has the line `repeat: True,`');
const c = await tool('compile', { files: [{ name: 'hello.tape', text: without }] });
const d = arr(c['diagnostics']).map(obj);
check(c['ok'] === false && d.length === 1, `compile without repeat: ok ${String(c['ok'])}, ${d.length} diagnostics`);
check(
  d[0]?.['code'] === 'C54' && d[0]['line'] === 11,
  `compile without repeat: ${str(d[0]?.['code'])} line ${str(d[0]?.['line'])}`,
);
const fb = await tool('feedback', { text: 'deploy smoke: ignore', kind: 'praise' });
const fbId = str(fb['id']);
check(fb['ok'] === true && /^\d{8}T\d{6}\.\d{3}Z-[0-9a-f]{12}$/.test(fbId), `feedback: ${JSON.stringify(fb)}`);
const v1 = await post('/v1/run', { requests: twice.requests });
check(v1.r.status === 200, `/v1/run: ${v1.r.status}`);
sees('/v1/run', v1.j, 'lines');
const origin = await post(
  '/mcp',
  { jsonrpc: '2.0', id: ++id, method: 'tools/list' },
  { origin: 'https://example.com' },
);
check(
  origin.r.status === 403 && origin.j['error'] === 'origin_refused',
  `Origin: ${origin.r.status} ${String(origin.j['error'])}`,
);
console.log(`  feedback: ${fbId} (smoke/)`);
console.log(`  run: ${ran}; compile: ${str(d[0]?.['code'])} line ${str(d[0]?.['line'])}; Origin: ${origin.r.status}`);
console.log(
  failed === 0 ? `mcp smoke ok: ${passed} checks` : `FAIL mcp smoke: ${failed} of ${passed + failed} checks failed`,
);
process.exit(failed === 0 ? 0 : 1);
