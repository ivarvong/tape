// view.ts: one request, joined with the calls it made, as a page, as text, or as OTLP/JSON. Pure functions of
// the data Name.joined builds: { account, name, version, ...the request's view, calls: [{ e, served }] }, where
// e is the call's entry in the caller's log and served is what the callee recorded for it (null: nothing).
import { measuredText } from '../../host/log.ts';
import type { CallEffect } from '../../host/log.ts';
import { isCheckHead, isMigrationsHead, isRunHead } from './records.ts';
import type {
  CheckHead,
  CheckProblem,
  Entry,
  Invoked,
  Joined,
  JoinedCall,
  MigrateStep,
  MigrationsHead,
  Routed,
  Run,
  RunHead,
  ServedRow,
  Step,
} from './records.ts';
import type { Attributes, RouterRecord, SpanEvent, StepRecord } from './spans.ts';

const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (s: unknown): string => String(s).replaceAll(/[&<>"]/g, c => ESCAPES[c] ?? c);
const iso = (ms: number): string => new Date(ms).toISOString();
const packed = (v: unknown, other: string): string => (typeof v === 'string' ? v : other);

/** A run's first entry, one line. */
const headLine = (e: RunHead | MigrationsHead | CheckHead): string => {
  if ('check' in e)
    return `start   upload check for v${e.candidate}, rolled back afterwards  ${e.problems.length} problems`;
  if ('migrations' in e) return `start   migrations, before any request`;
  const flags = Object.keys(e.flags).length > 0 ? `  flags ${JSON.stringify(e.flags)}` : '',
    method = e.method === undefined || e.method === '' ? '' : `  method ${e.method}`,
    message = typeof e.message === 'string' ? `  message ${e.message}` : '';
  return `start   build ${e.build}${flags}${method}${message}  ${measuredText(e)}${e.undone === true ? '  UNDONE: these writes were rolled back' : ''}`;
};
/** A step of an upload check or a migration run, one line. */
const stepLine = (e: Step): string => {
  if ('prepare' in e)
    return `prepare v${e.prepare}  ${e.waits === true ? 'waits for a held contract' : `${e.statements - e.errors.length} of ${e.statements} statements`}`;
  if ('machines' in e) return `machines ${e.machines.join(', ')}  ${e.statements.length} triggers`;
  const removed = e.removed ?? [];
  return `migrate ${e.migrate} "${e.name}"${e.contract ? ' contract' : ''}  ${e.hash.slice(0, 12)}  ${e.statements.length} statements${removed.length > 0 ? `  removes ${removed.join(', ')}` : ''}${(e.errors ?? []).length > 0 ? '  FAILED' : ''}  ${e.ms} ms`;
};
const callLine = (e: CallEffect): string => {
  const once = 'once' in e;
  return `${once ? 'call ' : 'ask  '}   ${e.call}.${e.method} ${packed(e.send, '(bytes)')} within ${e.within} ms${once ? ` once ${e.once}` : ''} -> ${e.status}${e.reply === '' ? '' : ` ${packed(e.reply, '')}`}`;
};
// One effect-log entry on one line.
const fx = (e: Entry): string => {
  if ('prepare' in e || 'machines' in e || 'migrate' in e) return stepLine(e);
  if ('build' in e) return headLine(e);
  if ('call' in e) return callLine(e);
  if ('wake' in e) return `wake    ${e.wake} after ${e.after} ms (due ${iso(e.due)})`;
  if ('now' in e) return `now     -> ${e.now}`;
  if ('random' in e) return `random  -> ${e.random}`;
  if ('secret' in e) return `secret  ${e.secret} -> ${e.version === null ? 'none' : `version ${e.version}`}`;
  return `sql ${e.q}   ${JSON.stringify(e.p)} -> ${e.rows ? JSON.stringify(e.rows) : `${e.r} written`}`;
};

// What the callee says about one call: it ran (and here is its trace), it answered from a stored reply, or nothing.
const NO_RECORD =
  'it has no record of this call under this trace: it did not run it (refused, unreachable or never sent), or it was reset after the run and before recording it, and then the caller got no reply';
const outcome = (e: CallEffect, s: ServedRow | null, why: string | undefined): string => {
  if (!s) return `${e.call}: ${why ?? NO_RECORD}`;
  return s.view
    ? `${e.call} v${s.version} ran ${e.method} at ${iso(s.view.at)} for key ${s.key} and answered ${s.status}`
    : `${e.call} v${s.version} answered ${s.status} from the reply it stored for key ${s.key}: ${e.method} did not run again, nothing was written`;
};
const callText = ({ e, served: s, why }: JoinedCall): string[] => [
  '',
  `call ${e.call}.${e.method}${'once' in e ? ` once ${e.once}` : ''} -> ${e.status} (${e.took} ms): ${outcome(e, s, why)}`,
  ...(s?.view
    ? text(s.view)
        .trimEnd()
        .split('\n')
        .map(x => `  | ${x}`)
    : []),
];
export const text = (j: Run): string =>
  `${[...j.trace.map(([, x]) => x), ...(j.error === null ? [] : [j.error]), ...(j.calls ?? []).flatMap(callText)].join('\n')}\n`;

const CSS = `:root { color-scheme: light dark; --fg: #1c1b19; --bg: #fbfaf7; --mut: #6f6a60; --line: #e3dfd6; --ok: #1f7a3d; --bad: #b3261e; --code: #f2efe8; }
@media (prefers-color-scheme: dark) { :root { --fg: #ece9e2; --bg: #171614; --mut: #9c968a; --line: #33302b; --ok: #6fcf8e; --bad: #f08a80; --code: #211f1c; } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 ui-sans-serif, system-ui, sans-serif; }
main { max-width: 960px; margin: 0 auto; padding: 20px 16px 60px; } h1 { font-size: 22px; margin: 8px 0 4px; } h2 { font-size: 17px; margin: 26px 0 4px; border-top: 1px solid var(--line); padding-top: 16px; }
h3 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--mut); margin: 18px 0 6px; } p { margin: 6px 0; } a { color: inherit; }
.meta, .mut { color: var(--mut); } .meta { font-size: 13px; } .ok { color: var(--ok); } .bad { color: var(--bad); } .fn { font-weight: 600; }
pre, code { font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
pre { background: var(--code); padding: 10px 12px; border-radius: 6px; overflow-x: auto; margin: 0; white-space: pre; }
details { margin: 8px 0; } summary { cursor: pointer; color: var(--mut); font-size: 14px; } details pre { margin-top: 6px; }`;
const good = (status: number | string): boolean => status === 'ok' || (typeof status === 'number' && status < 400);
const traceBlock = (v: Pick<Run, 'trace' | 'error'>): string =>
  `<pre>${v.trace.map(([c, t]) => `<span class="${c}">${esc(t)}</span>`).join('\n')}${v.error === null || v.error === '' ? '' : `\n<span class="bad">${esc(v.error)}</span>`}</pre>`;
const servedClass = (s: ServedRow | null): string => {
  if (!s) return 'bad';
  return s.view ? 'meta' : 'ok';
};
const calleeBlock = (call: string, view: Run): string =>
  `<h3>${esc(call)}: its trace, from its own log</h3>${traceBlock(view)}<h3>${esc(call)}: its effect log</h3><pre>${esc(view.effects.map(fx).join('\n'))}</pre>${(view.calls ?? []).length > 0 ? `<pre>${esc(text({ ...view, trace: [], error: null }).trim())}</pre>` : ''}`;
const callBlock = (
  { e, served: s, why }: JoinedCall,
  i: number,
): string => `<h2>Call ${i + 1}: ${esc(e.call)}.${esc(e.method)}${'once' in e ? ` once ${e.once}` : ''} <span class="${e.status === 'ok' ? 'ok' : 'bad'}">→ ${esc(e.status)}</span> <span class="meta">${e.took} ms of ${e.within}</span></h2>
<p class="${servedClass(s)}">${esc(outcome(e, s, why))}</p>
${s?.view ? calleeBlock(e.call, s.view) : ''}`;

const runSections = (j: Run): string => `<h3>Request</h3><pre>${esc(j.request)}</pre>
<h3>Response</h3><pre><span class="${good(j.status) ? 'ok' : 'bad'}">${esc(j.status)}</span>\n${esc(j.response)}</pre>${j.failed ? `\n<p class="bad">The run failed and its transaction was rolled back: nothing it wrote was kept.</p>` : ''}
<h3>Trace</h3>${traceBlock(j)}
<h3>Effect log</h3><pre>${esc(j.effects.map(fx).join('\n'))}</pre>
${(j.calls ?? []).map(callBlock).join('\n')}
<details><summary>Source</summary><pre>${esc(j.source)}</pre></details>`;
const traceIdOf = (e: Entry | undefined): string => (e && 'trace' in e ? (e.trace ?? '') : '');
const page = (title: string, body: string): string =>
  `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${CSS}</style></head><body><main>
${body}
</main></body></html>`;
export type Links = { otlp?: string };
const otlpLink = (links: Links): string =>
  links.otlp === undefined || links.otlp === '' ? '' : ` · <a href="${esc(links.otlp)}">OTLP/JSON</a>`;

export const html = (j: Joined, links: Links = {}): string => {
  const [head] = j.effects,
    recorded = isMigrationsHead(head) || isCheckHead(head);
  return page(
    `${j.account}/${j.name} v${j.version}`,
    `<h1>${esc(`${j.account}/${j.name} v${j.version}`)}</h1><p class="meta">request ${esc(j.id)} · ${iso(j.at)} · trace ${esc(traceIdOf(head))} · ${j.effects.length} effects · ${esc(recorded ? 'recorded as it ran: a migration run or an upload check is not replayed' : 'traced afterwards by replaying its effect log through a traced build')}${otlpLink(links)}</p>
${runSections(j)}`,
  );
};

// ---- OTLP/JSON (ExportTraceServiceRequest). Ids are hex, times are nanosecond strings, enums are numbers.
type AttrValue = { boolValue: boolean } | { intValue: string } | { doubleValue: number } | { stringValue: string };
type Attr = { key: string; value: AttrValue };
type OtlpEvent = { timeUnixNano: string; name: string; attributes: Attr[] };
type OtlpStatus = { code: number; message?: string };
type OtlpSpan = {
  traceId: string | undefined;
  spanId: string | null | undefined;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Attr[];
  events: OtlpEvent[];
  status: OtlpStatus;
};
type ResourceSpans = {
  resource: { attributes: Attr[] };
  scopeSpans: [{ scope: { name: string }; spans: OtlpSpan[] }];
};
export type Otlp = { resourceSpans: ResourceSpans[] };

const ns = (ms: number): string => `${BigInt(Math.round(ms * 1000)) * 1000n}`;
const value = (v: unknown): AttrValue => {
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v !== 'number') return { stringValue: String(v) };
  return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
};
const attrs = (o: Attributes): Attr[] =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([key, v]) => ({ key, value: value(v) }));
const KIND = { server: 2, client: 3, consumer: 5 },
  UNSET: OtlpStatus = { code: 0 },
  error = (message: string): OtlpStatus => ({ code: 2, message });
// a span id for the call itself, made from the caller's span and the call's place in its log
const childId = (span: string | undefined, i: number): string =>
  (BigInt(`0x${span}`) ^ BigInt(i + 1)).toString(16).padStart(16, '0');
const event = (t: number, name: string, attributes: Attributes): OtlpEvent => ({
  timeUnixNano: ns(t),
  name,
  attributes: attrs(attributes),
});
/** The time an entry was logged at, when it carries one. */
const atOf = (e: Entry | undefined): number => (e && 'at' in e && typeof e.at === 'number' ? e.at : 0);
// The host also logs times to the microsecond (host/log.ts, clockUs): `at_us` and `took_us` on a run's head,
// `sent_us` and `took_us` on a call. A span is placed by them when they are there, in fractional ms (ns() keeps
// the µs), and by the ms fields when they are not (a log from before them, or a row the service measured in ms).
const fine = (us: unknown, inMs: number): number => (typeof us === 'number' ? us / 1000 : inMs);
/** When a run began: to the µs when its head says so. */
const startOf = (e: Entry | undefined): number => fine(e && 'at_us' in e ? e.at_us : undefined, atOf(e));
/** How long a run took, as its head says: to the µs when it can. */
const tookOf = (h: { took?: number | undefined; took_us?: number | undefined }): number => fine(h.took_us, h.took ?? 0);

/** One entry of a log as span events, at time t. */
const entryEvents = (e: Entry, t: number, queries: readonly string[]): OtlpEvent[] => {
  if ('wake' in e)
    return [
      event(t, 'tape.timer.set', {
        'tape.wake.key': e.wake,
        'tape.wake.after_ms': e.after,
        'tape.wake.due': iso(e.due),
        // set in a stretch its run's rollback(out) or trap undid: the timer was never kept
        'tape.timer.undone': e.undone,
      }),
    ];
  if ('now' in e) return [event(t, 'tape.clock', { 'tape.now': e.now })];
  if ('random' in e) return [event(t, 'tape.entropy', { 'tape.random': e.random })];
  // the name and the version read, never the value: the log has none
  if ('secret' in e)
    return [event(t, 'tape.secret', { 'tape.secret.name': e.secret, 'tape.secret.version': e.version ?? undefined })];
  if ('migrate' in e)
    return e.statements.map(st =>
      event(t, 'db.migration', {
        'db.system.name': 'sqlite',
        'db.query.text': st,
        'tape.migration.version': e.migrate,
        'tape.migration.name': e.name,
        'tape.migration.hash': e.hash,
        'tape.migration.contract': e.contract,
      }),
    );
  if (!('q' in e)) return [];
  return [
    event(t, 'db.query', {
      'db.system.name': 'sqlite',
      'db.query.text': queries[e.q],
      'db.query.parameters': JSON.stringify(e.p),
      'db.response.returned_rows': e.rows?.length,
      'tape.sql.rows': e.rows ? JSON.stringify(e.rows) : undefined,
      'tape.sql.rows_written': e.r,
      // rolled back by the run's rollback(out) or trap (host/run.ts, markUndone): it did not stay
      'tape.sql.undone': e.undone,
    }),
  ];
};
// Effects as span events, timed by the log's own clock: each takes the latest `now` read before it (the clock
// event too). A `now` is Date.now(), truncated to the ms, while the run's start may be to the µs, so a reading in
// the run's first ms can fall before the start it came after: it is taken as the start, never earlier.
const events = (v: Pick<Run, 'effects' | 'queries'>): OtlpEvent[] => {
  const start = startOf(v.effects[0]);
  let t = start;
  return v.effects.slice(1).flatMap(e => {
    if ('now' in e) t = Math.max(start, e.now);
    return entryEvents(e, t, v.queries);
  });
};
const resource = (service: string, version: number | null, spans: OtlpSpan[]): ResourceSpans => ({
  resource: {
    attributes: attrs({ 'service.name': service, 'service.version': `v${version}`, 'telemetry.sdk.name': 'tape' }),
  },
  scopeSpans: [{ scope: { name: 'tape' }, spans }],
});

type StepSpan = Pick<OtlpSpan, 'name' | 'attributes' | 'events' | 'status'>;
const migrateSpan = (e: MigrateStep, at: number): StepSpan => {
  const errors = e.errors ?? [],
    removed = e.removed ?? [];
  return {
    name: `migrate ${e.migrate} "${e.name}"${e.contract ? ' contract' : ''}`,
    attributes: attrs({
      'db.system.name': 'sqlite',
      'db.operation.name': 'migrate',
      'tape.migration.version': e.migrate,
      'tape.migration.hash': e.hash,
      'tape.migration.contract': e.contract,
      'tape.migration.removed': removed.length > 0 ? removed.join(', ') : undefined,
    }),
    events: e.statements.map(st =>
      event(at, 'db.migration', {
        'db.query.text': st,
        'error.message': errors.find(x => x.statement === st)?.reason,
      }),
    ),
    status:
      errors.length > 0 || (removed.length > 0 && !e.contract)
        ? error(errors[0]?.reason ?? `removes ${removed.join(', ')}`)
        : UNSET,
  };
};
/** A step of an upload check as a span: a migration it ran, a version it prepared, or the machines it installed. */
const stepSpan = (e: Step, at: number, problems: readonly CheckProblem[]): StepSpan => {
  if ('migrate' in e) return migrateSpan(e, at);
  const failed = e.errors.map(x =>
    event(at, 'db.prepare.failed', { 'db.query.text': x.statement, 'error.message': x.reason }),
  );
  const [first] = e.errors;
  if ('machines' in e)
    return {
      name: `machines ${e.machines.join(', ')}`,
      attributes: attrs({
        'db.system.name': 'sqlite',
        'db.operation.name': 'machines',
        'tape.check.statements': e.statements.length,
      }),
      events: failed,
      status: first ? error(first.reason) : UNSET,
    };
  return {
    name: `prepare v${e.prepare}`,
    attributes: attrs({
      'db.system.name': 'sqlite',
      'db.operation.name': 'prepare',
      'tape.version': e.prepare,
      'tape.check.statements': e.statements,
      'tape.check.waits': e.waits,
    }),
    events: failed,
    status:
      first && problems.some(p => p.version === e.prepare && p.migration === undefined) ? error(first.reason) : UNSET,
  };
};
const isStep = (e: Entry): e is Step => 'migrate' in e || 'prepare' in e || 'machines' in e;

// An upload check as spans: the check, and under it one span per migration it ran and one per version it prepared.
// The steps run inside one synchronous transaction, where a Worker's clock does not move, so they share its start;
// the check's own duration is measured around it by the supervisor.
const checkOtlp = (j: Joined, head: CheckHead): Otlp => {
  const end = head.at + (head.took ?? 0),
    window = { startTimeUnixNano: ns(head.at), endTimeUnixNano: ns(end) };
  const check: OtlpSpan = {
    traceId: head.trace,
    spanId: head.span,
    name: `check v${head.candidate} against ${j.account}/${j.name}`,
    kind: 1,
    ...window,
    attributes: attrs({
      'db.system.name': 'sqlite',
      'db.operation.name': 'check',
      'tape.request_id': j.id,
      'tape.check.candidate': head.candidate,
      'tape.check.problems': head.problems.length,
      'tape.check.rolled_back': true,
    }),
    events: head.problems.map(p =>
      event(head.at, 'tape.check.problem', {
        'tape.version': p.version,
        'tape.migration.version': p.migration,
        'db.query.text': p.query ?? p.statement,
        'error.message': p.reason,
      }),
    ),
    status: head.problems.length > 0 ? error(`${head.problems.length} problems`) : UNSET,
  };
  const steps = j.effects.slice(1).flatMap((e, i): OtlpSpan[] =>
    isStep(e)
      ? [
          {
            traceId: head.trace,
            spanId: childId(head.span, i),
            parentSpanId: head.span,
            kind: 1,
            ...window,
            ...stepSpan(e, head.at, head.problems),
          },
        ]
      : [],
  );
  return { resourceSpans: [resource(`${j.account}/${j.name}`, j.version, [check, ...steps])] };
};

// What a run did to its tables: statements, rows they returned, rows they wrote.
const sqlStats = (effects: readonly Entry[]): { statements: number; returned: number; written: number } => {
  const sql = effects.flatMap(e => ('q' in e ? [e] : []));
  return {
    statements: sql.length,
    returned: sql.reduce((n, e) => n + (e.rows?.length ?? 0), 0),
    // what stayed written: an undone write's rows are not counted
    written: sql.reduce((n, e) => n + (e.undone ? 0 : (e.r ?? 0)), 0),
  };
};
const UNMEASURED =
  "unmeasured: a run cannot time itself (a Worker's clock does not advance while code runs), and no supervisor measured this one";
const MEASURED =
  "measured by the supervisor around the facet call that ran it (includes making its writes durable); the run's own clock does not advance, so its events are in order but not timed";
const missing = (t: number, what: string, reason: string, extra: Attributes = {}): OtlpEvent =>
  event(t, 'tape.span.missing', { 'tape.missing': what, 'tape.missing.reason': reason, ...extra });

/** A run's request line: an HTTP verb and a target, or (a served call, a tool call) a method and a message. */
const requestLine = (request: string): { method: string; target: string; path: string; query: string | undefined } => {
  // the request headers follow on the line, each after a carriage return (web.ts tapeRequest)
  const [line = ''] = (request.split('\n')[0] ?? '').split('\r'),
    [method = ''] = line.split(' '),
    target = line.slice(method.length + 1),
    [path = '', query] = target.split('?');
  return { method, target, path, query };
};
type Window = { start: number; end: number };
/** What kind of span a run is, with the attributes that say so. */
const runKind = (j: Joined, head: RunHead | MigrationsHead): Pick<OtlpSpan, 'name' | 'kind'> & { own: Attributes } => {
  const { method, target, path, query } = requestLine(j.request);
  if ('migrations' in head)
    return {
      name: `migrate ${j.account}/${j.name} to v${j.version}`,
      kind: 1,
      own: {
        'db.system.name': 'sqlite',
        'db.operation.name': 'migrate',
        'tape.request_id': j.id,
        'tape.migrations': j.effects.length - 1,
      },
    };
  // what the run used, of the limits docs/service.md gives: absent in a log from before it was recorded
  const run = {
    'tape.request_id': j.id,
    'tape.build': head.build,
    'tape.memory_bytes': head.bytes,
    'tape.steps': head.steps,
    'tape.step_version': head.step_version,
  };
  if (head.woke)
    return {
      name: `${j.name} woken by timer ${head.woke.key}`,
      kind: KIND.consumer,
      own: {
        'tape.wake.key': head.woke.key,
        'tape.wake.due': head.woke.due === null ? undefined : iso(head.woke.due),
        'tape.wake.late_ms': head.woke.due === null ? undefined : atOf(head) - head.woke.due,
        'rpc.method': 'woken',
        'tape.reply_status': j.status,
        ...run,
      },
    };
  // a served call or a tool call has a method and a message on its request line, not an HTTP verb and a path
  if (!/^[A-Z]+$/.test(method))
    return {
      name: `${method} ${path}`,
      kind: KIND.server,
      own: {
        'rpc.system': 'tape',
        'rpc.service': j.name,
        'rpc.method': method,
        'tape.message': target === '' ? undefined : target,
        'tape.reply_status': j.status,
        ...run,
      },
    };
  return {
    name: `${method} ${path}`,
    kind: KIND.server,
    own: {
      'http.request.method': method,
      'url.path': path,
      'url.query': query,
      'http.response.status_code': typeof j.status === 'number' ? j.status : undefined,
      ...run,
      'tape.undone': head.undone,
    },
  };
};
const STOPPED =
  'the run stopped while it waited on a call (its object was reset): its log ends at that call; what it wrote before the call committed, nothing after';
const runStatus = (j: Joined, failed: RunHead['failed'] | null): OtlpStatus => {
  if (failed) return error(failed.error);
  return typeof j.status === 'number' && j.status >= 500 ? error(j.response) : UNSET;
};

// One run as spans: the run's span (times from `window` when its supervisor measured it), its calls' client spans,
// and each callee's spans (recursively), in the run's resource and the callees' own.
export const otlp = (j: Joined, { window = null }: { window?: Window | null } = {}): Otlp => {
  const [head] = j.effects;
  if (isCheckHead(head)) return checkOtlp(j, head);
  if (!isRunHead(head) && !isMigrationsHead(head)) return { resourceSpans: [] };
  const run = isRunHead(head) ? head : null,
    stats = sqlStats(j.effects),
    failed = run?.failed ?? j.failed ?? null,
    partial = run?.partial === true;
  const start = window?.start ?? startOf(head),
    end = window ? window.end : startOf(head) + tookOf(head);
  const { name, kind, own } = runKind(j, head);
  const span: OtlpSpan = {
    traceId: head.trace,
    spanId: head.span,
    ...(head.parent === null || head.parent === undefined || head.parent === '' ? {} : { parentSpanId: head.parent }),
    name,
    kind,
    startTimeUnixNano: ns(start),
    endTimeUnixNano: ns(end),
    attributes: attrs({
      ...own,
      'tape.duration.source': window ? MEASURED : UNMEASURED,
      'tape.sql.statements': stats.statements,
      'tape.sql.rows_returned': stats.returned,
      'tape.sql.rows_written': stats.written,
      'tape.run.failed': failed ? true : undefined,
      'tape.run.rolled_back': failed || run?.undone === true ? true : undefined,
      'tape.run.incomplete': partial ? true : undefined,
    }),
    events: [
      ...events(j),
      ...(failed
        ? [
            event(end, 'tape.run.rolled_back', {
              'error.message': failed.error,
              'tape.run.storage_fault': failed.storage,
            }),
          ]
        : []),
      ...(partial ? [missing(end, 'run.end', STOPPED)] : []),
    ],
    status: runStatus(j, failed),
  };
  const callee: ResourceSpans[] = [],
    spans = [span];
  if (run) callSpans(j, run, spans, callee, start);
  return { resourceSpans: [resource(`${j.account}/${j.name}`, j.version, spans), ...callee] };
};

/** When a call was sent: as measured, or (a log from before sends were timed) estimated from the calls before it. */
/** A number of a stored log, which a log from before it was recorded does not have. */
const ms = (v: unknown): number => (typeof v === 'number' ? v : 0);
const timed = (e: CallEffect): boolean => ms(e.sent) > 0;
/** How long a call took, to the µs when its entry says so. */
const tookOfCall = (e: CallEffect): number => fine(e.took_us, ms(e.took));
const sentAt = (effects: readonly Entry[], at: number, e: CallEffect, floor: number): number => {
  if (timed(e)) return fine(e.sent_us, e.sent);
  let t = floor;
  for (const x of effects.slice(0, at)) {
    if ('now' in x) t = Math.max(t, x.now);
    else if ('call' in x) t += tookOfCall(x);
  }
  return t;
};
const toUs = (t: number): number => Math.round(t * 1000) / 1000;
const staleNote = (took: number, within: number): string =>
  `this object's clock was stale when the call arrived (its last I/O was earlier): its span reads ${toUs(took)} ms, longer than the ${toUs(within)} ms call that contained it, so its start is ${toUs(took - within)} ms or more too early; its end is measured`;
/** The window of a callee's span: from when the call reached it to when it answered, as its supervisor measured
 * across the facet call (rows from before that was recorded fall back to the callee's own clock, which reads 0 ms). */
// `us`: to the µs where the head and the row say so (the stale-clock check below picks one resolution for both).
const calleeWindow = (s: ServedRow, h: RunHead | null, us = true): Window => {
  const began = s.began === null ? null : us ? fine(s.began_us, s.began) : s.began,
    took = us ? fine(s.took_us, s.took ?? 0) : (s.took ?? 0),
    start = h ? (us ? startOf(h) : atOf(h)) : Infinity;
  return {
    start: Math.min(start, began ?? Infinity),
    end: Math.max(h ? start + (us ? tookOf(h) : (h.took ?? 0)) : 0, began === null ? 0 : began + took),
  };
};
const isNumber = (v: unknown): v is number => typeof v === 'number';
const timedTook = (e: CallEffect): boolean => isNumber(e.took);
// A callee window longer than the answered call that contained it began on a stale clock (requestSpans, below).
// Both durations are compared at one resolution: in µs when the call and the row were both timed so, else in ms
// as recorded (a ms field is Date.now() truncated, so a µs window against a ms call, or the reverse, would read
// up to 1 ms long and be called stale when it is not). The mark goes at the start of the span it is drawn on
// (`span`, the window the span is placed by), so it lies inside that span.
const staleAt = (e: CallEffect, s: ServedRow, h: RunHead | null, span: Window): OtlpEvent[] => {
  const us = isNumber(e.took_us) && isNumber(s.began_us) && isNumber(s.took_us),
    w = calleeWindow(s, h, us),
    took = w.end - w.start,
    within = us ? tookOfCall(e) : e.took;
  return e.status === 'ok' && timedTook(e) && took > within
    ? [missing(span.start, 'supervisor.start', staleNote(took, within))]
    : [];
};
/** The call itself, as the caller saw it: a client span under the run's. */
const clientSpan = (c: JoinedCall, head: RunHead, id: string, start: number): OtlpSpan => {
  const { e, served: s, why } = c;
  const noted = (): OtlpEvent[] => {
    if (!s)
      return [missing(start + tookOfCall(e), 'callee', why ?? `${e.call} ${NO_RECORD}`, { 'rpc.service': e.call })];
    return s.view
      ? []
      : [event(s.at, 'tape.call.deduplicated', { 'tape.call.key': s.key, 'tape.call.reply_status': s.status })];
  };
  return {
    traceId: head.trace,
    spanId: id,
    ...(head.span === undefined ? {} : { parentSpanId: head.span }),
    name: `${e.call}/${e.method}`,
    kind: KIND.client,
    startTimeUnixNano: ns(start),
    endTimeUnixNano: ns(start + tookOfCall(e)),
    attributes: attrs({
      'rpc.system': 'tape',
      'rpc.service': e.call,
      'rpc.method': e.method,
      'tape.call.once': e.once,
      'tape.call.key': s?.key,
      'tape.call.within_ms': e.within,
      'tape.call.status': e.status,
      'tape.call.deduplicated': s ? !s.view : undefined,
      'tape.duration.source': timed(e)
        ? 'measured by the caller around the call'
        : 'took measured; start estimated from the calls before it (a log from before sends were timed)',
    }),
    events: noted(),
    status: e.status === 'ok' ? UNSET : error(e.status),
  };
};
/** A callee that answered from its stored reply: one span, when its supervisor measured it. */
const storedSpan = (e: CallEffect, s: ServedRow, head: RunHead, id: string): OtlpSpan => {
  const w = calleeWindow(s, null);
  return {
    traceId: head.trace,
    spanId: childId(id, 0),
    parentSpanId: id,
    name: `${e.call} ${e.method} (stored reply)`,
    kind: KIND.server,
    startTimeUnixNano: ns(w.start),
    endTimeUnixNano: ns(w.end),
    attributes: attrs({
      'rpc.system': 'tape',
      'rpc.service': e.call,
      'rpc.method': e.method,
      'tape.call.key': s.key,
      'tape.call.reply_status': s.status,
      'tape.call.deduplicated': true,
      'tape.duration.source': MEASURED,
    }),
    events: staleAt(e, s, null, w),
    status: s.status === 'ok' ? UNSET : error(s.status),
  };
};
/** A callee's run, as its own log has it: a server span under the call's. */
const servedSpan = (e: CallEffect, s: ServedRow, view: Run, h: RunHead, id: string): OtlpSpan => {
  const stats = sqlStats(view.effects),
    failed = h.failed ?? null,
    w = calleeWindow(s, h);
  const status = (): OtlpStatus => {
    if (failed) return error(failed.error);
    return s.status === 'ok' ? UNSET : error(view.response);
  };
  return {
    traceId: h.trace,
    spanId: h.span,
    parentSpanId: id,
    name: `${e.call} ${e.method}`,
    kind: KIND.server,
    startTimeUnixNano: ns(w.start),
    endTimeUnixNano: ns(w.end),
    attributes: attrs({
      'rpc.system': 'tape',
      'rpc.service': e.call,
      'rpc.method': e.method,
      'tape.request_id': view.id,
      'tape.build': h.build,
      'tape.call.key': s.key,
      'tape.call.reply_status': s.status,
      'tape.duration.source': s.began === null ? UNMEASURED : MEASURED,
      'tape.sql.statements': stats.statements,
      'tape.sql.rows_returned': stats.returned,
      'tape.sql.rows_written': stats.written,
      'tape.run.failed': failed ? true : undefined,
      'tape.run.rolled_back': failed ? true : undefined,
    }),
    events: [...staleAt(e, s, h, w), ...events(view)],
    status: status(),
  };
};

// A run's calls: one client span each, under the run's span, and under it what the callee recorded: its run (with
// its own calls), its stored reply, or an explicit tape.span.missing event when it recorded nothing.
// Calls in one request run one after another (each is a commit point), so a call is sent when the one before it
// answered, or at a later clock reading in the log; the callee's span keeps its own times (it may start late).
const callSpans = (
  j: Pick<Joined, 'account' | 'effects' | 'calls'>,
  head: RunHead,
  spans: OtlpSpan[],
  callee: ResourceSpans[],
  base: number,
): void => {
  for (const c of j.calls) {
    const { e, served: s } = c,
      at = j.effects.indexOf(e),
      id = childId(head.span, at),
      start = sentAt(j.effects, at, e, Math.max(base, startOf(head)));
    spans.push(clientSpan(c, head, id, start));
    if (!s) continue;
    const [h] = s.view?.effects ?? [];
    if (!s.view || !isRunHead(h)) {
      if (!s.view && s.began !== null)
        callee.push(resource(`${j.account}/${e.call}`, s.version, [storedSpan(e, s, head, id)]));
      continue;
    }
    const cspans = [servedSpan(e, s, s.view, h, id)],
      sub: ResourceSpans[] = [];
    callSpans(
      { account: j.account, effects: s.view.effects, calls: s.view.calls ?? [] },
      h,
      cspans,
      sub,
      calleeWindow(s, h).start,
    );
    callee.push(resource(`${j.account}/${e.call}`, s.version, cspans), ...sub);
  }
};

// ---- A routed request (Name.request): the router's spans (spans.ts), the supervisor's span for each time the
// object took the call, and the run's spans under it. Whatever is not there is an explicit tape.span.missing event.
const KINDS: Readonly<Record<string, number>> = { internal: 1, server: 2, client: 3 };
const ROUTER_MISSING =
  'the router did not store its record of this request: it stopped before it could (the client went away and the Worker was cancelled), or storing it failed (the response said tape-trace-complete: false)';
const NO_SHARD_RECORD = 'the shard has no record of this call';
const spanEvents = (list: readonly SpanEvent[]): OtlpEvent[] => list.map(ev => event(ev.at, ev.name, ev.attributes));
/** Did the object the request was routed to record nothing of it? */
const unseen = (r: Routed): boolean => r.invoked.length === 0 && (r.orphans ?? []).length === 0;
/** Why the call never reached the object, as the step that made it says. */
const notSent = (st: StepRecord | null | undefined): string | null => {
  const why = st?.attributes['tape.call.not_sent'];
  return typeof why === 'string' ? why : null;
};
/** The router's own spans: the request it received, and each step it took. */
const routerSpans = (r: Routed, route: RouterRecord, trace: string | undefined): OtlpSpan[] => {
  const status = route.status ?? 0;
  const request: OtlpSpan = {
    traceId: trace,
    spanId: route.span,
    ...(route.client === null || route.client === '' ? {} : { parentSpanId: route.client }),
    name: route.name,
    kind: 2,
    startTimeUnixNano: ns(route.start),
    endTimeUnixNano: ns(route.end ?? route.start),
    attributes: attrs({
      ...route.attributes,
      'http.response.status_code': route.status,
      'tape.duration.source': 'measured by the Worker across its I/O',
    }),
    events: spanEvents(route.events),
    status: status >= 500 ? error(`${status}`) : UNSET,
  };
  const steps = route.steps.map((st): OtlpSpan => {
    const failed = st.error !== null && st.error !== '';
    const lost =
      st.span === r.call_span && unseen(r)
        ? [
            missing(
              st.end ?? st.start,
              'supervisor',
              notSent(st) ?? (failed ? `${NO_SHARD_RECORD}; the call failed: ${st.error}` : NO_SHARD_RECORD),
            ),
          ]
        : [];
    return {
      traceId: trace,
      spanId: st.span,
      parentSpanId: st.parent,
      name: st.name,
      kind: KINDS[st.kind] ?? 1,
      startTimeUnixNano: ns(st.start),
      endTimeUnixNano: ns(st.end ?? st.start),
      attributes: attrs(st.attributes),
      events: [...spanEvents(st.events), ...lost],
      status: failed ? error(st.error ?? '') : UNSET,
    };
  });
  return [request, ...steps];
};
// only the object's side is stored: the call span stands in for the router, and says what is missing
const standIn = (r: Routed, first: Invoked, trace: string | undefined): OtlpSpan => ({
  traceId: trace,
  spanId: r.call_span,
  name: 'router (not recorded)',
  kind: 3,
  startTimeUnixNano: ns(first.began),
  endTimeUnixNano: ns(first.began + (first.took ?? 0)),
  attributes: attrs({ 'tape.missing': 'router' }),
  events: [missing(first.began, 'router', ROUTER_MISSING)],
  status: error("the router's record is missing"),
});
const STOPPED_IN_FLIGHT = 'the object stopped while the call was in flight';
/** One time the object took the call, as its supervisor recorded it; `stale`: its clock was behind when it began. */
const supervisorSpan = (r: Routed, row: Invoked, trace: string | undefined, stale: string | null): OtlpSpan => {
  const open = row.took === null, // begun, never completed: the object stopped while the call was in flight
    end = row.began + (row.took ?? 0);
  const unfinished = row.run
    ? "this object stopped before it recorded the end of the call (its duration is unknown); the run was found in the program's log by its span"
    : 'this object stopped before it recorded the end of the call; its duration is unknown';
  return {
    traceId: trace,
    spanId: row.name_span,
    ...(r.call_span === null ? {} : { parentSpanId: r.call_span }),
    name: `${r.name} invoke v${row.version}`,
    kind: 2,
    startTimeUnixNano: ns(row.began),
    endTimeUnixNano: ns(end),
    attributes: attrs({
      'tape.supervisor': `${r.account}/${r.name}`,
      'tape.version': row.version,
      'http.response.status_code': row.status,
      'tape.request_id': row.log_id,
      'tape.fault.kind': row.fault,
      'tape.facet.took_ms': row.facet_took,
      'tape.clock.lag_ms': row.clock_lag,
      'tape.duration.source': 'measured by the supervisor (the Durable Object) across the facet call',
      'error.message': row.error,
    }),
    events: [
      ...(stale === null ? [] : [missing(row.began, 'supervisor.start', stale)]),
      ...(open ? [missing(row.began, 'supervisor.end', unfinished)] : []),
      ...(row.run
        ? []
        : [missing(end, 'run', row.missing ?? row.error ?? 'the supervisor recorded no run for this call')]),
    ],
    status: (row.error !== null && row.error !== '') || open ? error(row.error ?? STOPPED_IN_FLIGHT) : UNSET,
  };
};
// runs of this trace found in the program's log with no supervisor record: under the call span, marked
const orphanSpans = (run: Joined, callSpan: string | null): ResourceSpans[] => {
  const all = otlp(run).resourceSpans,
    first = all[0]?.scopeSpans[0].spans[0];
  if (!first) return all;
  if (callSpan !== null && callSpan !== '') first.parentSpanId = callSpan;
  first.attributes.push(...attrs({ 'tape.supervisor.missing': true }));
  first.events.unshift(
    missing(
      run.at,
      'supervisor',
      "this object has no record of the call that ran this run (it was reset while the call was in flight, and its record was lost); the run was found in the program's log by its trace id",
    ),
  );
  return all;
};
const named = (service: string, spans: OtlpSpan[]): ResourceSpans => ({
  resource: { attributes: attrs({ 'service.name': service, 'telemetry.sdk.name': 'tape' }) },
  scopeSpans: [{ scope: { name: 'tape' }, spans }],
});
/** The trace a routed request belongs to, from whichever part of it was recorded. */
const traceOfRouted = (r: Routed): string | undefined =>
  r.route?.trace ??
  r.invoked[0]?.trace ??
  [...(r.orphans ?? []), ...(r.woken ?? [])].map(run => traceIdOf(run.effects[0])).find(t => t !== '');

export const requestSpans = (r: Routed): ResourceSpans[] => {
  const { route } = r,
    orphans = r.orphans ?? [],
    woken = r.woken ?? [],
    trace = traceOfRouted(r);
  if (!route && unseen(r)) return woken.flatMap(run => otlp(run).resourceSpans);
  const [first] = r.invoked;
  let router: OtlpSpan[] = [];
  if (route) router = routerSpans(r, route, trace);
  else if (first) router = [standIn(r, first, trace)];
  // A supervisor's window cannot be longer than the call that it answered (the call contains it). When it is, the
  // object began on a stale clock: a Durable Object's clock is the time of its last I/O, and a busy object can take
  // a call with a clock 100 ms or more behind (seen in production; neither a 0 nor a 1 ms timer reliably renews it).
  // Its end is measured after I/O, its start is then only an upper bound on how early it began: said so here.
  const callStep = route?.steps.find(st => st.span === r.call_span);
  const callTook =
    callStep && callStep.end !== null && (callStep.error === null || callStep.error === '')
      ? callStep.end - callStep.start
      : null;
  const stale = (row: Invoked): string | null =>
    row.took !== null && callTook !== null && row.took > callTook ? staleNote(row.took, callTook) : null;
  const shard = r.invoked.map(row => supervisorSpan(r, row, trace, stale(row)));
  const runs = r.invoked.flatMap(row =>
    row.run
      ? otlp(row.run, {
          window:
            row.facet_began === null ? null : { start: row.facet_began, end: row.facet_began + (row.facet_took ?? 0) },
        }).resourceSpans
      : [],
  );
  return [
    named('tape-router', router),
    ...(shard.length > 0 ? [named(`${r.account}/${r.name} supervisor`, shard)] : []),
    ...runs,
    ...orphans.flatMap(run => orphanSpans(run, r.call_span)),
    // runs its timers started later, each a child (a consumer span) of the run that set the timer
    ...woken.flatMap(run => otlp(run).resourceSpans),
  ];
};
export const requestOtlp = (list: readonly (Routed | null | undefined)[]): Otlp => ({
  resourceSpans: list.flatMap(r => (r ? requestSpans(r) : [])),
});

// The same as text and as a page: the path through the Worker and the object, then the run as before.
const took = (a: number, b: number): string => `${b - a} ms`;
const stepLineOf = (st: StepRecord): string => {
  const shown = Object.entries(st.attributes)
    .filter(([k]) => k !== 'tape.timing' && k !== 'rpc.system')
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(' ');
  return `  ${st.kind === 'client' ? 'call ' : 'step '}  ${st.name}  ${took(st.start, st.end ?? st.start)}${st.attributes['tape.timing'] === undefined ? '' : '  (no I/O: 0 ms)'}  ${shown}${st.error === null || st.error === '' ? '' : `  ERROR ${st.error}`}`;
};
const supervisorLine = (r: Routed, row: Invoked): string =>
  `    supervisor  ${r.account}/${r.name} v${row.version}  -> ${row.status ?? 'no reply'}  ${row.took ?? '?'} ms (run ${row.facet_took ?? '?'} ms)${row.fault === null || row.fault === '' ? '' : `  fault ${row.fault}`}${row.error === null || row.error === '' ? '' : `  ${row.error}`}${row.took === null ? '  STOPPED in flight' : ''}${row.recovered ? '  (run found by its span)' : ''}${row.run ? '' : `  MISSING run: ${row.missing ?? row.error ?? 'none recorded'}`}`;
const pathLines = (r: Routed): string[] => {
  const { route } = r;
  const router = route
    ? [
        `router  ${route.name}  -> ${route.status}  ${took(route.start, route.end ?? route.start)}  trace ${route.trace}${route.client === null || route.client === '' ? '  (no client traceparent)' : `  (client span ${route.client})`}`,
        ...route.steps.map(stepLineOf),
      ]
    : [`router  MISSING: ${ROUTER_MISSING}`];
  return [
    ...router,
    ...(r.orphans ?? []).map(
      run => `    run ${run.id} (no supervisor record: found in the program's log by its trace)`,
    ),
    ...(unseen(r)
      ? [`  shard  MISSING: ${notSent(route?.steps.find(st => st.span === r.call_span)) ?? NO_SHARD_RECORD}`]
      : []),
    ...r.invoked.map(row => supervisorLine(r, row)),
  ];
};
/** The runs a routed request led to: the ones its supervisor recorded, then the ones found only in the log. */
const runsOf = (r: Routed): Joined[] => [...r.invoked.flatMap(x => (x.run ? [x.run] : [])), ...(r.orphans ?? [])];
export const requestText = (r: Routed): string =>
  `${[...pathLines(r), ...runsOf(r).flatMap(run => ['', text(run).trimEnd()])].join('\n')}\n`;
export const requestHtml = (r: Routed, links: Links = {}): string =>
  page(
    `${r.account}/${r.name} request`,
    `<h1>${esc(`${r.account}/${r.name}`)}: one request</h1><p class="meta">call span ${esc(r.call_span)} · trace ${esc(r.route?.trace ?? r.invoked[0]?.trace ?? '')}${otlpLink(links)}</p>
<h3>Path</h3><pre>${esc(pathLines(r).join('\n'))}</pre>
${runsOf(r).map(runSections).join('\n')}`,
  );
