// bench/usability/run.ts: the usability benchmark. For each task, a fresh agent (the `claude` CLI, headless) gets the
// task's spec, Tape's public docs and the live MCP server's three tools, and nothing else: no repository, no shell,
// no web. It writes a program; the program is then graded by the task's hidden acceptance requests (accept/*.ts)
// through prod's own `run`. What is recorded per task: wall time and tool calls to the first program that compiled,
// compile attempts, every diagnostic code hit, the acceptance result, tokens and cost, the feedback the agent filed,
// and the transcript.
//
//   node bench/usability/run.ts                          every task once, 4 at a time, against prod
//   node bench/usability/run.ts --tasks todo,ledger --n 3 --parallel 2 --model opus --budget-usd 8 --timeout-min 45
//   node bench/usability/run.ts --n 3 --model sonnet,haiku   the models one after another, each in <out>/<model>/
//   node bench/usability/run.ts --regrade <results dir>  grade the saved solutions again (after a release, say)
//
// Results go to bench/usability/results/<date>-<prod tape-version>/ (or --out): per job a directory with the
// transcript, the solution and metrics.json (all ignored by git), then results.json and summary.md (tracked).
// Needs the `claude` CLI logged in, and Node 25.
// Prod limits calls per address per minute. Two runs at once from one machine (two models side by side, say), or
// Haiku 4 at a time, meet the limit: a session then starts with the tape server not connected, or has a compile or
// run refused for it, and its counts are the limiter's. So --model takes a list, run one after another; a model runs
// at most its --max-concurrent-per-model cap at a time (`haiku=3` unless the flag says otherwise, whatever --parallel
// says); and a spoiled session (sessions.ts) is stopped and started again after a jittered, growing wait (65 s·2^(k−1)
// plus up to 65 s), up to --retries (3) times. A job still spoiled after that is graded, marked `spoiled` with the
// reason, and left out of summary.md's numbers.
import '../../node25.ts';
import { execSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { analyse, connected } from './transcript.ts';
import { backoffMs, concurrencyFor, DEFAULT_CAPS, parseCaps, spoiledBy } from './sessions.ts';
import type { Metrics } from './transcript.ts';
import { grade, TASKS } from './grade.ts';
import { MCP_URL } from './lib.ts';
import type { File } from './lib.ts';
import { loadSaved, writeSummary } from './summary.ts';

const here = dirname(new URL(import.meta.url).pathname);
const root = join(here, '..', '..');
const args = process.argv.slice(2);
const opt = (f: string, d: string): string => {
  const i = args.indexOf(`--${f}`);
  return i < 0 ? d : (args[i + 1] ?? d);
};

/** The public docs an agent is given, as the files it sees. Links in them to the rest of the repository do not resolve. */
const DOCS: [from: string, to: string][] = [
  ['README.md', 'README.md'],
  ['LANGUAGE.md', 'LANGUAGE.md'],
  ['docs/guide.md', 'guide.md'],
  ['docs/mcp.md', 'mcp.md'],
  ['docs/std.md', 'std.md'],
];

export type Job = { task: string; rep: number; id: string };
export type JobResult = Metrics & {
  task: string;
  rep: number;
  id: string;
  exit: number | null;
  timedOut: boolean;
  /** sessions started again because they were spoiled (sessions.ts: no tape server, or a rate-limited call) */
  restarts: number;
  /** why the session that counts is spoiled after the last restart (then summary.md leaves it out), or null */
  spoiled: string | null;
  solution: string[];
  solutionFrom: 'solution/' | 'last compiled call' | 'last call' | 'none';
  grade: Awaited<ReturnType<typeof grade>>;
};
export type RunInfo = {
  runId: string;
  date: string;
  tapeVersion: string;
  tapeMcpVersion: string;
  benchSha: string;
  model: string;
  n: number;
  parallel: number;
  budgetUsd: number;
  timeoutMin: number;
  mcpUrl: string;
};

const prodVersions = async (): Promise<{ tape: string; mcp: string }> => {
  const r = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  await r.text();
  return { tape: r.headers.get('tape-version') ?? 'unknown', mcp: r.headers.get('tape-mcp-version') ?? 'unknown' };
};

const gitSha = (): string => {
  try {
    return execSync('git rev-parse --short=12 HEAD', { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
};

const SYSTEM = (
  runId: string,
  task: string,
): string => `You are a backend developer trying Tape, a new programming language, for the first time.

You have:
- the task, in TASK.md (also below);
- Tape's public documentation in ./docs: README.md, LANGUAGE.md, guide.md, mcp.md and std.md (the standard library
  reference) (links in them to other files of the Tape repository do not resolve here);
- the \`tape\` MCP server's tools: compile, run and feedback.
There is nothing else: no repository, no shell, no web.

Your job: write a Tape program that implements TASK.md exactly, test it with \`run\`, and save the final program as one
or more .tape files in ./solution/ (create them with the Write tool). Hidden acceptance tests will send HTTP requests to
the program in ./solution/ through the same \`run\` tool, so the spec's routes, status codes and JSON shapes matter.

Whenever something about Tape is confusing, wrong, missing or surprising (a diagnostic you did not understand, a
doc that misled you, a feature you needed and could not find), report it with the \`feedback\` tool when it happens,
with the smallest program that shows it when you can. Start every feedback \`text\` with "[usability-bench ${runId} ${task}]".
Filing feedback is part of the task.

Work until the program passes your own tests of the whole spec, or until you conclude a part cannot be done in Tape
(then do the rest, report why with feedback, and say so). End with a short summary: what works, what does not, and
what was hardest.`;

/** How many times a spoiled session is started again (--connect-retries is the flag's old name). */
const RETRIES = Number(opt('retries', opt('connect-retries', '3')));
const pause = async (ms: number): Promise<void> => {
  await new Promise<void>(done => {
    setTimeout(done, ms);
  });
};

type Session = { work: string; lines: string[]; exit: number | null; timedOut: boolean; wallMs: number };

/** One agent on one task, in a fresh working directory. A session whose init says the tape server did not connect
 * (or connected with no tools) is stopped there: it could not test anything, and it is started again. */
const session = async (job: Job, info: RunInfo, dir: string): Promise<Session> => {
  // The agent's working directory is outside the repository, so no CLAUDE.md of the repository's is found and the file
  // tools (confined to it by --restricted) cannot reach the source.
  const work = mkdtempSync(join(tmpdir(), `tape-usability-${job.task}-`));
  mkdirSync(join(work, 'docs'));
  for (const [from, to] of DOCS) copyFileSync(join(root, from), join(work, 'docs', to));
  const spec = readFileSync(join(here, 'tasks', `${job.task}.md`), 'utf8');
  writeFileSync(join(work, 'TASK.md'), spec);
  const mcpConfig = join(dir, 'mcp.json');
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { tape: { type: 'http', url: MCP_URL } } }));
  const tools = 'mcp__tape__compile mcp__tape__run mcp__tape__feedback Read Write Edit Glob Grep';
  const argv = [
    '-p',
    `Build the service in TASK.md in Tape. The docs are in ./docs. Here is TASK.md:\n\n${spec}`,
    '--append-system-prompt',
    SYSTEM(info.runId, job.task),
    '--restricted',
    '--tools',
    'Read,Write,Edit,Glob,Grep',
    '--strict-mcp-config',
    '--mcp-config',
    mcpConfig,
    '--allowedTools',
    tools,
    '--permission-mode',
    'acceptEdits',
    '--permission-prompts',
    'none',
    '--output-format',
    'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--model',
    info.model,
    '--max-budget-usd',
    String(info.budgetUsd),
  ];
  writeFileSync(join(dir, 'work-dir.txt'), `${work}\n`);
  const t0 = Date.now();
  const lines: string[] = [];
  let timedOut = false;
  let seenInit = false;
  const exit = await new Promise<number | null>(done => {
    const child = spawn('claude', argv, { cwd: work, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim() !== '') {
          const wrapped = `{"t":${Date.now() - t0},"m":${line}}`;
          lines.push(wrapped);
          if (!seenInit && line.includes('"subtype":"init"')) {
            seenInit = true;
            if (!connected([wrapped])) child.kill('SIGTERM');
          }
          // a compile or run the limit refused spoils the session: stop it now rather than pay for the rest
          if (line.includes('rate_limited') && spoiledBy(lines) !== null) child.kill('SIGTERM');
        }
        nl = buf.indexOf('\n');
      }
    });
    let err = '';
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString('utf8');
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, info.timeoutMin * 60_000);
    child.on('close', code => {
      clearTimeout(timer);
      if (buf.trim() !== '') lines.push(`{"t":${Date.now() - t0},"m":${buf}}`);
      writeFileSync(join(dir, 'stderr.txt'), err);
      done(code);
    });
  });
  return { work, lines, exit, timedOut, wallMs: Date.now() - t0 };
};

const runJob = async (job: Job, info: RunInfo, outDir: string): Promise<JobResult> => {
  const dir = join(outDir, job.id);
  mkdirSync(dir, { recursive: true });
  let s = await session(job, info, dir);
  let restarts = 0;
  for (let why = spoiledBy(s.lines); why !== null && restarts < RETRIES; why = spoiledBy(s.lines)) {
    restarts++;
    // the spoiled session is kept beside the one that counts, for the record
    writeFileSync(join(dir, `spoiled-${restarts}.jsonl`), `${s.lines.join('\n')}\n`);
    const wait = backoffMs(restarts);
    console.log(`${job.id}: ${why} (${restarts} of ${RETRIES}); again in ${Math.round(wait / 1000)} s`);
    await pause(wait);
    s = await session(job, info, dir);
  }
  const spoiled = spoiledBy(s.lines);
  const { work, lines, exit, timedOut } = s;
  const transcript = join(dir, 'transcript.jsonl');
  writeFileSync(transcript, `${lines.join('\n')}\n`);
  const metrics = analyse(lines, s.wallMs);
  metrics.transcript = transcript;

  // The program graded: what the agent saved in solution/, else the last program it sent that compiled.
  let files: File[] = [];
  let solutionFrom: JobResult['solutionFrom'] = 'none';
  const sol = join(work, 'solution');
  if (existsSync(sol)) {
    files = readdirSync(sol)
      .filter(f => f.endsWith('.tape'))
      .map(f => ({ name: f, text: readFileSync(join(sol, f), 'utf8') }));
    if (files.length > 0) solutionFrom = 'solution/';
  }
  if (files.length === 0 && metrics.lastCompiledFiles !== null) {
    files = metrics.lastCompiledFiles;
    solutionFrom = 'last compiled call';
  } else if (files.length === 0 && metrics.lastFiles !== null) {
    files = metrics.lastFiles;
    solutionFrom = 'last call';
  }
  mkdirSync(join(dir, 'solution'), { recursive: true });
  for (const f of files) writeFileSync(join(dir, 'solution', f.name), f.text);
  const graded = await grade(job.task, files);
  const result: JobResult = {
    ...metrics,
    task: job.task,
    rep: job.rep,
    id: job.id,
    exit,
    timedOut,
    restarts,
    spoiled,
    solution: files.map(f => f.name),
    solutionFrom,
    grade: graded,
  };
  writeFileSync(join(dir, 'metrics.json'), JSON.stringify(result, null, 2));
  console.log(
    `${job.id}: ${graded.passed}/${graded.total} checks, first compile ${metrics.firstCompileMs === null ? 'never' : `${Math.round(metrics.firstCompileMs / 1000)} s`}, ` +
      `${metrics.compileAttempts} attempts, $${metrics.costUsd.toFixed(2)}, ${metrics.feedback.length} feedback` +
      (spoiled === null ? '' : ` (spoiled: ${spoiled}; left out of the summary's numbers)`),
  );
  return result;
};

const pool = async <T, R>(items: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> => {
  const out: R[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) {
      const item = items[i];
      if (item !== undefined) out[i] = await f(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
};

const regrade = async (outDir: string): Promise<void> => {
  const saved = loadSaved(outDir);
  for (const [i, j] of saved.jobs.entries()) {
    // The transcript is read again too, so a change to transcript.ts applies to old runs.
    const transcript = join(outDir, j.id, 'transcript.jsonl');
    if (existsSync(transcript)) {
      const lines = readFileSync(transcript, 'utf8')
        .split('\n')
        .filter(l => l !== '');
      saved.jobs[i] = Object.assign(j, analyse(lines, j.wallMs), { transcript, spoiled: spoiledBy(lines) });
    }
    const sol = join(outDir, j.id, 'solution');
    const files = existsSync(sol)
      ? readdirSync(sol).map(f => ({ name: f, text: readFileSync(join(sol, f), 'utf8') }))
      : [];
    j.grade = await grade(j.task, files);
    console.log(`${j.id}: ${j.grade.passed}/${j.grade.total}`);
  }
  writeFileSync(join(outDir, 'results.json'), JSON.stringify(saved, null, 2));
  writeSummary(outDir, saved.info, saved.jobs);
};

if (args[0] === '--regrade') {
  await regrade(args[1] ?? '.');
} else {
  const tasks = opt('tasks', TASKS.join(',')).split(',');
  for (const t of tasks) if (!TASKS.some(x => x === t)) throw new Error(`no task ${t}: ${TASKS.join(', ')}`);
  const models = opt('model', 'sonnet').split(',');
  const caps = parseCaps(opt('max-concurrent-per-model', DEFAULT_CAPS));
  const date = new Date().toISOString().slice(0, 10);
  // resolved: the agent's cwd is a temporary directory, so a relative path would not find mcp.json
  const base = resolve(opt('out', ''));
  for (const model of models) {
    const v = await prodVersions();
    const info: RunInfo = {
      runId: `${date}-${v.tape}`,
      date: new Date().toISOString(),
      tapeVersion: v.tape,
      tapeMcpVersion: v.mcp,
      benchSha: gitSha(),
      model,
      n: Number(opt('n', '1')),
      parallel: concurrencyFor(model, Number(opt('parallel', '4')), caps),
      budgetUsd: Number(opt('budget-usd', '6')),
      timeoutMin: Number(opt('timeout-min', '45')),
      mcpUrl: MCP_URL,
    };
    const top = opt('out', '') === '' ? join(here, 'results', info.runId) : base;
    const outDir = models.length > 1 ? join(top, model) : top;
    mkdirSync(outDir, { recursive: true });
    const jobs: Job[] = tasks.flatMap(task =>
      Array.from({ length: info.n }, (_, rep) => ({ task, rep, id: info.n > 1 ? `${task}-${rep + 1}` : task })),
    );
    console.log(
      `run ${info.runId}: ${jobs.length} jobs, ${info.parallel} at a time, model ${info.model}, tape ${v.tape}`,
    );
    const results = await pool(jobs, info.parallel, j => runJob(j, info, outDir));
    writeFileSync(join(outDir, 'results.json'), JSON.stringify({ info, jobs: results }, null, 2));
    writeSummary(outDir, info, results);
    console.log(`wrote ${join(outDir, 'summary.md')}`);
  }
}
