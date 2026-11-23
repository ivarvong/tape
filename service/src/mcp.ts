// mcp.ts: MCP over streamable HTTP (2025-06-18), JSON responses only: initialize, ping, tools/list, tools/call.
// What a server serves is its tools, already in MCP's shape, and what calling one gives. Two servers use it: the
// service's tools of an account (tools.ts, mcp()) and the hosted compiler and runner (mcp/, served at /mcp).
export type Fields = Readonly<Record<string, unknown>>;
export const fieldsOf = (v: unknown): Fields => (typeof v === 'object' && v !== null ? { ...v } : {});

/** A server: its name and version, what it tells a client on initialize, its tools, and calling one. */
export type McpServer = {
  name: string;
  version: string;
  instructions: string;
  /** each tool as tools/list gives it: name, description, inputSchema, … */
  list: () => Promise<Fields[]> | Fields[];
  /** a CallToolResult, or null when no tool has that name */
  call: (name: unknown, args: unknown) => Promise<Fields | null>;
};

const PROTOCOLS = new Set(['2025-06-18', '2025-03-26']);

export async function serveMcp(request: Request, server: McpServer): Promise<Response> {
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
        serverInfo: { name: server.name, version: server.version },
        instructions: server.instructions,
      });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: await server.list() });
    case 'tools/call': {
      const result = await server.call(params.name, params.arguments ?? {});
      return result ? ok(result) : no(-32602, `unknown tool ${String(params.name)}`);
    }
    default:
      return no(-32601, `method not found: ${String(method)}`);
  }
}
