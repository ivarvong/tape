// node service/jepsen/run.ts --base https://tape.ivar.workers.dev --token-file <path> --prefix jepsen-p --seeds 1-4
//   [--out dir]
// Every seed runs harness.ts CONFIG, the config the local runs use; there are no flags to change it.
// The harness (harness.ts) against a deployed service, one fresh account per seed (<prefix><seed>). The token is
// read from the file and sent only in the authorization header; it is never printed. Each run's history, final
// state, result and trace-checker result are written to <out>/<account>.json (raw OTLP per operation to
// <out>/<account>.traces.json); one summary line per seed goes to stdout.
import { writeFileSync, mkdirSync } from 'node:fs';
import { faultable, flag, need, refuse, removeAccounts, sources, tokenFromFile } from './cli.ts';
import { makeSender, stats as clientStats } from './client.ts';
import type { Sender } from './client.ts';
import { setup, load, heal, check, collectTraces, checkTraces, CONFIG } from './harness.ts';
import { at } from './json.ts';
import { seedsIn } from './seeds.ts';

const base = need('base'),
  token = tokenFromFile(),
  prefix = faultable(flag('prefix') ?? 'jepsen-p'),
  out = flag('out') ?? '/tmp/jepsen';
refuse(['clients', 'ops', 'no-faults'], 'harness.ts CONFIG');
const { clients, ops, plan, tail, router } = CONFIG;
const programs = sources();
mkdirSync(out, { recursive: true });

// operations are sent once, reads included (a resent read was a second router root under one client span); the
// runner's own requests are resent on a broken connection (client.ts)
const sender = (account: string): Sender =>
  makeSender({ base, token, route: path => (path === '/~faults' ? `/_faults/${account}` : `/${account}${path}`) });

let failed = 0;
const made: string[] = [];
for (const seed of seedsIn(flag('seeds') ?? '1')) {
  const account = `${prefix}${seed}`,
    send = sender(account),
    began = Date.now();
  made.push(account);
  const set = await setup(send, programs, { seed, plan, tail, router });
  const history = await load(send, { seed, clients, ops });
  const final = await heal(send),
    result = check(history, final);
  const traces = await collectTraces(send, history),
    tr = checkTraces(history, final, traces);
  writeFileSync(
    `${out}/${account}.json`,
    JSON.stringify(
      { account, seed, clients, ops, plan: at(set.body, 'plan') ?? null, result, traces: tr, final, history },
      null,
      1,
    ),
  );
  writeFileSync(`${out}/${account}.traces.json`, JSON.stringify(Object.fromEntries(traces)));
  if (!result.valid || !tr.valid) failed++;
  console.log(
    JSON.stringify({
      account,
      seed,
      ms: Date.now() - began,
      valid: result.valid,
      anomalies: result.anomalies.map(a => a.type),
      stats: result.stats,
      traces_valid: tr.valid,
      trace_anomalies: [...new Set(tr.anomalies.map(a => a.type))],
      trace_stats: tr.stats,
      client: { ...clientStats },
    }),
  );
}
await removeAccounts(base, made);
process.exit(failed > 0 ? 1 : 0);
