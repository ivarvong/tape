// obs/public.ts: where the time of public requests (/p/:account/:name/…) goes, cold and warm, from prod traces.
//   node scripts/obs/public.ts [--minutes 30] [--from ISO --to ISO] [--path /p/demo/] [--version <id prefix>]
//        [--limit 300] [--rows]
// For each request: when the Worker had the answer, the call to the list of published names, how long the call to
// the name's object took to reach its first line, the object's CPU and wall, and its call to its data (the run, and
// its log made durable). A request is cold when the object was a new instance (o11y.ts publicTimes): an object
// idle for about 30 s is evicted, and every object is after a deploy. Prints p50 and p95 by Worker version, cold
// and warm; --rows prints each request too. `reach` compares two machines' clocks and can read a few ms negative.
// One query a request (its trace), so a few seconds per ten requests.
// Needs CLOUDFLARE_ACCOUNT_ID; runs cf with the OAuth login.
import '../../../node25.ts';
import { BASE, eq, invocationOf, lastMinutes, pct, publicTimes, query, spanOf, startsWith } from './o11y.ts';
import type { Invocation, PublicTimes, Span } from './o11y.ts';

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
const path = opt('path') ?? '/p/',
  version = opt('version'),
  limit = Number(opt('limit') ?? '300');
if (!path.startsWith('/p/') || !(limit > 0)) {
  console.error(
    'usage: node scripts/obs/public.ts [--minutes N | --from ISO --to ISO] [--path /p/…] [--version <id>] [--limit N] [--rows]',
  );
  process.exit(2);
}
const requests = query(
  [
    eq('$metadata.type', 'cf-worker-event'),
    startsWith('$workers.event.request.url', BASE + path),
    ...(version ? [startsWith('$workers.scriptVersion.id', version)] : []),
  ],
  window,
  1000,
)
  .map(invocationOf)
  .filter((r): r is Invocation => r !== null && r.model !== 'durableObject')
  .toSorted((a, b) => a.at - b.at)
  .slice(-limit);
type Row = PublicTimes & { request: Invocation };
const rows: Row[] = requests.map(request => {
  const events = query([eq('$metadata.traceId', request.traceId)], window, 1000);
  return {
    request,
    ...publicTimes(
      events.map(spanOf).filter((s): s is Span => s !== null),
      events.map(invocationOf).filter((i): i is Invocation => i !== null),
    ),
  };
});
const pad = (v: string | number | null, n: number): string => String(v ?? '-').padStart(n);
const COLUMNS = ['answer', 'wall', 'list', 'reach', 'objectCpu', 'objectWall', 'data'] as const;
const LABEL = {
  answer: 'answer',
  wall: 'wall',
  list: 'list',
  reach: 'reach',
  objectCpu: 'obj cpu',
  objectWall: 'obj wall',
  data: 'data',
};
const value = (r: Row, c: (typeof COLUMNS)[number]): number | null => (c === 'wall' ? r.request.wall : r[c]);
if (args.includes('--rows')) {
  console.log(`${'time'.padEnd(12)} ${'version'.padEnd(8)}  st ${COLUMNS.map(c => pad(LABEL[c], 10)).join(' ')}  path`);
  for (const r of rows)
    console.log(
      `${new Date(r.request.at).toISOString().slice(11, 23)} ${r.request.version.slice(0, 8)} ${pad(r.request.status, 3)} ${COLUMNS.map(c => pad(value(r, c), 10)).join(' ')}  ${r.started ? 'COLD ' : ''}${new URL(r.request.url).pathname}  ${r.request.traceId}`,
    );
  console.log('');
}
console.log(
  `${'version'.padEnd(8)} ${'kind'.padEnd(4)} ${pad('n', 4)}  ${COLUMNS.map(c => pad(`${LABEL[c]} p50`, 14) + pad('p95', 5)).join('')}`,
);
const groups = new Map<string, Row[]>();
// a request that was not run (404, 405, 413) has no call to the name's object: left out of the percentiles
for (const r of rows.filter(x => x.answer !== null)) {
  const k = `${r.request.version.slice(0, 8)} ${r.started ? 'cold' : 'warm'}`;
  groups.set(k, [...(groups.get(k) ?? []), r]);
}
for (const [k, g] of [...groups].toSorted((a, b) => a[0].localeCompare(b[0]))) {
  const cells = COLUMNS.map(c => {
    const v = g.map(r => value(r, c)).filter((x): x is number => x !== null);
    return pad(v.length > 0 ? pct(v, 0.5) : null, 14) + pad(v.length > 0 ? pct(v, 0.95) : null, 5);
  });
  console.log(`${k.padEnd(13)} ${pad(g.length, 4)}  ${cells.join('')}`);
}
console.error(
  `${rows.length} requests under ${path}, ${new Date(window.from).toISOString()} to ${new Date(window.to).toISOString()} (ms; cold: the name's object was a new instance)`,
);
