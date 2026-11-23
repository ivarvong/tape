// Every fault at every position (jepsen/seams.ts), in workerd: the KV router's hop and the
// client's, then the workflow's router hop and its calls between programs. Each case's result goes to the JSON
// reporter (task.meta.seams); the test fails on any anomaly, and on a seam that no position reached.
import { describe, it } from 'vitest';
import tickets from '../../examples/tickets.tape?raw';
import payments from '../../examples/payments.tape?raw';
import inventory from '../../examples/inventory.tape?raw';
import shipping from '../../examples/shipping.tape?raw';
import fulfillment from '../../examples/fulfillment.tape?raw';
import { kvSeams, workflowSeams, coverage } from '../jepsen/seams.ts';
import type { Anomaly } from '../jepsen/traces.ts';
import type { Case } from '../jepsen/seams.ts';
import { roomy, send } from './help.ts';
import { sender } from './jepsen-run.ts';
import { env } from 'cloudflare:workers';

/** How many slices the workflow's cases run in (SEAMS_SLICES, default 6). */
const SLICES = Math.max(1, Math.trunc(Number(env.SEAMS_SLICES)) || 6);

type Ran = {
  cases: readonly Case[];
  result: { anomalies: readonly Anomaly[]; stats: unknown };
  tr: { anomalies: readonly Anomaly[]; stats: unknown };
};
const summary = (r: Ran): Record<string, unknown> => ({
  coverage: coverage(r.cases),
  anomalies: [...r.result.anomalies, ...r.tr.anomalies].slice(0, 20),
  stats: r.result.stats,
  traces: r.tr.stats,
  cases: r.cases.map(c => [c.hop, c.kind, c.n, c.fired, c.anomalies ?? []]),
});

// The three runs are on accounts of their own, so they run side by side (describe.concurrent; each asserts with its own
// expect).
describe.concurrent('seams: every fault kind at every position, one per run', () => {
  for (const shards of [1, 3])
    it(`KV, ${shards} shard(s): linearizable, every trace complete`, async ({ task, expect }) => {
      const r = await kvSeams(send, { account: `jepsen-seamkv${shards}`, cluster: 's', shards });
      task.meta.seams = summary(r);
      expect([...r.result.anomalies, ...r.tr.anomalies]).toEqual([]);
      // every router seam fired at every position (the KV script has one router call per attempt)
      for (const [seam, c] of Object.entries(coverage(r.cases))) expect([seam, c.fired]).toEqual([seam, c.positions]);
    }, 600000);
  // The workflow's cases run in SLICES slices side by side, each on its own account (its own objects and fault
  // plan, counted by its own base run), one client each: the slices are every case, and what is asserted of the
  // whole run is asserted of their union. Side by side because a case mostly waits (deadlines, retries), not computes.
  it('the workflow: conserved, each order linearizable, every trace complete', async ({ task, expect }) => {
    const of = SLICES;
    const runs = await Promise.all(
      Array.from({ length: of }, (_, i) =>
        workflowSeams(
          sender(of === 1 ? 'jepsen-seamwf' : `jepsen-seamwf${i}`),
          // roomy: the base run's buy answers in its budget however loaded the machine, so every slice counts the same
          // positions; the buy's timeouts come from the faults injected at it (race, drop, lost), not from the load
          { tickets: roomy(tickets), payments, inventory, shipping, fulfillment },
          { slice: [i, of] },
        ),
      ),
    );
    const cases = runs.flatMap(r => r.cases),
      anomalies = runs.flatMap(r => [...r.result.anomalies, ...r.tr.anomalies]);
    task.meta.seams = {
      counts: runs.map(r => r.counts),
      coverage: coverage(cases),
      anomalies: anomalies.slice(0, 20),
      stats: runs.map(r => r.result.stats),
      traces: runs.map(r => r.tr.stats),
      cases: cases.map(c => [c.hop, c.kind, c.n, c.fired, c.anomalies ?? []]),
    };
    // each slice counted the same positions: the slices are of one run
    for (const r of runs) expect(r.counts).toEqual(runs[0]?.counts);
    expect(anomalies).toEqual([]);
    for (const [seam, c] of Object.entries(coverage(cases))) expect([seam, c.fired > 0]).toEqual([seam, true]);
  }, 900000);
});
