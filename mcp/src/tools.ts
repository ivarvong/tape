// tools.ts: the two tools, compile and run, as functions of their JSON arguments (the third, feedback, is feedback.ts). The same functions answer MCP's
// tools/call and POST /v1/compile and /v1/run (serve.ts). They use no Workers API: how a program is run is given
// (Deps.run: in production a Dynamic Worker, index.ts; in test.ts, runner.ts in Node), so test.ts runs them as
// they are.
//
// Two tools on purpose. Others an agent could use (fmt, the simulator, a trace as text, a program's tables) would
// each be a field of these or a third tool; they wait until someone asks, so the list an agent reads stays short.
import { compile } from '../../compiler.ts';
import type { Built, Source } from '../../compiler.ts';
import { isHead } from '../../host.ts';
import type { Effect, Header } from '../../host.ts';
import { responseOf } from '../../host.ts';
import { effectLine, queryNames } from '../../apps/playground/src/lines.ts';
import { otlp } from '../../service/src/view.ts';
import type { Otlp } from '../../service/src/view.ts';
import type { Entry, Joined, JoinedCall, RunHead } from '../../service/src/records.ts';
import { NAME, TRACE_STEPS, UNREACHABLE } from './runner.ts';
import type { Ran, RanAll, RunRequest } from './runner.ts';

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
  run: (program: Program, requests: readonly RunRequest[]) => Promise<RanAll>;
  /** the wall-clock guard on a run call (LIMITS.wallMs; a test shortens it) */
  wallMs?: number;
};

export type Diagnostic = { file: string; line: number; code: string; message: string; fix: string };
export type CompileResult = {
  ok: boolean;
  diagnostics: Diagnostic[];
  wasm_bytes: number | null;
  /** the SQL statements the program can run */
  statements: number | null;
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
export type TraceMode = 'lines' | 'full' | 'none';
export type EffectsMode = 'compact' | 'full';
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
  memory_bytes: number | null;
  trace: Otlp | string | null;
  omitted?: string;
};
export type RunResult = {
  ok: boolean;
  diagnostics: Diagnostic[];
  error?: string;
  results: RunResultOne[];
  /** on the run's own clock: the timers that ran, and those still set at the end */
  timers?: { fired: number; pending: number };
};
/** What the log line says of a call, beside what serve.ts knows (serve.ts, logLine). */
export type Usage = {
  codes: string[];
  files: number;
  source_bytes: number;
  requests: number;
  statuses: number[];
  steps: number;
  compile_ms: number;
  run_ms: number;
};

const enc = new TextEncoder(),
  dec = new TextDecoder();
type Fields = Readonly<Record<string, unknown>>;
const isFields = (v: unknown): v is Fields => typeof v === 'object' && v !== null && !Array.isArray(v);
const FILE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,62}\.tape$/;
const REQUEST_LINE = /^[A-Z]{1,16} \/\S*$/;

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
    const extra = Object.keys(f).filter(k => k !== 'name' && k !== 'text');
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
      const extra = Object.keys(item).filter(k => k !== 'request' && k !== 'at_ms');
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
    if (!REQUEST_LINE.test(line))
      return refused(
        400,
        'bad_request_line',
        `requests[${i}] starts ${JSON.stringify(line.slice(0, 80))}; a request is METHOD SP TARGET, then optionally a line feed and a body: "GET /hello/ada" or "POST /links\\n{\\"url\\":\\"https://example.com\\"}"`,
      );
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

type Compiled = { built: Built | null; diagnostics: Diagnostic[]; files: Source[]; ms: number };
function compiled(args: Fields, deps: Deps, known: readonly string[]): Compiled | Refusal {
  const extra = unknownKeys(args, known);
  if (extra) return extra;
  const files = filesOf(args, deps);
  if (!Array.isArray(files)) return files;
  const t0 = Date.now(),
    r = compile([...deps.std, ...files]),
    ms = Date.now() - t0;
  return r.wasm === null
    ? { built: null, diagnostics: diagnosticsOf(r.errors), files, ms }
    : { built: r, diagnostics: [], files, ms };
}
const usageOf = (c: Compiled, requests = 0): Usage => ({
  codes: c.diagnostics.map(d => d.code),
  files: c.files.length,
  source_bytes: c.files.reduce((n, f) => n + enc.encode(f.text).length, 0),
  requests,
  statuses: [],
  steps: 0,
  compile_ms: c.ms,
  run_ms: 0,
});

/** compile: what the compiler says of the program. */
export function compileTool(args: unknown, deps: Deps): { result: CompileResult | Refusal; usage: Usage | null } {
  if (!isFields(args)) return { result: refused(400, 'bad_arguments', 'the arguments are a JSON object'), usage: null };
  const c = compiled(args, deps, ['files']);
  if (isRefusal(c)) return { result: c, usage: null };
  const ok = c.built !== null;
  return {
    result: {
      ok,
      diagnostics: c.diagnostics,
      wasm_bytes: c.built?.wasm.length ?? null,
      statements: c.built?.queries.length ?? null,
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
    else if ('json' in e) out.push(`      json: ${e.json}`);
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
  const c = compiled(args, deps, ['files', 'requests', 'trace', 'effects']);
  if (isRefusal(c)) return { result: c, usage: null };
  const requests = requestsOf(args);
  if (isRefusal(requests)) return { result: requests, usage: null };
  const trace = modeOf<TraceMode>(args, 'trace', ['lines', 'full', 'none'], 'lines');
  if (isRefusal(trace)) return { result: trace, usage: null };
  const effects = modeOf<EffectsMode>(args, 'effects', ['compact', 'full'], 'compact');
  if (isRefusal(effects)) return { result: effects, usage: null };
  const usage = usageOf(c, requests.length);
  const built = c.built;
  if (!built) return { result: { ok: false, diagnostics: c.diagnostics, results: [] }, usage };
  // the line trace: the same program built with { trace: true }, each request replayed through it from its log
  const traced = trace === 'lines' ? compile([...deps.std, ...c.files], { trace: true }) : null;
  const tracedWasm = traced?.wasm ?? null;
  const program = { wasm: built.wasm, build: built.build, ...(tracedWasm ? { traced: tracedWasm } : {}) };
  const t0 = Date.now();
  let all: RanAll | 'timeout';
  try {
    all = await within(deps.run(program, requests), deps.wallMs ?? LIMITS.wallMs);
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
  if (all === 'timeout')
    return {
      result: refused(
        504,
        'run_timeout',
        `the requests took more than ${deps.wallMs ?? LIMITS.wallMs} ms together; send fewer, or less work each`,
      ),
      usage,
    };
  if (!all.ok) return { result: { ok: false, diagnostics: [], error: all.error, results: [] }, usage };
  const names = namesOf(c.files);
  const tracedBuilt = traced?.wasm ? traced : null;
  const results = all.runs.map(ran => resultOf(built, tracedBuilt, c.files, ran, names, { trace, effects }));
  usage.statuses = results.map(r => r.status);
  usage.steps = all.runs.reduce((n, r) => n + r.steps, 0);
  return {
    result: {
      ok: results.every(r => r.error === null && r.replayed !== false),
      diagnostics: [],
      results,
      ...(all.timers ? { timers: all.timers } : {}),
    },
    usage,
  };
}
