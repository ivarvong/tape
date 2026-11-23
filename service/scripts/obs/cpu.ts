// obs/cpu.ts: CPU and wall p50/p90/p99 per (version, route, status) from prod invocation events. The A/B tool.
//   node scripts/obs/cpu.ts [--minutes 30] [--from ISO --to ISO] [--version <id prefix>] [--route /v1/run] [--ua <prefix>]
//        [--json out.json]
// Routes: /, /mcp, /v1/compile, /v1/run, /v1/test, /v1/feedback, /playground, /mcp/:account, /p/:account/…,
// /t/:account/…, /:account/:program…, and a Durable Object's invocation as `DO Name.<methods>`. A hosted call is
// joined to its own log line (tape-mcp.call) by request id, so /mcp is split by tool (`/mcp run`) and --ua picks out
// one client (a profile.ts run's user agent). The view returns at most 1,000 rows a query: --from/--to is read in
// slices small enough to be complete (one slice at the cap is split in two).
// Needs CLOUDFLARE_ACCOUNT_ID; runs cf with the OAuth login.
import '../../../node25.ts';
import { writeFileSync } from 'node:fs';
import { callLogOf, eq, field, grouped, invocationOf, lastMinutes, query, startsWith, BASE } from './o11y.ts';
import type { CallLog, Filter, Invocation } from './o11y.ts';

const args = process.argv.slice(2);
const opt = (name: string): string | null => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? null : (args[i + 1] ?? null);
};
const iso = (s: string): number => {
  const t = Date.parse(s);
  if (!Number.isFinite(t)) throw new TypeError(`not a time: ${s}`);
  return t;
};
const from = opt('from'),
  to = opt('to');
const window = from && to ? { from: iso(from), to: iso(to) } : lastMinutes(Number(opt('minutes') ?? '30'));
const version = opt('version'),
  route = opt('route'),
  ua = opt('ua');

/** Every event of the window that matches: slices, each one split again while it comes back at the cap. */
function all(filters: Filter[]): unknown[] {
  const out: unknown[] = [];
  const todo: [number, number][] = [];
  for (let t = window.from; t < window.to; t += 5 * 60_000) todo.push([t, Math.min(window.to, t + 5 * 60_000)]);
  for (let s = todo.shift(); s; s = todo.shift()) {
    const [a, b] = s;
    const got = query(filters, { from: a, to: b });
    if (got.length >= 1000 && b - a > 100) {
      const m = Math.floor((a + b) / 2);
      todo.unshift([a, m], [m, b]);
    } else out.push(...got);
  }
  // an event on a slice's edge can come twice: the whole metadata is its identity ($metadata.id is not unique)
  const seen = new Set<string>();
  return out.filter(e => {
    const k = JSON.stringify(field(e, '$metadata'));
    return seen.has(k) ? false : (seen.add(k), true);
  });
}

const base: Filter[] = version ? [startsWith('$workers.scriptVersion.id', version)] : [];
const urlFilter: Filter[] =
  route?.startsWith('/') && !route.includes(':') ? [startsWith('$workers.event.request.url', BASE + route)] : [];
const inv = all([...base, ...urlFilter, eq('$metadata.type', 'cf-worker-event')])
  .map(invocationOf)
  .filter((r): r is Invocation => r !== null);
// the hosted calls' log lines, for the tool and the client of each /mcp and /v1 call
const hosted = inv.some(r => r.route === '/mcp' || r.route.startsWith('/v1/'));
const logs = new Map<string, CallLog & { ua: string }>();
if (hosted)
  for (const e of all([...base, eq('$metadata.type', 'cf-worker'), eq('event', 'tape-mcp.call')])) {
    const c = callLogOf(e);
    const agent = field(e, 'source', 'user_agent');
    if (c) logs.set(c.requestId, { ...c, ua: typeof agent === 'string' ? agent : '' });
  }
const rows = inv
  .map(r => {
    const c = logs.get(r.requestId);
    const named = r.route === '/mcp' && c ? `/mcp ${c.tool}` : r.route;
    // a call answered from the compile cache is a route of its own: the hit rate, and what a hit costs
    return { ...r, route: c?.cached === true ? `${named} cached` : named, ua: c?.ua ?? null, call: c ?? null };
  })
  .filter(r => !route || r.route === route || r.route.startsWith(`${route} `))
  .filter(r => !ua || (r.ua ?? '').startsWith(ua));

if (opt('json')) writeFileSync(opt('json') ?? '', JSON.stringify(rows, null, 1));
const groups = grouped(rows, r => [r.route, r.version.slice(0, 8), String(r.status ?? '-')]);
const pad = (s: string | number, n: number): string => String(s).padStart(n);
console.log(
  `${'route'.padEnd(22)} ${'version'.padEnd(8)} ${'st'.padStart(4)} ${'n'.padStart(5)}  ${'cpu p50'.padStart(7)} ${'p90'.padStart(5)} ${'p99'.padStart(5)} ${'cpu sum'.padStart(8)}  ${'wall p50'.padStart(8)} ${'p90'.padStart(5)} ${'p99'.padStart(5)}`,
);
for (const g of groups) {
  const [r = '', v = '', st = ''] = g.key;
  console.log(
    `${r.padEnd(22)} ${v.padEnd(8)} ${pad(st, 4)} ${pad(g.n, 5)}  ${pad(g.cpu[0], 7)} ${pad(g.cpu[1], 5)} ${pad(g.cpu[2], 5)} ${pad(g.cpuSum, 8)}  ${pad(g.wall[0], 8)} ${pad(g.wall[1], 5)} ${pad(g.wall[2], 5)}`,
  );
}
console.error(
  `${rows.length} invocations, ${new Date(window.from).toISOString()} to ${new Date(window.to).toISOString()} (ms; cpu is the invocation's cpuTimeMs)`,
);
