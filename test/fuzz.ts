// A short fixed-seed slice of every fuzz campaign in fuzz/ (the campaigns themselves run for hours, outside the
// gate: node fuzz/campaign.ts --seconds 3600). Each slice is a fixed set of seeds, so the gate runs the same cases
// every time: the program differential (and with a small step budget, and under V8's tiers), Dec and Float against
// their references, write_json and decode on random types, mutated source through the compiler, replay of
// simulated and changed requests, and random SQL against node:sqlite. A slice passes when it finds nothing and ran
// as many cases as it was given.
import '../node25.ts';
import { execFileSync } from 'node:child_process';
import { finish, ok } from './harness.ts';

const root = new URL('..', import.meta.url).pathname;
const SLICES: [target: string, args: string[], ran: RegExp][] = [
  ['programs.ts', ['--count', '12'], /^programs: 12 programs, 12 agree/m],
  ['programs.ts', ['--count', '8', '--budget'], /^programs: 8 programs, 8 agree/m],
  ['tiers.ts', ['--count', '6'], /^tiers: 6 programs under three tiers, 0 differ/m],
  ['numbers.ts', ['--count', '8'], /^numbers: [1-9]\d+ cases, 0 findings/m],
  ['json.ts', ['--count', '6'], /^json: 6 types, 96 documents, 0 findings/m],
  ['compile.ts', ['--count', '150'], /^compile: 150 cases, 0 findings/m],
  ['replay.ts', ['--count', '2'], /^replay: [1-9]\d+ runs replayed through 4 builds, 0 findings/m],
  ['sql.ts', ['--count', '12'], /^sql: [1-9]\d* statements, [1-9]\d* runs against SQLite, 0 findings/m],
];
for (const [target, args, ran] of SLICES) {
  let out: string;
  try {
    out = execFileSync(process.execPath, [`fuzz/${target}`, '--seed', '1', '--seconds', '600', ...args], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (e) {
    out = e instanceof Error && 'stdout' in e && typeof e.stdout === 'string' ? e.stdout : String(e);
  }
  const found = out.split('\n').filter(l => l.startsWith('FINDING'));
  const last = out.trim().split('\n').at(-1) ?? '';
  ok(`fuzz/${target} ${args.join(' ')}: ${last}`, found.length === 0 && ran.test(out), found.slice(0, 3).join(' | '));
}
finish();
