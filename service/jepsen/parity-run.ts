// node service/jepsen/parity-run.ts --base <url> --token-file <path> --prefix jepsen-par --seeds 1-8 --out <file.jsonl>
// The parity workload (parity.ts) against a deployed service; one JSON record per seed to --out. The token is read
// from the file and sent only in the authorization header.
import { appendFileSync, writeFileSync } from 'node:fs';
import { faultable, flag, need, tokenFromFile } from './cli.ts';
import { sendOnce, stats as clientStats } from './client.ts';
import { parityRun } from './parity.ts';
import { seedsIn } from './seeds.ts';

const prefix = faultable(need('prefix')),
  out = need('out');
const send = sendOnce({ base: need('base'), token: tokenFromFile() });
writeFileSync(out, '');
for (const seed of seedsIn(flag('seeds') ?? '1')) {
  const r = await parityRun(send, { account: `${prefix}${seed}`, seed });
  appendFileSync(out, `${JSON.stringify({ ...r, clock_jumps: clientStats.clock_jumps.splice(0) })}\n`);
  console.log(JSON.stringify({ seed, ...r.verdicts, ops: r.ops.length, faults: r.faults.length }));
}
