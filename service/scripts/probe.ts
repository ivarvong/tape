// probe.ts: synthetic traffic through a ramp step, unpinned, as a visitor would send it.
//   node scripts/probe.ts <base-url> <seconds> [--rps <n>] [--new <version-id>] [--prev <version-id>] [--sha <sha>]
// Sends <rps> requests a second (default 5) for <seconds>, in turn: the homepage (200), an API path without a token
// (401) and a public route nobody published (404, which asks the list of published names, a Durable Object). Every
// answer of the new version (the Worker's tape-worker-version is --new; a static file's tape-version is --sha) must be
// the status it should be, with nosniff; an answer of the previous version (which may predate the site and answer
// the homepage 401) must not be a 5xx. Prints the count by version (the new version's share is what the step
// routed) and exits 1 on any wrong answer, a network error, or a Worker version that is neither --new nor --prev.
import '../../node25.ts';
import { setTimeout as wait } from 'node:timers/promises';

const args = process.argv.slice(2);
const [baseArg = '', secondsArg = ''] = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const opt = (name: string): string | null => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? null : (args[i + 1] ?? null);
};
const base = baseArg.replace(/\/$/, ''),
  seconds = Number(secondsArg),
  rps = Number(opt('rps') ?? '5'),
  next = opt('new'),
  prev = opt('prev'),
  sha = opt('sha');
if (!/^https?:\/\//.test(base) || !(seconds > 0) || !(rps > 0)) {
  console.error('usage: node scripts/probe.ts <base-url> <seconds> [--rps <n>] [--new <id>] [--prev <id>]');
  process.exit(2);
}
const calls = [
  { path: '/', status: 200, worker: false },
  { path: '/ivar/hello', status: 401, worker: true },
  { path: '/p/nobody-probe/x', status: 404, worker: true },
] as const;
const versions = new Map<string, number>(),
  wrong: string[] = [];
let sent = 0,
  answered = 0;
const one = async (i: number): Promise<void> => {
  const c = calls[i % calls.length] ?? calls[0];
  sent++;
  try {
    const r = await fetch(`${base}${c.path}`, {
      redirect: 'manual',
      headers: { 'x-tape-synthetic': 'deploy-probe' },
      signal: AbortSignal.timeout(10_000),
    });
    await r.arrayBuffer();
    answered++;
    // which version answered: the Worker names its version; a static file names only its commit
    const v = c.worker
      ? (r.headers.get('tape-worker-version') ?? 'none')
      : r.headers.get('tape-version') === sha && sha !== null
        ? (next ?? 'new')
        : 'previous';
    versions.set(v, (versions.get(v) ?? 0) + 1);
    if (v === next || (next === null && sha === null)) {
      if (r.status !== c.status) wrong.push(`${c.path}: ${r.status}`);
      if (r.headers.get('x-content-type-options') !== 'nosniff') wrong.push(`${c.path}: no nosniff`);
    } else if (r.status >= 500) wrong.push(`${c.path}: ${r.status} from the previous version`);
    if (c.worker && next !== null && v !== next && v !== 'none' && v !== prev) wrong.push(`${c.path}: version ${v}`);
  } catch (e) {
    wrong.push(`${c.path}: ${e instanceof Error ? e.message : String(e)}`);
  }
};
const started = Date.now(),
  pending: Promise<void>[] = [];
for (let i = 0; Date.now() - started < seconds * 1000; i++) {
  // oxlint-disable-next-line unicorn/prefer-top-level-await -- the requests overlap; each is awaited below
  pending.push(one(i));
  // oxlint-disable-next-line no-await-in-loop -- requests are paced, not batched
  await wait(1000 / rps);
}
await Promise.all(pending);
const total = [...versions.values()].reduce((a, b) => a + b, 0);
const share = next === null || total === 0 ? null : (versions.get(next) ?? 0) / total;
// the version before this pipeline has no tape-worker-version header: counted as "none"; a static file not of --sha
// as "previous"
console.log(
  `probe ${seconds}s at ${rps}/s: ${answered}/${sent} answered, ${wrong.length} wrong; answers by version: ${[
    ...versions,
  ]
    .map(([v, n]) => `${v === next ? 'new' : v === prev ? 'previous' : v} ${n}`)
    .join(', ')}${share === null ? '' : `; new share ${(share * 100).toFixed(1)}%`}`,
);
for (const w of wrong.slice(0, 10)) console.log(`  ${w}`);
if (wrong.length > 0) {
  console.log('FAIL probe');
  process.exit(1);
}
console.log('probe ok');
