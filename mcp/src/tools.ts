// tools.ts: three tools, compile, run and test, as functions of their JSON arguments (the fourth, feedback, is
// feedback.ts). The same functions answer MCP's tools/call and POST /v1/compile, /v1/run and /v1/test (serve.ts).
// They use no Workers API: how a program is run is given (Deps.run and Deps.examples: in production a Dynamic
// Worker, index.ts; in test.ts, Node), so test.ts runs them as they are.
//
// Few tools on purpose. Others an agent could use (fmt, the simulator, a program's tables) would each be a field of
// these or a tool of its own; they wait until someone asks (test did: report 1fdd40f44552), so the list stays short.
import { compileAlso } from '../../compiler.ts';
import { STEP_VERSION, isStepVersion } from '../../compiler/step-version.ts';
import type { StepVersion } from '../../compiler/step-version.ts';
import { sha256 } from '../../compiler/sha256.ts';
import type { Built, Source } from '../../compiler.ts';
import { isHead } from '../../host.ts';
import type { Effect, Header } from '../../host.ts';
import { responseOf } from '../../host.ts';
import { effectLine, queryNames } from '../../apps/playground/src/lines.ts';
import { otlp } from '../../service/src/view.ts';
import type { Otlp } from '../../service/src/view.ts';
import type { Entry, Joined, JoinedCall, RunHead } from '../../service/src/records.ts';
import { finish, prepare } from '../../doctest.ts';
import type { Called } from '../../host/examples.ts';
import { NAME, TRACE_STEPS, UNREACHABLE } from './runner.ts';
import type { Ran, RanAll, RunRequest, Scripts } from './runner.ts';

export const LIMITS = {
  /** every file's text together, in UTF-8 bytes */
  sourceBytes: 64 * 1024,
  files: 8,
  /** one call of 50 hello requests: about 8 ms of wall time in Node (20: about 3 ms) */
  requests: 50,
  /** a request's first line (METHOD SP TARGET) */
  lineBytes: 2 * 1024,
  /** a request's body, after its first line feed */
  requestBodyBytes: 16 * 1024,
  /** a response's body as it is given back; longer is cut, and the result says so */
  responseBodyBytes: 64 * 1024,
  /** a result's effect log and trace together, as JSON; longer and both are left out, and the result says so */
  resultBytes: 512 * 1024,
  /** the time a whole run call may take, from the first request to the last answer */
  wallMs: 20_000,
  /** the CPU the Dynamic Worker running the program may use per call */
  cpuMs: 10_000,
  /** a request's at_ms: up to 30 days after the run's start */
  atMs: 30 * 24 * 3600 * 1000,
  /** compact effects show a query's rows when it returned at most this many */
  compactRows: 20,
} as const;

/** Why a call was not done: a code, the HTTP status, and a sentence that says what to change. */
export type Refusal = { ok: false; error: string; reason: string; status: number };
export const refused = (status: number, error: string, reason: string): Refusal => ({
  ok: false,
  error,
  reason,
  status,
});
export const isRefusal = (v: unknown): v is Refusal =>
  typeof v === 'object' && v !== null && 'ok' in v && v.ok === false && 'status' in v && 'reason' in v;

/** What a build is given to run: its module's bytes, and a name the Loader can cache it by. */
/** A build to run; `traced`, the same program built with { trace: true }, when a line trace is asked for. */
export type Program = { wasm: Uint8Array; build: string; traced?: Uint8Array };
export type Deps = {
  /** the standard library, as the compiler takes it */
  std: readonly Source[];
  /** examples/hello.tape, the program used when no files are given */
  hello: Source;
  run: (program: Program, requests: readonly RunRequest[], remotes: Scripts) => Promise<RanAll>;
  /** call a doc examples build's functions (doctest.ts), where Wasm can be instantiated: host/examples.ts */
  examples: (wasm: Uint8Array, fns: readonly string[]) => Promise<Called[]>;
  /** the wall-clock guard on a run call (LIMITS.wallMs; a test shortens it) */
  wallMs?: number;
  /** the compiler's hash (the tape-compiler header), part of the compile cache's key */
  compiler?: string;
};

export type Diagnostic = { file: string; line: number; code: string; message: string; fix: string };
export type CompileResult = {
  ok: boolean;
  diagnostics: Diagnostic[];
  wasm_bytes: number | null;
  /** the SQL statements the program can run */
  statements: number | null;
  /** the step accounting this compiler builds, whether or not the program compiled */
  step_version: StepVersion;
  /** the compiler's answer came from this isolate's cache of programs compiled here before */
  cached: boolean;
};
export type EffectOut =
  | {
      kind: 'sql';
      query: string;
      params: Record<string, unknown>;
      rows?: unknown[][];
      /** compact effects: how many rows the statement returned (rows are left out past LIMITS.compactRows) */
      rows_returned?: number;
      rows_written?: number;
      /** the write was undone: its run's rollback(out) or trap rolled it back */
      undone?: true;
    }
  | {
      kind: 'call';
      to: string;
      method: string;
      send: unknown;
      within_ms: number;
      once?: unknown;
      status: string;
      reply: unknown;
    }
  | { kind: 'now'; now: number }
  | { kind: 'random'; random: number }
  | { kind: 'wake'; key: number; after_ms: number; due: number; undone?: true };
export type TraceMode = (typeof TRACE_MODES)[number];
export type EffectsMode = (typeof EFFECTS_MODES)[number];
export type RunResultOne = {
  request: string;
  /** on the run's own clock (a request with at_ms): when it ran, in ms from the run's start */
  at_ms?: number;
  /** a timer's run: the key, and when it was due */
  woken?: { key: number; due_ms: number };
  status: number;
  content_type: string | null;
  /** the headers the program set (std/http's header), in its order; left out when it set none */
  headers?: Header[];
  body: string;
  body_bytes: number;
  truncated: boolean;
  error: string | null;
  effects: EffectOut[] | null;
  /** null for a timer's run: the host replays `handle` only */
  replayed: boolean | null;
  replay_error?: string;
  steps: number;
  /** which step accounting produced `steps` */
  step_version: StepVersion;
  memory_bytes: number | null;
  trace: Otlp | string | null;
  omitted?: string;
};
export type RunResult = {
  ok: boolean;
  diagnostics: Diagnostic[];
  /** the build came from this isolate's cache (CompileResult.cached) */
  cached: boolean;
  error?: string;
  results: RunResultOne[];
  /** on the run's own clock: the timers that ran, and those still set at the end */
  timers?: { fired: number; pending: number };
  /**
   * Whole milliseconds the caller waited for the invocation that ran every request in this call. Absent when
   * nothing ran. A wall-clock reading at 1 ms (a wait under 1 ms is 0), not the platform's CPU time, which is
   * logged after the response (tail.ts). One number for the call: the requests share the invocation.
   */
  invoke_wall_ms?: number;
};
/** What the log line says of a call, beside what serve.ts knows (serve.ts, logLine). */
export type Usage = {
  /** the build came from the compile cache: compile_ms is the lookup's */
  cached: boolean;
  /** this isolate (a random id, made on its first call) and its compile cache after the call: occupancy on prod */
  isolate: string;
  cache_entries: number;
  cache_bytes: number;
  codes: string[];
  files: number;
  source_bytes: number;
  requests: number;
  statuses: number[];
  steps: number;
  /** the step accounting those steps were counted with */
  step_version: StepVersion;
  compile_ms: number;
  run_ms: number;
  /**
   * the run, when there was one in a Dynamic Worker: its id (its tail's line says the same, tail.ts) and the Wasm
   * memories its isolate held at the end (runner.ts RunMemory)
   */
  run?: { run_id: string | null; program_bytes: number | null; sqlite_bytes: number | null };
};

const enc = new TextEncoder(),
  dec = new TextDecoder();
type Fields = Readonly<Record<string, unknown>>;
const isFields = (v: unknown): v is Fields => typeof v === 'object' && v !== null && !Array.isArray(v);
const FILE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,62}\.tape$/;
const REQUEST_LINE = /^[A-Z]{1,16} \/\S*$/;

// ---- what each tool takes: one definition, published as its inputSchema (serve.ts, listing) and the fields the tool
// reads (filesOf, requestsOf, modeOf and the unknown-argument check take their keys and words from it), so the two
// cannot drift (mcp/test.ts, schema: a strict client checks arguments against the schema before it sends them)

/** A JSON Schema object with its properties, as the tools' schemas are. */
type ObjectSchema = { type: 'object'; properties: Record<string, unknown> };
/** The fields an object schema names: all a tool takes there. */
export const fieldsOfSchema = (s: ObjectSchema): string[] => Object.keys(s.properties);

const FILE_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', pattern: FILE_NAME.source, description: 'hello.tape' },
    text: { type: 'string', description: 'The Tape source.' },
  },
  required: ['name', 'text'],
  additionalProperties: false,
} as const;
export const FILES_SCHEMA = {
  type: 'array',
  description: `The program's files (at most ${LIMITS.files}, ${LIMITS.sourceBytes} bytes together). Leave it out to use examples/hello.tape.`,
  minItems: 1,
  maxItems: LIMITS.files,
  items: FILE_SCHEMA,
} as const;
const TIMED_REQUEST_SCHEMA = {
  type: 'object',
  properties: {
    request: { type: 'string' },
    at_ms: { type: 'integer', minimum: 0, maximum: LIMITS.atMs },
  },
  required: ['request'],
  additionalProperties: false,
} as const;
export const REQUESTS_SCHEMA = {
  type: 'array',
  minItems: 1,
  maxItems: LIMITS.requests,
  items: { anyOf: [{ type: 'string' }, TIMED_REQUEST_SCHEMA] },
  description:
    'Requests, run in order: "GET /hello/ada", "POST /path\\n<body>", or {"request": "GET /x", "at_ms": 61000} on the run\'s own clock (ms from its start, never going back).',
} as const;
export const REMOTES_SCHEMA = {
  type: 'object',
  description:
    'Answers for calls to other programs, which otherwise answer Unreachable: {"payments": {"charge": [{"payment": 7}, {"error": "Rejected", "reason": "card declined"}, "timeout", "unreachable"]}}, by the Remote parameter\'s name and the method. Each call takes the next answer for its method: the reply\'s value as JSON, a refusal ({"error": "Skew", …} for a key used for another message), no answer in time, or none; once they run out, Unreachable. A repeated `once` key gets the reply or refusal it got before; after a timeout or none, it takes the next answer.',
  additionalProperties: { type: 'object', additionalProperties: { type: 'array', items: {} } },
} as const;
export const TRACE_MODES = ['lines', 'full', 'none'] as const;
export const EFFECTS_MODES = ['compact', 'full'] as const;
export const COMPILE_INPUT = {
  type: 'object',
  properties: { files: FILES_SCHEMA },
  additionalProperties: false,
} as const;
export const TEST_INPUT = COMPILE_INPUT;
export const RUN_INPUT = {
  type: 'object',
  properties: {
    files: FILES_SCHEMA,
    requests: REQUESTS_SCHEMA,
    trace: {
      type: 'string',
      enum: TRACE_MODES,
      description:
        'lines (the default for one request): the line trace, each arm tried (✓ taken, ✗ not) at its file:line with the effects it made, a trap at its line; full: OTLP/JSON; none (the default for more than one request: ask for lines to see them).',
    },
    remotes: REMOTES_SCHEMA,
    effects: {
      type: 'string',
      enum: EFFECTS_MODES,
      description: `compact (the default): a query's rows only when it returned at most ${LIMITS.compactRows}; full: all.`,
    },
  },
  required: ['requests'],
  additionalProperties: false,
} as const;

/** Arguments with keys that are not the tool's: refused, so a misspelt `file` is not silently ignored. */
export const unknownKeys = (args: Fields, known: readonly string[]): Refusal | null => {
  const extra = Object.keys(args).filter(k => !known.includes(k));
  return extra.length === 0
    ? null
    : refused(
        400,
        'unknown_argument',
        `unknown argument ${extra.map(k => JSON.stringify(k)).join(', ')}: this tool takes ${known.join(' and ')}`,
      );
};

/** run's `remotes`, or why not: by Remote, by method, a list of answers (runner.ts Scripts). */
export function remotesOf(args: Fields): Scripts | Refusal {
  const given = args['remotes'];
  if (given === undefined || given === null) return {};
  const bad = (why: string): Refusal =>
    refused(
      400,
      'bad_remotes',
      `${why}; \`remotes\` is {"<Remote>": {"<method>": [answers]}}, an answer the reply's value, {"error": "Rejected", "reason": "…"}, "timeout" or "unreachable"`,
    );
  if (!isFields(given)) return bad('`remotes` is not an object');
  let answers = 0;
  const out: Record<string, Record<string, unknown[]>> = {};
  for (const [to, methods] of Object.entries(given)) {
    if (!isFields(methods)) return bad(`remotes.${to} is not an object of methods`);
    const mine: Record<string, unknown[]> = {};
    out[to] = mine;
    for (const [method, list] of Object.entries(methods)) {
      if (!Array.isArray(list)) return bad(`remotes.${to}.${method} is not a list`);
      const listed: unknown[] = list;
      mine[method] = listed;
      answers += list.length;
      for (const [i, a] of list.entries()) {
        const at = `remotes.${to}.${method}[${i}]`;
        if (typeof a === 'string' && a !== 'timeout' && a !== 'unreachable')
          return bad(`${at} is ${JSON.stringify(a.slice(0, 40))}: a text answer is "timeout" or "unreachable"`);
        if (
          isFields(a) &&
          'error' in a &&
          !((a['error'] === 'Rejected' || a['error'] === 'Skew') && typeof a['reason'] === 'string')
        )
          return bad(`${at} has "error" but is not {"error": "Rejected" or "Skew", "reason": "…"}`);
      }
    }
  }
  if (answers > LIMITS.requests * 4) return bad(`${answers} answers; a run takes at most ${LIMITS.requests * 4}`);
  return out;
}

/** The program's files, as the compiler takes them, or why not. No files: examples/hello.tape. */
export function filesOf(args: Fields, deps: Deps): Source[] | Refusal {
  const files = args['files'];
  if (files === undefined || files === null) return [deps.hello];
  if (!Array.isArray(files)) return refused(400, 'bad_files', '`files` is a list of {name, text}');
  if (files.length === 0) return refused(400, 'bad_files', '`files` is empty: leave it out to use examples/hello.tape');
  if (files.length > LIMITS.files)
    return refused(413, 'too_many_files', `${files.length} files; a program here has at most ${LIMITS.files}`);
  const out: Source[] = [],
    seen = new Set<string>();
  let bytes = 0;
  for (const [i, f] of files.entries()) {
    if (!isFields(f) || typeof f['name'] !== 'string' || typeof f['text'] !== 'string')
      return refused(400, 'bad_files', `files[${i}] is not {name: string, text: string}`);
    const extra = Object.keys(f).filter(k => !fieldsOfSchema(FILE_SCHEMA).includes(k));
    if (extra.length > 0)
      return refused(400, 'bad_files', `files[${i}] has ${extra.join(', ')}; a file is {name, text}`);
    const name = f['name'];
    if (!FILE_NAME.test(name))
      return refused(
        400,
        'bad_file_name',
        `files[${i}].name ${JSON.stringify(name.slice(0, 80))} is not a file name: letters, digits, _ and -, ending in .tape (hello.tape)`,
      );
    if (seen.has(name)) return refused(400, 'bad_files', `two files are named ${name}`);
    seen.add(name);
    bytes += enc.encode(f['text']).length;
    if (bytes > LIMITS.sourceBytes)
      return refused(413, 'source_too_large', `the files are more than ${LIMITS.sourceBytes} bytes together`);
    out.push({ name, text: f['text'] });
  }
  return out;
}

/**
 * The requests, or why not: each `METHOD SP TARGET`, then optionally a line feed and a body; or {request, at_ms},
 * at_ms a whole number of ms from the run's start, never less than the one before it.
 */
export function requestsOf(args: Fields): RunRequest[] | Refusal {
  const requests = args['requests'];
  if (!Array.isArray(requests) || requests.length === 0)
    return refused(400, 'bad_requests', '`requests` is a list of at least one request, such as "GET /hello/ada"');
  if (requests.length > LIMITS.requests)
    return refused(413, 'too_many_requests', `${requests.length} requests; a run takes at most ${LIMITS.requests}`);
  const out: RunRequest[] = [];
  let before = 0;
  for (const [i, item] of requests.entries()) {
    let r: unknown = item,
      at: number | null = null;
    if (isFields(item)) {
      const extra = Object.keys(item).filter(k => !fieldsOfSchema(TIMED_REQUEST_SCHEMA).includes(k));
      if (extra.length > 0)
        return refused(
          400,
          'bad_requests',
          `requests[${i}] has ${extra.join(', ')}; a request is text, or {request, at_ms}`,
        );
      r = item['request'];
      const ms = item['at_ms'];
      if (ms !== undefined && ms !== null) {
        if (typeof ms !== 'number' || !Number.isSafeInteger(ms) || ms < 0 || ms > LIMITS.atMs)
          return refused(
            400,
            'bad_at_ms',
            `requests[${i}].at_ms is ${JSON.stringify(ms)}; it is a whole number of ms from the run's start, 0 to ${LIMITS.atMs}`,
          );
        if (ms < before)
          return refused(
            400,
            'bad_at_ms',
            `requests[${i}].at_ms is ${ms}, before the ${before} of a request before it: the run's clock only goes forward`,
          );
        at = before = ms;
      }
    }
    if (typeof r !== 'string') return refused(400, 'bad_requests', `requests[${i}] is not text, or {request, at_ms}`);
    const nl = r.indexOf('\n'),
      line = nl < 0 ? r : r.slice(0, nl),
      body = nl < 0 ? '' : r.slice(nl + 1);
    if (enc.encode(line).length > LIMITS.lineBytes)
      return refused(413, 'request_too_large', `requests[${i}]'s first line is more than ${LIMITS.lineBytes} bytes`);
    if (!REQUEST_LINE.test(line)) {
      // a space inside the target: the line with each written as %20, when that is a request line
      const [, method, target] = /^([A-Z]{1,16}) (\/.*\S)$/.exec(line) ?? [];
      const spaced = method && target ? `${method} ${target.replaceAll(' ', '%20')}` : null;
      return refused(
        400,
        'bad_request_line',
        spaced && REQUEST_LINE.test(spaced)
          ? `requests[${i}] starts ${JSON.stringify(line.slice(0, 80))}: a space in the target is sent as %20, so write ${JSON.stringify(spaced.slice(0, 80))}; a request is METHOD SP TARGET, then optionally a line feed and a body`
          : `requests[${i}] starts ${JSON.stringify(line.slice(0, 80))}; a request is METHOD SP TARGET, then optionally a line feed and a body: "GET /hello/ada" or "POST /links\\n{\\"url\\":\\"https://example.com\\"}"`,
      );
    }
    if (enc.encode(body).length > LIMITS.requestBodyBytes)
      return refused(413, 'request_too_large', `requests[${i}]'s body is more than ${LIMITS.requestBodyBytes} bytes`);
    out.push({ request: r, at_ms: at });
  }
  return out;
}

/** An argument that is one of a few words, or its default when it is absent. */
function modeOf<T extends string>(args: Fields, name: string, modes: readonly T[], fallback: T): T | Refusal {
  const given = args[name];
  if (given === undefined || given === null) return fallback;
  // the mode quoted twice ("\"none\"", JSON inside the JSON) is the mode: agents send it often enough to accept it
  const v = typeof given === 'string' && /^"[a-z]+"$/.test(given) ? given.slice(1, -1) : given;
  const found = modes.find(m => m === v);
  return (
    found ??
    refused(
      400,
      'bad_arguments',
      `\`${name}\` is ${JSON.stringify(given)}; it is one of ${modes.map(m => `"${m}"`).join(', ')}`,
    )
  );
}

const diagnosticsOf = (
  errors: Built['errors'] | { code: string; file: string; line: number; message: string; hint: string }[],
): Diagnostic[] => errors.map(e => ({ file: e.file, line: e.line, code: e.code, message: e.message, fix: e.hint }));

type Compiled = {
  built: Built | null;
  /** the build with { trace: true }, when asked for: made from the same parse and checks (compileAlso) */
  traced: Built | null;
  diagnostics: Diagnostic[];
  files: Source[];
  /** what the compile took (Date.now: in a Worker, the clock does not move while code runs); 0 when cached */
  ms: number;
  /** the builds came from this isolate's cache: the same program was compiled here before */
  cached: boolean;
};

// ---- the compile cache: the builds made in this isolate, by a hash of what they were made from (the compiler,
// the standard library, the files, and whether a traced build is wanted beside the build), refusals too. Compiling
// was 80-87% of the hosted Worker's CPU (profiles of tape 56539ce5, 2026-11-23), and in the 72 h before, 64% of 1195
// hosted calls repeated a program their client had sent already (by its files, size and diagnostics).
// Memory: an entry is counted as 128 KiB, twice its Wasm (both builds) and 8 bytes a source character, which is at
// least what one retains: measured in Node 25 over 20 entries each, the count against the retained heap is hello
// 146/74 KiB, todo 245/69, kv 387/150, tickets 825/100, and with a traced build hello 156/142, todo 327/268, kv
// 450/200, tickets 1093/359. The least recently used goes once the counted bytes pass
// CACHE.bytes, 8 MiB: an isolate has 128 MB; ~15 MB is the Worker at rest and 2 MB std's tokens, one compile needs
// up to ~16 MB live (tickets.tape with its traced build: the smallest old space it completes in is 31 MB, at rest
// 15), so four at once need 64 MB, and ~20 MB is left for collector slack and answers. Builds are frozen (but their
// Wasm bytes: a typed array cannot be), so code that changed a cached one would throw. Every log line says the
// isolate's entries and counted bytes (occupancy), so prod shows what the cache really holds.
/** The bound on the counted bytes (a test lowers it). */
export const CACHE = { bytes: 8 << 20 };
type Kept = Omit<Compiled, 'files' | 'ms' | 'cached'> & { bytes: number };
const kept = new Map<string, Kept>();
let keptBytes = 0;
const stdHashes = new WeakMap<readonly Source[], string>();
const hashOf = (v: unknown): string => sha256(enc.encode(JSON.stringify(v)));
const stdHash = (std: readonly Source[]): string => {
  let h = stdHashes.get(std);
  if (h === undefined) stdHashes.set(std, (h = hashOf(std.map(s => [s.name, s.text]))));
  return h;
};
const frozen = (v: unknown): void => {
  if (typeof v !== 'object' || v === null || ArrayBuffer.isView(v) || Object.isFrozen(v)) return;
  Object.freeze(v);
  for (const x of Object.values(v)) frozen(x);
};
let isolateId: string | null = null;
/** This isolate's id and its compile cache's entries and counted bytes, for the log line. */
export const occupancy = (): { isolate: string; cache_entries: number; cache_bytes: number } => ({
  isolate: (isolateId ??= Math.random().toString(36).slice(2, 10)),
  cache_entries: kept.size,
  cache_bytes: keptBytes,
});
/** The cache's entries and their counted bytes (test.ts). */
export const cacheHeld = (): { entries: number; bytes: number } => ({ entries: kept.size, bytes: keptBytes });
/** What an entry is counted as: see the measurement above CACHE. */
export const entryBytes = (wasm: number, sourceChars: number): number => 128 * 1024 + 2 * wasm + 8 * sourceChars;
function remember(key: string, k: Omit<Kept, 'bytes'>, sourceChars: number): void {
  const bytes = entryBytes((k.built?.wasm.length ?? 0) + (k.traced?.wasm.length ?? 0), sourceChars);
  frozen(k);
  for (const [old, e] of kept) {
    if (keptBytes + bytes <= CACHE.bytes) break;
    kept.delete(old);
    keptBytes -= e.bytes;
  }
  kept.set(key, { ...k, bytes });
  keptBytes += bytes;
}

function compiled(args: Fields, deps: Deps, known: readonly string[], traced = false): Compiled | Refusal {
  const extra = unknownKeys(args, known);
  if (extra) return extra;
  const files = filesOf(args, deps);
  if (!Array.isArray(files)) return files;
  const t0 = Date.now();
  const key = hashOf([deps.compiler ?? '', stdHash(deps.std), traced, files.map(f => [f.name, f.text])]);
  const had = kept.get(key);
  if (had) {
    kept.delete(key);
    kept.set(key, had);
    return {
      built: had.built,
      traced: had.traced,
      diagnostics: had.diagnostics,
      files,
      ms: Date.now() - t0,
      cached: true,
    };
  }
  const r = compileAlso([...deps.std, ...files], {}, traced ? [{ trace: true }] : []);
  const made = Array.isArray(r)
    ? { built: r[0], traced: r[1] ?? null, diagnostics: [] }
    : { built: null, traced: null, diagnostics: diagnosticsOf(r.errors) };
  remember(
    key,
    made,
    files.reduce((n, f) => n + f.text.length, 0),
  );
  return { ...made, files, ms: Date.now() - t0, cached: false };
}
const usageOf = (c: Compiled, requests = 0): Usage => ({
  cached: c.cached,
  ...occupancy(),
  codes: c.diagnostics.map(d => d.code),
  files: c.files.length,
  source_bytes: c.files.reduce((n, f) => n + enc.encode(f.text).length, 0),
  requests,
  statuses: [],
  steps: 0,
  step_version: STEP_VERSION,
  compile_ms: c.ms,
  run_ms: 0,
});

/** compile: what the compiler says of the program. */
export function compileTool(args: unknown, deps: Deps): { result: CompileResult | Refusal; usage: Usage | null } {
  if (!isFields(args)) return { result: refused(400, 'bad_arguments', 'the arguments are a JSON object'), usage: null };
  const c = compiled(args, deps, fieldsOfSchema(COMPILE_INPUT));
  if (isRefusal(c)) return { result: c, usage: null };
  const ok = c.built !== null;
  return {
    result: {
      ok,
      diagnostics: c.diagnostics,
      wasm_bytes: c.built?.wasm.length ?? null,
      statements: c.built?.queries.length ?? null,
      step_version: STEP_VERSION,
      cached: c.cached,
    },
    usage: usageOf(c),
  };
}

// ---- run

/** A value of a row or a parameter as JSON: bytes as base64, an integer too large for a double as text. */
const jsonCell = (v: unknown): unknown => {
  if (v instanceof Uint8Array) {
    let binary = '';
    for (const b of v) binary += String.fromCodePoint(b);
    return { base64: btoa(binary) };
  }
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : String(v);
  return v;
};
const unpacked = (v: unknown): unknown => {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};

/** The names each statement's values have in the program's own text (the playground's queryNames, per file). */
const namesOf = (files: readonly Source[]): Map<string, string[]> =>
  new Map(files.flatMap(f => [...queryNames(f.text)]));

function effectsOut(
  built: Built,
  effects: readonly Effect[],
  names: ReadonlyMap<string, string[]>,
  mode: EffectsMode,
): EffectOut[] {
  return effects.flatMap((e): EffectOut[] => {
    if (isHead(e)) return [];
    if ('q' in e) {
      // the playground's line for it: the query in the program's words, and each value's name (`:name`, or `?N`)
      const line = effectLine(built, e, names).sql,
        query = line?.query ?? built.queries[e.q]?.sql ?? `query ${e.q}`;
      const params = Object.fromEntries(e.p.map((v, i) => [line?.binds[i]?.[0] ?? `?${i + 1}`, jsonCell(v)]));
      const shown = e.rows && (mode === 'full' || e.rows.length <= LIMITS.compactRows);
      return [
        {
          kind: 'sql',
          query,
          params,
          ...(e.rows && mode === 'compact' ? { rows_returned: e.rows.length } : {}),
          ...(e.rows && shown ? { rows: e.rows.map(r => r.map(jsonCell)) } : {}),
          ...(e.r === undefined ? {} : { rows_written: e.r }),
          ...(e.undone ? { undone: true as const } : {}),
        },
      ];
    }
    if ('call' in e)
      return [
        {
          kind: 'call',
          to: e.call,
          method: e.method,
          send: unpacked(e.send),
          within_ms: e.within,
          ...(e.once === undefined ? {} : { once: e.once }),
          status: e.status,
          reply: unpacked(e.reply),
        },
      ];
    if ('now' in e) return [{ kind: 'now', now: e.now }];
    if ('random' in e) return [{ kind: 'random', random: e.random }];
    if ('wake' in e)
      return [
        { kind: 'wake', key: e.wake, after_ms: e.after, due: e.due, ...(e.undone ? { undone: true as const } : {}) },
      ];
    return [];
  });
}

/**
 * The request as the service records it (records.ts, Joined), for otlp(): its log with the run's times and, when it
 * trapped, how; each call it made, which nothing served (UNREACHABLE).
 */
export function joinedOf(built: Built, files: readonly Source[], ran: Ran, status: number, response: string): Joined {
  const effects: Entry[] = ran.effects.map((e, i): Entry => {
    if (i !== 0 || !isHead(e)) return e;
    const head: RunHead = { ...e, at: typeof e.at === 'number' ? e.at : ran.at, took: e.took ?? ran.took };
    if (ran.failed) head.failed = ran.failed;
    return head;
  });
  const calls: JoinedCall[] = effects.flatMap(e => ('call' in e ? [{ e, served: null, why: UNREACHABLE }] : []));
  const [head] = ran.effects;
  const [account = 'tape-mcp', program = 'program'] = NAME.split('/');
  return {
    account,
    // the span's service: tape-mcp/<the first file's name>, as the service names a program
    name: files[0]?.name.replace(/\.tape$/, '') ?? program,
    id: head && isHead(head) ? (head.span ?? '') : '',
    version: 1,
    at: ran.at,
    effects,
    source: files.map(f => f.text).join('\n'),
    queries: built.queries.map(q => q.sql),
    request: ran.request,
    status,
    response,
    trace: [],
    error: ran.failed?.error ?? null,
    ...(ran.failed ? { failed: ran.failed } : {}),
    calls,
  };
}

/** A line trace is cut after this many lines; the last says how many were left out. */
export const TRACE_LINES = 200;
/**
 * One run's line trace, as the CLI prints it (cli/run.ts): each function entered, each arm or step tried in the
 * program's files with ✓ (taken) or ✗ (tried, not taken) and its line, and each effect under the line that made
 * it, a query in the program's own words (its :names). A trap ends it, at the line it happened on.
 */
export function lineTraceOf(
  traced: Built,
  files: readonly Source[],
  trace: NonNullable<Ran['trace']>,
  names: ReadonlyMap<string, string[]>,
): string {
  if ('too_long' in trace)
    return `the run took ${trace.too_long} steps; a line trace is made for at most ${TRACE_STEPS} (trace: "full" gives the spans)`;
  const { events, error } = trace;
  const texts = new Map(files.map(f => [f.name, f.text.split('\n')]));
  const at = (file: string, line: number): string =>
    `${file}:${line}  ${(texts.get(file)?.[line - 1] ?? '').trim().slice(0, 100)}`;
  // an arm tried and then matched is shown once, as matched
  const matched = (site: number, i: number): boolean => {
    for (let j = i + 1; j < events.length; j++) {
      const n = events[j];
      if (n && 'site' in n && n.site === site) return n.what === 1;
    }
    return false;
  };
  const out: string[] = [];
  let last: { file: string; line: number } | null = null;
  for (const [i, e] of events.entries()) {
    if ('site' in e) {
      const s = traced.sites[e.site];
      if (!s || !texts.has(s.file)) continue;
      last = { file: s.file, line: s.line };
      if (e.what === 2) out.push(s.fn);
      else if (e.what === 1) out.push(`  ✓ ${at(s.file, s.line)}`);
      else if (e.what === 0 && s.kind !== 'else' && !matched(e.site, i)) out.push(`  ✗ ${at(s.file, s.line)}`);
      continue;
    }
    if ('sql' in e) {
      const sqlEffect: Effect = {
        q: e.sql,
        p: e.p,
        ...(e.r === undefined ? {} : { r: e.r }),
        ...(e.rows === undefined ? {} : { rows: e.rows }),
        ...(e.undone ? { undone: true as const } : {}),
      };
      const l = effectLine(traced, sqlEffect, names);
      const binds = (l.sql?.binds ?? []).map(([k, v]) => `${k}=${v}`).join(' ');
      out.push(`      sql ${l.sql?.query ?? ''}${binds ? `  ${binds}` : ''} -> ${l.sql?.result ?? ''}`);
    } else if ('call' in e) out.push(`      call ${e.call}.${e.method} within ${e.within} ms -> ${e.status}`);
    else if ('wake' in e) out.push(`      wake ${e.wake} after ${e.after} ms${e.undone ? ', undone' : ''}`);
    else if ('now' in e) out.push(`      now -> ${e.now}`);
    else if ('random' in e) out.push(`      random -> ${e.random}`);
  }
  if (error !== null) out.push(`  ✗ ${error}${last ? ` at ${at(last.file, last.line)}` : ''}`);
  return out.length > TRACE_LINES
    ? [...out.slice(0, TRACE_LINES), `… ${out.length - TRACE_LINES} more lines`].join('\n')
    : out.join('\n');
}

const sizeOf = (v: unknown): number =>
  JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? String(x) : x)).length;

type Modes = { trace: TraceMode; effects: EffectsMode };
function resultOf(
  built: Built,
  traced: Built | null,
  files: readonly Source[],
  ran: Ran,
  names: ReadonlyMap<string, string[]>,
  modes: Modes,
): RunResultOne {
  const res = ran.out ? responseOf(ran.out) : null,
    status = ran.failed ? 500 : (res?.status ?? 500),
    full = ran.failed ? ran.failed.error : dec.decode(res?.body ?? new Uint8Array()),
    bytes = res?.body.length ?? enc.encode(full).length,
    cut = bytes > LIMITS.responseBodyBytes,
    body = cut ? dec.decode((res?.body ?? enc.encode(full)).subarray(0, LIMITS.responseBodyBytes)) : full;
  const [head] = ran.effects;
  const effects = effectsOut(built, ran.effects, names, modes.effects),
    trace =
      modes.trace === 'full'
        ? otlp(joinedOf(built, files, ran, status, full))
        : modes.trace === 'lines' && traced !== null && ran.trace
          ? lineTraceOf(traced, files, ran.trace, names)
          : null;
  const large = sizeOf(effects) + sizeOf(trace) > LIMITS.resultBytes;
  return {
    request: ran.request,
    ...(ran.at_ms === undefined ? {} : { at_ms: ran.at_ms }),
    ...(ran.woken ? { woken: ran.woken } : {}),
    status,
    content_type: ran.failed ? null : (res?.type ?? null),
    ...(ran.failed || !res || res.headers.length === 0 ? {} : { headers: res.headers }),
    body,
    body_bytes: bytes,
    truncated: cut,
    error: ran.failed?.error ?? null,
    effects: large ? null : effects,
    replayed: ran.replayed,
    ...(ran.replay_error === null ? {} : { replay_error: ran.replay_error }),
    steps: ran.steps,
    step_version: head && isHead(head) && isStepVersion(head.step_version) ? head.step_version : STEP_VERSION,
    memory_bytes: head && isHead(head) ? (head.bytes ?? null) : null,
    trace: large ? null : trace,
    ...(large
      ? {
          omitted: `the effect log and trace are more than ${LIMITS.resultBytes} bytes as JSON, so both are left out; run fewer requests, return fewer rows, or ask for less (effects: "compact", trace: "lines" or "none")`,
        }
      : {}),
  };
}

/** p, or 'timeout' after ms, whichever comes first; the timer is cleared either way. */
async function within<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<'timeout'>(resolve => {
        timer = setTimeout(() => resolve('timeout'), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** run: compile, then each request in order against one fresh database, each with its log, replay and trace. */
export async function runTool(
  args: unknown,
  deps: Deps,
): Promise<{ result: RunResult | Refusal; usage: Usage | null }> {
  if (!isFields(args)) return { result: refused(400, 'bad_arguments', 'the arguments are a JSON object'), usage: null };
  const requests = requestsOf(args);
  // the line trace by default for one request only: 50 requests' traces made answers of 50,000 to 62,000
  // characters, more than a client shows (the usability bench, twice), and a run of many requests is read for its
  // statuses, bodies and effects; a trace is still there for the asking
  const trace = isRefusal(requests)
    ? requests
    : modeOf<TraceMode>(args, 'trace', TRACE_MODES, requests.length === 1 ? 'lines' : 'none');
  // the line trace's build (with { trace: true }) comes from the same parse and checks as the build: one compile
  const c = compiled(args, deps, fieldsOfSchema(RUN_INPUT), trace === 'lines');
  if (isRefusal(c)) return { result: c, usage: null };
  if (isRefusal(requests)) return { result: requests, usage: null };
  if (isRefusal(trace)) return { result: trace, usage: null };
  const effects = modeOf<EffectsMode>(args, 'effects', EFFECTS_MODES, 'compact');
  if (isRefusal(effects)) return { result: effects, usage: null };
  const remotes = remotesOf(args);
  if (isRefusal(remotes)) return { result: remotes, usage: null };
  const usage = usageOf(c, requests.length);
  const built = c.built;
  if (!built) return { result: { ok: false, diagnostics: c.diagnostics, cached: c.cached, results: [] }, usage };
  // the line trace: the same program built with { trace: true }, each request replayed through it from its log
  const traced = c.traced;
  const tracedWasm = traced?.wasm ?? null;
  const program = { wasm: built.wasm, build: built.build, ...(tracedWasm ? { traced: tracedWasm } : {}) };
  const t0 = Date.now();
  let all: RanAll | 'timeout';
  try {
    all = await within(deps.run(program, requests, remotes), deps.wallMs ?? LIMITS.wallMs);
  } catch (e) {
    usage.run_ms = Date.now() - t0;
    return {
      result: refused(
        503,
        'run_failed',
        `the program's run stopped before it finished (${messageOf(e).slice(0, 300)}); its CPU per call is limited to ${LIMITS.cpuMs} ms and its memory to 128 MB`,
      ),
      usage,
    };
  }
  usage.run_ms = Date.now() - t0;
  if (all !== 'timeout')
    usage.run = {
      run_id: all.run_id ?? null,
      program_bytes: all.memory?.program_bytes ?? null,
      sqlite_bytes: all.memory?.sqlite_bytes ?? null,
    };
  if (all === 'timeout')
    return {
      result: refused(
        504,
        'run_timeout',
        `the requests took more than ${deps.wallMs ?? LIMITS.wallMs} ms together; send fewer, or less work each`,
      ),
      usage,
    };
  // The Worker's own reading of the RPC (index.ts) when it sent one; otherwise the wait just measured, which
  // in Node is the in-process run (the clock there does advance during compute). Date.now is already a whole
  // millisecond, so there is nothing to reject.
  const fromCaller = all.invoke_wall_ms;
  const invoke_wall_ms = typeof fromCaller === 'number' ? fromCaller : usage.run_ms;
  const timed = { invoke_wall_ms };
  if (!all.ok)
    return {
      result: { ok: false, diagnostics: [], cached: c.cached, error: all.error, results: [], ...timed },
      usage,
    };
  const names = namesOf(c.files);
  const tracedBuilt = traced?.wasm ? traced : null;
  const results = all.runs.map(ran => resultOf(built, tracedBuilt, c.files, ran, names, { trace, effects }));
  usage.statuses = results.map(r => r.status);
  usage.steps = all.runs.reduce((n, r) => n + r.steps, 0);
  return {
    result: {
      ok: results.every(r => r.error === null && r.replayed !== false),
      diagnostics: [],
      cached: c.cached,
      results,
      ...timed,
      ...(all.timers ? { timers: all.timers } : {}),
    },
    usage,
  };
}

// ---- test

/** One doc example (doctest.ts): where it is, what it says, and how it came out. */
export type ExampleOut = {
  file: string;
  line: number;
  example: string;
  expected: string | null;
  ok: boolean;
  /** what it gave instead, when it gave something else */
  got?: string;
  /** why it could not hold: a compile error, a trap, no expected line */
  error?: string;
};
export type TestResult = {
  ok: boolean;
  diagnostics: Diagnostic[];
  /** the build came from this isolate's cache (CompileResult.cached) */
  cached: boolean;
  examples: ExampleOut[];
  passed: number;
  failed: number;
  /** the step accounting the examples were compiled with */
  step_version: StepVersion;
};

/** test: the doc examples in the program's files, as `tape test` runs them (doctest.ts), each called in deps.examples. */
export async function testTool(
  args: unknown,
  deps: Deps,
): Promise<{ result: TestResult | Refusal; usage: Usage | null }> {
  if (!isFields(args)) return { result: refused(400, 'bad_arguments', 'the arguments are a JSON object'), usage: null };
  const c = compiled(args, deps, fieldsOfSchema(TEST_INPUT));
  if (isRefusal(c)) return { result: c, usage: null };
  const usage = usageOf(c);
  // examples never call handle: a library of pure functions, with none, is tested as it is (C30 is for a program)
  const library = !c.built && c.diagnostics.length > 0 && c.diagnostics.every(d => d.code === 'C30');
  if (!c.built && !library)
    return {
      result: {
        ok: false,
        diagnostics: c.diagnostics,
        cached: c.cached,
        examples: [],
        passed: 0,
        failed: 0,
        step_version: STEP_VERSION,
      },
      usage,
    };
  const sources = [...deps.std, ...c.files];
  const t0 = Date.now();
  const prepared = c.files.map(f => prepare(sources, f.name));
  usage.compile_ms += Date.now() - t0;
  const t1 = Date.now();
  const calls = async (): Promise<Called[][][]> => {
    const out: Called[][][] = [];
    // oxlint-disable-next-line no-await-in-loop -- one Dynamic Worker at a time
    for (const p of prepared) out.push(await Promise.all(p.batches.map(b => deps.examples(b.wasm, b.fns))));
    return out;
  };
  let called: Called[][][] | 'timeout';
  try {
    called = await within(calls(), deps.wallMs ?? LIMITS.wallMs);
  } catch (e) {
    usage.run_ms = Date.now() - t1;
    return {
      result: refused(
        503,
        'run_failed',
        `the examples' run stopped before it finished (${messageOf(e).slice(0, 300)}); its CPU per call is limited to ${LIMITS.cpuMs} ms and its memory to 128 MB`,
      ),
      usage,
    };
  }
  usage.run_ms = Date.now() - t1;
  if (called === 'timeout')
    return {
      result: refused(504, 'run_timeout', `the examples took more than ${deps.wallMs ?? LIMITS.wallMs} ms together`),
      usage,
    };
  const done = called;
  const examples = prepared.flatMap((p, i) =>
    finish(p, done[i] ?? []).map((r): ExampleOut => ({
      file: r.file,
      line: r.line,
      example: r.expr,
      expected: r.want,
      ok: r.ok,
      ...(r.ok ? {} : r.error === null ? { got: r.got } : { error: r.error }),
    })),
  );
  const passed = examples.filter(e => e.ok).length;
  return {
    result: {
      ok: passed === examples.length,
      diagnostics: [],
      cached: c.cached,
      examples,
      passed,
      failed: examples.length - passed,
      step_version: STEP_VERSION,
    },
    usage,
  };
}
