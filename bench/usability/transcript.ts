// bench/usability/transcript.ts: what one agent's transcript says. A transcript is the CLI's stream-json, one
// message a line, each wrapped by the runner as {"t": <ms since the agent started>, "m": <message>}.
import { field, isObj, parseObj, recs, str } from './lib.ts';
import type { File } from './lib.ts';

/** One call of compile or run with a program: an attempt to compile. */
export type Attempt = {
  tool: 'compile' | 'run';
  t: number;
  /** tool calls of any kind up to and including this one */
  calls: number;
  compiled: boolean;
  codes: string[];
  /** each diagnostic's first line, for the report's excerpts */
  messages: { code: string; message: string; fix: string }[];
  refusal: string | null;
};
export type Feedback = { kind: string; text: string; id: string | null; t: number };
export type Metrics = {
  wallMs: number;
  firstCompileMs: number | null;
  callsToFirstCompile: number | null;
  compileAttempts: number;
  failedAttempts: number;
  runCalls: number;
  toolCalls: number;
  toolCounts: Record<string, number>;
  diagnostics: Record<string, number>;
  /** ms from each failed attempt to the next attempt (or the end), shared among its distinct codes */
  lostMsByCode: Record<string, number>;
  attempts: Attempt[];
  feedback: Feedback[];
  rateLimited: number;
  costUsd: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  turns: number;
  finalText: string;
  transcript: string;
  lastCompiledFiles: File[] | null;
  lastFiles: File[] | null;
};

const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : recs(content)
        .map(c => str(c['text']))
        .join('');
const short = (name: string): string => name.replace(/^mcp__tape__/, '');

export const analyse = (lines: string[], wallMs: number): Metrics => {
  const m: Metrics = {
    wallMs,
    firstCompileMs: null,
    callsToFirstCompile: null,
    compileAttempts: 0,
    failedAttempts: 0,
    runCalls: 0,
    toolCalls: 0,
    toolCounts: {},
    diagnostics: {},
    lostMsByCode: {},
    attempts: [],
    feedback: [],
    rateLimited: 0,
    costUsd: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    turns: 0,
    finalText: '',
    transcript: '',
    lastCompiledFiles: null,
    lastFiles: null,
  };
  const pending = new Map<string, { name: string; input: Record<string, unknown>; calls: number }>();
  for (const line of lines) {
    const w = parseObj(line);
    if (w === null) continue;
    const t = Number(w['t']);
    const msg = isObj(w['m']) ? w['m'] : {};
    const content = recs(field(msg['message'], 'content'));
    if (msg['type'] === 'assistant') {
      for (const b of content) {
        if (b['type'] !== 'tool_use' || typeof b['id'] !== 'string' || typeof b['name'] !== 'string') continue;
        m.toolCalls++;
        const name = short(b['name']);
        m.toolCounts[name] = (m.toolCounts[name] ?? 0) + 1;
        pending.set(b['id'], { name, input: isObj(b['input']) ? b['input'] : {}, calls: m.toolCalls });
        if (name === 'run') m.runCalls++;
      }
    } else if (msg['type'] === 'user') {
      for (const b of content) {
        if (b['type'] !== 'tool_result' || typeof b['tool_use_id'] !== 'string') continue;
        const call = pending.get(b['tool_use_id']);
        if (call === undefined) continue;
        const answer = parseObj(textOf(b['content'])) ?? {};
        if (answer['error'] === 'rate_limited' || answer['error'] === 'feedback_rate_limited') m.rateLimited++;
        if (call.name === 'feedback') {
          m.feedback.push({
            kind: str(call.input['kind']),
            text: str(call.input['text']),
            id: typeof answer['id'] === 'string' ? answer['id'] : null,
            t,
          });
          continue;
        }
        const files = recs(call.input['files']);
        if ((call.name !== 'compile' && call.name !== 'run') || files.length === 0) continue;
        const diags = recs(answer['diagnostics']);
        const compiled = call.name === 'compile' ? answer['ok'] === true : recs(answer['results']).length > 0;
        const a: Attempt = {
          tool: call.name,
          t,
          calls: call.calls,
          compiled,
          codes: diags.map(d => str(d['code'])),
          messages: diags.map(d => ({
            code: str(d['code']),
            message: str(d['message']).split('\n')[0] ?? '',
            fix: str(d['fix']).split('\n')[0] ?? '',
          })),
          refusal: typeof answer['error'] === 'string' ? `${answer['error']}: ${str(answer['reason'])}` : null,
        };
        m.attempts.push(a);
        const program = files.map(f => ({ name: str(f['name']), text: str(f['text']) }));
        m.lastFiles = program;
        if (compiled) m.lastCompiledFiles = program;
        if (compiled && m.firstCompileMs === null) {
          m.firstCompileMs = t;
          m.callsToFirstCompile = call.calls;
        }
      }
    } else if (msg['type'] === 'result') {
      m.costUsd = Number(msg['total_cost_usd'] ?? 0);
      m.turns = Number(msg['num_turns'] ?? 0);
      m.finalText = str(msg['result']);
      const u = isObj(msg['usage']) ? msg['usage'] : {};
      m.tokens = {
        input: Number(u['input_tokens'] ?? 0),
        output: Number(u['output_tokens'] ?? 0),
        cacheRead: Number(u['cache_read_input_tokens'] ?? 0),
        cacheWrite: Number(u['cache_creation_input_tokens'] ?? 0),
      };
    }
  }
  m.compileAttempts = m.attempts.length;
  // Refusals before compiling (a bad file name, too large) are not compiles and carry no codes.
  m.failedAttempts = m.attempts.filter(a => !a.compiled).length;
  m.attempts.forEach((a, i) => {
    for (const c of a.codes) m.diagnostics[c] = (m.diagnostics[c] ?? 0) + 1;
    if (a.compiled) return;
    const distinct = [...new Set(a.codes.length > 0 ? a.codes : [a.refusal === null ? '(none)' : 'refused'])];
    const next = m.attempts[i + 1]?.t ?? wallMs;
    for (const c of distinct) m.lostMsByCode[c] = (m.lostMsByCode[c] ?? 0) + (next - a.t) / distinct.length;
  });
  return m;
};
