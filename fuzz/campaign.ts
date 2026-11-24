// fuzz/campaign.ts: every fuzz target, sharded across processes, for as long as it is given.
//   node fuzz/campaign.ts --seconds 3600 [--jobs 10] [--seed 1] [--targets programs,numbers,…] [--out <dir>]
// Each job runs one target's shard for a round (at most --round seconds, default 300), then the next round goes on
// with fresh seeds, so a long campaign covers new cases and a short one stops on time. The targets:
//   programs        fuzz/programs.ts: generated programs, the interpreter against six builds
//   budget          the same with a small step budget, so runs stop on steps at the same place in every build
//   tiers           the same programs under V8's --liftoff-only and --no-liftoff: each seed's digest of answers,
//                   steps and memory must be the default's
//   numbers         fuzz/numbers.ts: Dec against BigInt, parse_dec and parse_float against the definition
//   json            fuzz/json.ts: write_json and decode on random types against a reference
//   json-docs       test/json-fuzz.ts at a new seed each round: decode against the reference of random documents
//   compile         fuzz/compile.ts: mutated source never crashes the compiler or makes Wasm WebAssembly refuses
//   replay          fuzz/replay.ts: random requests to the examples, replayed from their logs, give the same bytes
//   sql             fuzz/sql.ts: random statements through the checker and the binder against node:sqlite
// A shard that prints nothing for --stall seconds (default 120) is killed and its last seed recorded as a hang.
// Every FINDING line goes to <out>/findings.txt with the target and the command that repeats it, and a summary of
// what ran (cases, CPU seconds) to <out>/summary.json. Exit 1 when anything was found.
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';

const argv = process.argv.slice(2);
const val = (n: string, d: string): string => {
  const i = argv.indexOf(n);
  return i < 0 ? d : (argv[i + 1] ?? d);
};
const SECONDS = Number(val('--seconds', '60')),
  JOBS = Number(val('--jobs', '10')),
  ROUND = Number(val('--round', '300')),
  STALL = Number(val('--stall', '120')),
  SEED = Number(val('--seed', String(Date.now() % 1_000_000_000))),
  OUT = val(
    '--out',
    `${process.env.TAPE_STATE ?? `${homedir()}/.local/state/tape`}/fuzz/${new Date().toISOString().slice(0, 19)}`,
  );
const ALL = ['programs', 'budget', 'tiers', 'numbers', 'json', 'json-docs', 'compile', 'replay', 'sql'];
const TARGETS = val('--targets', ALL.join(',')).split(',');
const node = process.execPath,
  root = new URL('..', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

type Job = { target: string; cmd: string[]; env?: Record<string, string> };
/** the command of one round of a target's shard */
function job(target: string, round: number, shard: number, shards: number, seconds: number): Job {
  // each round of each target starts its seeds far from every other round's
  const seed = SEED + round * 10_000_000;
  const common = ['--seconds', String(seconds), '--seed', String(seed), '--shard', `${shard}/${shards}`, '--progress'];
  switch (target) {
    case 'budget':
      return { target, cmd: [node, 'fuzz/programs.ts', ...common, '--budget'] };
    case 'json-docs':
      return { target, cmd: [node, 'test/json-fuzz.ts'], env: { FUZZ_SEED: String(seed + shard), FUZZ_N: '40000' } };
    case 'tiers':
      return { target, cmd: [node, 'fuzz/tiers.ts', ...common] };
    default:
      return { target, cmd: [node, `fuzz/${target}.ts`, ...common] };
  }
}

type Tally = { rounds: number; cpuMs: number; findings: number; cases: number; lines: string[] };
const tally = new Map<string, Tally>(TARGETS.map(t => [t, { rounds: 0, cpuMs: 0, findings: 0, cases: 0, lines: [] }]));
const end = Date.now() + SECONDS * 1000;
let round = 0,
  found = 0;
const record = (target: string, line: string, cmd: string[]): void => {
  found++;
  const t = tally.get(target);
  if (t) t.findings++;
  const entry = `${new Date().toISOString()} ${target}: ${line}\n    repeat: ${cmd.map(a => (a === node ? 'node' : a)).join(' ')}\n`;
  appendFileSync(`${OUT}/findings.txt`, entry);
  console.log(`FINDING ${target}: ${line.slice(0, 400)}`);
};

function runJob(j: Job): Promise<void> {
  return new Promise(done => {
    const started = process.cpuUsage();
    void started;
    const child = spawn(j.cmd[0] ?? node, j.cmd.slice(1), {
      cwd: root,
      env: { ...process.env, ...j.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let last = Date.now(),
      at = '',
      buffer = '',
      err = '';
    const t0 = Date.now();
    const watch = setInterval(() => {
      if (Date.now() - last > STALL * 1000) {
        record(j.target, `hang: no output for ${STALL} s after seed ${at}`, [...j.cmd.slice(0, 2), '--only', at]);
        child.kill('SIGKILL');
      }
    }, 5000);
    child.stdout.on('data', (d: Buffer) => {
      last = Date.now();
      buffer += d.toString();
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.startsWith('at ')) at = line.slice(3);
        else if (line.startsWith('FINDING') || line.startsWith('FAIL')) record(j.target, line, j.cmd);
        else if (/^[a-z-]+: \d/.test(line)) {
          const t = tally.get(j.target);
          t?.lines.push(line);
          // the first number of a target's last line is how many cases it ran
          if (t) t.cases += Number(/: (\d+)/.exec(line)?.[1] ?? 0);
        }
      }
    });
    child.stderr.on('data', (d: Buffer) => {
      last = Date.now();
      err += d.toString();
    });
    child.on('close', code => {
      clearInterval(watch);
      const t = tally.get(j.target);
      if (t) {
        t.rounds++;
        // a shard is one process on one core: its wall time is its CPU time to within the collector's threads
        t.cpuMs += Date.now() - t0;
      }
      if (code !== 0 && code !== null && !buffer.includes('FAIL'))
        record(
          j.target,
          `exited ${code}: ${err.split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 300)}`,
          j.cmd,
        );
      done();
    });
  });
}

async function main(): Promise<void> {
  console.log(`campaign: ${TARGETS.join(', ')}; ${JOBS} jobs for ${SECONDS} s from seed ${SEED}; findings in ${OUT}`);
  const slots = Array.from({ length: JOBS }, (_, i) => i);
  // the jobs are spread over the targets: job i runs target i mod the number of targets, shard i div it
  const shardsOf = (t: number): number =>
    Math.max(1, Math.floor(JOBS / TARGETS.length) + (t < JOBS % TARGETS.length ? 1 : 0));
  await Promise.all(
    slots.map(async i => {
      const ti = i % TARGETS.length,
        target = TARGETS[ti] ?? 'programs';
      const shards = shardsOf(ti),
        shard = Math.floor(i / TARGETS.length);
      for (let r = 0; Date.now() < end - 5000; r++) {
        const seconds = Math.min(ROUND, Math.floor((end - Date.now()) / 1000));
        if (seconds < 5) break;
        round = Math.max(round, r);
        await runJob(job(target, r, shard, shards, seconds));
      }
    }),
  );
  const summary = Object.fromEntries(
    [...tally].map(([t, v]) => [
      t,
      {
        rounds: v.rounds,
        cases: v.cases,
        cpu_hours: +(v.cpuMs / 3_600_000).toFixed(3),
        findings: v.findings,
        last: v.lines.slice(-3),
      },
    ]),
  );
  writeFileSync(`${OUT}/summary.json`, JSON.stringify(summary, null, 2));
  for (const [t, v] of Object.entries(summary))
    console.log(`${t}: ${v.cases} cases in ${v.rounds} rounds, ${v.cpu_hours} CPU h, ${v.findings} findings`);
  console.log(
    `campaign: ${found} findings, ${Object.values(summary)
      .reduce((a, v) => a + v.cpu_hours, 0)
      .toFixed(2)} CPU h`,
  );
  process.exit(found ? 1 : 0);
}
await main();
