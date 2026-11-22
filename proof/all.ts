// proof/all.ts: every check in the repository, one after another, and one table at the end.
//   node proof/all.ts            everything (about twenty minutes on two cores)
//   node proof/all.ts --quick    without the service and mcp suites, the all-programs simulation and the planted bugs
//                                (the apps' planted bugs too)
//   node proof/all.ts --only sim a part whose name contains the word
// Exit 0 only when every row passed. A row passes when its command exits 0 and, where a number is recorded below
// (how many planted bugs are caught, and by what), the number is the one recorded: a check that quietly got weaker
// fails here as surely as one that broke.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { stripVTControlCharacters } from 'node:util';

const root = new URL('..', import.meta.url).pathname,
  node = process.execPath;
const quick = process.argv.includes('--quick'),
  at = process.argv.indexOf('--only'),
  only = at < 0 ? null : process.argv[at + 1];
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
type Part = readonly [name: string, cmd: string[] | null, expect?: Expect, cwd?: string];
const service: Part = existsSync(`${root}service/node_modules`)
  ? ['service suite (workerd)', ['npx', 'vitest', 'run'], /Tests\s+\d+ passed/, 'service']
  : ['service suite (workerd): SKIPPED, run npm ci in service/ first', null];
const mcpReady = existsSync(`${root}mcp/node_modules`);
const mcpSuite: Part = mcpReady
  ? [
      'mcp suite (workerd): tape-mcp with the real Loader and rate limiter',
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
  ],
  [
    'apps/highlight/test.ts --plants: 13 bugs planted in highlight.tape, each caught by its gate',
    [node, 'apps/highlight/test.ts', '--plants'],
    /^all 13 plants caught$/m,
  ],
  [
    'apps/trace/test.ts --plants: 38 bugs planted in trace.tape, each caught by its gate',
    [node, 'apps/trace/test.ts', '--plants'],
    s => (s.match(/^caught /gm) ?? []).length === 38 && !/^(MISSED|PLANT NOT FOUND)/m.test(s),
  ],
  [
    "apps/playground/test.ts --plants: 18 bugs planted in the playground's modules, each caught by its test",
    [node, 'apps/playground/test.ts', '--plants'],
    /^all 18 plants caught$/m,
  ],
  [
    'mcp/test.ts --plants: 31 bugs planted in tape-mcp, each caught by its test',
    [node, 'mcp/test.ts', '--plants'],
    /^all 31 plants caught$/m,
  ],
  service,
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
      ...tapes('apps/highlight'),
      ...tapes('apps/trace'),
      ...tapes('apps/trace/fixtures'),
      ...tapes('testdata/compare'),
    ],
  ],
  ...tests.map((t): Part => [t, [node, t]]),
  ['doc examples in std and examples', [node, 'tape.ts', 'test'], /\d+ examples, 0 failed/],
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
  ],
  // the benchmarks: the gate checks the answers, not the times (a time is one machine's, on one day)
  [
    'bench/csv.ts: csv.tape answers as the JavaScript beside it on 126 inputs',
    [node, 'bench/csv.ts'],
    /^126 inputs compared, 0 differ$/m,
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
    'apps/highlight/test.ts: highlight.tape against compiler/lex.ts, LANGUAGE.md and hand-written HTML',
    [node, 'apps/highlight/test.ts'],
    /^all 6 gates pass$/m,
  ],
  [
    "mcp/test.ts: tape-mcp's tools and HTTP face, in Node, against README.md and the playground's traces",
    [node, 'mcp/test.ts'],
    /^all 17 tests pass$/m,
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
function runPart([name, cmd, expect, cwd]: Part): Row {
  const [program, ...args] = cmd ?? [];
  if (program === undefined) return { name, ok: false, s: 0, note: 'not run' };
  const began = Date.now();
  const r = spawnSync(program, args, {
    cwd: root + (cwd ?? ''),
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    timeout: 30 * 60 * 1000,
    // Node 25 warns that node:sqlite is experimental; the warning is not a part's result, so it is left out
    env: {
      ...process.env,
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      NODE_OPTIONS: `${process.env['NODE_OPTIONS'] ?? ''} --disable-warning=ExperimentalWarning`.trim(),
    },
  });
  // colour codes are stripped before a recorded result is looked for: on a CI runner the service suite prints
  // its summary in colour, and the first run there failed for that alone
  const out = stripVTControlCharacters(`${r.stdout}${r.stderr}`);
  const said = expect === undefined || (typeof expect === 'function' ? expect(out) : expect.test(out));
  const failed = out.match(/^FAIL .*$/gm) ?? [];
  const ok = r.status === 0 && said && failed.length === 0;
  const row = {
    name,
    ok,
    s: Math.round((Date.now() - began) / 1000),
    note: ok ? '' : noteOf(r.status, r.signal, said, failed, out),
  };
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${String(row.s).padStart(4)} s  ${name}${ok ? '' : `\n            ${row.note}`}`,
  );
  // a failed part's last lines, so the log of a run somewhere else (CI) says why without a second run
  if (!ok)
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
const rows = parts.map(runPart);
const bad = rows.filter(r => !r.ok);
console.log(
  `\n${rows.length} parts, ${rows.length - bad.length} passed, ${bad.length} failed, ${rows.reduce((n, r) => n + r.s, 0)} s${quick ? ' (quick: the service and mcp suites, sim-all, sim-plants and the --plants runs of the apps were not run)' : ''}`,
);
for (const r of bad) console.log(`  FAILED: ${r.name}`);
process.exit(bad.length > 0 ? 1 : 0);
