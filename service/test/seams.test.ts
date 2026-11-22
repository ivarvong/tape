// Every fault at every position (jepsen/seams.ts), in workerd: the KV router's hop and the
// client's, then the workflow's router hop and its calls between programs. Each case's result goes to the JSON
// reporter (task.meta.seams); the test fails on any anomaly, and on a seam that no position reached.
import { describe, expect, it } from 'vitest';
import tickets from '../../examples/tickets.tape?raw';
import payments from '../../examples/payments.tape?raw';
import inventory from '../../examples/inventory.tape?raw';
import shipping from '../../examples/shipping.tape?raw';
import fulfillment from '../../examples/fulfillment.tape?raw';
import { kvSeams, workflowSeams, coverage } from '../jepsen/seams.ts';
import type { Anomaly } from '../jepsen/traces.ts';
import type { Case } from '../jepsen/seams.ts';
import { send } from './help.ts';
import { sender } from './jepsen-run.ts';

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

describe('seams: every fault kind at every position, one per run', () => {
  for (const shards of [1, 3])
    it(`KV, ${shards} shard(s): linearizable, every trace complete`, async ({ task }) => {
      const r = await kvSeams(send, { account: `jepsen-seamkv${shards}`, cluster: 's', shards });
      task.meta.seams = summary(r);
      expect([...r.result.anomalies, ...r.tr.anomalies]).toEqual([]);
      // every router seam fired at every position (the KV script has one router call per attempt)
      for (const [seam, c] of Object.entries(coverage(r.cases))) expect([seam, c.fired]).toEqual([seam, c.positions]);
    }, 600000);
  it('the workflow: conserved, each order linearizable, every trace complete', async ({ task }) => {
    const r = await workflowSeams(sender('jepsen-seamwf'), { tickets, payments, inventory, shipping, fulfillment });
    task.meta.seams = { counts: r.counts, ...summary(r) };
    expect([...r.result.anomalies, ...r.tr.anomalies]).toEqual([]);
    for (const [seam, c] of Object.entries(coverage(r.cases))) expect([seam, c.fired > 0]).toEqual([seam, true]);
  }, 900000);
});
