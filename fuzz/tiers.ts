// fuzz/tiers.ts: the program differential's seeds under each of V8's Wasm tiers. A batch of seeds is run three
// times, in this process (V8's default: Liftoff, then TurboFan for what is hot) and in two children, one under
// --liftoff-only and one under --no-liftoff (TurboFan from the first call); each prints a digest of every answer,
// trap, step count and memory figure of every seed (fuzz/programs.ts --digest), and the three must be the same.
//   node fuzz/tiers.ts --seconds 60 [--seed 1] [--shard 0/8]
import { execFileSync } from 'node:child_process';
import { check, inputsOf } from './programs.ts';
import { parts } from './gen.ts';
import { cli } from './run.ts';

const c = cli(),
  BATCH = Math.min(12, c.count);
const progress = process.argv.includes('--progress');
const end = Date.now() + c.seconds * 1000;
let seeds = 0,
  bad = 0;
const digestsOf = (flags: string[], first: number, count: number): Map<string, string> => {
  const out = execFileSync(
    process.execPath,
    [
      ...flags,
      'fuzz/programs.ts',
      '--digest',
      '--seed',
      String(first),
      '--shard',
      `0/${c.shards}`,
      '--count',
      String(count),
      '--seconds',
      '100000',
    ],
    { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8', maxBuffer: 1 << 26 },
  );
  return new Map([...out.matchAll(/^digest (\d+) (\w+)$/gm)].map(m => [m[1] ?? '', m[2] ?? '']));
};
for (let b = 0; Date.now() < end && b * BATCH < c.count; b++) {
  const first = c.seed + c.shard + b * BATCH * c.shards;
  if (progress) console.log(`at ${first}`);
  const here = new Map<string, string>();
  for (let i = 0; i < BATCH; i++) {
    const seed = first + i * c.shards;
    const { text, entries } = parts(seed, 1 + (seed % 3));
    const v = check(text, inputsOf(seed), {}, entries);
    if (v.kind === 'ok') here.set(String(seed), v.digest);
  }
  for (const flags of [['--liftoff-only'], ['--no-liftoff']]) {
    const there = digestsOf(flags, first, BATCH);
    for (const [seed, d] of here)
      if (there.get(seed) !== d) {
        bad++;
        console.log(`FINDING tiers seed=${seed}: default ${d}, ${flags.join(' ')} ${there.get(seed) ?? 'none'}`);
      }
  }
  seeds += here.size;
}
console.log(`tiers: ${seeds} programs under three tiers, ${bad} differ`);
