// obs/o11y.ts: what trace.ts, cpu.ts and profile.ts share. Running the cf CLI (never wrangler) with the OAuth login
// (CLOUDFLARE_API_TOKEN removed: the env's token is an old scoped one) and the account from CLOUDFLARE_ACCOUNT_ID,
// which is never written to a file; querying Workers Observability; and the parsing, as pure functions that
// test/obs.ts checks: an invocation event read into one row, the route a URL is, percentiles, a span tree.
import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/** The Worker queried, and the origin its routes are under. */
export const SERVICE = process.env['TAPE_SERVICE'] ?? 'tape';
export const BASE = process.env['TAPE_BASE'] ?? 'https://tape.ivar.workers.dev';
/** service/: cf reads cloudflare.config.ts from where it runs, and the bundle's source paths are relative to it. */
export const SERVICE_DIR = new URL('../../', import.meta.url).pathname;

/** The environment cf runs in: the OAuth login, the account from the caller's environment. */
export function cfEnv(): NodeJS.ProcessEnv {
  if (!process.env['CLOUDFLARE_ACCOUNT_ID']) {
    console.error('set CLOUDFLARE_ACCOUNT_ID (the account the tape Worker is in); it is read from the env only');
    process.exit(2);
  }
  const env = { ...process.env };
  delete env['CLOUDFLARE_API_TOKEN'];
  return env;
}

const CF_BIN = `${SERVICE_DIR}node_modules/.bin/cf`;
/** Runs cf in service/; its stdout, as bytes (a profile is binary). Throws with cf's stderr on a non-zero exit. */
export function cfBytes(args: readonly string[]): Buffer {
  const [bin, pre] = existsSync(CF_BIN) ? [CF_BIN, []] : ['npx', ['cf']];
  return execFileSync(bin, [...pre, ...args], {
    cwd: SERVICE_DIR,
    env: cfEnv(),
    maxBuffer: 512 << 20,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
export const cf = (args: readonly string[]): string => cfBytes(args).toString('utf8');
/** cfBytes without blocking: a profile's load keeps running while cf waits for the capture. */
export function cfBytesAsync(args: readonly string[]): Promise<Buffer> {
  const [bin, pre] = existsSync(CF_BIN) ? [CF_BIN, []] : ['npx', ['cf']];
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      [...pre, ...args],
      { cwd: SERVICE_DIR, env: cfEnv(), maxBuffer: 512 << 20, encoding: 'buffer' },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`cf ${args.slice(0, 3).join(' ')}: ${stderr.toString('utf8').slice(0, 600)}`));
        else resolve(stdout);
      },
    );
  });
}

export type Filter = { key: string; operation: string; type: string; value: string | number };
export const eq = (key: string, value: string): Filter => ({ key, operation: 'eq', type: 'string', value });
export const startsWith = (key: string, value: string): Filter => ({
  key,
  operation: 'starts_with',
  type: 'string',
  value,
});

/** One query of a Workers Observability view (`events` here), retried: the API rate-limits bursts and 500s at times. */
export function query(
  filters: readonly Filter[],
  window: { from: number; to: number },
  limit = 1000,
  view = 'events',
): unknown[] {
  const body = {
    queryId: 'adhoc',
    view,
    limit,
    timeframe: window,
    parameters: { filters: [eq('$metadata.service', SERVICE), ...filters] },
  };
  let last: unknown = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const out = cf(['o11y', 'telemetry', 'query', '--body', JSON.stringify(body)]);
      const list = field(JSON.parse(out), 'events', 'events');
      return Array.isArray(list) ? list : [];
    } catch (e) {
      last = e;
      // sleep 1, 3, 5 s without a timer: these scripts are synchronous
      execFileSync('sleep', [String(1 + 2 * attempt)]);
    }
  }
  const stderr = field(last, 'stderr');
  const why = stderr instanceof Buffer ? stderr.toString('utf8') : last instanceof Error ? last.message : '';
  throw new Error(`cf o11y telemetry query failed 4 times: ${why.slice(0, 600)}`);
}

/** The window ending now, `minutes` long. */
export const lastMinutes = (minutes: number): { from: number; to: number } => {
  const to = Date.now();
  return { from: to - Math.round(minutes * 60_000), to };
};

// ---- parsing (pure)

export const field = (v: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((o, k) => (typeof o === 'object' && o !== null ? Reflect.get(o, k) : undefined), v);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** The route a request URL is, as cpu.ts groups them: the hosted tools by name, an account's routes by kind. */
export function routeOf(url: string): string {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return url === '' ? '' : 'other';
  }
  if (path === '/' || path === '/mcp' || /^\/v1\/(compile|run|test|feedback)$/.test(path)) return path;
  if (path === '/v1') return '/';
  if (path.startsWith('/playground')) return '/playground';
  if (/^\/mcp\/[^/]+$/.test(path)) return '/mcp/:account';
  if (/^\/[pt]\/[^/]+(\/|$)/.test(path)) return `/${path[1] ?? ''}/:account/…`;
  if (/^\/(tools|api)\//.test(path)) return `/${path.split('/')[1] ?? ''}/…`;
  // a program's own route: /<account>/<name>/...
  if (/^\/[^/]+\/[^/]+/.test(path)) return '/:account/:program…';
  return 'other';
}

/** One invocation event (`$metadata.type` cf-worker-event), read into the fields the scripts use. */
export type Invocation = {
  version: string;
  entrypoint: string;
  model: string;
  route: string;
  url: string;
  method: string;
  status: number | null;
  cpu: number;
  wall: number;
  outcome: string;
  requestId: string;
  traceId: string;
  rayId: string;
  at: number;
};
export function invocationOf(e: unknown): Invocation | null {
  if (field(e, '$metadata', 'type') !== 'cf-worker-event') return null;
  const w = field(e, '$workers');
  const model = text(field(w, 'executionModel'));
  const url = text(field(w, 'event', 'request', 'url'));
  const methods = field(w, 'event', 'rpcMethods');
  const entrypoint = text(field(w, 'entrypoint')) || 'default';
  // a Durable Object's invocation has no URL: it is its class and the methods called (Name.serve, Name.isPublished)
  const route =
    model === 'durableObject'
      ? `DO ${entrypoint}.${Array.isArray(methods) && methods.length > 0 ? methods.map(String).join('+') : text(field(w, 'eventType')) || '?'}`
      : routeOf(url);
  const status = field(w, 'event', 'response', 'status');
  return {
    version: text(field(w, 'scriptVersion', 'id')),
    entrypoint,
    model,
    route,
    url,
    method: text(field(w, 'event', 'request', 'method')),
    status: typeof status === 'number' ? status : null,
    cpu: num(field(w, 'cpuTimeMs')),
    wall: num(field(w, 'wallTimeMs')),
    outcome: text(field(w, 'outcome')),
    requestId: text(field(e, '$metadata', 'requestId')),
    traceId: text(field(e, '$metadata', 'traceId')),
    rayId: text(field(e, '$metadata', 'rayId')),
    at: num(field(e, 'timestamp')),
  };
}

/** The hosted call's own log line ({"event": "tape-mcp.call", …}, mcp/src/serve.ts logLine), when this event is one. */
export type CallLog = { requestId: string; tool: string; via: string; requests: number; sourceBytes: number };
export function callLogOf(e: unknown): CallLog | null {
  if (field(e, '$metadata', 'type') !== 'cf-worker') return null;
  const s = field(e, 'source');
  if (field(s, 'event') !== 'tape-mcp.call') return null;
  return {
    requestId: text(field(e, '$metadata', 'requestId')),
    tool: text(field(s, 'tool')) || text(field(s, 'mcp_method')) || '-',
    via: text(field(s, 'via')),
    requests: num(field(s, 'requests')),
    sourceBytes: num(field(s, 'source_bytes')),
  };
}

/** The nearest-rank percentile (p in 0..1) of the values: the smallest value at least p of them are at or below. */
export function pct(values: readonly number[], p: number): number {
  if (values.length === 0) return NaN;
  const s = values.toSorted((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] ?? NaN;
}

/** Rows grouped by key, each group's CPU and wall percentiles; sorted by route, then version. */
export type Group = {
  key: string[];
  n: number;
  cpu: [number, number, number];
  cpuSum: number;
  wall: [number, number, number];
};
export function grouped(rows: readonly Invocation[], keyOf: (r: Invocation) => string[]): Group[] {
  const by = new Map<string, { key: string[]; rows: Invocation[] }>();
  for (const r of rows) {
    const key = keyOf(r),
      k = JSON.stringify(key);
    const g = by.get(k) ?? { key, rows: [] };
    g.rows.push(r);
    by.set(k, g);
  }
  return [...by.values()]
    .map(({ key, rows: rs }): Group => {
      const cpu = rs.map(r => r.cpu),
        wall = rs.map(r => r.wall);
      return {
        key,
        n: rs.length,
        cpu: [pct(cpu, 0.5), pct(cpu, 0.9), pct(cpu, 0.99)],
        cpuSum: cpu.reduce((a, b) => a + b, 0),
        wall: [pct(wall, 0.5), pct(wall, 0.9), pct(wall, 0.99)],
      };
    })
    .toSorted((a, b) => a.key.join('\0').localeCompare(b.key.join('\0')));
}

/** One span event (`$metadata.type` span) of a trace. */
export type Span = {
  id: string;
  parent: string | null;
  name: string;
  start: number;
  ms: number;
  status: string;
  attributes: Record<string, unknown>;
};
/** Attributes every span carries (where it ran, what it is): left out of the tree's lines. */
const INFRA =
  /^(cloudflare\.(colo|script_name|script_version\.id|invocation\.sequence\.number|asn|verified_bot_category)|faas\.|cloud\.|telemetry\.|service\.|scope\.|geo\.|server\.|network\.|traceId$|spanId$|parentSpanId$|name$|startTime$|endTime$|durationMS$)/;
const flat = (v: unknown, p = '', out: Record<string, unknown> = {}): Record<string, unknown> => {
  if (typeof v === 'object' && v !== null && !Array.isArray(v))
    for (const [k, x] of Object.entries(v)) flat(x, `${p}${k}.`, out);
  else out[p.slice(0, -1)] = v;
  return out;
};
export function spanOf(e: unknown): Span | null {
  if (field(e, '$metadata', 'type') !== 'span') return null;
  const src = field(e, 'source');
  const parent = text(field(e, '$metadata', 'parentSpanId')) || text(field(src, 'parentSpanId'));
  const attributes = Object.fromEntries(
    Object.entries(flat(src)).filter(([k, v]) => !INFRA.test(k) && v !== undefined && v !== null),
  );
  return {
    id: text(field(e, '$metadata', 'spanId')) || text(field(src, 'spanId')),
    parent: parent === '' ? null : parent,
    name: text(field(src, 'name')),
    start: num(field(src, 'startTime')),
    ms: num(field(src, 'durationMS')),
    status: text(field(e, '$metadata', 'spanStatus')),
    attributes,
  };
}

/** The spans as an indented tree, children in start order; a span whose parent is not here is a root. */
export function treeLines(spans: readonly Span[], width = 70): string[] {
  const ids = new Set(spans.map(s => s.id));
  const kids = new Map<string | null, Span[]>();
  for (const s of spans) {
    const p = s.parent !== null && ids.has(s.parent) ? s.parent : null;
    kids.set(p, [...(kids.get(p) ?? []), s]);
  }
  const t0 = Math.min(...spans.map(s => s.start));
  const out: string[] = [];
  const seen = new Set<string>();
  const show = (s: Span, pre: string, branch: string, last: boolean): void => {
    if (seen.has(s.id)) return; // a cycle in bad data: each span once
    seen.add(s.id);
    const attrs = Object.entries(s.attributes)
      .map(([k, v]) => {
        const t = typeof v === 'string' ? v : JSON.stringify(v);
        return `${k}=${t.length > width ? `${t.slice(0, width)}…` : t}`;
      })
      .join('  ');
    out.push(
      `${pre}${branch}${s.name}  +${s.start - t0}ms ${s.ms}ms${s.status ? ` ${s.status}` : ''}${attrs ? `  ${attrs}` : ''}`,
    );
    const cs = (kids.get(s.id) ?? []).toSorted((a, b) => a.start - b.start);
    const next = branch === '' ? pre : pre + (last ? '   ' : '│  ');
    cs.forEach((c, i) => show(c, next, i === cs.length - 1 ? '└─ ' : '├─ ', i === cs.length - 1));
  };
  for (const r of (kids.get(null) ?? []).toSorted((a, b) => a.start - b.start)) show(r, '', '', true);
  return out;
}
