// telemetry.ts: the deploy's telemetry gate, from Workers Observability (cf o11y), for one version of the tape Worker.
//   node scripts/telemetry.ts <version-id> <since-ms> [--min <invocations>] [--prev <version-id>]
// Waits (up to ~2 min) until at least <min> fetch invocations of the version since <since-ms> are ingested, then
// fails on any invocation of it whose outcome is not ok, any response of 500 or more, and any error log, except a 503
// whose own invocation logged {"tape.stopped": reason} with a reason a deploy gives (the object was reset because
// its code was updated, or its connection was cut): an object moved to the new version stops what it was running.
// Also prints the Durable Object invocations in the window by version (with --prev: of the two versions), which
// shows which version the objects ran while the Worker was pinned or split.
// Needs CLOUDFLARE_ACCOUNT_ID; runs cf without CLOUDFLARE_API_TOKEN (the OAuth login).
import '../../node25.ts';
import { setTimeout as wait } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const [version = '', sinceArg = ''] = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const opt = (name: string): string | null => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? null : (args[i + 1] ?? null);
};
const min = Number(opt('min') ?? '5'),
  prev = opt('prev'),
  since = Number(sinceArg);
if (!/^[0-9a-f-]{36}$/.test(version) || !Number.isFinite(since)) {
  console.error('usage: node scripts/telemetry.ts <version-id> <since-ms> [--min <n>] [--prev <version-id>]');
  process.exit(2);
}
/** The reasons a deploy gives an object that stops: a 503 with one of these is expected, any other is a fault. */
const DEPLOY_RESET = /code was updated|reset because|Network connection lost|object was reset/i;

/** One row of the query, the fields the gate reads. */
type Ev = {
  type: string;
  level: string;
  message: string;
  requestId: string;
  outcome: string;
  entrypoint: string;
  eventType: string;
  model: string;
  version: string;
  method: string;
  url: string;
  status: number;
};
const field = (v: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((o, k) => (typeof o === 'object' && o !== null ? Reflect.get(o, k) : undefined), v);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const row = (r: unknown): Ev => ({
  type: text(field(r, '$metadata', 'type')),
  level: text(field(r, '$metadata', 'level')),
  message: text(field(r, '$metadata', 'message')),
  requestId: text(field(r, '$metadata', 'requestId')),
  outcome: text(field(r, '$workers', 'outcome')),
  entrypoint: text(field(r, '$workers', 'entrypoint')),
  eventType: text(field(r, '$workers', 'eventType')),
  model: text(field(r, '$workers', 'executionModel')),
  version: text(field(r, '$workers', 'scriptVersion', 'id')),
  method: text(field(r, '$workers', 'event', 'request', 'method')),
  url: text(field(r, '$workers', 'event', 'request', 'url')),
  status: Number(field(r, '$workers', 'event', 'response', 'status') ?? 0),
});
const env = { ...process.env };
delete env['CLOUDFLARE_API_TOKEN'];
const query = (filters: object[]): Ev[] => {
  const body = {
    queryId: 'adhoc',
    view: 'events',
    limit: 2000,
    timeframe: { from: since - 5000, to: Date.now() + 5000 },
    parameters: { filters: [{ key: '$metadata.service', operation: 'eq', type: 'string', value: 'tape' }, ...filters] },
  };
  for (let attempt = 1; ; attempt++) {
    try {
      const out = execFileSync('npx', ['cf', 'o11y', 'telemetry', 'query', '--body', JSON.stringify(body)], {
        env,
        encoding: 'utf8',
        maxBuffer: 256 << 20,
      });
      const list = field(JSON.parse(out), 'events', 'events');
      return Array.isArray(list) ? list.map(row) : [];
    } catch (e) {
      if (attempt >= 3) throw e;
    }
  }
};
const byVersion = [{ key: '$workers.scriptVersion.id', operation: 'eq', type: 'string', value: version }];
let evs: Ev[] = [];
const fetches = (): Ev[] => evs.filter(e => e.type === 'cf-worker-event' && e.model !== 'durableObject');
for (let i = 0; i < 12; i++) {
  evs = query(byVersion);
  if (fetches().length >= min) break;
  // oxlint-disable-next-line no-await-in-loop -- polling ingestion
  await wait(10_000);
}
const inv = evs.filter(e => e.type === 'cf-worker-event');
const stoppedIn = new Set(
  evs.filter(e => e.message.includes('"tape.stopped"') && DEPLOY_RESET.test(e.message)).map(e => e.requestId),
);
const expected = inv.filter(e => e.status === 503 && stoppedIn.has(e.requestId));
const notOk = inv.filter(e => e.outcome !== 'ok' && e.outcome !== 'canceled');
const s5 = inv.filter(e => e.status >= 500 && !expected.includes(e));
const errs = evs.filter(e => e.level === 'error');
const kinds = new Map<string, number>();
for (const e of inv) {
  const k = e.model === 'durableObject' ? `do:${e.eventType}` : e.entrypoint || 'default';
  kinds.set(k, (kinds.get(k) ?? 0) + 1);
}
console.log(
  `telemetry ${version}: ${inv.length} invocations (${[...kinds].map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}), ` +
    `${notOk.length} not ok, ${s5.length} unexpected 5xx, ${expected.length} expected 503 (stopped by the deploy), ${errs.length} error logs`,
);
for (const e of [...notOk, ...s5, ...errs].slice(0, 8))
  console.log(`  ${e.outcome} ${e.status} ${e.method} ${e.url.replace(/\?.*/, '')} ${e.message.slice(0, 200)}`);
if (prev !== null) {
  // which version the Durable Objects ran in the window: by the deployment's assignment, not the override header
  const dos = query([{ key: '$workers.executionModel', operation: 'eq', type: 'string', value: 'durableObject' }]);
  const n = (v: string): number => dos.filter(e => e.type === 'cf-worker-event' && e.version === v).length;
  console.log(`  durable object invocations in the window: new ${n(version)}, previous ${n(prev)}`);
}
const few = fetches().length < min;
if (few || notOk.length > 0 || s5.length > 0 || errs.length > 0) {
  console.log(few ? `FAIL: fewer than ${min} fetch invocations of ${version} ingested` : 'FAIL telemetry');
  process.exit(1);
}
console.log('telemetry ok');
