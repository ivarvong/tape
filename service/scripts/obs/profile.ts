// obs/profile.ts: a CPU (or heap) profile of one exact version of the tape Worker in prod, under load this script
// drives, then where the time went.
//   node scripts/obs/profile.ts <full version uuid> [--type cpu|heap] [--ms 10000] [--load hello|hello-lines|hello50|
//        fulfillment|kv|compile-hello|compile-kv] [--rps 0.7] [--runs 1]
//   node scripts/obs/profile.ts --read <file.pb> [...]     the summary of profiles taken already (summed)
// Underneath: `cf workers versions profile <uuid> --worker-id tape --profile-type cpu|heap --duration-ms N` (raw pprof
// on stdout). The capture needs an isolate executing when it lands ("No recent executions" otherwise), so the load
// starts 4 s before it and runs until it ends; it is retried 4 times. Load is 0.7 requests/s: the hosted routes
// allow 60 a minute per client. Each request says `user-agent: tape-obs-profile/<load>` (cpu.ts --ua picks them out).
// Files go to service/profiles/ (gitignored): <v8>-<type>-<load>-<time>.pb (raw), .sym.pb (unnamed frames named
// from the source), .load.txt. Then go tool pprof -top on it, and the hosted buckets (pprof.ts buckets()).
// What it cannot see: a program's run. Programs run in a Dynamic Worker (mcp/src/index.ts, LOADER), another isolate;
// this profile is the tape Worker's own: parsing, compiling, rendering the answer, the RPC.
// Needs CLOUDFLARE_ACCOUNT_ID; runs cf with the OAuth login.
import '../../../node25.ts';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as wait } from 'node:timers/promises';
import { BASE, cfBytesAsync, SERVICE, SERVICE_DIR } from './o11y.ts';
import { buckets, decode, nameAt, renamed } from './pprof.ts';
import type { Profile } from './pprof.ts';

const args = process.argv.slice(2);
const opt = (name: string, d: string): string => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? d : (args[i + 1] ?? d);
};
const ROOT = new URL('../../../', import.meta.url).pathname;
const src = (p: string): string => readFileSync(ROOT + p, 'utf8');

/** The loads: the route and the body each request posts. */
const many = (n: number): string[] => Array.from({ length: n }, (_, i) => `GET /hello/u${i % 7}`);
const file = (p: string): { name: string; text: string } => ({ name: p.split('/').pop() ?? p, text: src(p) });
const LOADS: Record<string, { path: string; body: () => unknown }> = {
  hello: { path: '/v1/run', body: () => ({ requests: ['GET /hello/ada'], trace: 'none' }) },
  'hello-lines': { path: '/v1/run', body: () => ({ requests: ['GET /hello/ada'] }) },
  hello50: { path: '/v1/run', body: () => ({ requests: many(50), trace: 'none' }) },
  fulfillment: {
    path: '/v1/run',
    body: () => ({ files: [file('examples/fulfillment.tape')], requests: ['POST /orders\n{}'], trace: 'none' }),
  },
  kv: { path: '/v1/run', body: () => ({ files: [file('examples/kv.tape')], requests: ['GET /'], trace: 'none' }) },
  'compile-hello': { path: '/v1/compile', body: () => ({ files: [file('examples/hello.tape')] }) },
  'compile-kv': { path: '/v1/compile', body: () => ({ files: [file('examples/kv.tape')] }) },
  'compile-fulfillment': { path: '/v1/compile', body: () => ({ files: [file('examples/fulfillment.tape')] }) },
};

/** Names an unnamed frame from the source at its definition line; paths in the bundle are relative to service/. */
const lines = new Map<string, string[]>();
const namer = (f: string, line: number): string | null => {
  if (!f.endsWith('.ts') || f.includes('node_modules')) return null;
  if (!lines.has(f))
    try {
      lines.set(f, readFileSync(SERVICE_DIR + f, 'utf8').split('\n'));
    } catch {
      lines.set(f, []);
    }
  const n = nameAt(lines.get(f) ?? [], line);
  return n === null ? null : `${f.split('/').pop()?.replace(/\.ts$/, '')}.${n}`;
};

function summary(ps: Profile[]): void {
  const by = new Map<string, number>();
  let total = 0,
    unit = '';
  for (const p of ps) {
    const b = buckets(p);
    unit = b.unit;
    total += b.total;
    for (const [k, v] of b.rows) by.set(k, (by.get(k) ?? 0) + v);
  }
  const scale = unit === 'nanoseconds' ? 1e6 : 1024;
  console.log(
    `\nwhere it went (${ps.length} profile${ps.length > 1 ? 's' : ''}, ${unit === 'nanoseconds' ? 'ms of samples' : 'KiB'})`,
  );
  for (const [k, v] of [...by].toSorted((a, b) => b[1] - a[1]))
    console.log(
      `  ${k.padEnd(40)} ${(v / scale).toFixed(0).padStart(7)}  ${((100 * v) / total).toFixed(1).padStart(5)}%`,
    );
}

if (args[0] === '--read') {
  const files = args.slice(1).filter(a => a.endsWith('.pb'));
  summary(files.map(f => decode(new Uint8Array(readFileSync(f)))));
  process.exit(0);
}

const version = args[0] ?? '';
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(version)) {
  console.error(
    'usage: node scripts/obs/profile.ts <full version uuid> [--type cpu|heap] [--ms N] [--load name] [--runs N]',
  );
  console.error('(the full uuid, not latest-deployed: a concurrent deploy could put the profile on another build)');
  process.exit(2);
}
const type = opt('type', 'cpu'),
  ms = Number(opt('ms', '10000')),
  loadName = opt('load', 'hello'),
  rps = Number(opt('rps', '0.7')),
  runs = Number(opt('runs', '1'));
const load = LOADS[loadName];
if (!load || (type !== 'cpu' && type !== 'heap')) {
  console.error(`--type cpu|heap; --load one of ${Object.keys(LOADS).join(', ')}`);
  process.exit(2);
}
const body = JSON.stringify(load.body());
const dir = `${SERVICE_DIR}profiles/`;
mkdirSync(dir, { recursive: true });

const taken: Profile[] = [];
for (let run = 1; run <= runs; run++) {
  const stamp = new Date().toISOString().replaceAll(/[-:]|\.\d+/g, '');
  const out = `${dir}${version.slice(0, 8)}-${type}-${loadName}-${stamp}`;
  const log: string[] = [];
  const pending: Promise<void>[] = [];
  /** One request of the load; its status, the version that answered and its time go to the load log. */
  const send = async (): Promise<void> => {
    const t = performance.now();
    try {
      const r = await fetch(BASE + load.path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': `tape-obs-profile/${loadName}`,
          'x-tape-synthetic': 'profile',
        },
        body,
      });
      await r.arrayBuffer();
      log.push(`${r.status} ${r.headers.get('tape-worker-version') ?? '-'} ${(performance.now() - t).toFixed(0)}ms`);
    } catch (e) {
      log.push(`error ${String(e)}`);
    }
  };
  const timer = setInterval(() => {
    pending.push(send());
  }, 1000 / rps);
  pending.push(send());
  await wait(4000);
  let pb: Buffer | null = null;
  for (let attempt = 1; attempt <= 4 && pb === null; attempt++) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- one capture at a time
      pb = await cfBytesAsync([
        'workers',
        'versions',
        'profile',
        version,
        '--worker-id',
        SERVICE,
        '--profile-type',
        type,
        '--duration-ms',
        String(ms),
      ]);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      console.error(`attempt ${attempt} failed: ${/\[\d+\][^\n│]*/.exec(why)?.[0] ?? why.slice(0, 200)}`);
      // oxlint-disable-next-line no-await-in-loop -- retry after a pause
      await wait(3000);
    }
  }
  clearInterval(timer);
  await Promise.all(pending);
  writeFileSync(`${out}.load.txt`, `${log.join('\n')}\n`);
  const statuses = new Map<string, number>();
  for (const l of log) statuses.set(l.split(' ')[0] ?? '', (statuses.get(l.split(' ')[0] ?? '') ?? 0) + 1);
  console.log(`load ${loadName}: ${[...statuses].map(([s, n]) => `${n}× ${s}`).join(', ')}`);
  if (pb === null) {
    console.error('profile failed after 4 attempts');
    process.exit(1);
  }
  writeFileSync(`${out}.pb`, pb);
  const r = renamed(new Uint8Array(pb), namer);
  writeFileSync(`${out}.sym.pb`, r.out);
  console.log(`profile: ${out}.pb (raw), ${out}.sym.pb (${r.n} unnamed frames named from the source)`);
  taken.push(decode(r.out));
  if (run === runs)
    try {
      const top = execFileSync('go', ['tool', 'pprof', '-top', '-lines', '-nodecount=25', `${out}.sym.pb`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      console.log(top.split('\n').slice(1, 34).join('\n'));
    } catch {
      console.log('(no go on PATH: go tool pprof -top shows the top)');
    }
}
summary(taken);
