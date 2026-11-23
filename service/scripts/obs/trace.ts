// obs/trace.ts: one prod request: its invocation (version, status, CPU, wall, outcome) and its span tree.
//   node scripts/obs/trace.ts <trace id> [--minutes 60]
//   node scripts/obs/trace.ts --latest /v1/run [--minutes 60]     the newest request to that path
// Spans exist only with Workers traces on (observability.traces in cloudflare.config.ts); without them this prints
// the invocation and its logs. A trace is queryable ~10-30 s after the request.
// Needs CLOUDFLARE_ACCOUNT_ID; runs cf with the OAuth login.
import '../../../node25.ts';
import { BASE, eq, field, invocationOf, lastMinutes, query, spanOf, startsWith, treeLines } from './o11y.ts';
import type { Invocation, Span } from './o11y.ts';

const args = process.argv.slice(2);
const opt = (name: string): string | null => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? null : (args[i + 1] ?? null);
};
const window = lastMinutes(Number(opt('minutes') ?? '60'));
let trace = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')) ?? '';
const latest = opt('latest');
if (latest) {
  const inv = query(
    [eq('$metadata.type', 'cf-worker-event'), startsWith('$workers.event.request.url', BASE + latest)],
    window,
    200,
  )
    .map(invocationOf)
    .filter((r): r is Invocation => r !== null && new URL(r.url).pathname === latest);
  const newest = inv.toSorted((a, b) => b.at - a.at)[0];
  if (!newest) throw new Error(`no request to ${latest} in the window`);
  trace = newest.traceId;
}
if (!/^[0-9a-f]{32}$/.test(trace)) {
  console.error('usage: node scripts/obs/trace.ts <trace id> | --latest <path> [--minutes N]');
  process.exit(2);
}
const evs = query([eq('$metadata.traceId', trace)], window, 1000);
if (evs.length === 0) throw new Error(`trace ${trace} not found (ingest lags ~10-30 s)`);
console.log(`trace ${trace}`);
for (const r of evs
  .map(invocationOf)
  .filter((x): x is Invocation => x !== null)
  .toSorted((a, b) => a.at - b.at))
  console.log(
    `${r.model === 'durableObject' ? r.route : `${r.method} ${r.url}`}  version ${r.version.slice(0, 8)}  status ${r.status ?? '-'}  cpu ${r.cpu} ms  wall ${r.wall} ms  ${r.outcome}`,
  );
const spans = evs.map(spanOf).filter((s): s is Span => s !== null);
console.log(spans.length > 0 ? `\nspans (${spans.length})` : '\nno spans: traces are off for this version');
for (const l of treeLines(spans)) console.log(`  ${l}`);
const logs = evs.filter(e => field(e, '$metadata', 'type') === 'cf-worker');
if (logs.length > 0) console.log(`\nlogs (${logs.length})`);
for (const e of logs) console.log(`  ${JSON.stringify(field(e, 'source')).slice(0, 400)}`);
