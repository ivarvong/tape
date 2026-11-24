// proof/all.ts: every check in the repository, run side by side, and one table at the end.
//   node proof/all.ts            everything (a few minutes on sixteen cores; the parts' own times add to about ten)
//   node proof/all.ts --quick    without the service and mcp suites, the all-programs simulation and the planted bugs
//                                (the apps' planted bugs too)
//   node proof/all.ts --only sim a part whose name contains the word
//   --jobs <n>                   how many parts run at once (default: the machine's cores; --jobs 1 is one at a time)
//   --keep-going                 run every part even after one failed (the default stops at the first failure)
//   --changed                    only the parts whose inputs changed since the last passing gate (see below)
//   --no-lock                    run without the machine's gate lock (below)
// Exit 0 only when every row passed. A row passes when its command exits 0 and, where a number is recorded below
// (how many planted bugs are caught, and by what), the number is the one recorded: a check that quietly got weaker
// fails here as surely as one that broke.
// One gate at a time on a machine: a run first takes ~/.local/state/tape/gate.lock (proof/lock.ts; under TAPE_STATE
// when that is set), and a second run started meanwhile prints whose it is and waits. Several agents' gates at once
// drove the load past 30 and the fault-injection seams test failed for that alone. service/scripts/gate.sh runs this
// file, so it waits the same way. A lock whose process is gone is stale and taken.
// Order: the cheap parts (format, types, lint, the fix texts and the definition) run first, all at once, and a
// failure among them ends the run before anything slow starts; then the rest, longest first (by the times the last
// run recorded in proof/results/all-times.json), --jobs at a time. No two parts share mutable state: each writes
// its own proof/results/<name>.json, plants are made in fresh temporary directories, the two workerd suites keep
// their state under their own directories, and no part listens on a fixed port.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { availableParallelism, homedir } from 'node:os';
import { stripVTControlCharacters } from 'node:util';
import { acquire } from './lock.ts';

const root = new URL('..', import.meta.url).pathname,
  node = process.execPath;
const quick = process.argv.includes('--quick'),
  at = process.argv.indexOf('--only'),
  only = at < 0 ? null : process.argv[at + 1],
  jobsAt = process.argv.indexOf('--jobs'),
  jobs = Math.max(1, Number(jobsAt < 0 ? availableParallelism() : process.argv[jobsAt + 1]) || 1),
  keepGoing = process.argv.includes('--keep-going');
const tapes = (dir: string) =>
  readdirSync(root + dir)
    .filter(f => f.endsWith('.tape'))
    .map(f => `${dir}/${f}`);
const tests = readdirSync(root + 'test')
  .filter(f => f.endsWith('.ts') && !['harness.ts', 'fail-exit.ts'].includes(f))
  .toSorted()
  .map(f => `test/${f}`);

// name, command, and optionally `expect`: a pattern the output must contain (the recorded number)
type Expect = RegExp | ((out: string) => boolean);
type Part = readonly [name: string, cmd: string[] | null, expect?: Expect, cwd?: string | undefined, shards?: number];
// the service suite in two workerd runs side by side: the seams (the longest file) and every other file
const service: Part[] = existsSync(`${root}service/node_modules`)
  ? [
      [
        'service suite (workerd): test/seams.test.ts',
        ['npx', 'vitest', 'run', 'test/seams.test.ts'],
        /Tests\s+\d+ passed/,
        'service',
      ],
      [
        'service suite (workerd): every file but test/seams.test.ts',
        ['npx', 'vitest', 'run', '--exclude', 'test/seams.test.ts'],
        /Tests\s+\d+ passed/,
        'service',
      ],
    ]
  : [['service suite (workerd): SKIPPED, run npm ci in service/ first', null]];
const mcpReady = existsSync(`${root}mcp/node_modules`);
const mcpSuite: Part = mcpReady
  ? [
      'mcp suite (workerd): mcp/src, served by the tape Worker, with the real Loader and rate limiter',
      ['npx', 'vitest', 'run'],
      /Tests\s+\d+ passed/,
      'mcp',
    ]
  : ['mcp suite (workerd): SKIPPED, run npm ci in mcp/ first', null];
/** What --quick leaves out. */
const slow: Part[] = [
  // sim-all exits 1 on any finding but the one it expects (trap.tape); the number of programs is free to grow
  [
    'proof/sim-all.ts: every program with a handle, simulated; only trap.tape fails, on purpose',
    [node, 'proof/sim-all.ts', '--seeds', '150'],
    /0 safety, 0 liveness, 0 do not build, 0 simulator failures/,
    undefined,
    8,
  ],
  [
    'proof/sim-invariants.ts: a bug planted against each invariant: at least 28 of 34 caught by the invariant, the rest refused or recorded',
    [node, 'proof/sim-invariants.ts'],
    s => Number(/(\d+) caught by the invariant meant for it/.exec(s)?.[1] ?? 0) >= 28,
  ],
  [
    'proof/sim-plants.ts: planted bugs found from the programs alone: at least 37 of 49',
    [node, 'proof/sim-plants.ts', '--runs', '500'],
    s => Number(/found (\d+) from the programs alone/.exec(s)?.[1] ?? 0) >= 37,
    undefined,
    8,
  ],
  [
    'apps/highlight/test.ts --plants: 18 bugs planted in highlight.tape, each caught by its gate',
    [node, 'apps/highlight/test.ts', '--plants'],
    /^all 18 plants caught$/m,
  ],
  [
    'apps/trace/test.ts --plants: 39 bugs planted in trace.tape, each caught by its gate',
    [node, 'apps/trace/test.ts', '--plants'],
    s => (s.match(/^caught /gm) ?? []).length === 39 && !/^(MISSED|PLANT NOT FOUND)/m.test(s),
  ],
  [
    "apps/playground/test.ts --plants: 19 bugs planted in the playground's modules, each caught by its test",
    [node, 'apps/playground/test.ts', '--plants'],
    /^all 19 plants caught$/m,
    undefined,
    6,
  ],
  [
    'mcp/test.ts --plants: 50 bugs planted in tape-mcp, each caught by its test',
    [node, 'mcp/test.ts', '--plants'],
    /^all 50 plants caught$/m,
  ],
  ...service,
  mcpSuite,
];
const all: Part[] = [
  ['format: the toolchain is as prettier writes it', ['npx', 'prettier', '--check', '.']],
  ['types: every file not on proof/untyped.txt passes tsc under strict', ['npx', 'tsc', '--noEmit']],
  ['types: the service, against the Workers runtime types', ['npx', 'tsc', '--noEmit', '-p', 'service/tsconfig.json']],
  ...(mcpReady
    ? ([
        ["types: tape-mcp's Node side (its test, and the tools it runs)", ['npx', 'tsc', '--noEmit', '-p', 'mcp']],
        ['types: tape-mcp, against the Workers runtime types', ['npx', 'tsc', '--noEmit', '-p', 'mcp/test']],
      ] satisfies Part[])
    : [['types: tape-mcp: SKIPPED, run npm ci in mcp/ first', null] satisfies Part]),
  ["types: the playground, with the browser's types", ['npx', 'tsc', '--noEmit', '-p', 'apps/playground']],
  ["types: the service's build and deploy scripts", ['npx', 'tsc', '--noEmit', '-p', 'service/scripts']],
  ["types: the highlighter's page, with the browser's types", ['npx', 'tsc', '--noEmit', '-p', 'apps/highlight']],
  ['lint: every file not on proof/untyped.txt passes oxlint, type-aware', [node, 'proof/lint.ts']],
  [
    'format: every program is as the formatter writes it',
    [
      node,
      'tape.ts',
      'fmt',
      '--check',
      ...tapes('std'),
      ...tapes('examples'),
      ...tapes('examples/timed'),
      ...tapes('examples/tools'),
      ...tapes('apps/tickets'),
      ...tapes('apps/queue'),
      ...tapes('apps/products/pastebin'),
      ...tapes('apps/products/poll'),
      ...tapes('apps/products/countdown'),
      ...tapes('apps/products/ledger'),
      ...tapes('apps/products/status'),
      ...tapes('apps/highlight'),
      ...tapes('apps/trace'),
      ...tapes('apps/trace/fixtures'),
      ...tapes('testdata/compare'),
      'corpus/md.tape',
      'corpus/blog.tape',
    ],
  ],
  ...tests.map((t): Part => [t, [node, t]]),
  ['doc examples in std and examples', [node, 'tape.ts', 'test'], /\d+ examples, 0 failed/],
  [
    'docs/gen-std.ts --check: docs/std.md is current, every std function and type has a doc comment, every built-in an entry, every common task compiles',
    [node, 'docs/gen-std.ts', '--check'],
    /^docs\/std\.md is current/m,
  ],
  [
    'proof/verify.ts: the interpreter against three builds, and the rest of its table',
    [node, 'proof/verify.ts', '300'],
  ],
  ['proof/schedule.ts: every schedule of keyed calls', [node, 'proof/schedule.ts']],
  ['apps/tickets scenarios', [node, 'apps/tickets/scenarios.ts'], /\d+ checks, 0 failed/],
  [
    'apps/tickets planted bugs: 52, 43 by the compiler, 8 by the scenarios, 1 missed',
    [node, 'apps/tickets/plants.ts'],
    /52 plants: 43 by the compiler, 8 by the scenarios, 1 missed/,
  ],
  [
    'examples/timed planted bugs: 7 of 7 by the compiler',
    [node, 'experiments/c78/timed-mutants.ts'],
    s => (s.match(/^caught /gm) ?? []).length === 7 && !/^(MISSED|missed|wrong)/m.test(s),
  ],
  [
    'service/verify/plant/plant.ts --check: every bug planted in the service still matches the code it edits',
    [node, 'service/verify/plant/plant.ts', '--check'],
    / 0 edits do not match/,
  ],
  [
    'proof/sim-transcript.ts --check: the transcript the service is compared with is current',
    [node, 'proof/sim-transcript.ts', '--check'],
    /the transcript is current/,
  ],
  [
    'tape sim: tickets and pay, 300 guided runs, nothing wrong',
    [node, 'tape.ts', 'sim', 'apps/tickets/tickets.tape', 'apps/tickets/pay.tape', '--seeds', '300'],
    /ok\s+300 runs/,
  ],
  [
    'tape sim: tickets alone, pay stood in for, 300 runs',
    [node, 'tape.ts', 'sim', 'apps/tickets/tickets.tape', '--seeds', '300'],
    /ok\s+300 runs/,
  ],
  [
    'proof/interp-effects.ts: the compiled build and the reference interpreter ask for the same effects and answer the same bytes; four planted differences seen',
    [node, 'proof/interp-effects.ts', '--seeds', quick ? '2' : '6'],
    s =>
      / 0 differ$/m.test(s) &&
      !/MISSED/.test(s) &&
      Number(/^(\d+) of \d+ distinct runs agree/m.exec(s)?.[1] ?? 0) >= 500,
    undefined,
    8,
  ],
  // the benchmarks: the gate checks the answers, not the times (a time is one machine's, on one day)
  [
    'bench/csv.ts: csv.tape answers as the JavaScript beside it on 126 inputs',
    [node, 'bench/csv.ts'],
    /^126 inputs compared, 0 differ$/m,
  ],
  [
    'bench/md-scan.ts: the Markdown byte walks, per byte and as scan, agree with the byte loop',
    [node, 'bench/md-scan.ts'],
    /^[0-9]+ inputs compared, 0 differ$/m,
  ],
  [
    'bench/cart.ts: cart.tape answers as the JavaScript beside it on 267 bodies, carts and not',
    [node, 'bench/cart.ts'],
    /^267 inputs compared, 0 differ$/m,
  ],
  [
    'bench/hello.ts: hello.tape answers as the request by hand, with the log on and off',
    [node, 'bench/hello.ts'],
    /^204 requests answered three ways, 0 differ$/m,
  ],
  [
    'bench/blog.ts: the renderer and the blog, steps exactly and bytes within 2%, against bench/blog.json',
    [node, 'bench/blog.ts'],
    /the record matches/,
  ],
  [
    'bench/usability/transcript-test.ts: the usability bench counts refusals, rate limits and oversized results right',
    [node, 'bench/usability/transcript-test.ts'],
    /^all passed$/m,
  ],
  [
    'apps/highlight/test.ts: highlight.tape against compiler/lex.ts, LANGUAGE.md and hand-written HTML',
    [node, 'apps/highlight/test.ts'],
    /^all 6 gates pass$/m,
  ],
  [
    "mcp/test.ts: tape-mcp's tools and HTTP face, in Node, against README.md and the playground's traces",
    [node, 'mcp/test.ts'],
    /^all 27 tests pass$/m,
  ],
  [
    'apps/trace/test.ts: trace.tape against what the OTLP alone says the picture should show',
    [node, 'apps/trace/test.ts'],
  ],
  [
    "apps/playground/test.ts: the playground's logic and build, without a browser",
    [node, 'apps/playground/test.ts'],
    /^all 9 tests pass$/m,
  ],
  ...(quick ? [] : slow),
];
const parts = all.filter(p => only === null || only === undefined || p[0].includes(only));

type Row = { name: string; ok: boolean; s: number; note: string };
/** Why a part failed: its exit, the result that was not in its output, or its first FAIL line. */
function noteOf(
  status: number | null,
  signal: string | null,
  said: boolean,
  failed: readonly string[],
  out: string,
): string {
  const last = out.trim().split('\n').at(-1) ?? '';
  if (status !== 0) return `exit ${status ?? signal}: ${(failed[0] ?? last).slice(0, 140)}`;
  return said ? (failed[0] ?? '').slice(0, 140) : `the recorded result is not in the output: ${last.slice(0, 120)}`;
}
/** The cheap parts: they run first, together, and a failure among them stops the run within seconds. */
const cheap = (name: string): boolean =>
  /^(format|types|lint):/.test(name) || name === 'test/fix-texts.ts' || name === 'test/definition.ts';
const TIMES = `${root}proof/results/all-times.json`;
/** How long each part took the last time it passed (seconds), for longest-first; a part not seen yet goes first. */
const times: Record<string, number> = (() => {
  try {
    const v: unknown = JSON.parse(readFileSync(TIMES, 'utf8'));
    return typeof v === 'object' && v !== null
      ? Object.fromEntries(Object.entries(v).filter((e): e is [string, number] => typeof e[1] === 'number'))
      : {};
  } catch {
    return {};
  }
})();
type Child = ReturnType<typeof spawn>;
const children = new Set<Child>();
let stopping = false;
function kill(child: Child): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    // gone already
  }
}
function report(row: Row, out: string): Row {
  console.log(
    `${row.ok ? 'ok  ' : 'FAIL'} ${String(row.s).padStart(4)} s  ${row.name}${row.ok ? '' : `\n            ${row.note}`}`,
  );
  // a failed part's last lines, so the log of a run somewhere else (CI) says why without a second run
  if (out !== '')
    console.log(
      out
        .trim()
        .split('\n')
        .slice(-40)
        .map(l => `            | ${l.slice(0, 300)}`)
        .join('\n'),
    );
  return row;
}
type Ran = { status: number | null; signal: string | null; out: string };
/** One command, in its own process group, so a stopped run takes its children (vitest's workerd) with it. */
function exec(program: string, args: readonly string[], cwd: string | undefined): Promise<Ran> {
  return new Promise(done => {
    const child = spawn(program, args, {
      cwd: root + (cwd ?? ''),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Node 25 warns that node:sqlite is experimental; the warning is not a part's result, so it is left out
      env: {
        ...process.env,
        NO_COLOR: '1',
        FORCE_COLOR: '0',
        NODE_OPTIONS: `${process.env['NODE_OPTIONS'] ?? ''} --disable-warning=ExperimentalWarning`.trim(),
      },
    });
    children.add(child);
    const chunks: Buffer[] = [];
    child.stdout?.on('data', (b: Buffer) => {
      chunks.push(b);
    });
    child.stderr?.on('data', (b: Buffer) => {
      chunks.push(b);
    });
    const timer = setTimeout(() => kill(child), 30 * 60 * 1000);
    child.on('close', (status: number | null, signal: string | null) => {
      clearTimeout(timer);
      children.delete(child);
      // colour codes are stripped before a recorded result is looked for: on a CI runner the service suite prints
      // its summary in colour, and the first run there failed for that alone
      done({ status, signal, out: stripVTControlCharacters(Buffer.concat(chunks).toString('utf8')) });
    });
  });
}
/** A part; a sharded one runs `<cmd> --shard i/n` for each i side by side, then `<cmd> --merge n`, which prints
 * (and records) what one run of the whole would, and is what the part's recorded result is looked for in. */
async function runPart([name, cmd, expect, cwd, shards = 1]: Part): Promise<Row> {
  const [program, ...args] = cmd ?? [];
  if (program === undefined) return report({ name, ok: false, s: 0, note: 'not run' }, '');
  const began = Date.now();
  let r: Ran;
  if (shards > 1) {
    const ran = await Promise.all(
      Array.from({ length: shards }, (_, i) => exec(program, [...args, '--shard', `${i}/${shards}`], cwd)),
    );
    const bad = ran.find(p => p.status !== 0);
    const merged = bad ?? (await exec(program, [...args, '--merge', String(shards)], cwd));
    r = { ...merged, out: `${ran.map(p => p.out).join('')}${bad ? '' : merged.out}` };
  } else r = await exec(program, args, cwd);
  const said = expect === undefined || (typeof expect === 'function' ? expect(r.out) : expect.test(r.out));
  const failed = r.out.match(/^FAIL .*$/gm) ?? [];
  const ok = r.status === 0 && said && failed.length === 0;
  if (ok) times[name] = (Date.now() - began) / 1000;
  const stopped = !ok && stopping && r.signal !== null;
  const note = ok ? '' : stopped ? 'stopped: another part failed' : noteOf(r.status, r.signal, said, failed, r.out);
  return report({ name, ok, s: Math.round((Date.now() - began) / 1000), note }, ok || stopped ? '' : r.out);
}
/** Runs the parts, `width` at a time, in the order given; after a failure (without --keep-going) it starts no more
 * and stops the ones running. The rows come back in the parts' order. */
async function pool(list: readonly Part[], width: number): Promise<Row[]> {
  const rows: Row[] = [];
  let next = 0;
  const lane = async (): Promise<void> => {
    for (let i = next++; i < list.length; i = next++) {
      const part = list[i];
      if (part === undefined) return;
      if (stopping) {
        rows[i] = { name: part[0], ok: false, s: 0, note: 'not run: another part failed' };
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- a lane runs its parts one after another
      const row = await runPart(part);
      rows[i] = row;
      if (!row.ok && !keepGoing && !stopping) {
        stopping = true;
        for (const c of children) kill(c);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, list.length) }, lane));
  return rows;
}
// --changed (npm run check:changed): only the parts whose inputs changed since the newest passing gate record
// (~/.local/state/tape/gate/<sha>, service/scripts/gate.sh) that is an ancestor of HEAD: the commits since, the
// working tree and the untracked files. For iteration only: it writes no gate record, and a deploy needs one.
// A change to anything that is not one part's own (the compiler, the host, std, the examples, the simulator, the
// interpreter, the CLI, testdata, the shared proof code, the dependencies: anything outside the directories below)
// runs every part. Otherwise a part runs when a changed file is under its home (the service suite: service/; mcp:
// mcp/; an app's test: its app; a test or proof script: the file itself) or its home's TypeScript names the changed
// file; the playground is built into the service's site and read by tape-mcp's tests, so a change there runs both.
// The cheap parts always run.
const LOCAL = /^(service|mcp|apps\/[^/]+|bench|test|proof|docs|\.github)\/|^[^/]+\.md$/;
const SHARED = /^proof\/lib\.ts$|^test\/harness\.ts$|\.tape$/;
function changedSince(): { base: string; files: string[] } | null {
  const sh = (args: string[]): string[] =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter(l => l !== '');
  const dir = `${process.env['TAPE_STATE'] ?? `${homedir()}/.local/state/tape`}/gate`;
  const records = existsSync(dir) ? readdirSync(dir).filter(f => /^[0-9a-f]{40}$/.test(f)) : [];
  const passing = records
    .map(sha => ({ sha, text: readFileSync(`${dir}/${sha}`, 'utf8') }))
    .filter(r => / passed, 0 failed,/.test(r.text))
    .filter(r => spawnSync('git', ['merge-base', '--is-ancestor', r.sha, 'HEAD'], { cwd: root }).status === 0)
    .map(r => ({ sha: r.sha, at: /^at (.*)$/m.exec(r.text)?.[1] ?? '' }))
    .toSorted((a, b) => b.at.localeCompare(a.at));
  const [newest] = passing;
  if (newest === undefined) return null;
  return {
    base: newest.sha,
    files: [
      ...new Set([...sh(['diff', '--name-only', newest.sha]), ...sh(['ls-files', '--others', '--exclude-standard'])]),
    ],
  };
}
/** The files a part is about: its home directory, or its script alone. */
function homeOf([, cmd, , cwd]: Part): string | null {
  if (cwd !== undefined) return `${cwd}/`;
  const script = (cmd ?? []).find(a => a.endsWith('.ts') && a !== 'tape.ts');
  if (script === undefined) return null;
  if (/^apps\/[^/]+\//.test(script)) return /^apps\/[^/]+\//.exec(script)?.[0] ?? null;
  if (script.startsWith('mcp/')) return 'mcp/';
  if (script.startsWith('service/')) return 'service/';
  if (script.startsWith('bench/')) return 'bench/';
  return script;
}
const sourcesOf = (home: string): string =>
  home.endsWith('/')
    ? readdirSync(root + home, { recursive: true, withFileTypes: true })
        .filter(e => e.isFile() && e.name.endsWith('.ts') && !e.parentPath.includes('node_modules'))
        .map(e => readFileSync(`${e.parentPath}/${e.name}`, 'utf8'))
        .join('\n')
    : readFileSync(root + home, 'utf8');
function selectChanged(list: readonly Part[]): Part[] {
  const got = changedSince();
  if (got === null) {
    console.log('--changed: no passing gate record is an ancestor of HEAD: every part runs');
    return [...list];
  }
  const { base, files } = got;
  const core = files.filter(f => !LOCAL.test(f) || SHARED.test(f));
  console.log(`--changed: ${files.length} files changed since the gate passed at ${base.slice(0, 12)}`);
  if (core.length > 0) {
    console.log(
      `--changed: ${core.slice(0, 5).join(', ')}${core.length > 5 ? ', ...' : ''} is shared: every part runs`,
    );
    return [...list];
  }
  const keep = list.filter(p => {
    if (cheap(p[0])) return true;
    const home = homeOf(p);
    if (home === null) return true;
    const homes = files.some(f => f.startsWith('apps/playground/')) && (home === 'service/' || home === 'mcp/');
    if (homes || files.some(f => f === home || f.startsWith(home))) return true;
    const text = sourcesOf(home);
    return files.some(f => text.includes(f.split('/').pop() ?? f));
  });
  console.log(`--changed: ${keep.length} of ${list.length} parts run; left out: ${list.length - keep.length}`);
  return keep;
}
const chosen = process.argv.includes('--changed') ? selectChanged(parts) : parts;
if (!process.argv.includes('--no-lock')) {
  const release = await acquire();
  // a run stopped by a signal lets go of the lock (and stops its parts) instead of leaving it to look stale
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const)
    process.on(signal, () => {
      for (const c of children) kill(c);
      release();
      process.exit(128 + (signal === 'SIGINT' ? 2 : signal === 'SIGTERM' ? 15 : 1));
    });
}
const wallStart = Date.now();
const first = chosen.filter(p => cheap(p[0])),
  rest = chosen.filter(p => !cheap(p[0])).toSorted((a, b) => (times[b[0]] ?? 1e9) - (times[a[0]] ?? 1e9));
console.log(
  `${chosen.length} parts, ${jobs} at a time: ${first.length} cheap ones first, then ${rest.length}, longest first`,
);
const rows = [...(await pool(first, Math.max(jobs, first.length))), ...(await pool(rest, jobs))];
try {
  mkdirSync(`${root}proof/results`, { recursive: true });
  writeFileSync(TIMES, `${JSON.stringify(times, null, 1)}\n`);
} catch {
  // the times only order the next run
}
const bad = rows.filter(r => !r.ok);
const why = (r: Row): string => (/^(not run|stopped)/.test(r.note) ? ` (${r.note})` : '');
console.log(
  `\n${rows.length} parts, ${rows.length - bad.length} passed, ${bad.length} failed, ${rows.reduce((n, r) => n + r.s, 0)} s of parts in ${Math.round((Date.now() - wallStart) / 1000)} s wall (--jobs ${jobs})${quick ? ' (quick: the service and mcp suites, sim-all, sim-plants and the --plants runs of the apps were not run)' : ''}`,
);
for (const r of bad) console.log(`  FAILED: ${r.name}${why(r)}`);
process.exit(bad.length > 0 ? 1 : 0);
