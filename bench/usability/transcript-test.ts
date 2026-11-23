// bench/usability/transcript-test.ts: what transcript.ts makes of the tool answers that are not Tape's. The tool
// answer texts are the ones the 2026-11-23 run recorded (the CLI's wording, prod's limiter); only the saved file's
// path is replaced, and the program is examples/hello.tape.
//   node bench/usability/transcript-test.ts
// - A call prod's rate limit refused (the CLI wraps the 429 as "Error POSTing to endpoint: {…}") is not an attempt:
//   it says nothing of Tape. Before, it was counted a refused compile.
// - A run whose answer was too large for the CLI to show (it saves it to a file and shows a schema of it) compiled
//   when that schema has results. Before, it was counted a refused compile.
// - A session whose tape server did not connect, or connected with no tools, is not connected (run.ts retries it).
// - sessions.ts: a session with no tape server or with a rate-limited compile or run is spoiled (a rate-limited
//   feedback is not: the feedback limit is its own); the wait before restart k is 65 s·2^(k−1) plus up to 65 s at
//   random; haiku runs at most 3 at a time unless --max-concurrent-per-model says otherwise.
// - summary.ts leaves a job still spoiled after its last restart out of every number, and names it with the reason.
import '../../node25.ts';
import { finish, raw, same } from '../../test/harness.ts';
import { analyse, connected } from './transcript.ts';
import { backoffMs, concurrencyFor, DEFAULT_CAPS, parseCaps, spoiledBy } from './sessions.ts';
import { counted, render } from './summary.ts';
import type { Graded } from './grade.ts';
import type { JobResult, RunInfo } from './run.ts';

const hello = raw('examples/hello.tape');
const init = (status: string, tools: string[]): string =>
  JSON.stringify({
    t: 500,
    m: { type: 'system', subtype: 'init', mcp_servers: [{ name: 'tape', status, source: 'dynamic' }], tools },
  });
const ALL = ['Edit', 'Glob', 'Grep', 'Read', 'Write', 'mcp__tape__compile', 'mcp__tape__feedback', 'mcp__tape__run'];
let n = 0;
/** One `run` call of hello.tape at t ms (or a `feedback` call), and the text the agent was given back. */
const call = (t: number, answer: string, isError = false, tool = 'run'): string[] => {
  const id = `toolu_${++n}`;
  const input =
    tool === 'feedback'
      ? { kind: 'friction', text: '[usability-bench test] a report' }
      : { files: [{ name: 'hello.tape', text: hello }], requests: ['GET /hello/ada'] };
  return [
    JSON.stringify({
      t: t - 1,
      m: {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id,
              name: `mcp__tape__${tool}`,
              input,
            },
          ],
        },
      },
    }),
    JSON.stringify({
      t,
      m: {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: id, content: answer, ...(isError ? { is_error: true } : {}) }],
        },
      },
    }),
  ];
};
const LIMITED =
  'Error POSTing to endpoint: {"ok":false,"error":"rate_limited","reason":"too many calls from this address in the last minute; wait a minute and try again"}';
const tooLarge = (schema: string): string =>
  'Error: result (50,006 characters) exceeds maximum allowed tokens. Output has been saved to /tmp/tool-results/mcp-tape-run-1.txt.\n' +
  `Format: JSON with schema: ${schema}\n` +
  '- For targeted queries (find a value, filter by field): use jq on the file directly.';
const ANSWERED = JSON.stringify({ ok: true, diagnostics: [], results: [{ request: 'GET /hello/ada', status: 200 }] });
const REFUSED = JSON.stringify({
  ok: false,
  diagnostics: [{ file: 'hello.tape', line: 11, code: 'C54', message: 'run twice …', fix: '…' }],
  results: [],
});
const read = (lines: string[]) => {
  const m = analyse(lines, 10_000);
  return {
    attempts: m.compileAttempts,
    refused: m.failedAttempts,
    rateLimited: m.rateLimited,
    tooLarge: m.tooLarge,
    firstCompileMs: m.firstCompileMs,
    lost: Object.keys(m.lostMsByCode),
  };
};

same('a rate-limited run is no attempt', read([init('connected', ALL), ...call(1000, LIMITED, true)]), {
  attempts: 0,
  refused: 0,
  rateLimited: 1,
  tooLarge: 0,
  firstCompileMs: null,
  lost: [],
});
same(
  'a rate-limited run, then the same run answered: one attempt, compiled when it was answered',
  read([init('connected', ALL), ...call(1000, LIMITED, true), ...call(5000, ANSWERED)]),
  { attempts: 1, refused: 0, rateLimited: 1, tooLarge: 0, firstCompileMs: 5000, lost: [] },
);
same(
  'the limit refused as JSON (no CLI wrapping) is no attempt either',
  read([init('connected', ALL), ...call(1000, JSON.stringify({ ok: false, error: 'rate_limited', reason: '…' }))]),
  { attempts: 0, refused: 0, rateLimited: 1, tooLarge: 0, firstCompileMs: null, lost: [] },
);
same(
  'a run too large to show, whose schema has results, compiled',
  read([init('connected', ALL), ...call(2000, tooLarge('{ok: boolean, diagnostics: [], results: [{...}]}'))]),
  { attempts: 1, refused: 0, rateLimited: 0, tooLarge: 1, firstCompileMs: 2000, lost: [] },
);
same(
  'a run too large to show, whose schema has no results, did not compile',
  read([init('connected', ALL), ...call(2000, tooLarge('{ok: boolean, diagnostics: [{...}], results: []}'))]),
  { attempts: 1, refused: 1, rateLimited: 0, tooLarge: 1, firstCompileMs: null, lost: ['(none)'] },
);
same('a compile Tape refused is still a refusal', read([init('connected', ALL), ...call(2000, REFUSED)]), {
  attempts: 1,
  refused: 1,
  rateLimited: 0,
  tooLarge: 0,
  firstCompileMs: null,
  lost: ['C54'],
});

same(
  'connected: the tape server connected with its tools; failed; connected with no tools; no init at all',
  [
    connected([init('connected', ALL)]),
    connected([init('failed', ['Edit', 'Glob', 'Grep', 'Read', 'Write'])]),
    connected([init('connected', ['Edit', 'Glob', 'Grep', 'Read', 'Write'])]),
    connected([]),
  ],
  [true, false, false, false],
);

// sessions.ts: which sessions are spoiled, the wait before each restart, and the per-model caps
const FEEDBACK_LIMITED = JSON.stringify({ ok: false, error: 'feedback_rate_limited', reason: '…' });
same(
  'spoiledBy: clean; a rate-limited run; only a rate-limited feedback (a separate limit: not spoiled); no tape server',
  [
    spoiledBy([init('connected', ALL), ...call(1000, ANSWERED)]),
    spoiledBy([init('connected', ALL), ...call(1000, LIMITED, true), ...call(5000, ANSWERED)]),
    spoiledBy([init('connected', ALL), ...call(1000, FEEDBACK_LIMITED, false, 'feedback'), ...call(2000, ANSWERED)]),
    spoiledBy([init('failed', ['Edit', 'Glob', 'Grep', 'Read', 'Write'])]),
  ],
  [
    null,
    '1 compile or run call was rate-limited',
    null,
    'the tape server did not connect (or connected with no tools)',
  ],
);
same(
  'backoffMs: 65 s·2^(k−1), plus up to one more 65 s at random',
  [1, 2, 3].flatMap(k => [backoffMs(k, () => 0), backoffMs(k, () => 0.999_999)]),
  [65_000, 129_999, 130_000, 194_999, 260_000, 324_999],
);
const draws = Array.from({ length: 200 }, () => backoffMs(1));
same(
  'backoffMs: jobs spoiled together come back at different times (200 draws, all within the first wait)',
  { spread: new Set(draws).size > 150, within: draws.every(w => w >= 65_000 && w < 130_000) },
  { spread: true, within: true },
);
const caps = parseCaps(DEFAULT_CAPS);
same(
  'concurrency: haiku is capped at 3 by default, sonnet and opus take --parallel; a flag sets its own caps',
  [
    concurrencyFor('haiku', 4, caps),
    concurrencyFor('claude-haiku-5-5', 4, caps),
    concurrencyFor('haiku', 2, caps),
    concurrencyFor('sonnet', 4, caps),
    concurrencyFor('sonnet', 4, parseCaps('sonnet=2,haiku=1')),
    concurrencyFor('haiku', 4, parseCaps('sonnet=2,haiku=1')),
  ],
  [3, 3, 2, 4, 2, 1],
);
const refusedCaps = ['haiku', 'haiku=0', 'haiku=1.5', '=3'].map(spec => {
  try {
    parseCaps(spec);
    return 'taken';
  } catch {
    return 'refused';
  }
});
same('parseCaps refuses what is not model=count', refusedCaps, ['refused', 'refused', 'refused', 'refused']);

// summary.ts: a job still spoiled after its last restart is in no number, and is listed with its reason
const graded: Graded = { task: 'todo', compiled: true, diagnostics: [], checks: [], passed: 29, total: 29, skipped: 0 };
const job = (id: string, spoiled: string | null, lines: string[]): JobResult => ({
  ...analyse(lines, 60_000),
  task: 'todo',
  rep: 0,
  id,
  exit: 0,
  timedOut: false,
  restarts: spoiled === null ? 0 : 3,
  spoiled,
  solution: ['todo.tape'],
  solutionFrom: 'solution/',
  grade: spoiled === null ? graded : { ...graded, passed: 0 },
});
const info: RunInfo = {
  runId: 'test',
  date: '2026-11-23T00:00:00.000Z',
  tapeVersion: 'test',
  tapeMcpVersion: 'test',
  benchSha: 'test',
  model: 'haiku',
  n: 1,
  parallel: 3,
  budgetUsd: 6,
  timeoutMin: 45,
  mcpUrl: 'https://example.invalid/mcp',
};
const jobs = [
  job('todo-1', null, [init('connected', ALL), ...call(1000, REFUSED), ...call(2000, ANSWERED)]),
  job('todo-2', 'the tape server did not connect (or connected with no tools)', [init('failed', [])]),
];
const page = render(info, jobs);
same(
  'summary: the spoiled job is left out of the numbers and named with its reason',
  {
    counted: counted(jobs).map(j => j.id),
    leftOut: page.includes('**1 of 2 jobs are left out of every number below**'),
    reason: page.includes('todo-2: the tape server did not connect'),
    accepted: page.includes('**Tasks fully accepted: 1 of 1.**'),
    attempts: page.includes('Compile attempts 2, of which refused 1;'),
    restarts: page.includes('rate-limited compile or run) 3;'),
  },
  { counted: ['todo-1'], leftOut: true, reason: true, accepted: true, attempts: true, restarts: true },
);

finish();
