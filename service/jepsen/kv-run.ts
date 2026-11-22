// node service/jepsen/kv-run.ts --base https://tape.ivar.workers.dev --token-file <path> --prefix jepsen-kvp --seeds 1-8
//   [--out dir]
// Every seed runs kv.js CONFIG, the config the local runs use: only the seed changes (and the shard count,
// 1 + seed % 4). There are no flags to change it, so a seed here is the same run as that seed locally.
// The KV Jepsen workload (kv.js) against a deployed service: one fresh account per seed (<prefix><seed>), one
// cluster in it. The token is read from the file and sent only in the authorization header; it is never printed.
// Each run's history, final reads, result and trace-checker result go to <out>/<account>.json, the raw OTLP of every
// operation to <out>/<account>.traces.json; one summary line per seed to stdout. Every operation carries its own
// traceparent; after the run its trace is fetched and checked (traces.ts, kv.js checkTraces).
import { writeFileSync, mkdirSync } from 'node:fs';
import { counted, faultable, flag, need, refuse, tokenFromFile } from './cli.ts';
// the clock watchdog of R-CLIENT-2 (it starts on import): a run during which the box was paused or restored is marked
import { sendOnce, stats as clientStats } from './client.ts';
import { at, list, text } from './json.ts';
import { setup, load, heal, check, logical, collectTraces, checkTraces, CONFIG } from './kv.ts';
import { seedsIn } from './seeds.ts';

const prefix = faultable(flag('prefix') ?? 'jepsen-kvp'),
  out = flag('out') ?? '/tmp/jepsen-kv';
refuse(['shards', 'clients', 'ops', 'keys', 'retries', 'no-faults', 'no-client-faults'], 'kv.js CONFIG');
const { clients, ops, keys, retries, plan, clientFaults, tail } = CONFIG;
mkdirSync(out, { recursive: true });

// A request that gets no answer is recorded as unknown (info), which the checker allows for; an odd-numbered client
// resends it under the same op id (?op=), and the service must apply it at most once.
const send = sendOnce({ base: need('base'), token: tokenFromFile() });

let failed = 0;
for (const seed of seedsIn(flag('seeds') ?? '1')) {
  const account = `${prefix}${seed}`,
    cluster = 'j',
    began = Date.now(),
    shards = CONFIG.shards(seed);
  await setup(send, { account, cluster, shards, seed, plan, tail });
  const { history, keys: names } = await load(send, {
    account,
    cluster,
    seed,
    clients,
    ops,
    keys,
    retries,
    clientFaults,
  });
  const faults = list(at((await send('GET', `/_faults/${account}`)).body, 'faults'));
  const final = await heal(send, { account, cluster, keys: names }),
    result = check(logical(history), final);
  const traces = await collectTraces(send, { account, cluster, history }),
    tr = checkTraces(history, final, traces, { account, cluster, shards });
  const kinds = counted(faults.map(f => text(at(f, 'kind')))),
    cf = counted(history.flatMap(h => (h.client_fault === undefined ? [] : [h.client_fault])));
  writeFileSync(
    `${out}/${account}.json`,
    JSON.stringify(
      {
        account,
        seed,
        shards,
        clients,
        ops,
        keys,
        retries: 'odd clients 2, even 0',
        faults: kinds,
        client_faults: cf,
        result,
        traces: tr,
        final,
        history,
      },
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
      shards,
      ms: Date.now() - began,
      valid: result.valid,
      anomalies: result.anomalies.map(a => a.type),
      faults: faults.length,
      kinds,
      client_faults: cf,
      stats: result.stats,
      traces_valid: tr.valid,
      trace_anomalies: [...new Set(tr.anomalies.map(a => a.type))],
      trace_stats: tr.stats,
      client: { clock_jumps: clientStats.clock_jumps.splice(0) },
    }),
  );
}
process.exit(failed > 0 ? 1 : 0);
