// serve.ts: the HTTP face of tape-mcp. POST /mcp is MCP over streamable HTTP (the service's transport,
// service/src/mcp.ts); POST /v1/compile and POST /v1/run are the same two tools as plain JSON. Every answer is
// JSON with nosniff and a sandboxing CSP, and nothing a caller sends is ever served back as a page.
//
// Before a call reaches a tool: the kill switch, the Origin check, the method and content type, the body's size,
// and the rate limit, each refused as JSON with a reason. After it: one log line (logLine), to Workers
// Observability. The line says what was done, not what was sent: no source text, request bodies or responses.
//
// No CORS. The clients are MCP clients and HTTP tools, which are not browsers. A browser page cannot use this
// service from its visitors' browsers: a request with an Origin header is refused, and a JSON POST from another
// origin needs a preflight, which gets no CORS headers, so the browser never sends it.
import { fieldsOf, serveMcp } from '../../service/src/mcp.ts';
import type { Fields, McpServer } from '../../service/src/mcp.ts';
import { LIMITS, compileTool, isRefusal, refused, runTool } from './tools.ts';
import type { Deps, Refusal, Usage } from './tools.ts';

export const VERSION = '0.1.0';
/** What the Worker is given besides the tools' dependencies (index.ts, from env). */
export type Gate = {
  /** "on" refuses every call (503) */
  killSwitch: string;
  limiter: { limit: (o: { key: string }) => Promise<{ success: boolean }> } | null;
  log: (line: Fields) => void;
};

const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; sandbox",
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
};
/** Any answer, with the headers every answer has. */
const secured = (res: Response): Response => {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(HEADERS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
};
const bigints = (_k: string, v: unknown): unknown => (typeof v === 'bigint' ? String(v) : v);
export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body, bigints), { status, headers: HEADERS });
const refusal = (r: Refusal): Response => json({ ok: false, error: r.error, reason: r.reason }, r.status);

const enc = new TextEncoder();
const hexOf = (buf: ArrayBuffer): string => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
/** The client's IP as a short hash: what the log and the rate limit key on, never the address itself. */
export const ipHash = async (ip: string): Promise<string> =>
  hexOf(await crypto.subtle.digest('SHA-256', enc.encode(`tape-mcp:${ip}`))).slice(0, 16);

// The whole body of a request: an MCP message or a tool's arguments, which hold the program and its requests
const MAX_BODY = LIMITS.sourceBytes + LIMITS.requests * (LIMITS.requestBodyBytes + LIMITS.lineBytes) + 64 * 1024;
/** The body as text, or null when it is longer than MAX_BODY (read no further than that). */
async function capped(request: Request): Promise<string | null> {
  const said = Number(request.headers.get('content-length') ?? '0');
  if (said > MAX_BODY) return null;
  if (!request.body) return '';
  const reader = request.body.getReader(),
    parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    const value: unknown = chunk.value;
    if (!(value instanceof Uint8Array)) return null;
    n += value.length;
    if (n > MAX_BODY) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  const all = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  return new TextDecoder().decode(all);
}

// ---- the tools as MCP lists them

const FILES_SCHEMA = {
  type: 'array',
  description: `The program's files (at most ${LIMITS.files}, ${LIMITS.sourceBytes} bytes together). Leave it out to use examples/hello.tape.`,
  minItems: 1,
  maxItems: LIMITS.files,
  items: {
    type: 'object',
    properties: {
      name: { type: 'string', pattern: '^[A-Za-z0-9_][A-Za-z0-9_-]{0,62}\\.tape$', description: 'hello.tape' },
      text: { type: 'string', description: 'The Tape source.' },
    },
    required: ['name', 'text'],
    additionalProperties: false,
  },
};
const DIAGNOSTICS_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      file: { type: 'string' },
      line: { type: 'integer' },
      code: { type: 'string' },
      message: { type: 'string' },
      fix: { type: 'string' },
    },
  },
};
const refusalFields = { error: { type: 'string' }, reason: { type: 'string' } };

/** The tools' descriptions: what each does, and examples/hello.tape with what it gives, to check in one call. */
export function listing(deps: Deps): Fields[] {
  const hello = `examples/hello.tape, the program used when \`files\` is left out:\n\n\`\`\`tape\n${deps.hello.text.trimEnd()}\n\`\`\``;
  const limits = `Limits: ${LIMITS.files} files and ${LIMITS.sourceBytes / 1024} KB of source; ${LIMITS.requests} requests a call, each body at most ${LIMITS.requestBodyBytes / 1024} KB; each request runs within Tape's own budget (50,000,000 steps, 64 MB of memory); response bodies longer than ${LIMITS.responseBodyBytes / 1024} KB are cut (truncated: true). Alpha: anything can change. Calls are logged (what was called and how it went, not the source or bodies): https://github.com/ivarvong/tape/blob/main/TERMS.md`;
  return [
    {
      name: 'compile',
      title: 'Compile a Tape program',
      description: `Compile a Tape program (https://github.com/ivarvong/tape: a language for Cloudflare Workers, compiled to Wasm, whose compiler refuses writes a retried request would apply twice). Returns ok, each diagnostic as {file, line, code, message, fix} (the fix says what to write instead), the module's size and its SQL statement count.

To check it works: compile with no arguments gives {"ok": true, "diagnostics": []}. Send hello.tape with the line \`repeat: True,\` taken out, and it gives ok: false and one diagnostic, code C54 at hello.tape line 11: the INSERT … DO UPDATE SET n = n + 1 would apply twice if the request were run twice.

${hello}

${limits}`,
      inputSchema: { type: 'object', properties: { files: FILES_SCHEMA }, additionalProperties: false },
      outputSchema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          diagnostics: DIAGNOSTICS_SCHEMA,
          wasm_bytes: { type: ['integer', 'null'] },
          statements: { type: ['integer', 'null'] },
          ...refusalFields,
        },
        required: ['ok'],
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    {
      name: 'run',
      title: 'Run HTTP requests against a Tape program',
      description: `Compile a Tape program and send it HTTP requests, in order, against one fresh in-memory SQLite database that lasts for this call only. A request is "METHOD SP TARGET", then optionally a line feed and a body: "GET /hello/ada", "POST /links\\n{\\"url\\":\\"https://example.com\\"}".

Each result has the status, content type and body; effects, the effect log (each SQL statement as the program wrote it, with its :name placeholders, the params bound to each name, and the rows it returned or how many it wrote; calls, clock reads, random draws, timers); replayed, true when the service ran the request again from that log alone and got the same bytes; steps, the reductions it used; and trace, its spans as OTLP/JSON (resourceSpans), made from the same log. If the program does not compile, ok is false and diagnostics says why, as compile does. random() is seeded the same way each call, so the same input gives the same output except trace ids and times. Calls to other programs answer Unreachable: one program runs at a time.

To check it works: run with requests ["GET /hello/ada", "GET /hello/ada"] and no files. Both are status 200; the first body is "Hello, ada", the second "Hello again, ada #2!"; each has one sql effect, the INSERT with params {":name": "ada"} and rows [[1]] then [[2]]; both are replayed: true.

${hello}

${limits}`,
      inputSchema: {
        type: 'object',
        properties: {
          files: FILES_SCHEMA,
          requests: {
            type: 'array',
            minItems: 1,
            maxItems: LIMITS.requests,
            items: { type: 'string' },
            description: 'Requests, run in order: "GET /hello/ada", or "POST /path\\n<body>".',
          },
        },
        required: ['requests'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          diagnostics: DIAGNOSTICS_SCHEMA,
          results: { type: 'array', items: { type: 'object' } },
          ...refusalFields,
        },
        required: ['ok'],
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
  ];
}

type Called = { result: unknown; usage: Usage | null };
const TOOLS: Readonly<Record<string, (args: unknown, deps: Deps) => Called | Promise<Called>>> = {
  compile: compileTool,
  run: runTool,
};
/** A tool's answer as MCP's CallToolResult: the JSON as text, and as structuredContent; a refusal is an error. */
const toolResult = (result: unknown): Fields => {
  const out = isRefusal(result) ? { ok: false, error: result.error, reason: result.reason } : result;
  return {
    content: [{ type: 'text', text: JSON.stringify(out, bigints) }],
    structuredContent: JSON.parse(JSON.stringify(out, bigints)),
    isError: isRefusal(result),
  };
};

/** What a call was, for its log line. */
type Seen = {
  via: 'mcp' | 'http';
  method: string | null;
  tool: string | null;
  ok: boolean | null;
  refused: string | null;
  usage: Usage | null;
};

/** The log line of one call: what was done and how it went; never the source, a request's body or a response. */
export const logLine = (
  seen: Seen,
  meta: { ip_hash: string; user_agent: string; rate_limited: boolean; status: number; total_ms: number },
): Fields => ({
  event: 'tape-mcp.call',
  version: VERSION,
  via: seen.via,
  mcp_method: seen.method,
  tool: seen.tool,
  ok: seen.ok,
  refused: seen.refused,
  status: meta.status,
  ...(seen.usage
    ? {
        diagnostic_codes: seen.usage.codes,
        files: seen.usage.files,
        source_bytes: seen.usage.source_bytes,
        requests: seen.usage.requests,
        statuses: seen.usage.statuses,
        steps: seen.usage.steps,
        compile_ms: seen.usage.compile_ms,
        run_ms: seen.usage.run_ms,
      }
    : {}),
  total_ms: meta.total_ms,
  ip_hash: meta.ip_hash,
  user_agent: meta.user_agent.slice(0, 200),
  rate_limited: meta.rate_limited,
});

const okOf = (r: unknown): boolean | null => {
  const ok = fieldsOf(r)['ok'];
  return typeof ok === 'boolean' ? ok : null;
};

/** The Worker's fetch: every route, every refusal, one log line. */
export async function serve(request: Request, deps: Deps, gate: Gate): Promise<Response> {
  const t0 = Date.now(),
    url = new URL(request.url),
    ip = request.headers.get('cf-connecting-ip') ?? 'unknown',
    seen: Seen = {
      via: url.pathname === '/mcp' ? 'mcp' : 'http',
      method: null,
      tool: null,
      ok: null,
      refused: null,
      usage: null,
    };
  const meta = {
    ip_hash: await ipHash(ip),
    user_agent: request.headers.get('user-agent') ?? '',
    rate_limited: false,
    status: 0,
    total_ms: 0,
  };
  const res = secured(await route(request, url, deps, gate, seen, meta));
  meta.status = res.status;
  meta.total_ms = Date.now() - t0;
  gate.log(logLine(seen, meta));
  return res;
}

async function route(
  request: Request,
  url: URL,
  deps: Deps,
  gate: Gate,
  seen: Seen,
  meta: { ip_hash: string; rate_limited: boolean },
): Promise<Response> {
  const no = (r: Refusal): Response => {
    seen.refused = r.error;
    seen.ok = false;
    return refusal(r);
  };
  const path = url.pathname;
  const known = path === '/mcp' || path === '/v1/compile' || path === '/v1/run';
  if (gate.killSwitch === 'on')
    return no(refused(503, 'disabled', 'the hosted compiler and runner is switched off for now; try again later'));
  if (path === '/' || path === '/v1') {
    if (request.method !== 'GET') return no(refused(405, 'method_not_allowed', `${path} is GET`));
    return json({
      name: 'tape-mcp',
      version: VERSION,
      what: 'Compile Tape programs and run requests against them: MCP at POST /mcp, or JSON at POST /v1/compile and POST /v1/run.',
      docs: 'https://github.com/ivarvong/tape/blob/main/docs/mcp.md',
      terms: 'https://github.com/ivarvong/tape/blob/main/TERMS.md',
      limits: LIMITS,
    });
  }
  if (!known) return no(refused(404, 'not_found', `no route ${path}: POST /mcp, POST /v1/compile or POST /v1/run`));
  // a browser's request (DNS rebinding, a page using its visitors as clients): MCP clients and HTTP tools send none
  if (request.headers.has('origin'))
    return no(
      refused(403, 'origin_refused', 'requests from web pages are refused: use an MCP client, curl or a server'),
    );
  if (request.method !== 'POST')
    return no(
      refused(405, 'method_not_allowed', `${path} takes POST, with a JSON body (this server sends no event streams)`),
    );
  const type = request.headers.get('content-type') ?? '';
  if (!/^application\/json\s*(;|$)/i.test(type))
    return no(
      refused(
        415,
        'unsupported_media_type',
        `the body must be JSON, sent as content-type: application/json (not ${JSON.stringify(type.slice(0, 60))})`,
      ),
    );
  if (gate.limiter) {
    const { success } = await gate.limiter.limit({ key: meta.ip_hash });
    if (!success) {
      meta.rate_limited = true;
      return no(
        refused(
          429,
          'rate_limited',
          'too many calls from this address in the last minute; wait a minute and try again',
        ),
      );
    }
  }
  const text = await capped(request);
  if (text === null) return no(refused(413, 'body_too_large', `the body is more than ${MAX_BODY} bytes`));
  if (path === '/mcp') return mcpCall(text, deps, seen);
  let args: unknown;
  try {
    args = JSON.parse(text);
  } catch {
    return no(refused(400, 'bad_json', 'the body is not JSON'));
  }
  seen.tool = path === '/v1/run' ? 'run' : 'compile';
  const called = await (TOOLS[seen.tool] ?? compileTool)(args, deps);
  seen.usage = called.usage;
  if (isRefusal(called.result)) return no(called.result);
  seen.ok = okOf(called.result);
  return json(called.result);
}

function mcpCall(text: string, deps: Deps, seen: Seen): Promise<Response> {
  try {
    const method: unknown = fieldsOf(JSON.parse(text))['method'];
    seen.method = typeof method === 'string' ? method.slice(0, 64) : null;
  } catch {
    seen.refused = 'bad_json';
  }
  const server: McpServer = {
    name: 'tape',
    version: VERSION,
    instructions:
      'Tape is a small language for Cloudflare Workers, compiled to Wasm (https://github.com/ivarvong/tape). compile reports what the compiler says of a program; run compiles it and sends it HTTP requests against a fresh in-memory SQLite database, and returns each response with its effect log, whether a replay from that log matched, and its OTLP trace. With no files, both use examples/hello.tape, and their descriptions say what it gives. Alpha; calls are logged (TERMS.md).',
    list: () => listing(deps),
    call: async (name, args) => {
      seen.tool = typeof name === 'string' ? name.slice(0, 40) : null;
      const tool = typeof name === 'string' ? TOOLS[name] : undefined;
      if (!tool) return null;
      const called = await tool(args, deps);
      seen.usage = called.usage;
      seen.ok = isRefusal(called.result) ? false : okOf(called.result);
      if (isRefusal(called.result)) seen.refused = called.result.error;
      return toolResult(called.result);
    },
  };
  return serveMcp(new Request('http://tape-mcp/mcp', { method: 'POST', body: text }), server);
}
