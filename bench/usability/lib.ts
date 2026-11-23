// bench/usability/lib.ts: what the graders, the runner and the report share. The graders reach prod through the
// MCP `run` tool (JSON-RPC over HTTP, as an agent does), so a program is graded by the runtime it was written for.
export const MCP_URL = process.env['TAPE_MCP_URL'] ?? 'https://tape.ivar.workers.dev/mcp';

export type File = { name: string; text: string };
export type Effect = { kind: string; [k: string]: unknown };
/** One request's answer from `run`, with its body parsed as JSON when it is JSON. */
export type Res = {
  request: string;
  status: number;
  /** the response headers the program set, names in lower case (run leaves them out when there are none) */
  headers: { name: string; value: string }[];
  body: string;
  json: unknown;
  error: string | null;
  effects: Effect[];
};
export type RunAnswer = {
  ok: boolean;
  compiled: boolean;
  diagnostics: { code: string; line: number; file: string; message: string }[];
  results: Res[];
  error?: string;
};

/** A check the grader could not make (`skipped`) counts neither way. */
export type Check = { name: string; pass: boolean; detail?: string; skipped?: boolean };
/** A scenario is a sequence of requests on one fresh database, and what must hold of the answers. */
export type Scenario = {
  name: string;
  requests: string[];
  checks: (rs: Res[]) => Check[];
  /** A second call made from what the first answered (on a fresh database, so it sends what it needs again). */
  followup?: (rs: Res[]) => Scenario | null;
};
export type Grader = { task: string; scenarios: Scenario[] };

// Reading JSON whose shape is not known: guards, not assertions.
export const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
export const parseObj = (s: string): Record<string, unknown> | null => {
  try {
    const v: unknown = JSON.parse(s);
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
};
/** The records of an array (anything else is left out); none when it is not an array. */
export const recs = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isObj) : []);
/** A value as text: a string as it is, nothing as '', anything else as JSON. */
export const str = (v: unknown): string =>
  typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v);
const pause = async (ms: number): Promise<void> => {
  await new Promise<void>(done => {
    setTimeout(done, ms);
  });
};

let rpcId = 0;
/** Calls one MCP tool and gives back its JSON answer, waiting out the service's rate limit. */
export const callTool = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(MCP_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'tape-usability-bench' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
    });
    const text = await r.text();
    const content = recs(field(parseObj(text)?.['result'], 'content'))[0];
    const answer = parseObj(str(content?.['text'])) ?? {
      ok: false,
      error: `http ${r.status}`,
      reason: text.slice(0, 300),
    };
    if ((r.status === 429 || answer['error'] === 'rate_limited') && attempt < 8) {
      await pause(5000 * (attempt + 1));
      continue;
    }
    return answer;
  }
};

const parsed = (body: string): unknown => {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
};

/** `run` on prod: the program and up to 20 requests on one fresh in-memory database. */
export const run = async (files: File[], requests: string[]): Promise<RunAnswer> => {
  const a = await callTool('run', { files, requests });
  const results = recs(a['results']).map((x): Res => ({
    request: str(x['request']),
    status: Number(x['status']),
    headers: recs(x['headers']).map(h => ({ name: str(h['name']).toLowerCase(), value: str(h['value']) })),
    body: str(x['body']),
    json: parsed(str(x['body'])),
    error: typeof x['error'] === 'string' ? x['error'] : null,
    effects: recs(x['effects']).map(e => ({ ...e, kind: str(e['kind']) })),
  }));
  const answer: RunAnswer = {
    ok: a['ok'] === true,
    compiled: results.length > 0,
    diagnostics: recs(a['diagnostics']).map(d => ({
      code: str(d['code']),
      line: Number(d['line']),
      file: str(d['file']),
      message: str(d['message']),
    })),
    results,
  };
  if (typeof a['error'] === 'string') answer.error = `${a['error']}: ${str(a['reason'])}`;
  return answer;
};

// Predicates. Every grader is written from its task's spec, never from a solution.
export const field = (v: unknown, k: string): unknown => (isObj(v) ? v[k] : undefined);
/** A response header's value by name (any case), or null when the response did not set it. */
export const headerOf = (r: Res | undefined, name: string): string | null =>
  r?.headers.find(h => h.name === name.toLowerCase())?.value ?? null;
export const check = (name: string, pass: boolean, detail?: string): Check =>
  pass ? { name, pass } : { name, pass, detail: detail ?? '' };
const shown = (r: Res | undefined): string =>
  r === undefined ? 'no answer' : `${r.status} ${r.body.slice(0, 160)}${r.error === null ? '' : ` (${r.error})`}`;
/** The answer has this status (or one of these). */
export const status = (name: string, r: Res | undefined, ...want: number[]): Check =>
  check(name, r !== undefined && want.includes(r.status), `want ${want.join('|')}, got ${shown(r)}`);
/** The answer has this status and its JSON body passes `ok`. */
export const json = (name: string, r: Res | undefined, want: number[], ok: (j: unknown) => boolean): Check => {
  let pass = false;
  try {
    pass = r !== undefined && want.includes(r.status) && ok(r.json);
  } catch {
    pass = false;
  }
  return check(name, pass, `want ${want.join('|')} and a body that passes, got ${shown(r)}`);
};
/** A 4xx with a JSON body {"error": "<text>"}. */
export const problem = (name: string, r: Res | undefined, ...want: number[]): Check =>
  json(name, r, want, j => typeof field(j, 'error') === 'string' && String(field(j, 'error')).length > 0);
export const skip = (name: string, why: string): Check => ({ name, pass: false, skipped: true, detail: why });
export const req = (method: string, target: string, body?: unknown): string =>
  body === undefined
    ? `${method} ${target}`
    : `${method} ${target}\n${typeof body === 'string' ? body : JSON.stringify(body)}`;
