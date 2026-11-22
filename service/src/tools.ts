// tools.ts: Tape programs as tools for agents. A tool is a program made only of exported functions
// (`export fn quote(message: Basket) -> Result[Price, View]`): one JSON message in, one JSON reply or a refusal
// out. Its capabilities are its parameters, and nothing else can give it any: a Tape function reaches storage
// only through a Sql value, another program only through a Remote, the time only through a Clock, randomness
// only through an Entropy, and the host passes them only as parameters of the exported function. The module
// shows the same thing at the Wasm level: a tool that takes no Sql has no `env.sql` import, one that takes no
// Remote has no `env.call` (`env.call_key` since command keys are text), one with neither Clock nor Entropy has
// no `env.ask`. Schema statements and migrations also need Sql, because the host runs them on the tool's database.
//
// An account's policy (PUT /_policy/:account, operator token) grants capabilities: { sql, clock, entropy,
// remote: [program names] }. With no policy, only pure tools are accepted. An upload that needs a capability the
// policy does not grant is refused (403) before anything is stored, with the function and parameter that asked.
import type { JsonSchema } from '../../compiler/gen/schema.ts';
import type { Refusal, Stored } from './build.ts';

const SECTION_IMPORT = 2;
type Cursor = { i: number };
const byte = (b: Uint8Array, at: Cursor): number => b[at.i++] ?? 0;
const uleb = (b: Uint8Array, at: Cursor): number => {
  let v = 0,
    shift = 0,
    x = 0;
  do {
    x = byte(b, at);
    v |= (x & 0x7f) << shift;
    shift += 7;
  } while ((x & 0x80) !== 0);
  return v >>> 0;
};
const str = (b: Uint8Array, at: Cursor): string => {
  const n = uleb(b, at),
    s = new TextDecoder().decode(b.subarray(at.i, at.i + n));
  at.i += n;
  return s;
};
/** Step over the limits of a table or memory import: a flags byte, a minimum, and a maximum when the flag says. */
const limits = (b: Uint8Array, at: Cursor): void => {
  const flags = byte(b, at);
  uleb(b, at);
  if ((flags & 1) !== 0) uleb(b, at);
};
/** Step over what an import is: a function's type index, a table, a memory, or a global. */
const skipImport = (b: Uint8Array, at: Cursor): void => {
  const kind = byte(b, at);
  if (kind === 0) uleb(b, at);
  else if (kind === 2) limits(b, at);
  else if (kind === 1) {
    at.i++;
    limits(b, at);
  } else at.i += 2;
};
// The functions a module imports, read from its import section ("env.sql", "env.json", …).
export function importsOf(wasm: Uint8Array | ArrayBuffer): string[] {
  const b = new Uint8Array(wasm),
    out: string[] = [],
    at = { i: 8 };
  while (at.i < b.length) {
    const id = byte(b, at),
      size = uleb(b, at),
      end = at.i + size;
    if (id === SECTION_IMPORT) {
      for (let n = uleb(b, at); n > 0; n--) {
        const mod = str(b, at),
          field = str(b, at);
        skipImport(b, at);
        out.push(`${mod}.${field}`);
      }
    }
    at.i = end;
  }
  return out;
}

/** A capability a tool needs, and why: 'sql' | 'clock' | 'entropy' | 'timer' | 'remote:<name>'. */
export type Need = { cap: string; why: string };
/** What an operator grants an account's tools (PUT /_policy/:account). */
export type Policy = { sql?: boolean; clock?: boolean; entropy?: boolean; remote?: string[] };
/** The part of a stored program the tools read. */
export type Tool = Pick<Stored, 'methods' | 'base' | 'migrations' | 'plain' | 'entry' | 'schemas'>;

const BY_TYPE: Readonly<Record<string, (p: string) => readonly [string, string]>> = {
  Sql: p => ['sql', `takes ${p}: Sql`],
  Clock: p => ['clock', `takes ${p}: Clock`],
  Entropy: p => ['entropy', `takes ${p}: Entropy`],
  Timer: p => ['timer', `takes ${p}: Timer`],
  Remote: p => [`remote:${p}`, `takes ${p}: Remote, the program named ${p}`],
  // a family reaches every program named <name>-<n>; a policy lists programs by name, so a family is granted only
  // by the literal entry <name>-* (and a call to a member is still checked by its own name when it is made)
  Remotes: p => [`remote:${p}-*`, `takes ${p}: Remotes, the programs named ${p}-<n>`],
};

// What a tool needs, each with the reason.
export function needsOf(built: Tool): { needs: Need[]; imports: string[] } {
  const needs: Need[] = [];
  const has = (cap: string): boolean => needs.some(n => n.cap === cap);
  const add = (cap: string, why: string): void => {
    if (!has(cap)) needs.push({ cap, why });
  };
  for (const m of built.methods)
    for (const p of m.params) {
      const [cap, why] = BY_TYPE[p.type]?.(p.name) ?? [];
      if (cap !== undefined && why !== undefined) add(cap, `export fn ${m.name} ${why}`);
    }
  if (built.base.length > 0) add('sql', `it declares schema statements, which run on its database`);
  if (built.migrations.length > 0) add('sql', `it declares migrations, which run on its database`);
  // the module itself, as a second witness: an import the signatures do not explain is refused too
  const imports = importsOf(built.plain);
  if (imports.includes('env.sql')) add('sql', 'its module imports env.sql');
  // env.call is the import of modules built before command keys were text; env.call_key since; env.member picks a
  // member of a family
  for (const imp of ['env.call', 'env.call_key', 'env.member'])
    if (imports.includes(imp) && !needs.some(n => n.cap.startsWith('remote:')))
      add('remote:?', `its module imports ${imp}`);
  if (imports.includes('env.wake')) add('timer', 'its module imports env.wake');
  return { needs, imports };
}

const granted = (policy: Policy | null | undefined, cap: string): boolean => {
  if (cap === 'sql') return policy?.sql === true;
  if (cap === 'clock') return policy?.clock === true;
  if (cap === 'entropy') return policy?.entropy === true;
  return cap.startsWith('remote:') && (policy?.remote ?? []).includes(cap.slice(7));
};
const grants = (policy: Policy | null | undefined): string[] => [
  ...(['sql', 'clock', 'entropy'] as const).filter(cap => policy?.[cap] === true),
  ...(policy?.remote ?? []).map(r => `remote:${r}`),
];
const HOW: Readonly<Record<string, string>> = {
  sql: '{"sql": true}',
  clock: '{"clock": true}',
  entropy: '{"entropy": true}',
};
const capName = (cap: string): string => {
  if (cap === 'remote:?') return 'Remote';
  return cap.startsWith('remote:') ? `Remote ${cap.slice(7)}` : cap.slice(0, 1).toUpperCase() + cap.slice(1);
};
export type ToolRefusal = Refusal & { problems?: string[]; granted?: string[]; hint?: string };

// Why this tool cannot be accepted, or null.
export function refusal(name: string, built: Tool, policy: Policy | null | undefined): ToolRefusal | null {
  if (built.methods.length === 0)
    return {
      status: 400,
      error: `tool ${name} exports no function; a tool is \`export fn name(capabilities…, message: Type) -> Result[Reply, View]\``,
    };
  if (built.entry.length > 0)
    return {
      status: 400,
      error: `tool ${name} has a handle function; a tool is only exported functions, each taking one message`,
    };
  const { needs } = needsOf(built),
    missing = needs.filter(n => !granted(policy, n.cap));
  if (missing.length === 0) return null;
  const examples = missing.map(n => HOW[n.cap] ?? `{"remote": ["${n.cap.slice(7)}"]}`).join(' or ');
  return {
    status: 403,
    error: 'capability not granted',
    problems: missing.map(n => `${capName(n.cap)} is not granted: ${n.why}`),
    granted: grants(policy),
    hint: missing.some(n => n.cap === 'timer')
      ? 'A tool runs only when an agent calls it, so no policy grants Timer: take the timer out, or upload it as a program (POST /:account/:name); nothing was stored.'
      : `An operator grants capabilities with PUT /_policy/:account, for example ${examples}; nothing was stored.`,
  };
}

// The comment lines right above `export fn <name>`, as its description.
const described = (source: string, fn: string): string => {
  const lines = source.split('\n').map(l => l.trim()),
    at = lines.findIndex(l => new RegExp(`^export fn ${fn}\\b`).test(l));
  const doc: string[] = [];
  for (const line of lines.slice(0, Math.max(at, 0)).toReversed()) {
    if (!line.startsWith('//')) break;
    doc.unshift(line.replace(/^\/\/\s?/, ''));
  }
  return doc.join(' ');
};

/** One exported function of a tool, as agents see it. */
export type ToolEntry = {
  name: string;
  tool: string;
  function: string;
  version: number;
  description: string;
  inputSchema: JsonSchema | undefined;
  outputSchema: JsonSchema | undefined;
  capabilities: { sql: boolean; clock: boolean; entropy: boolean; remote: string[]; pure: boolean; imports: string[] };
};

// One manifest entry per exported function, named <tool>_<function> as function calling wants ([a-zA-Z0-9_-]).
export function manifest(name: string, version: number, built: Tool, source: string): ToolEntry[] {
  const { needs, imports } = needsOf(built);
  const capabilities = {
    sql: needs.some(n => n.cap === 'sql'),
    clock: needs.some(n => n.cap === 'clock'),
    entropy: needs.some(n => n.cap === 'entropy'),
    remote: needs.filter(n => n.cap.startsWith('remote:')).map(n => n.cap.slice(7)),
    pure: needs.length === 0,
    imports,
  };
  return built.methods.map(m => {
    const s = built.schemas.find(x => x.name === m.name),
      doc = described(source, m.name);
    return {
      name: `${name}_${m.name}`,
      tool: name,
      function: m.name,
      version,
      description: doc === '' ? `${name}.${m.name}` : doc,
      inputSchema: s?.input,
      outputSchema: s?.output,
      capabilities,
    };
  });
}

/** What calling a tool gave: its output or its refusal, and where its trace is. */
export type ToolResult = { ok: boolean; output?: unknown; error?: string; trace_url?: string; otlp_url?: string };
export type McpHost = {
  version: string;
  list: () => Promise<ToolEntry[]> | ToolEntry[];
  call: (tool: ToolEntry, input: unknown) => Promise<ToolResult>;
};
type Fields = Readonly<Record<string, unknown>>;
const fieldsOf = (v: unknown): Fields => (typeof v === 'object' && v !== null ? { ...v } : {});
const PROTOCOLS = new Set(['2025-06-18', '2025-03-26']);
const listed = (t: ToolEntry): Fields => ({
  name: t.name,
  description: t.description,
  inputSchema: t.inputSchema,
  outputSchema: t.outputSchema,
  annotations: {
    readOnlyHint: !t.capabilities.sql && t.capabilities.remote.length === 0,
    openWorldHint: t.capabilities.remote.length > 0,
  },
  _meta: { 'tape/capabilities': t.capabilities, 'tape/version': t.version },
});
const called = (r: ToolResult): Fields => {
  const meta = { 'tape/trace_url': r.trace_url, 'tape/otlp_url': r.otlp_url };
  return r.ok
    ? {
        content: [{ type: 'text', text: JSON.stringify(r.output) }],
        structuredContent: r.output,
        isError: false,
        _meta: meta,
      }
    : { content: [{ type: 'text', text: r.error }], isError: true, _meta: meta };
};

// MCP over streamable HTTP (2025-06-18), JSON responses only: initialize, ping, tools/list, tools/call.
export async function mcp(request: Request, { list, call, version }: McpHost): Promise<Response> {
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
  let msg: Fields;
  try {
    msg = fieldsOf(await request.json());
  } catch {
    return Response.json(
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } },
      { status: 400 },
    );
  }
  const { id, method } = msg,
    params = fieldsOf(msg.params);
  if (id === undefined) return new Response(null, { status: 202 }); // a notification or a response: nothing to answer
  const ok = (result: Fields): Response => Response.json({ jsonrpc: '2.0', id, result }),
    no = (code: number, message: string): Response => Response.json({ jsonrpc: '2.0', id, error: { code, message } });
  switch (method) {
    case 'initialize': {
      const asked = params.protocolVersion;
      return ok({
        protocolVersion: typeof asked === 'string' && PROTOCOLS.has(asked) ? asked : '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'tape-tools', version },
        instructions:
          'Each tool is a Tape program. Every call returns a signed link to its trace, replayable from its effect log, in _meta.',
      });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: (await list()).map(listed) });
    case 'tools/call': {
      const t = (await list()).find(x => x.name === params.name);
      if (!t) return no(-32602, `unknown tool ${String(params.name)}`);
      return ok(called(await call(t, params.arguments ?? {})));
    }
    default:
      return no(-32601, `method not found: ${String(method)}`);
  }
}

const texts = (v: unknown): string[] => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : []);
/** A policy as it was sent or stored (JSON): what of it is a policy. */
export const policyOf = (v: unknown): Policy => {
  const p = fieldsOf(v);
  return {
    ...(typeof p.sql === 'boolean' ? { sql: p.sql } : {}),
    ...(typeof p.clock === 'boolean' ? { clock: p.clock } : {}),
    ...(typeof p.entropy === 'boolean' ? { entropy: p.entropy } : {}),
    ...(Array.isArray(p.remote) ? { remote: texts(p.remote) } : {}),
  };
};
const schemaOf = (v: unknown): JsonSchema | undefined => (typeof v === 'object' && v !== null ? { ...v } : undefined);
/** A manifest entry as it was stored (JSON). */
export const entryOf = (v: unknown): ToolEntry[] => {
  const e = fieldsOf(v),
    c = fieldsOf(e.capabilities);
  if (typeof e.name !== 'string' || typeof e.tool !== 'string' || typeof e.function !== 'string') return [];
  return [
    {
      name: e.name,
      tool: e.tool,
      function: e.function,
      version: typeof e.version === 'number' ? e.version : 0,
      description: typeof e.description === 'string' ? e.description : '',
      inputSchema: schemaOf(e.inputSchema),
      outputSchema: schemaOf(e.outputSchema),
      capabilities: {
        sql: c.sql === true,
        clock: c.clock === true,
        entropy: c.entropy === true,
        remote: texts(c.remote),
        pure: c.pure === true,
        imports: texts(c.imports),
      },
    },
  ];
};
