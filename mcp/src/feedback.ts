// feedback.ts: the third tool. An agent that finds something surprising, wrong or missing in Tape (the language, the
// compiler, these tools) reports it, ideally with the smallest program that shows it; the report is stored, one
// object per report, in a private R2 bucket the maintainers read (mcp/scripts/feedback.ts). Nothing is ever served
// back from it. Like tools.ts it uses no Workers API: the store and the rate limiter are given (serve.ts, Gate).
//
// What is stored: the fields sent, the time, the tape-mcp version, the daily salted hash of the client's address (as
// the log has it, never the address), the user agent and the MCP protocol version header, and, when a program is
// sent, what the compiler says of it now, so a report says which version it reproduced on.
import { compile } from '../../compiler.ts';
import {
  FILES_SCHEMA,
  REQUESTS_SCHEMA,
  fieldsOfSchema,
  filesOf,
  isRefusal,
  occupancy,
  refused,
  requestsOf,
  unknownKeys,
} from './tools.ts';
import type { Deps, Refusal, Usage } from './tools.ts';

export const FEEDBACK = {
  /** the text of a report, and each of expected and actual, in UTF-8 bytes */
  textBytes: 8 * 1024,
  /** reports a minute per client (the FEEDBACK_RATE binding; the platform's periods are 10 s or 60 s) */
  perMinute: 5,
} as const;
export const KINDS = ['bug', 'confusing', 'missing', 'idea', 'praise'] as const;
/** What feedback takes: its inputSchema (serve.ts, listing), and the fields it reads (as tools.ts's RUN_INPUT). */
export const FEEDBACK_INPUT = {
  type: 'object',
  properties: {
    text: {
      type: 'string',
      minLength: 1,
      maxLength: FEEDBACK.textBytes,
      description: 'What you found, in a few sentences: what you did, and why it surprised you.',
    },
    kind: { type: 'string', enum: KINDS, description: 'What sort of report it is.' },
    files: { ...FILES_SCHEMA, description: 'The minimal program that shows it, if there is one.' },
    requests: { ...REQUESTS_SCHEMA, description: 'The requests that show it, as run takes them.' },
    expected: { type: 'string', maxLength: FEEDBACK.textBytes, description: 'What you expected.' },
    actual: { type: 'string', maxLength: FEEDBACK.textBytes, description: 'What happened instead.' },
  },
  required: ['text'],
  additionalProperties: false,
} as const;
const ARGS = fieldsOfSchema(FEEDBACK_INPUT);

/** Where reports go, and how often a client may send one: from the Worker's bindings (index.ts). */
export type Store = {
  put: (key: string, body: string) => Promise<void>;
  limiter: { limit: (o: { key: string }) => Promise<{ success: boolean }> } | null;
};
/** What the server knows of the call, beside its arguments. */
export type CallMeta = {
  ip_hash: string;
  user_agent: string;
  mcp_protocol_version: string | null;
  tape_mcp_version: string | null;
  /** a deploy's smoke (x-tape-synthetic): stored under smoke/, apart from real reports */
  smoke: boolean;
};

const enc = new TextEncoder();
type Fields = Readonly<Record<string, unknown>>;
const isFields = (v: unknown): v is Fields => typeof v === 'object' && v !== null && !Array.isArray(v);
const hex = (bytes: Uint8Array): string => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
const bytesOf = (s: string): number => enc.encode(s).length;

/** An optional text field (expected, actual): absent, or text of at most FEEDBACK.textBytes. */
const textField = (args: Fields, k: string): string | null | Refusal => {
  const v = args[k];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') return refused(400, 'bad_field', `\`${k}\` is text`);
  if (bytesOf(v) > FEEDBACK.textBytes)
    return refused(413, 'field_too_large', `\`${k}\` is more than ${FEEDBACK.textBytes} bytes`);
  return v;
};

/** The time as an object key's part: ISO 8601 in its basic form (no colons), 20261122T221914.833Z. */
const stamp = (d: Date): string => d.toISOString().replaceAll(/[-:]/g, '');

/** feedback: store one report; its id is how the maintainers find it. */
export async function feedbackTool(
  args: unknown,
  deps: Deps,
  meta: CallMeta,
  store: Store | null,
): Promise<{ result: { ok: true; id: string } | Refusal; usage: Usage | null }> {
  const no = (r: Refusal): { result: Refusal; usage: null } => ({ result: r, usage: null });
  if (!store)
    return no(refused(503, 'feedback_unavailable', 'this deployment has nowhere to store feedback; try again later'));
  if (!isFields(args)) return no(refused(400, 'bad_arguments', 'the arguments are a JSON object'));
  const extra = unknownKeys(args, ARGS);
  if (extra) return no(extra);
  const text = args['text'];
  if (typeof text !== 'string' || text.trim() === '')
    return no(refused(400, 'bad_text', '`text` is required: what you found, in a few sentences'));
  if (bytesOf(text) > FEEDBACK.textBytes)
    return no(refused(413, 'text_too_large', `\`text\` is more than ${FEEDBACK.textBytes} bytes`));
  const kind = args['kind'];
  if (kind !== undefined && kind !== null && !KINDS.some(k => k === kind))
    return no(refused(400, 'bad_kind', `\`kind\` is one of ${KINDS.join(', ')}, or left out`));
  const files = args['files'] === undefined || args['files'] === null ? null : filesOf(args, deps);
  if (isRefusal(files)) return no(files);
  const requests = args['requests'] === undefined || args['requests'] === null ? null : requestsOf(args);
  if (isRefusal(requests)) return no(requests);
  const expected = textField(args, 'expected');
  if (isRefusal(expected)) return no(expected);
  const actual = textField(args, 'actual');
  if (isRefusal(actual)) return no(actual);
  if (store.limiter) {
    const { success } = await store.limiter.limit({ key: `feedback/${meta.ip_hash}` });
    if (!success)
      return no(
        refused(
          429,
          'feedback_rate_limited',
          `at most ${FEEDBACK.perMinute} reports a minute from one address; wait a minute and send it again`,
        ),
      );
  }
  const t0 = Date.now();
  const built = files ? compile([...deps.std, ...files]) : null;
  const codes = built ? built.errors.map(e => e.code) : [];
  const now = new Date(),
    id = `${stamp(now)}-${hex(crypto.getRandomValues(new Uint8Array(6)))}`,
    day = now.toISOString().slice(0, 10).replaceAll('-', '/'),
    key = `${meta.smoke ? 'smoke/' : ''}${day}/${id}.json`;
  const record = {
    id,
    received_at: now.toISOString(),
    kind: kind ?? null,
    text,
    expected,
    actual,
    files,
    // as run takes them: text, or {request, at_ms} for one sent on the run's own clock
    requests: requests?.map(r => (r.at_ms === null ? r.request : r)) ?? null,
    reproduced: built ? { ok: built.wasm !== null, diagnostic_codes: codes } : null,
    server: {
      tape_mcp_version: meta.tape_mcp_version,
      ip_hash: meta.ip_hash,
      user_agent: meta.user_agent.slice(0, 200),
      mcp_protocol_version: meta.mcp_protocol_version?.slice(0, 40) ?? null,
    },
  };
  const usage: Usage = {
    cached: false,
    ...occupancy(),
    codes,
    files: files?.length ?? 0,
    source_bytes: (files ?? []).reduce((n, f) => n + bytesOf(f.text), 0),
    requests: requests?.length ?? 0,
    statuses: [],
    steps: 0,
    compile_ms: Date.now() - t0,
    run_ms: 0,
  };
  try {
    await store.put(key, JSON.stringify(record));
  } catch {
    return { result: refused(503, 'store_failed', 'the report could not be stored; send it again'), usage };
  }
  return { result: { ok: true, id }, usage };
}
