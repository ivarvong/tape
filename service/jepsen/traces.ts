// traces.ts: traces as a correctness property, for the Jepsen workloads (kv.js, harness.ts). No runtime imports.
//
// Every operation a Jepsen client sends carries its own W3C traceparent: a fresh trace id and a client span id.
// After the run, the service is asked for each operation's trace by its id, and the trace must be complete and
// true: one tree, rooted at the router's span whose parent is the client's span, with the right kinds of spans in
// the right places, every parent present, and what the trace says happened (the status, the SQL and the rows it
// returned, whether the run was rolled back) agreeing with what the client saw and with the final state. A span
// that cannot exist (a shard that never saw the call) must be replaced by an explicit tape.span.missing event that
// says why; silence is an anomaly. The workload-specific checks are in kv.js and harness.ts; this file has what
// they share: parsing OTLP/JSON, the tree check, timing, and the mutations that make broken traces for the
// checker's own tests.

import { fields, list, text } from './json.ts';

const hex = (n: number): string =>
  [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');
// a fresh client span for one operation: its trace id, its span id, and the header that carries them
export const clientSpan = (): { trace: string; span: string; traceparent: string } => {
  const trace = hex(16),
    span = hex(8);
  return { trace, span, traceparent: `00-${trace}-${span}-01` };
};

/** An attribute's value as the checks read it. */
export type Value = string | number | boolean | undefined;
export type Attrs = Readonly<Record<string, Value>>;
export type SpanEvent = { name: string; at: number; attrs: Attrs };
/** A span of an OTLP document, flat: times in ms; kind 1 internal, 2 server, 3 client, 5 consumer; status 2 an error. */
export type Span = {
  trace: string;
  id: string;
  parent: string | null;
  name: string;
  kind: number;
  service: Value;
  start: number;
  end: number;
  attrs: Attrs;
  events: SpanEvent[];
  status: number;
  message: string | undefined;
};
export type Anomaly = { type: string } & Readonly<Record<string, unknown>>;

const val = (v: unknown): Value => {
  const { stringValue, intValue, boolValue, doubleValue } = fields(v);
  if (typeof stringValue === 'string') return stringValue;
  if (intValue !== undefined) return Number(intValue);
  if (typeof boolValue === 'boolean') return boolValue;
  return typeof doubleValue === 'number' ? doubleValue : undefined;
};
const attrsOf = (attributes: unknown): Attrs =>
  Object.fromEntries(
    list(attributes)
      .map(fields)
      .map(a => [text(a.key), val(a.value)]),
  );
const msOf = (ns: unknown): number => Number(BigInt(text(ns) === '' ? '0' : text(ns)) / 1000n) / 1000; // nanosecond string -> ms (µs precision)

const spanOf = (raw: unknown, service: Value): Span => {
  const sp = fields(raw),
    status = fields(sp.status);
  return {
    trace: text(sp.traceId),
    id: text(sp.spanId),
    parent: typeof sp.parentSpanId === 'string' ? sp.parentSpanId : null,
    name: text(sp.name),
    kind: typeof sp.kind === 'number' ? sp.kind : 0,
    service,
    start: msOf(sp.startTimeUnixNano),
    end: msOf(sp.endTimeUnixNano),
    attrs: attrsOf(sp.attributes),
    events: list(sp.events)
      .map(fields)
      .map(e => ({ name: text(e.name), at: msOf(e.timeUnixNano), attrs: attrsOf(e.attributes) })),
    status: typeof status.code === 'number' ? status.code : 0,
    message: typeof status.message === 'string' ? status.message : undefined,
  };
};
// OTLP/JSON -> flat spans
export function spans(otlp: unknown): Span[] {
  return list(fields(otlp).resourceSpans)
    .map(fields)
    .flatMap(r => {
      const service = attrsOf(fields(r.resource).attributes)['service.name'];
      return list(r.scopeSpans).flatMap(s => list(fields(s).spans).map(sp => spanOf(sp, service)));
    });
}

export type Tree = {
  anomalies: Anomaly[];
  by: Map<string, Span>;
  kids: (s: Span) => Span[];
  root: Span | null;
};
/** Is a span part of a cycle of parents? Walk up from it. */
const cyclic = (s: Span, by: ReadonlyMap<string, Span>): boolean => {
  const seen = new Set<string>();
  for (let here: Span | undefined = s; here?.parent !== null && here !== undefined; here = by.get(here.parent)) {
    if (!by.has(here.parent)) return false;
    if (seen.has(here.id)) return true;
    seen.add(here.id);
  }
  return false;
};
// The shape every trace must have, whatever the workload: one trace id, unique span ids, exactly one root (a span
// whose parent is not in the trace), and that root's parent the client's span. Returns { anomalies, by, kids, root }.
export function tree(all: readonly Span[], { trace, client }: { trace: string; client: string }): Tree {
  const anomalies: Anomaly[] = [],
    by = new Map<string, Span>();
  for (const s of all) {
    if (s.trace !== trace) anomalies.push({ type: 'trace-id-mismatch', span: s.name, got: s.trace, want: trace });
    if (by.has(s.id)) anomalies.push({ type: 'duplicate-span-id', span: s.name, id: s.id });
    by.set(s.id, s);
  }
  const roots = all.filter(s => s.parent === null || !by.has(s.parent)),
    [first] = roots;
  if (roots.length !== 1)
    anomalies.push({ type: 'trace-not-one-tree', roots: roots.map(s => `${s.name} (parent ${s.parent})`) });
  const root = roots.length === 1 && first ? first : null;
  if (root && root.parent !== client && (root.attrs['tape.missing'] === undefined || root.attrs['tape.missing'] === ''))
    anomalies.push({ type: 'root-not-under-client-span', root: root.name, parent: root.parent, client });
  // a cycle would leave no root for part of the trace; walk up from every span
  for (const s of all) if (cyclic(s, by)) anomalies.push({ type: 'span-cycle', span: s.name });
  for (const s of all) if (!(s.end >= s.start)) anomalies.push({ type: 'negative-duration', span: s.name });
  const kids = (s: Span): Span[] => all.filter(k => k.parent === s.id);
  return { anomalies, by, kids, root };
}

export const missingEvents = (s: Span): SpanEvent[] => s.events.filter(e => e.name === 'tape.span.missing');
const marked = (s: Span, ...what: string[]): boolean =>
  missingEvents(s).some(e => what.some(w => e.attrs['tape.missing'] === w));

// A child must start and end within its parent, when both were timed by one clock (the router's spans; a Durable
// Object's supervisor and run spans and the calls it makes). Across clocks, a call span (CLIENT, timed by the
// caller) and the callee's span (SERVER, another service, timed by another machine) cannot be compared by
// position: the clocks are offset (in production by tens of ms either way; Workers clocks also only advance at
// I/O). What can be compared is length, which no offset changes: the callee's span must not outlast the call
// that it answered by more than `tolerance` ms. The offsets seen are reported (offset: callee start - call start),
// not judged. A callee span marked tape.missing=supervisor.start (view.ts: its clock was stale on arrival) may
// outlast its call; it is counted (stale). Returns { anomalies, worst (largest excess, ms), offsets: [ms], stale }.
export function nesting(
  all: readonly Span[],
  by: ReadonlyMap<string, Span>,
  tolerance: number,
): { anomalies: Anomaly[]; worst: number; offsets: number[]; stale: number } {
  const anomalies: Anomaly[] = [],
    offsets: number[] = [];
  let worst = 0,
    stale = 0;
  for (const s of all) {
    const p = s.parent === null ? undefined : by.get(s.parent);
    // a consumer span (a run a timer started) follows its parent; it runs later by design
    if (!p || s.kind === 5) continue;
    // A callee outlives a call that failed (the caller gave up at its budget; the callee went on), and a span whose
    // end is explicitly unknown (its object stopped) bounds only when its children start.
    const endless = (p.kind === 3 && p.status === 2) || marked(p, 'run.end', 'supervisor.end');
    if (p.kind === 3 && s.kind === 2 && p.service !== s.service) {
      offsets.push(s.start - p.start);
      // a callee that says its start is stale (its clock behind at arrival) is allowed to outlast, and is counted
      const said = marked(s, 'supervisor.start');
      if (said && !endless && s.end - s.start <= p.end - p.start)
        anomalies.push({ type: 'stale-start-marker-unfounded', span: s.name, parent: p.name });
      if (said) {
        stale++;
        continue;
      }
      const outlasts = endless ? 0 : Math.max(s.end - s.start - (p.end - p.start), 0);
      worst = Math.max(worst, outlasts);
      if (outlasts > tolerance)
        anomalies.push({ type: 'callee-outlasts-call', span: s.name, parent: p.name, excess_ms: outlasts });
      continue;
    }
    const excess = Math.max(p.start - s.start, endless ? 0 : s.end - p.end, 0);
    worst = Math.max(worst, excess);
    if (excess > tolerance)
      anomalies.push({ type: 'span-outside-parent', span: s.name, parent: p.name, excess_ms: excess });
  }
  return { anomalies, worst, offsets, stale };
}

// ---- broken traces, for the checker's own tests: each returns a new OTLP document
/** A span, an event and an attribute as an OTLP document has them. */
export type AttrValue = { stringValue?: string; intValue?: string; boolValue?: boolean; doubleValue?: number };
export type Attr = { key: string; value: AttrValue };
export type RawEvent = { name: string; timeUnixNano: string; attributes: Attr[] };
export type RawSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Attr[];
  events: RawEvent[];
  status: { code: number; message?: string };
};
export type RawScope = { scope: { name: string }; spans: RawSpan[] };
export type RawResource = { resource: { attributes: Attr[] }; scopeSpans: RawScope[] };
export type Doc = { resourceSpans: RawResource[] };
const valueIn = (v: unknown): AttrValue => {
  const { stringValue, intValue, boolValue, doubleValue } = fields(v);
  return {
    ...(typeof stringValue === 'string' ? { stringValue } : {}),
    ...(typeof intValue === 'string' ? { intValue } : {}),
    ...(typeof boolValue === 'boolean' ? { boolValue } : {}),
    ...(typeof doubleValue === 'number' ? { doubleValue } : {}),
  };
};
const attrList = (v: unknown): Attr[] =>
  list(v)
    .map(fields)
    .map(a => ({ key: text(a.key), value: valueIn(a.value) }));
const rawSpan = (v: unknown): RawSpan => {
  const sp = fields(v),
    status = fields(sp.status);
  return {
    traceId: text(sp.traceId),
    spanId: text(sp.spanId),
    ...(typeof sp.parentSpanId === 'string' ? { parentSpanId: sp.parentSpanId } : {}),
    name: text(sp.name),
    kind: typeof sp.kind === 'number' ? sp.kind : 0,
    startTimeUnixNano: text(sp.startTimeUnixNano),
    endTimeUnixNano: text(sp.endTimeUnixNano),
    attributes: attrList(sp.attributes),
    events: list(sp.events)
      .map(fields)
      .map(e => ({ name: text(e.name), timeUnixNano: text(e.timeUnixNano), attributes: attrList(e.attributes) })),
    status: {
      code: typeof status.code === 'number' ? status.code : 0,
      ...(typeof status.message === 'string' ? { message: status.message } : {}),
    },
  };
};
/** An OTLP document as it came over HTTP, for the mutations below. */
export const docOf = (otlp: unknown): Doc => ({
  resourceSpans: list(fields(otlp).resourceSpans)
    .map(fields)
    .map(r => ({
      resource: { attributes: attrList(fields(r.resource).attributes) },
      scopeSpans: list(r.scopeSpans)
        .map(fields)
        .map(sc => ({ scope: { name: text(fields(sc.scope).name) }, spans: list(sc.spans).map(rawSpan) })),
    })),
});
type Match = (sp: RawSpan) => boolean;
type Change = (v: AttrValue) => AttrValue;
const each = (otlp: Doc, f: (sp: RawSpan) => RawSpan[] | null): Doc => {
  const o = structuredClone(otlp);
  for (const r of o.resourceSpans) for (const s of r.scopeSpans) s.spans = s.spans.flatMap(sp => f(sp) ?? [sp]);
  return o;
};
const withAttr = (attributes: readonly Attr[], key: string, f: Change): Attr[] =>
  attributes.map(a => (a.key === key ? { key, value: f(a.value) } : a));
export const breaks = {
  // drop every span whose name matches
  drop: (otlp: Doc, match: Match): Doc => each(otlp, sp => (match(sp) ? [] : null)),
  // give the matching span another parent (a span id not in the trace, or another span's)
  reparent: (otlp: Doc, match: Match, parent: string): Doc =>
    each(otlp, sp => (match(sp) ? [{ ...sp, parentSpanId: parent }] : null)),
  // a copy of the matching span with a new id: a second root, or a second execution
  duplicate: (otlp: Doc, match: Match): Doc => each(otlp, sp => (match(sp) ? [sp, { ...sp, spanId: hex(8) }] : null)),
  retrace: (otlp: Doc, match: Match): Doc => each(otlp, sp => (match(sp) ? [{ ...sp, traceId: hex(16) }] : null)),
  // change one attribute of the matching span, or of the matching event on it
  attr: (otlp: Doc, match: Match, key: string, f: Change): Doc =>
    each(otlp, sp => (match(sp) ? [{ ...sp, attributes: withAttr(sp.attributes, key, f) }] : null)),
  eventAttr: (otlp: Doc, match: Match, event: (e: RawEvent) => boolean, key: string, f: Change): Doc =>
    each(otlp, sp =>
      match(sp)
        ? [{ ...sp, events: sp.events.map(e => (event(e) ? { ...e, attributes: withAttr(e.attributes, key, f) } : e)) }]
        : null,
    ),
  // remove the matching events (a tape.span.missing marker, say)
  dropEvents: (otlp: Doc, match: Match, event: (e: RawEvent) => boolean): Doc =>
    each(otlp, sp => (match(sp) ? [{ ...sp, events: sp.events.filter(e => !event(e)) }] : null)),
};
