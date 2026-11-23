// bench/usability/run.ts: the usability benchmark. For each task, a fresh agent (the `claude` CLI, headless) gets the
// task's spec, Tape's public docs and the live MCP server's three tools, and nothing else: no repository, no shell,
// no web. It writes a program; the program is then graded by the task's hidden acceptance requests (accept/*.ts)
// through prod's own `run`. What is recorded per task: wall time and tool calls to the first program that compiled,
// compile attempts, every diagnostic code hit, the acceptance result, tokens and cost, the feedback the agent filed,
// and the transcript.
//
//   node bench/usability/run.ts                          every task once, 4 at a time, against prod
//   node bench/usability/run.ts --tasks todo,ledger --n 3 --parallel 2 --model opus --budget-usd 8 --timeout-min 45
//   node bench/usability/run.ts --regrade <results dir>  grade the saved solutions again (after a release, say)
//
// Results go to bench/usability/results/<date>-<prod tape-version>/ (or --out): per job a directory with the
// transcript, the solution and metrics.json (all ignored by git), then results.json and summary.md (tracked).
// Needs the `claude` CLI logged in, and Node 25.
import '../../node25.ts';
import { execSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { analyse } from './transcript.ts';
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
];

export type Job = { task: string; rep: number; id: string };
export type JobResult = Metrics & {
  task: string;
  rep: number;
  id: string;
  exit: number | null;
  timedOut: boolean;
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
- Tape's public documentation in ./docs: README.md, LANGUAGE.md, guide.md and mcp.md (links in them to other files of
  the Tape repository do not resolve here);
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

const runJob = async (job: Job, info: RunInfo, outDir: string): Promise<JobResult> => {
  const dir = join(outDir, job.id);
  mkdirSync(dir, { recursive: true });
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
  const exit = await new Promise<number | null>(done => {
    const child = spawn('claude', argv, { cwd: work, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim() !== '') lines.push(`{"t":${Date.now() - t0},"m":${line}}`);
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
  const transcript = join(dir, 'transcript.jsonl');
  writeFileSync(transcript, `${lines.join('\n')}\n`);
  const metrics = analyse(lines, Date.now() - t0);
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
    solution: files.map(f => f.name),
    solutionFrom,
    grade: graded,
  };
  writeFileSync(join(dir, 'metrics.json'), JSON.stringify(result, null, 2));
  console.log(
    `${job.id}: ${graded.passed}/${graded.total} checks, first compile ${metrics.firstCompileMs === null ? 'never' : `${Math.round(metrics.firstCompileMs / 1000)} s`}, ` +
      `${metrics.compileAttempts} attempts, $${metrics.costUsd.toFixed(2)}, ${metrics.feedback.length} feedback`,
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
      saved.jobs[i] = Object.assign(j, analyse(lines, j.wallMs), { transcript });
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
  for (const t of tasks)
    if (!(TASKS as readonly string[]).includes(t)) throw new Error(`no task ${t}: ${TASKS.join(', ')}`);
  const v = await prodVersions();
  const date = new Date().toISOString().slice(0, 10);
  const info: RunInfo = {
    runId: `${date}-${v.tape}`,
    date: new Date().toISOString(),
    tapeVersion: v.tape,
    tapeMcpVersion: v.mcp,
    benchSha: gitSha(),
    model: opt('model', 'sonnet'),
    n: Number(opt('n', '1')),
    parallel: Number(opt('parallel', '4')),
    budgetUsd: Number(opt('budget-usd', '6')),
    timeoutMin: Number(opt('timeout-min', '45')),
    mcpUrl: MCP_URL,
  };
  const outDir = opt('out', join(here, 'results', info.runId));
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
