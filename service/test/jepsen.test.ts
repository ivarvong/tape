// Jepsen-style runs in workerd: concurrent clients on the box office and the fulfillment workflow, with faults
// and long-tail delays on the call path (src/faults.ts), then a heal and a check (jepsen/harness.ts).
import { describe, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { seedsIn } from './help.ts';
import { jepsen } from './jepsen-run.ts';
export { sender, jepsen } from './jepsen-run.ts';

// JEPSEN_SEEDS=1-64 npx vitest run test/jepsen.test.ts; the default is a short run. Every seed runs harness.ts CONFIG.
const SEEDS = seedsIn(env.JEPSEN_SEEDS);
// Each seed is an account of its own (jepsen-run.ts), so the seeds run side by side (describe.concurrent).
describe.concurrent(
  'jepsen: faults and long-tail delays on every call, concurrent clients, retries racing originals',
  () => {
    for (const seed of SEEDS)
      it(`seed ${seed}: money, stock, seats and labels conserved; each order linearizable`, async ({
        task,
        expect,
      }) => {
        const r = await jepsen(seed);
        task.meta.jepsen = {
          seed,
          stats: r.stats,
          heal: r.final.heal,
          unreadable: r.final.unreadable,
          anomalies: r.anomalies.slice(0, 20),
          traces: r.traces.stats,
          trace_anomalies: r.traces.anomalies.slice(0, 20),
        }; // in --reporter=json output
        expect(r.anomalies).toEqual([]);
        expect(r.traces.anomalies).toEqual([]);
        expect(r.traces.stats.traced + (r.traces.stats.absent_told ?? 0)).toBe(r.traces.stats.ops);
      }, 300000);
  },
);
