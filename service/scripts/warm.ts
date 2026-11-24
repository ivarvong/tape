// warm.ts: one request to each published name's page after a deploy, so no visitor is the one who starts its object.
//   node scripts/warm.ts <base-url> <rebuild.json> [--max <n>] [--concurrency <n>] [--timeout-ms <n>]
// A deploy restarts every Durable Object, and the first request to a name then starts its object and loads its
// data's code again: p50 509 ms, p95 832 ms in the Worker on prod (n=82), against p50 69 ms warm (n=122; tape
// 0936bbf2, 24 November 2026, scripts/obs/public.ts). <rebuild.json> is what POST /_rebuild answered (ship.sh's rebuild.out): its
// `published` lists every published account/name. Each gets one GET of /p/<account>/<name>/, as a visitor would
// send it (so the program runs, and records the request, as for any visit), at most --max names (200),
// --concurrency at a time (4), each given --timeout-ms (10,000). Whatever a name answers, its object has started:
// only a network error or a timeout is a failure, and no failure fails the deploy. Prints one line, always exits 0.
// It spares only the visitors of the first seconds: a name stays warm while it is used, and on prod an object idle
// for 30 s or more (30, 50, 75, 100 s) was started again by the next request; one idle for 15 s was not.
import '../../node25.ts';
import { readFileSync } from 'node:fs';
import { pct } from './obs/o11y.ts';

const args = process.argv.slice(2);
const [baseArg = '', file = ''] = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const opt = (name: string, otherwise: number): number => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? otherwise : Number(args[i + 1]);
};
const base = baseArg.replace(/\/$/, ''),
  max = opt('max', 200),
  concurrency = opt('concurrency', 4),
  timeoutMs = opt('timeout-ms', 10_000);
if (!/^https?:\/\//.test(base) || file === '' || !(max > 0) || !(concurrency > 0) || !(timeoutMs > 0)) {
  console.error(
    'usage: node scripts/warm.ts <base-url> <rebuild.json> [--max <n>] [--concurrency <n>] [--timeout-ms <n>]',
  );
  process.exit(2);
}
const KEY = /^[a-z0-9][a-z0-9_-]{0,63}\/[a-z0-9][a-z0-9_-]{0,63}$/;
let listed: string[] = [];
try {
  const answer: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const published: unknown = typeof answer === 'object' && answer !== null ? Reflect.get(answer, 'published') : null;
  if (!Array.isArray(published)) throw new TypeError('it has no `published` list (a Worker from before warm.ts?)');
  listed = published.filter((k): k is string => typeof k === 'string' && KEY.test(k));
} catch (e) {
  console.log(`warm: skipped, ${file} could not be read: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(0);
}
const names = listed.slice(0, max);
type Warmed = { name: string; ms: number; status: number | null; error?: string };
const done: Warmed[] = [];
const one = async (name: string): Promise<void> => {
  const t = performance.now();
  try {
    const r = await fetch(`${base}/p/${name}/`, {
      redirect: 'manual',
      headers: { 'x-tape-synthetic': 'deploy-warm' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    await r.arrayBuffer();
    done.push({ name, ms: performance.now() - t, status: r.status });
  } catch (e) {
    done.push({ name, ms: performance.now() - t, status: null, error: e instanceof Error ? e.message : String(e) });
  }
};
let next = 0;
const worker = async (): Promise<void> => {
  // oxlint-disable-next-line no-await-in-loop -- each worker sends one request at a time
  for (let i = next++; i < names.length; i = next++) await one(names[i] ?? '');
};
await Promise.all(Array.from({ length: Math.min(concurrency, names.length) }, worker));
const answered = done.filter(d => d.status !== null),
  failed = done.filter(d => d.status === null),
  ms = answered.map(d => Math.round(d.ms)),
  statuses = new Map<number, number>();
for (const d of answered) if (d.status !== null) statuses.set(d.status, (statuses.get(d.status) ?? 0) + 1);
const slowest = answered.toSorted((a, b) => b.ms - a.ms)[0];
console.log(
  `warm: ${names.length} of ${listed.length} published names, ${answered.length} answered (${
    [...statuses]
      .toSorted((a, b) => a[0] - b[0])
      .map(([s, n]) => `${s}: ${n}`)
      .join(', ') || 'none'
  }), ${failed.length} failed${
    failed.length > 0
      ? ` (${failed
          .slice(0, 3)
          .map(d => `${d.name}: ${d.error ?? ''}`)
          .join('; ')})`
      : ''
  }${
    slowest
      ? `; first request p50 ${pct(ms, 0.5)} ms, p95 ${pct(ms, 0.95)} ms, slowest ${slowest.name} ${Math.round(slowest.ms)} ms`
      : ''
  }`,
);
