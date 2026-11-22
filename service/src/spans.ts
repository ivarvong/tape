// spans.ts: the Worker's own part of a request's trace. The router (kv.js, and the program route in index.ts)
// opens a span for the request it received, a child span for each step it takes (finding the cluster, hashing the
// key, deciding an injected fault, calling the Durable Object), and hands the call's span to the object it calls,
// whose supervisor records its own span and the run's under it. When the call is over, the router stores what it
// recorded in the same object (Name.routed), before it answers: a trace never depends on a write after the reply.
//
// Durations are what the Worker measured with Date.now(), which in a Worker advances only across I/O. A step that
// does no I/O (hashing a key) therefore reads 0 ms; such a span says so in its tape.timing attribute instead of
// showing a made-up duration. Every span id is random; the trace id is the client's (from traceparent) or new.
const hex = (n: number): string =>
  [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');
export const newSpan = (): string => hex(8);
export const newTrace = (): string => hex(16);
// The clock as of now, as near as a Worker can get it. A Worker's or Durable Object's clock is the time of its last
// I/O; an isolate busy with other requests can begin this one with a clock 100 ms or more old (seen in production:
// two calls that arrived 13 ms apart at a busy shard both read the same start, 140 ms before either was sent).
// A zero-length timer renewed nothing in production (lag 0 on every span, the stale starts unchanged); a 1 ms timer
// renewed some (54 of 520 supervisor starts, by up to 124 ms) but not all. What it does not catch the trace does:
// a callee window longer than the call that contained it is marked tape.missing=supervisor.start (view.ts).
// Costs 1 ms at the start of each span that uses it. lag: how far the clock moved beyond the 1 ms waited (ms).
export async function fresh(): Promise<{ now: number; lag: number }> {
  const before = Date.now();
  await scheduler.wait(1);
  const now = Date.now();
  return { now, lag: Math.max(0, now - before - 1) };
}
export const NO_IO = "computed without I/O: a Worker's clock does not advance while code runs, so this reads 0 ms";

// W3C traceparent (version 00) -> { trace, parent } or null; all-zero ids are invalid
export const parseTraceparent = (h: string | null | undefined): { trace: string; parent: string } | null => {
  const [, trace = '', parent = ''] = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/.exec(h ?? '') ?? [];
  return trace !== '' && !/^0+$/.test(trace) && !/^0+$/.test(parent) ? { trace, parent } : null;
};

/** A span attribute's value. */
export type Attribute = string | number | boolean | null | undefined;
export type Attributes = Record<string, Attribute>;
export type SpanEvent = { name: string; at: number; attributes: Attributes };
/** A step as it is stored. */
export type StepRecord = {
  span: string;
  parent: string;
  name: string;
  kind: string;
  start: number;
  end: number | null;
  attributes: Attributes;
  events: SpanEvent[];
  error: string | null;
};
/** A step while it is open: end it with done(attrs); a step can be a client span (an RPC). */
export type Step = StepRecord & {
  done: (attrs?: Attributes, error?: unknown) => Step;
  event: (name: string, attrs?: Attributes) => void;
};
/** A request's router span and its steps, as stored. */
export type RouterRecord = {
  trace: string;
  client: string | null;
  span: string;
  name: string;
  start: number;
  end: number | null;
  status: number | null;
  attributes: Attributes;
  events: SpanEvent[];
  steps: StepRecord[];
};
const stored = ({ span, parent, name, kind, start, end, attributes, events, error }: StepRecord): StepRecord => ({
  span,
  parent,
  name,
  kind,
  start,
  end,
  attributes,
  events,
  error,
});

// One request's router span and its steps. name: the route ("PUT /kv/{account}/{cluster}/k/{key}").
export class RouterTrace {
  readonly trace: string;
  readonly client: string | null;
  readonly span: string = newSpan();
  readonly name: string;
  start: number = Date.now();
  end: number | null = null;
  status: number | null = null;
  readonly attributes: Attributes;
  readonly events: SpanEvent[] = [];
  readonly steps: Step[] = [];

  constructor(request: Request, name: string, attributes: Attributes = {}) {
    const tp = parseTraceparent(request.headers.get('traceparent'));
    this.trace = tp?.trace ?? newTrace();
    this.client = tp?.parent ?? null;
    this.name = name;
    this.attributes = {
      'http.request.method': request.method,
      'url.path': new URL(request.url).pathname,
      'tape.trace.from_client': tp !== null,
      ...attributes,
    };
  }
  // Start the span at the current time (fresh(), above), not the clock the isolate had when the request arrived.
  async started(): Promise<this> {
    const { now, lag } = await fresh();
    this.start = now;
    this.attributes['tape.clock.lag_ms'] = lag;
    return this;
  }
  // A step: begin() returns the step, end it with step.done(attrs); a step can be a client span (an RPC).
  begin(
    name: string,
    {
      kind = 'internal',
      attributes = {},
      span = newSpan(),
    }: { kind?: string; attributes?: Attributes; span?: string } = {},
  ): Step {
    const s: Step = {
      span,
      parent: this.span,
      name,
      kind,
      start: Date.now(),
      end: null,
      attributes: { ...attributes },
      events: [],
      error: null,
      done: (attrs = {}, error = null) => {
        s.end = Date.now();
        Object.assign(s.attributes, attrs);
        // oxlint-disable-next-line typescript/no-base-to-string -- an error of any kind is recorded as its text
        if (error !== null && error !== undefined && error !== false && error !== '') s.error = String(error);
        return s;
      },
      event: (event, attrs = {}) => {
        s.events.push({ name: event, at: Date.now(), attributes: attrs });
      },
    };
    this.steps.push(s);
    return s;
  }
  // a step that does no I/O: start = end, and it says why
  instant(name: string, attributes: Attributes = {}): Step {
    return this.begin(name, { attributes: { ...attributes, 'tape.timing': NO_IO } }).done();
  }
  event(name: string, attributes: Attributes = {}): void {
    this.events.push({ name, at: Date.now(), attributes });
  }
  // the traceparent for a call made in a step: the step's span is the parent of what the callee records
  traceparent(step: { span: string }): string {
    return `00-${this.trace}-${step.span}-01`;
  }
  finish(status: number, attributes: Attributes = {}): this {
    this.end = Date.now();
    this.status = status;
    Object.assign(this.attributes, attributes);
    return this;
  }
  // what is stored: plain data (steps lose their methods in structured clone anyway)
  toJSON(): RouterRecord {
    return {
      trace: this.trace,
      client: this.client,
      span: this.span,
      name: this.name,
      start: this.start,
      end: this.end,
      status: this.status,
      attributes: this.attributes,
      events: this.events,
      steps: this.steps.map(stored),
    };
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise(done => {
    setTimeout(done, ms);
  });
// Store the router's record with the object it called, before the reply. It is tried three times; if it still fails
// the response says so (tape-trace-complete: false) and the trace shows the router's part as missing, with why.
// stubOf() makes a new stub each time: a stub whose object was reset during the call is broken for good, and the
// requests whose objects reset are the ones whose traces matter most.
export async function store(
  stubOf: () => { routed: (callSpan: string, record: RouterRecord) => unknown },
  callSpan: string,
  rt: RouterTrace,
): Promise<string | null> {
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      await stubOf().routed(callSpan, rt.toJSON());
      return null;
    } catch (e) {
      last = e;
      if (i < 2) await sleep(50 * (i + 1) * (i + 1));
    }
  }
  return last instanceof Error ? last.message : String(last);
}

type Fields = Readonly<Record<string, unknown>>;
const fieldsOf = (v: unknown): Fields => (typeof v === 'object' && v !== null ? { ...v } : {});
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const count = (v: unknown): number => (typeof v === 'number' ? v : 0);
const attributesOf = (v: unknown): Attributes =>
  Object.fromEntries(
    Object.entries(fieldsOf(v)).flatMap(([k, x]): [string, Attribute][] =>
      typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean' ? [[k, x]] : [],
    ),
  );
const eventsOf = (v: unknown): SpanEvent[] =>
  (Array.isArray(v) ? v : [])
    .map(fieldsOf)
    .map(e => ({ name: text(e.name), at: count(e.at), attributes: attributesOf(e.attributes) }));
const stepOf = (v: unknown): StepRecord => {
  const s = fieldsOf(v);
  return {
    span: text(s.span),
    parent: text(s.parent),
    name: text(s.name),
    kind: text(s.kind),
    start: count(s.start),
    end: typeof s.end === 'number' ? s.end : null,
    attributes: attributesOf(s.attributes),
    events: eventsOf(s.events),
    error: typeof s.error === 'string' ? s.error : null,
  };
};
/** A router's record as it was stored (JSON). */
export const recordOf = (v: unknown): RouterRecord => {
  const r = fieldsOf(v);
  return {
    trace: text(r.trace),
    client: typeof r.client === 'string' ? r.client : null,
    span: text(r.span),
    name: text(r.name),
    start: count(r.start),
    end: typeof r.end === 'number' ? r.end : null,
    status: typeof r.status === 'number' ? r.status : null,
    attributes: attributesOf(r.attributes),
    events: eventsOf(r.events),
    steps: (Array.isArray(r.steps) ? r.steps : []).map(stepOf),
  };
};
