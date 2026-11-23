// serve.ts: the HTTP face of tape-mcp. POST /mcp is MCP over streamable HTTP (the service's transport,
// service/src/mcp.ts); POST /v1/compile, POST /v1/run and POST /v1/feedback are the same three tools as plain JSON. Every answer is
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
import { LIMITS, TRACE_LINES, compileTool, isRefusal, refused, runTool } from './tools.ts';
import type { Deps, Refusal, Usage } from './tools.ts';
import { FEEDBACK, KINDS, feedbackTool } from './feedback.ts';
import type { CallMeta, Store } from './feedback.ts';

export const VERSION = '0.1.0';
/** What the Worker is given besides the tools' dependencies (index.ts, from env). */
export type Gate = {
  /** "on" refuses every call (503) */
  killSwitch: string;
  /** the secret the address is hashed with (IP_SALT); without it every call is refused (503) */
  salt: string | undefined;
  limiter: { limit: (o: { key: string }) => Promise<{ success: boolean }> } | null;
  log: (line: Fields) => void;
  /** where feedback goes (an R2 bucket) and its own rate limit; without it the feedback tool refuses (503) */
  feedback?: Store | null;
  /** this version's id (tape-mcp-version), stored with each report */
  version?: string | null;
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
/** The UTC day of a time, as 2026-11-22. */
export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
/**
 * The client's IP as a short hash: what the log and the rate limit key on, never the address itself. It is salted
 * with a secret (IP_SALT, a Worker secret, never in the repository), so it cannot be reversed by trying every
 * address without it, and with the UTC day, so one client's calls are linked for a day at most.
 */
export const ipHash = async (ip: string, salt: string, day: string): Promise<string> =>
  hexOf(await crypto.subtle.digest('SHA-256', enc.encode(`${ip}\u0000${day}\u0000${salt}`))).slice(0, 16);

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

/** Read a body to its end and drop it (up to 2 × MAX_BODY, then cancel): the request is finished before the answer. */
async function drain(body: ReadableStream): Promise<void> {
  const reader = body.getReader();
  let n = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      const value: unknown = chunk.value;
      n += value instanceof Uint8Array ? value.length : 1;
      if (n > 2 * MAX_BODY) {
        await reader.cancel();
        return;
      }
    }
  } catch {
    // the client went away: nothing more to read
  }
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

const DOCS = 'https://github.com/ivarvong/tape/blob/main/docs';
/**
 * Tape in brief, in compile's and run's descriptions: what an agent reached for first in the usability benchmark
 * and could not find (bench/usability, 2026-11-22: respond_as, Request's fields, the query). Every function named
 * here is in std/ or a built-in (mcp/test.ts, list).
 */
export const CHEAT_SHEET = `Tape in brief (every std function: ${DOCS}/std.md; a whole REST service, worked: ${DOCS}/guide.md#a-whole-rest-service-worked; the language: https://github.com/ivarvong/tape/blob/main/LANGUAGE.md):
- Entry: \`fn handle(raw: View, db: Sql) -> Buf\`, with only the capabilities it uses (db: Sql, clock: Clock, timer: Timer). Arguments are named, \`f(a: 1)\`, or bare when the value is named so, \`f(a)\`.
- Request: \`match request(raw) { Request(method: "GET", path: "/items/" ++ decimal(id)) -> … }\`. Fields: method, path (before \`?\`), query: Option[View] (raw, after \`?\`; one parameter: \`form_field(body: q, name: "limit")\`), body, caller, headers (read one: \`header_of(request: r, name: "accept")\`).
- Respond: \`respond(status: 404)\` is text/plain; \`respond_as(status: 200, content: Json) |> write_json(value: Item(id, name))\` is JSON (content: Json, Html, Text, Css, Svg or Csv); \`write_rows(rows: sql_all(…))\` writes rows as an array; \`append(view: "text")\` adds text; \`|> header(name: "location", value: url)\` sets a header. write_json takes a record: a List goes in a field; a list of computed items is \`write_json_list(list, by: …)\`, a function value that writes one item into the Buf it is handed.
- JSON in (an arm of a block is a line of its own):
    let Ok(value: NewItem(name, qty)) = decode(json: body, as: NewItem) else {
      Err(error) -> respond(status: 400) |> append(view: error)
    }
  Its error names the field. Refined types validate: \`type Qty = Int where self >= 1 and self <= 100\`. An Option field may be absent.
- SQL: \`sql_first(row: Item, query: "SELECT * FROM items WHERE id = :id", id)\` gives Option[Item]; \`sql_all\` gives Rows[Item]; \`sql_exec(query: "UPDATE items SET qty = :qty WHERE id = :id", qty, id)\` the rows changed. Each :name takes the argument of that name. Tables: \`migration 1 "items" { CREATE TABLE … }\` (a TEXT PRIMARY KEY needs NOT NULL; an INTEGER PRIMARY KEY does not). A POST that makes a row takes the client's key: UNIQUE, \`ON CONFLICT(key) DO NOTHING RETURNING *\`.
- Text and numbers: \`decimal(v)\` gives Option[Int] (strict, for ids; \`parse_int(text)\` takes a sign and leading zeros); \`is_digit\`, \`is_alpha\`, \`every_byte(v, keep)\` check bytes; holes \`"\\(n) items"\`; \`a ++ b\`; \`v[i]\` is a byte, \`len(v)\` the length. Steps: \`let P = e else { arms }\`; a match is an expression anywhere: \`let fee = match { … }\`, an argument, an operand.
- Numbers: Int is a 64-bit signed integer; + - * overflow traps ("trap 6: integer overflow"), so does division by zero ("trap 4: division by zero"); no floats yet (Dec, Float planned): use fixed point, cents.`;

/** The tools' descriptions: what each does, and examples/hello.tape with what it gives, to check in one call. */
export function listing(deps: Deps): Fields[] {
  const hello = `examples/hello.tape, the program used when \`files\` is left out:\n\n\`\`\`tape\n${deps.hello.text.trimEnd()}\n\`\`\``;
  const limits = `Limits (alpha, as is everything, and may change): ${LIMITS.files} files, ${LIMITS.sourceBytes / 1024} KB of source; ${LIMITS.requests} requests a call, bodies up to ${LIMITS.requestBodyBytes / 1024} KB; Tape's budget per request (50,000,000 steps, 64 MB); response bodies past ${LIMITS.responseBodyBytes / 1024} KB are cut (truncated: true); 60 calls a minute. Calls are logged (what was called, sizes, counts, codes, timings; not the source, bodies or responses): https://github.com/ivarvong/tape/blob/main/TERMS.md`;
  return [
    {
      name: 'compile',
      title: 'Compile a Tape program',
      description: `Compile a Tape program (https://github.com/ivarvong/tape: a small language for durable services, compiled to WebAssembly, that runs in the browser, in Node and on Cloudflare Workers; its compiler refuses writes a retried request would apply twice). Returns ok, each diagnostic as {file, line, code, message, fix} (the fix says what to write instead), the module's size and its SQL statement count. \`run\` compiles too, and runs requests.

To check it works: compile with no arguments gives {"ok": true, "diagnostics": []}. Send hello.tape with the line \`repeat: True,\` taken out, and it gives ok: false and one diagnostic, code C54 at hello.tape line 11: the INSERT … DO UPDATE SET n = n + 1 would apply twice if the request were run twice.

${CHEAT_SHEET}

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
      description: `Compile a Tape program and send it HTTP requests, in order, on one fresh in-memory SQLite database that lasts for this call. A request is "METHOD SP TARGET", then optionally a line feed and a body ("GET /hello/ada", "POST /links\\n{\\"url\\":\\"https://example.com\\"}"), or {"request": "GET /window", "at_ms": 61000} to send it on the run's own clock: now() is the run's start plus at_ms (a request without one keeps the time before it), and each timer due by then runs first, as a result of its own ("woken {\\"key\\":7}"), so a 60 s window or a retry is tested without waiting.

Each result: status, content_type, headers (the response headers the program set, [{name, value}], left out when none), body; effects, the effect log (each SQL statement as written, its :name params, rows_written or rows_returned and the rows: effects "compact", the default, leaves rows out past ${LIMITS.compactRows}, "full" keeps them; calls, now, random, wake); replayed, true when a replay from that log alone gave the same bytes; steps; trace: "lines" (default: the line trace, text: each function, each arm tried with ✓ taken or ✗ not and its file:line, each effect under the line that made it, a trap at its line; at most ${TRACE_LINES} lines), "full" (OTLP/JSON) or "none". If it does not compile, ok is false with diagnostics, as compile gives. random() is seeded the same on every call. Calls to other programs answer Unreachable.

${CHEAT_SHEET}

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
            items: {
              anyOf: [
                { type: 'string' },
                {
                  type: 'object',
                  properties: {
                    request: { type: 'string' },
                    at_ms: { type: 'integer', minimum: 0, maximum: LIMITS.atMs },
                  },
                  required: ['request'],
                  additionalProperties: false,
                },
              ],
            },
            description:
              'Requests, run in order: "GET /hello/ada", "POST /path\\n<body>", or {"request": "GET /x", "at_ms": 61000} on the run\'s own clock (ms from its start, never going back).',
          },
          trace: {
            type: 'string',
            enum: ['lines', 'full', 'none'],
            description:
              'lines (the default): the line trace, each arm tried (✓ taken, ✗ not) at its file:line with the effects it made, a trap at its line; full: OTLP/JSON; none.',
          },
          effects: {
            type: 'string',
            enum: ['compact', 'full'],
            description: `compact (the default): a query's rows only when it returned at most ${LIMITS.compactRows}; full: all.`,
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
          timers: { type: 'object' },
          ...refusalFields,
        },
        required: ['ok'],
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    {
      name: 'feedback',
      title: 'Report something about Tape to its maintainers',
      description: `Report anything surprising, wrong, confusing or missing about Tape (https://github.com/ivarvong/tape): the language, the compiler and its diagnostics, or these tools. A wrong answer, a rule that gets in the way, an error that did not help, a feature you reached for: all are worth a report, and so is what worked. Say what you did, what you expected and what happened, and send the minimal program that shows it in \`files\` (and the \`requests\` that show it, as run takes them): the smaller the program, the sooner it is fixed. Returns {ok: true, id}.

What is stored: the fields you send, the time, the tape-mcp version, a daily salted hash of your address (never the address), your user agent and, when you send a program, what the compiler says of it now. Reports are read by the maintainers to improve Tape and are kept until we delete them. Do not send secrets or personal data. Limits: text, expected and actual ${FEEDBACK.textBytes / 1024} KB each; files as compile takes them (${LIMITS.files} files, ${LIMITS.sourceBytes / 1024} KB); ${LIMITS.requests} requests; ${FEEDBACK.perMinute} reports a minute. https://github.com/ivarvong/tape/blob/main/TERMS.md`,
      inputSchema: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            minLength: 1,
            maxLength: FEEDBACK.textBytes,
            description: 'What you found, in a few sentences: what you did, and why it surprised you.',
          },
          kind: { type: 'string', enum: [...KINDS], description: 'What sort of report it is.' },
          files: { ...FILES_SCHEMA, description: 'The minimal program that shows it, if there is one.' },
          requests: {
            type: 'array',
            maxItems: LIMITS.requests,
            items: { type: 'string' },
            description: 'The requests that show it, as run takes them: "GET /hello/ada".',
          },
          expected: { type: 'string', maxLength: FEEDBACK.textBytes, description: 'What you expected.' },
          actual: { type: 'string', maxLength: FEEDBACK.textBytes, description: 'What happened instead.' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, id: { type: 'string' }, ...refusalFields },
        required: ['ok'],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
  ];
}

type Called = { result: unknown; usage: Usage | null };
type Tool = (args: unknown, deps: Deps, meta: CallMeta, store: Store | null) => Called | Promise<Called>;
const TOOLS: Readonly<Record<string, Tool>> = {
  compile: compileTool,
  run: runTool,
  feedback: feedbackTool,
};
/** The tool each plain-JSON route is. */
const HTTP_TOOLS: Readonly<Record<string, string>> = {
  '/v1/compile': 'compile',
  '/v1/run': 'run',
  '/v1/feedback': 'feedback',
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
    ip_hash: gate.salt ? await ipHash(ip, gate.salt, dayOf(Date.now())) : 'unsalted',
    user_agent: request.headers.get('user-agent') ?? '',
    rate_limited: false,
    status: 0,
    total_ms: 0,
  };
  const res = secured(await route(request, url, deps, gate, seen, meta));
  // a call refused before its body was read still finishes with the body: reached through the tape Worker's service
  // binding, a body left unread is logged there as an error after the answer is sent
  // Drain it rather than cancel it: a cancel can still race the binding's pump, a body read to its end cannot.
  if (request.body && !request.bodyUsed && !request.body.locked) await drain(request.body);
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
  const known = path === '/mcp' || path in HTTP_TOOLS;
  if (gate.killSwitch === 'on')
    return no(refused(503, 'disabled', 'the hosted compiler and runner is switched off for now; try again later'));
  if (!gate.salt)
    return no(
      refused(
        503,
        'misconfigured',
        'this deployment has no IP_SALT secret, so it does not serve; its operator sets one',
      ),
    );
  if (path === '/' || path === '/v1') {
    if (request.method !== 'GET') return no(refused(405, 'method_not_allowed', `${path} is GET`));
    return json({
      name: 'tape-mcp',
      version: VERSION,
      what: 'Compile Tape programs and run requests against them, and report what you find: MCP at POST /mcp, or JSON at POST /v1/compile, POST /v1/run and POST /v1/feedback.',
      docs: 'https://github.com/ivarvong/tape/blob/main/docs/mcp.md',
      terms: 'https://github.com/ivarvong/tape/blob/main/TERMS.md',
      limits: LIMITS,
    });
  }
  if (!known)
    return no(
      refused(404, 'not_found', `no route ${path}: POST /mcp, POST /v1/compile, POST /v1/run or POST /v1/feedback`),
    );
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
  const call: CallMeta = {
    ip_hash: meta.ip_hash,
    user_agent: request.headers.get('user-agent') ?? '',
    mcp_protocol_version: request.headers.get('mcp-protocol-version'),
    tape_mcp_version: gate.version ?? null,
    smoke: request.headers.has('x-tape-synthetic'),
  };
  const store = gate.feedback ?? null;
  if (path === '/mcp') return mcpCall(text, deps, seen, call, store);
  let args: unknown;
  try {
    args = JSON.parse(text);
  } catch {
    return no(refused(400, 'bad_json', 'the body is not JSON'));
  }
  seen.tool = HTTP_TOOLS[path] ?? 'compile';
  const called = await (TOOLS[seen.tool] ?? compileTool)(args, deps, call, store);
  seen.usage = called.usage;
  if (isRefusal(called.result)) return no(called.result);
  seen.ok = okOf(called.result);
  return json(called.result);
}

function mcpCall(text: string, deps: Deps, seen: Seen, meta: CallMeta, store: Store | null): Promise<Response> {
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
      'Tape is a small language for durable services, compiled to WebAssembly; it runs in the browser, in Node and on Cloudflare Workers, and every effect is recorded (https://github.com/ivarvong/tape). compile reports what the compiler says of a program; run compiles it and sends it HTTP requests against a fresh in-memory SQLite database, and returns each response with its effect log, whether a replay from that log matched, and its OTLP trace. With no files, both use examples/hello.tape, and their descriptions say what it gives. If anything about Tape surprises you, looks wrong or is missing, report it with feedback, with the smallest program that shows it: the maintainers read every report. Alpha; calls are logged (TERMS.md).',
    list: () => listing(deps),
    call: async (name, args) => {
      seen.tool = typeof name === 'string' ? name.slice(0, 40) : null;
      const tool = typeof name === 'string' ? TOOLS[name] : undefined;
      if (!tool) return null;
      const called = await tool(args, deps, meta, store);
      seen.usage = called.usage;
      seen.ok = isRefusal(called.result) ? false : okOf(called.result);
      if (isRefusal(called.result)) seen.refused = called.result.error;
      return toolResult(called.result);
    },
  };
  return serveMcp(new Request('http://tape-mcp/mcp', { method: 'POST', body: text }), server);
}
