// DUMP_SEEDS=236,237 DUMP_REPEAT=8 npx vitest run test/dump.test.ts --reporter=json --outputFile=<f>: run workflow
// seeds again and keep, in the test's meta, each run's anomalies and, for a failing run, its history and final state
// (for root-causing a seed; skipped unless DUMP_SEEDS is set)
import { env } from 'cloudflare:workers';
import { it } from 'vitest';
import { jepsen } from './jepsen-run.ts';
it.skipIf(env.DUMP_SEEDS === '')(
  'dump',
  async ({ task }) => {
    const runs: unknown[] = [];
    for (const s of env.DUMP_SEEDS.split(',')) {
      for (let k = 0; k < Number(env.DUMP_REPEAT); k++) {
        const r = await jepsen(Number(s), { tag: `d${k}` });
        const failed = r.anomalies.length > 0;
        runs.push({
          seed: s,
          k,
          anomalies: r.anomalies,
          trace_anomalies: r.traces.anomalies,
          history: failed ? r.history : undefined,
          final: failed ? r.final : { heal: r.final.heal, unreadable: r.final.unreadable },
        });
      }
    }
    task.meta.dump = runs;
  },
  3000000,
);
