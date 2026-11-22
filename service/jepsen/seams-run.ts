// node service/jepsen/seams-run.ts --base https://tape.ivar.workers.dev --token-file <path> --prefix jepsen-sp
//   [--kv 1,3] [--workflow] [--out dir]
// The fault-point enumeration (seams.ts: every fault at every position) against a deployed service: each KV shard count in --kv
// in a fresh account <prefix>kv<shards>, and with --workflow the five workflow programs in <prefix>wf. The token is
// read from the file and sent only in the authorization header; it is never printed. Each run's cases, history,
// final state and checker results go to <out>/<account>.json, its raw OTLP to <out>/<account>.traces.json; one
// summary line per run to stdout.
import { writeFileSync, mkdirSync } from 'node:fs';
import { faultable, flag, has, need, sources, tokenFromFile } from './cli.ts';
import { makeSender, stats as clientStats, RunnerError } from './client.ts';
import type { Sender } from './client.ts';
import { kvSeams, workflowSeams, coverage } from './seams.ts';
import type { Case } from './seams.ts';
import type { Anomaly } from './traces.ts';

const base = need('base'),
  token = tokenFromFile(),
  prefix = faultable(flag('prefix') ?? 'jepsen-sp'),
  out = flag('out') ?? '/tmp/jepsen-seams';
const sizes = (flag('kv') ?? '')
  .split(',')
  .filter(size => size !== '')
  .map(Number);
mkdirSync(out, { recursive: true });

// operations are sent once; the runner's own requests are resent on a broken connection (client.ts)
const kvSend = makeSender({ base, token });
const wfSend = (account: string): Sender =>
  makeSender({ base, token, route: path => (path === '/~faults' ? `/_faults/${account}` : `/${account}${path}`) });

/** What either enumeration came to. */
type Ran = {
  cases: Case[];
  counts?: unknown;
  result: { anomalies: readonly Anomaly[]; stats: unknown };
  tr: { anomalies: readonly Anomaly[]; stats: unknown };
  final: unknown;
  history: unknown;
  traces?: ReadonlyMap<string, unknown>;
};
let failed = 0;
const report = (account: string, r: Ran, began: number): void => {
  const anomalies = [...r.result.anomalies, ...r.tr.anomalies];
  writeFileSync(
    `${out}/${account}.json`,
    JSON.stringify(
      {
        account,
        cases: r.cases,
        coverage: coverage(r.cases),
        counts: r.counts ?? null,
        result: r.result,
        traces: r.tr,
        final: r.final,
        history: r.history,
      },
      null,
      1,
    ),
  );
  if (r.traces) writeFileSync(`${out}/${account}.traces.json`, JSON.stringify(Object.fromEntries(r.traces)));
  if (anomalies.length > 0) failed++;
  const cov = coverage(r.cases);
  console.log(
    JSON.stringify({
      account,
      ms: Date.now() - began,
      cases: r.cases.length,
      seams: Object.keys(cov).length,
      unfired: Object.entries(cov)
        .filter(([, c]) => c.fired < c.positions)
        .map(([s, c]) => `${s} ${c.fired}/${c.positions}`),
      anomalies: anomalies.map(a => a.type),
      stats: r.result.stats,
      trace_stats: r.tr.stats,
      client: { ...clientStats },
    }),
  );
};
// a runner request that failed every resend ends that run as a runner error (no verdict), never as an anomaly
const guarded = async (account: string, f: () => Promise<Ran>): Promise<void> => {
  const began = Date.now();
  try {
    report(account, await f(), began);
  } catch (e) {
    if (!(e instanceof RunnerError)) throw e;
    failed++;
    console.log(
      JSON.stringify({ account, ms: Date.now() - began, runner_error: e.message, client: { ...clientStats } }),
    );
  }
};
for (const shards of sizes) {
  const account = `${prefix}kv${shards}`;
  await guarded(account, () => kvSeams(kvSend, { account, cluster: 's', shards }));
}
if (has('workflow')) {
  const account = `${prefix}wf`;
  await guarded(account, () => workflowSeams(wfSend(account), sources()));
}
process.exit(failed > 0 ? 1 : 0);
