// bench/usability/transcript-test.ts: what transcript.ts makes of the tool answers that are not Tape's. The tool
// answer texts are the ones the 2026-11-23 run recorded (the CLI's wording, prod's limiter); only the saved file's
// path is replaced, and the program is examples/hello.tape.
//   node bench/usability/transcript-test.ts
// - A call prod's rate limit refused (the CLI wraps the 429 as "Error POSTing to endpoint: {…}") is not an attempt:
//   it says nothing of Tape. Before, it was counted a refused compile.
// - A run whose answer was too large for the CLI to show (it saves it to a file and shows a schema of it) compiled
//   when that schema has results. Before, it was counted a refused compile.
// - A session whose tape server did not connect, or connected with no tools, is not connected (run.ts retries it).
import '../../node25.ts';
import { finish, raw, same } from '../../test/harness.ts';
import { analyse, connected } from './transcript.ts';

const hello = raw('examples/hello.tape');
const init = (status: string, tools: string[]): string =>
  JSON.stringify({
    t: 500,
    m: { type: 'system', subtype: 'init', mcp_servers: [{ name: 'tape', status, source: 'dynamic' }], tools },
  });
const ALL = ['Edit', 'Glob', 'Grep', 'Read', 'Write', 'mcp__tape__compile', 'mcp__tape__feedback', 'mcp__tape__run'];
let n = 0;
/** One `run` call of hello.tape at t ms, and the text the agent was given back. */
const call = (t: number, answer: string, isError = false): string[] => {
  const id = `toolu_${++n}`;
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
              name: 'mcp__tape__run',
              input: { files: [{ name: 'hello.tape', text: hello }], requests: ['GET /hello/ada'] },
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

finish();
