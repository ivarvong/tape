// index.ts: Tape as a service. POST a program's source and get an immutable version; send requests to a version
// and get its responses, effect logs and traces.
//
//   POST /:account/:name                     body: Tape source      -> 201 { version, url, hash, … }
//   GET  /:account/:name                     the versions
//   GET  /:account/:name/storage             bytes held: the name's SQLite, its data's, and the request log's share
//   GET  /:account/:name/requests?since&limit  recent routed requests (operator and public), newest first, with signed
//                                            trace links; and the woken runs in that window
//   ANY  /:account/:name/v/:version/<path>   runs <METHOD /path?query LF body> through that version
//   GET  /:account/:name/log/:version/:id    a request's effect log (id from the tape-request-id header)
//   GET  /:account/:name/trace/:version/:id  its trace, made now by replaying that log through the traced build
//   GET  /t/:account/:name/:version/:id?exp&sig     the same trace as a page, with no token: the signed URL every
//                                                  response carries in tape-trace-url (?format=text for text)
//   GET  /otlp/:account/:name/:version/:id?exp&sig  the same, as OTLP/JSON (an ExportTraceServiceRequest)
// Every call another program serves is recorded with its trace context, so a request's page and its OTLP join
// the caller's log with what each callee did: ran (with its own log and trace), or answered from a stored reply.
//
//   DELETE /:account/:name/v/:version        retires a version, which may release a held contract migration
//   PUT  /_faults/:account   body: a fault plan (see faults.ts), or null to stop; only accounts named jepsen-*
//   GET  /_faults/:account   the faults injected so far, in order
//
// Tools (tools.ts): programs made only of exported functions, for agents. The operator sets what an account's
// tools may use; an agent uploads, lists and calls tools with the account's agent token, which opens nothing else.
//   PUT  /_policy/:account          { sql, clock, entropy, remote: [names] }   operator
//   GET  /_agent/:account           { token }: the account's agent token                  operator
//   POST /tools/:account/:name      body: Tape source -> 201 the manifest entries, or 403 capability not granted
//   GET  /tools/:account            the manifest: every tool function with JSON Schemas and capabilities
//   POST /tools/:account/:name/:fn  body: the JSON message -> { ok, output | error, trace_url, otlp_url }
//   POST /mcp/:account              MCP (streamable HTTP, JSON responses): initialize, tools/list, tools/call
//
// One Durable Object per account/name (Name). Each upload is a row in its SQLite: source, the plain and traced
// Wasm, the trace sites, the hash, its migration chain and the time; the row id is the version. The data is per
// name: one facet, loaded through the Worker Loader with every live version's builds, holds the program's tables.
// Each upload restarts it, and before its first request it applies the latest version's new migrations (one
// transaction, recorded like a request). Older versions keep running on the migrated tables, which only grow,
// until they are retired; a contract migration (one that drops or renames) waits for that. An upload whose chain
// edits or drops a shipped migration is refused. A program's Remote parameters reach the latest version of the
// program with that name in the same account.
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { ServiceReply } from '../../host.ts';
import { build, isRefusal, rulesNow } from './build.ts';
import { FAULTY, planOf, through } from './faults.ts';
import { kv } from './kv.ts';
import { Name, WIPED_ERROR } from './name.ts';
import { secured } from './headers.ts';
import { buyerOf, routes, run, targetOf, traceLinks } from './programs.ts';
import type { CallMeta } from './records.ts';
import { manifest, mcp, policyOf, refusal } from './tools.ts';
import type { Policy, ToolEntry, ToolResult } from './tools.ts';
import {
  PUBLISHED,
  SEGMENT,
  SOURCE_MAX,
  authorized,
  bodyOf,
  hex,
  messageOf,
  reply,
  signature,
  signed,
  tooLarge,
  verified,
} from './web.ts';

// only entrypoints and functions: with static assets, a main module that exports a string or a number does not load
export { build, rulesNow, Name, targetOf, buyerOf };

const enc = new TextEncoder();
type Env = Cloudflare.Env;
type Fields = Readonly<Record<string, unknown>>;
const fieldsOf = (v: unknown): Fields => (typeof v === 'object' && v !== null ? { ...v } : {});
/** A request's JSON body; null when it is not JSON. */
const jsonOf = async (request: Request): Promise<unknown> => {
  try {
    return await request.json();
  } catch {
    return null;
  }
};
const STOPPED =
  'the program stopped before it answered; what it committed before that is kept, so the outcome is unknown';

// GET /:account/:name/:version/:kind -> that build's Wasm. Versions never change, so Workers Cache keeps them.
export class Wasm extends WorkerEntrypoint {
  override async fetch(request: Request): Promise<Response> {
    const [, account, name, version, kind] = new URL(request.url).pathname.split('/');
    const bytes = await this.ctx.exports.Name.getByName(`${account}/${name}`).wasm(Number(version), kind);
    return bytes
      ? new Response(bytes, {
          headers: { 'content-type': 'application/wasm', 'cache-control': 'public, max-age=31536000, immutable' },
        })
      : new Response('no such version', { status: 404, headers: { 'cache-control': 'no-store' } });
  }
}

const rejected = (why: string): ServiceReply => ({ status: 'rejected', body: enc.encode(why) });
// Calls between programs: env.CALLS in each loaded program, bound to its account.
export class Calls extends WorkerEntrypoint<Env, { account: string; from: string }> {
  async call(to: string, meta: CallMeta, bytes: Uint8Array): Promise<ServiceReply> {
    const { account, from } = this.ctx.props,
      Names = this.ctx.exports.Name;
    if (!SEGMENT.test(to)) return rejected(`${to} is not a program name`);
    if (meta.method === 'woken')
      return rejected(`${to}.woken is run by ${to}'s own timers, not called by other programs`);
    // a tool reaches only the programs its account's policy lists now (it was checked at upload, too)
    if (from.startsWith('tool-')) {
      const policy = await Names.getByName(`${account}/~tools`).policy();
      if (!(policy?.remote ?? []).includes(to))
        return rejected(`tool ${from.slice(5)} may not call ${to}: the account's policy does not grant Remote ${to}`);
    }
    if (!FAULTY.test(account)) return Names.getByName(`${account}/${to}`).serve(account, to, meta, bytes);
    // a jepsen-* account: the plan, if one is set, picks this call's fault
    const fault = await Names.getByName(`${account}/~faults`).fault(
      `${from}>${to}.${meta.method}#${meta.key ?? '-'}`,
      meta.withinMs,
    );
    return through(
      fault,
      () => Names.getByName(`${account}/${to}`).serve(account, to, meta, bytes, fault?.kind),
      () => Names.getByName(`${account}/${from}`).reset('jepsen: the caller was reset while it waited for a reply'),
    );
  }
}

// ---- tools
// An account's agent token: an HMAC of the account under the service token. It opens /tools/:account and
// /mcp/:account, and nothing else.
const agentToken = (token: string, account: string): Promise<string> => signature(token, `agent/${account}`);
const stillGranted = (entry: ToolEntry, policy: Policy | null): boolean =>
  (!entry.capabilities.sql || policy?.sql === true) &&
  (!entry.capabilities.clock || policy?.clock === true) &&
  (!entry.capabilities.entropy || policy?.entropy === true) &&
  entry.capabilities.remote.every(r => (policy?.remote ?? []).includes(r));
async function invokeTool(
  ctx: ExecutionContext,
  token: string,
  origin: string,
  account: string,
  entry: ToolEntry,
  input: unknown,
): Promise<ToolResult & { status: number }> {
  const policy = await ctx.exports.Name.getByName(`${account}/~tools`).policy();
  if (!stillGranted(entry, policy))
    return {
      ok: false,
      status: 403,
      error: `tool ${entry.tool} needs a capability the account's policy no longer grants`,
    };
  const name = `tool-${entry.tool}`,
    r = await ctx.exports.Name.getByName(`${account}/${name}`).tool(
      account,
      name,
      entry.function,
      enc.encode(typeof input === 'string' ? input : JSON.stringify(input)),
    );
  const text = new TextDecoder().decode(r.body),
    links = await traceLinks(token, origin, account, name, r.version, r.id);
  if (r.status !== 'ok') return { ok: false, status: 422, error: text, ...links };
  const output: unknown = JSON.parse(text);
  return { ok: true, status: 200, output, ...links };
}

// GET /_accounts/:account: the names recorded for the account (R-RET-7). DELETE /_accounts/:account with
// {"confirm": "<account>", "names": [...]}: wipes every recorded name, and the extra names given (for an account made
// before names were recorded), then the record. Operator only. Each name's storage, data and alarm are removed.
const ACCOUNT_NAMES = /^(~kv|~faults|~tools|[a-z0-9_-]{1,64})$/;
type Wiped = { name: string; bytes_before?: number | null; stopped_first?: true; error?: string };
/** Delete one name; a stop that overtook the reply (WIPED_ERROR) means done. */
const wipeOne = async (ctx: ExecutionContext, account: string, name: string): Promise<Wiped> => {
  const stub = ctx.exports.Name.getByName(`${account}/${name}`);
  let bytes: number | null = null;
  try {
    bytes = await stub.size();
    return await stub.wipe(account, name);
  } catch (e) {
    const why = messageOf(e);
    return why.includes(WIPED_ERROR) ? { name, bytes_before: bytes, stopped_first: true } : { name, error: why };
  }
};
async function accountRoute(ctx: ExecutionContext, request: Request, account: string): Promise<Response> {
  if (!SEGMENT.test(account)) return reply({ error: 'an account is 1-64 of a-z 0-9 _ -' }, 400);
  const registry = ctx.exports.Name.getByName(`${account}/~registry`);
  if (request.method === 'GET') return reply({ account, names: await registry.registered() });
  if (request.method !== 'DELETE') return reply({ error: 'GET or DELETE' }, 405);
  const body = fieldsOf(await jsonOf(request));
  if (body.confirm !== account)
    return reply(
      { error: `deleting an account removes all of its data and cannot be undone; send {"confirm": "${account}"}` },
      400,
    );
  const given: unknown[] = Array.isArray(body.names) ? body.names : [],
    extra = given.flatMap(n => (typeof n === 'string' && ACCOUNT_NAMES.test(n) ? [n] : []));
  if (extra.length !== given.length)
    return reply({ error: 'names are 1-64 of a-z 0-9 _ -, or ~kv, ~faults, ~tools' }, 400);
  const names = [...new Set([...(await registry.registered()).map(r => r.name), ...extra])].toSorted();
  const wiped: Wiped[] = [];
  for (const name of names) wiped.push(await wipeOne(ctx, account, name));
  const failed = wiped.filter(w => w.error !== undefined);
  if (failed.length === 0) {
    try {
      await registry.wipe(account, '~registry');
    } catch {
      // the registry stopped as it was deleted: done
    }
  }
  return reply(
    {
      account,
      deleted: wiped.filter(w => w.error === undefined).map(w => w.name),
      failed,
      bytes_before: wiped.reduce((a, w) => a + (w.bytes_before ?? 0), 0),
    },
    failed.length > 0 ? 500 : 200,
  );
}

type ToolArgs = { request: Request; ctx: ExecutionContext; env: Env; url: URL; m: RegExpMatchArray };
type ToolRoute = readonly [
  method: string,
  pattern: RegExp,
  operatorOnly: boolean,
  run: (a: ToolArgs) => Response | Promise<Response>,
];
const setPolicy = async ({ request, ctx, m }: ToolArgs): Promise<Response> => {
  const account = m[1] ?? '',
    sent = policyOf(await jsonOf(request));
  const policy: Policy = {
    sql: sent.sql === true,
    clock: sent.clock === true,
    entropy: sent.entropy === true,
    remote: (sent.remote ?? []).filter(r => SEGMENT.test(r) && !r.startsWith('tool-')),
  };
  await ctx.exports.Name.getByName(`${account}/~registry`).registerName('~tools', 'tools');
  return reply(await ctx.exports.Name.getByName(`${account}/~tools`).setPolicy(policy));
};
const uploadTool = async ({ request, ctx, m }: ToolArgs): Promise<Response> => {
  const [, account = '', tool = ''] = m,
    registry = ctx.exports.Name.getByName(`${account}/~tools`),
    sent = await bodyOf(request, SOURCE_MAX);
  if (sent === null) return tooLarge("a tool's source", SOURCE_MAX);
  const source = new TextDecoder().decode(sent),
    built = build(source);
  if (isRefusal(built)) return reply({ tool, ...built }, built.status);
  const no = refusal(tool, built, await registry.policy());
  if (no) {
    const { status, ...why } = no;
    return reply({ tool, ...why }, status);
  }
  const name = `tool-${tool}`,
    hash = await hex(built.plain),
    row = await ctx.exports.Name.getByName(`${account}/${name}`).upload(account, name, { source, hash, ...built });
  if ('error' in row) {
    const { check: _check, ...rest } = row;
    return reply({ tool, ...rest }, row.status);
  }
  const entries = manifest(tool, row.version, built, source);
  await registry.register(tool, row.version, entries);
  return reply({ account, tool, version: row.version, hash, bytes: built.plain.length, tools: entries }, 201);
};
const toolRoutes: readonly ToolRoute[] = [
  ['PUT', /^\/_policy\/([^/]+)$/, true, setPolicy],
  [
    'GET',
    /^\/_policy\/([^/]+)$/,
    true,
    async ({ ctx, m }) => reply({ policy: await ctx.exports.Name.getByName(`${m[1]}/~tools`).policy() }),
  ],
  [
    'GET',
    /^\/_agent\/([^/]+)$/,
    true,
    async ({ env, m }) =>
      reply({
        account: m[1],
        token: await agentToken(env.TOKEN, m[1] ?? ''),
        opens: [`/tools/${m[1]}`, `/mcp/${m[1]}`],
      }),
  ],
  ['POST', /^\/tools\/([^/]+)\/([^/]+)$/, false, uploadTool],
  [
    'GET',
    /^\/tools\/([^/]+)$/,
    false,
    async ({ ctx, m }) => {
      const registry = ctx.exports.Name.getByName(`${m[1]}/~tools`),
        [tools, policy] = await Promise.all([registry.tools(), registry.policy()]);
      return reply({ account: m[1], policy, tools: tools.map(t => ({ ...t, granted: stillGranted(t, policy) })) });
    },
  ],
  [
    'POST',
    /^\/tools\/([^/]+)\/([^/]+)\/([^/]+)$/,
    false,
    async ({ request, ctx, env, url, m }) => {
      const [, account = '', tool, fn] = m,
        tools = await ctx.exports.Name.getByName(`${account}/~tools`).tools(),
        entry = tools.find(t => t.tool === tool && t.function === fn);
      if (!entry) return reply({ error: `no tool function ${tool}.${fn}` }, 404);
      const { status, ...r } = await invokeTool(ctx, env.TOKEN, url.origin, account, entry, await request.text());
      return reply(r, status);
    },
  ],
  [
    '*',
    /^\/mcp\/([^/]+)$/,
    false,
    ({ request, ctx, env, url, m }) => {
      const account = m[1] ?? '',
        registry = ctx.exports.Name.getByName(`${account}/~tools`);
      return mcp(request, {
        version: '1',
        list: () => registry.tools(),
        call: (t, args) => invokeTool(ctx, env.TOKEN, url.origin, account, t, args),
      });
    },
  ],
];

// GET /t/... and /otlp/...: a trace anyone with the link can open until it expires; one signature serves both.
// .../:version/:id is one run (by its log id); .../r/:span is one routed request (by the router's call span).
const TRACE_PAGE = /^\/(t|otlp)\/([^/]+)\/([^/]+)\/(?:(\d+)\/([0-9a-f-]{36})|r\/([0-9a-f]{16}))$/;
const tracePage = async (url: URL, env: Env, ctx: ExecutionContext, m: RegExpMatchArray): Promise<Response> => {
  const [, kind, account = '', name = '', version, id = '', callSpan] = m,
    routed = callSpan !== undefined && callSpan !== '',
    path = routed ? `/${account}/${name}/r/${callSpan}` : `/${account}/${name}/${version}/${id}`;
  if (
    !SEGMENT.test(account) ||
    !SEGMENT.test(name) ||
    !(await verified(env.TOKEN, path, url.searchParams.get('exp'), url.searchParams.get('sig')))
  )
    return reply({ error: 'this trace link is not valid, or has expired' }, 401);
  const page = url.searchParams.get('format') === 'text' ? 'text' : 'html',
    format = kind === 'otlp' ? 'otlp' : page,
    links = { otlp: `${url.origin}/otlp${path}${url.search.replace(/&format=[^&]*/, '')}` },
    stub = ctx.exports.Name.getByName(`${account}/${name}`);
  return routed
    ? stub.requestLog(account, name, callSpan, format, links)
    : stub.log(account, name, Number(version), id, format, links);
};

// A published name's public route: /p/:account/:name/<path>, no token, GET HEAD or POST, a body of at most
// PUBLIC_BODY bytes; it runs the latest live version. A name that is not published (or has no live version) is a
// 404, the same answer as no such name.
const PUBLIC = /^\/p\/([^/]+)\/([^/]+)(\/.*)?$/;
const PUBLIC_BODY = 64 * 1024;
const TOO_LARGE = `a public request's body is at most ${PUBLIC_BODY} bytes`;
const publicRoute = async (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
  m: RegExpMatchArray,
): Promise<Response> => {
  const [, account = '', name = '', path = '/'] = m,
    bodiless = request.method === 'GET' || request.method === 'HEAD';
  if (!SEGMENT.test(account) || !SEGMENT.test(name) || /^(kv|tool)-/.test(name))
    return reply({ error: 'no such page' }, 404);
  if (!bodiless && request.method !== 'POST') return reply({ error: 'GET, HEAD or POST' }, 405);
  if (Number(request.headers.get('content-length') ?? 0) > PUBLIC_BODY) return reply({ error: TOO_LARGE }, 413);
  // only a published name's own object is asked anything: for any other name, the one object that lists the
  // published names answers, and no object of the account is made
  if (!(await ctx.exports.Name.getByName(PUBLISHED).isPublished(`${account}/${name}`)))
    return reply({ error: 'no such page' }, 404);
  const stub = ctx.exports.Name.getByName(`${account}/${name}`),
    p = await stub.publication();
  if (!p.published || p.latest === null) return reply({ error: 'no such page' }, 404);
  const body = await bodyOf(request, PUBLIC_BODY);
  if (body === null) return reply({ error: TOO_LARGE }, 413);
  const again = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    ...(bodiless ? {} : { body }),
  });
  try {
    return await run(
      { request: again, stub, account, name, url, token: env.TOKEN, ctx },
      { version: p.latest, path, via: 'public' },
    );
  } catch {
    return reply({ error: STOPPED }, 503);
  }
};

const NAMES = 'account and name are 1-64 of a-z 0-9 _ -';
// PUT or GET /_public/:account/:name: the operator's opt-in to the public route
const publishRoute = async (
  request: Request,
  ctx: ExecutionContext,
  url: URL,
  m: RegExpMatchArray,
): Promise<Response> => {
  const [, account = '', name = ''] = m;
  if (!SEGMENT.test(account) || !SEGMENT.test(name)) return reply({ error: NAMES }, 400);
  if (/^(kv|tool)-/.test(name)) return reply({ error: 'KV shards and tools cannot be published' }, 400);
  const stub = ctx.exports.Name.getByName(`${account}/${name}`),
    at = { account, name, url: `${url.origin}/p/${account}/${name}/` };
  if (request.method === 'GET') return reply({ account, name, ...(await stub.publication()), url: at.url });
  if (request.method !== 'PUT') return reply({ error: 'PUT or GET' }, 405);
  const { published } = fieldsOf(await jsonOf(request));
  if (typeof published !== 'boolean') return reply({ error: '{"published": true} or {"published": false}' }, 400);
  if ((await stub.publication()).latest === null)
    return reply({ error: `${account}/${name} has no live version to publish` }, 404);
  // the public route answers only the names PUBLISHED lists: the name's own record first, then the list
  const done = await stub.setPublic(published);
  await ctx.exports.Name.getByName(PUBLISHED).setPublished(`${account}/${name}`, published);
  return reply({ account, name, ...done, url: at.url });
};
// PUT or GET /_faults/:account: a fault plan (faults.ts) for an account named jepsen-*, and the faults so far
const faultsRoute = async (request: Request, ctx: ExecutionContext, account: string): Promise<Response> => {
  if (!FAULTY.test(account) || !SEGMENT.test(account))
    return reply({ error: 'faults can be set only for an account named jepsen-*' }, 400);
  const stub = ctx.exports.Name.getByName(`${account}/~faults`);
  if (request.method === 'PUT') {
    await ctx.exports.Name.getByName(`${account}/~registry`).registerName('~faults', 'faults');
    return reply(await stub.setFaults(planOf(await request.json())));
  }
  return request.method === 'GET' ? reply(await stub.faultLog()) : reply({ error: 'PUT or GET' }, 405);
};
// PUT or GET /_retention/:account/:name: how many requests' trace records a name keeps (R-RET-6)
const retentionRoute = async (request: Request, ctx: ExecutionContext, m: RegExpMatchArray): Promise<Response> => {
  const [, account = '', name = ''] = m;
  if (!SEGMENT.test(account) || !SEGMENT.test(name)) return reply({ error: NAMES }, 400);
  const stub = ctx.exports.Name.getByName(`${account}/${name}`);
  if (request.method === 'GET') return reply(await stub.keep());
  if (request.method !== 'PUT') return reply({ error: 'PUT or GET' }, 405);
  const { trace_keep: keep } = fieldsOf(await jsonOf(request)),
    r = await stub.setKeep(typeof keep === 'number' ? keep : Number.NaN);
  return 'error' in r ? reply(r, r.status) : reply(r);
};
// POST /_ids {"names": ["<account>/<name>", ...]}: each name's object id (idFromName creates nothing), to match
// names against the platform's list of objects when choosing what to delete (R-RET-7)
const idsRoute = async (request: Request, ctx: ExecutionContext): Promise<Response> => {
  const { names } = fieldsOf(await jsonOf(request)),
    given: unknown[] = Array.isArray(names) ? names : [],
    list = given.flatMap(n => (typeof n === 'string' && n.length <= 140 ? [n] : []));
  if (!Array.isArray(names) || list.length > 10000 || list.length !== given.length)
    return reply({ error: 'names is a list of up to 10000 "<account>/<name>"' }, 400);
  return reply(Object.fromEntries(list.map(n => [n, ctx.exports.Name.idFromName(n).toString()])));
};

/** The operator's routes that are not a program's: null when the path is none of them. */
const operatorRoute = (request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> | null => {
  const path = url.pathname;
  const publish = /^\/_public\/([^/]+)\/([^/]+)$/.exec(path);
  if (publish) return publishRoute(request, ctx, url, publish);
  if (path.startsWith('/kv/'))
    return kv(ctx, request, url, async (account, name, callSpan) => {
      const trace_url = await signed(env.TOKEN, url.origin, `/${account}/${name}/r/${callSpan}`);
      return { trace_url, otlp_url: trace_url.replace(`${url.origin}/t/`, `${url.origin}/otlp/`) };
    });
  const faults = /^\/_faults\/([^/]+)$/.exec(path);
  if (faults) return faultsRoute(request, ctx, faults[1] ?? '');
  const retention = /^\/_retention\/([^/]+)\/([^/]+)$/.exec(path);
  if (retention) return retentionRoute(request, ctx, retention);
  if (path === '/_ids' && request.method === 'POST') return idsRoute(request, ctx);
  const accounts = /^\/_accounts\/([^/]+)$/.exec(path);
  return accounts ? accountRoute(ctx, request, accounts[1] ?? '') : null;
};
/** A route of the tools, when the path and method are one: refused without the operator's or the agent's token. */
const toolRoute = async (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
  operator: boolean,
): Promise<Response | null> => {
  for (const [method, pattern, operatorOnly, handle] of toolRoutes) {
    const m = pattern.exec(url.pathname);
    if (!m || (method !== '*' && method !== request.method)) continue;
    if (!m.slice(1).every(x => SEGMENT.test(x)))
      return reply({ error: 'account, tool and function names are 1-64 of a-z 0-9 _ -' }, 400);
    if (!operator && (operatorOnly || !authorized(request, await agentToken(env.TOKEN, m[1] ?? ''))))
      return reply({ error: 'unauthorized' }, 401);
    return handle({ request, ctx, env, url, m });
  }
  return null;
};
/** A program's route. An object that is reset while it runs a request (a deploy, an eviction, an injected fault)
 * gives no answer: what the request committed before it stopped is kept, and the client cannot know how far it got. */
const programRoute = async (request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> => {
  for (const [method, pattern, handle] of routes) {
    const m = pattern.exec(url.pathname);
    if (!m || (method !== '*' && method !== request.method)) continue;
    const [, account = '', name = ''] = m;
    if (!SEGMENT.test(account) || !SEGMENT.test(name)) return reply({ error: NAMES }, 400);
    try {
      const stub = ctx.exports.Name.getByName(`${account}/${name}`);
      return await handle({ request, m, account, name, url, token: env.TOKEN, origin: url.origin, ctx, stub });
    } catch (e) {
      return reply({ error: STOPPED, reason: messageOf(e) }, 503);
    }
  }
  return reply({ error: 'no such route' }, 404);
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return secured(await route(request, env, ctx), new URL(request.url).pathname, env.VERSION?.id);
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // a version without its secret opens nothing (not even to "Bearer undefined")
  if (typeof env.TOKEN !== 'string' || env.TOKEN === '') return reply({ error: 'unauthorized' }, 401);
  const url = new URL(request.url),
    page = request.method === 'GET' ? TRACE_PAGE.exec(url.pathname) : null;
  if (page) return tracePage(url, env, ctx, page);
  const operator = authorized(request, env.TOKEN);
  const tool = await toolRoute(request, env, ctx, url, operator);
  if (tool) return tool;
  const open = PUBLIC.exec(url.pathname);
  if (open) return publicRoute(request, env, ctx, url, open);
  if (!operator) return reply({ error: 'unauthorized' }, 401);
  return (await operatorRoute(request, env, ctx, url)) ?? programRoute(request, env, ctx, url);
}
