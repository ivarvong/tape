// The local half of the parity runs (jepsen/parity.ts): the same workload in workerd, one record per
// seed printed as a line `PARITY <json>` (a test in workerd cannot write files). Runs only when PARITY_SEEDS is set.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { parityRun } from '../jepsen/parity.ts';
import { seedsIn, send } from './help.ts';

const seeds = seedsIn(env.PARITY_SEEDS);
describe.skipIf(seeds.length === 0)('parity: local half', () => {
  for (const seed of seeds)
    it(`seed ${seed}`, async () => {
      const r = await parityRun(send, { account: `jepsen-par${seed}`, seed });
      console.log(`PARITY ${JSON.stringify(r)}`);
      expect(r.ops.length).toBeGreaterThan(0);
    }, 300000);
});
