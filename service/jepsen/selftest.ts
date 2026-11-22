// node service/jepsen/selftest.ts: the checkers' own tests, run in Node (no workerd), in `npm test` of service/.
// verify/mutate/mutate.ts runs every checker rule against them: each rule disabled in turn
// must make at least one case here fail.
//
// Each case takes a real history and its real traces (fixtures/: from production runs of version c4e7a343, kept
// whole, which pass every check), changes one thing the way a bug would, and states exactly which anomalies the
// checker must report for it: no fewer (the rule fires) and no more (the others do not misfire). The KV
// linearizability check also has small histories written by hand, the way kv-jepsen.test.ts has.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import * as kv from './kv.ts';
import * as wf from './harness.ts';
import * as ret from './retention.ts';
import { docOf } from './traces.ts';
import type { Anomaly, AttrValue, Doc, RawEvent, RawResource, RawScope, RawSpan, Span } from './traces.ts';

const load = (n: string): Readonly<Record<string, unknown>> => {
  const v: unknown = JSON.parse(
    gunzipSync(readFileSync(new URL(`./fixtures/${n}.json.gz`, import.meta.url).pathname)).toString(),
  );
  return typeof v === 'object' && v !== null ? { ...v } : {};
};
const clone = <T>(o: T): T => structuredClone(o);
let failed = 0,
  passed = 0;
/** A value a fixture must have. */
const must = <T>(v: T | undefined | null, what: string): T => {
  if (v === undefined || v === null) throw new Error(`the fixture has no ${what}`);
  return v;
};
const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);
export const types = (r: { anomalies: readonly Anomaly[] }): string[] =>
  [...new Set(r.anomalies.map(a => a.type))].toSorted();
function expectTypes(name: string, got: readonly string[], want: readonly string[]): void {
  const w = [...new Set(want)].toSorted();
  if (sameSet(got, w)) {
    passed++;
    return;
  }
  failed++;
  console.log(`FAIL ${name}\n  want ${JSON.stringify(w)}\n  got  ${JSON.stringify(got)}`);
}

// ---- editing a trace: OTLP/JSON in, a changed copy out
type Scalar = string | number | boolean;
const valueOf = (v: Scalar): AttrValue => {
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v !== 'number') return { stringValue: v };
  return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
};
const scalarOf = (v: AttrValue | undefined): Scalar | undefined => {
  if (v === undefined) return undefined;
  if (v.stringValue !== undefined) return v.stringValue;
  return v.intValue === undefined ? (v.boolValue ?? v.doubleValue) : Number(v.intValue);
};
const serviceOf = (r: RawResource): string | undefined =>
  r.resource.attributes.find(a => a.key === 'service.name')?.value.stringValue;
type Found = { sp: RawSpan; r: RawResource; s: RawScope; service: string | undefined };
type Pred = (sp: RawSpan, service: string | undefined) => boolean;
const missingOf = (e: RawEvent): string | undefined =>
  e.attributes.find(a => a.key === 'tape.missing')?.value.stringValue;
/** What a case edits a trace with. */
export type Editor = {
  o: Doc;
  list: () => Found[];
  find: (pred: Pred) => RawSpan[];
  one: (pred: Pred) => RawSpan;
  get: (sp: RawSpan, k: string) => Scalar | undefined;
  set: (sp: RawSpan, k: string, v: Scalar | undefined) => void;
  drop: (pred: Pred) => void;
  /** a copy of a span, beside it, with a new id (or the same one) */
  copy: (sp: RawSpan, change?: Partial<RawSpan>) => RawSpan;
  /** a span moved into another resource (another service) */
  move: (sp: RawSpan, service: string) => void;
  marker: (what: string, reason?: string, at?: string) => RawEvent;
  markers: (sp: RawSpan) => (string | undefined)[];
  unmark: (sp: RawSpan, what?: string) => void;
  shift: (sp: RawSpan, startMs: number, endMs?: number) => void;
  queries: (sp: RawSpan) => RawEvent[];
  text: (e: RawEvent) => string;
  rows: (e: RawEvent) => unknown[][];
  setRows: (e: RawEvent, rows: unknown) => void;
};
const editor = (o: Doc): Editor => {
  const list = (): Found[] =>
    o.resourceSpans.flatMap(r => r.scopeSpans.flatMap(s => s.spans.map(sp => ({ sp, r, s, service: serviceOf(r) }))));
  const scopeOf = (sp: RawSpan): RawScope => {
    const found = list().find(x => x.sp === sp);
    if (!found) throw new Error(`edit: span ${sp.name} is not in the trace`);
    return found.s;
  };
  const rowsAttr = (e: RawEvent): AttrValue | undefined => e.attributes.find(x => x.key === 'tape.sql.rows')?.value;
  return {
    o,
    list,
    find: pred =>
      list()
        .filter(e => pred(e.sp, e.service))
        .map(e => e.sp),
    one: pred => {
      const x = list().filter(e => pred(e.sp, e.service)),
        [only] = x;
      if (x.length !== 1 || !only) throw new Error(`edit: ${x.length} spans match`);
      return only.sp;
    },
    get: (sp, k) => scalarOf(sp.attributes.find(a => a.key === k)?.value),
    set: (sp, k, v) => {
      sp.attributes = sp.attributes.filter(a => a.key !== k);
      if (v !== undefined) sp.attributes.push({ key: k, value: valueOf(v) });
    },
    drop: pred => {
      for (const r of o.resourceSpans)
        for (const s of r.scopeSpans) s.spans = s.spans.filter(sp => !pred(sp, serviceOf(r)));
    },
    copy: (sp, change = {}) => {
      const c = { ...clone(sp), spanId: `${sp.spanId.slice(0, 12)}beef`, ...change };
      scopeOf(sp).spans.push(c);
      return c;
    },
    move: (sp, service) => {
      const s = scopeOf(sp);
      s.spans = s.spans.filter(x => x !== sp);
      o.resourceSpans.push({
        resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
        scopeSpans: [{ scope: { name: 'tape' }, spans: [sp] }],
      });
    },
    marker: (what, reason = 'test', at = '0') => ({
      name: 'tape.span.missing',
      timeUnixNano: at,
      attributes: [
        { key: 'tape.missing', value: { stringValue: what } },
        { key: 'tape.missing.reason', value: { stringValue: reason } },
      ],
    }),
    markers: sp => sp.events.filter(e => e.name === 'tape.span.missing').map(missingOf),
    unmark: (sp, what) => {
      sp.events = sp.events.filter(
        e => !(e.name === 'tape.span.missing' && (what === undefined || what === '' || missingOf(e) === what)),
      );
    },
    shift: (sp, startMs, endMs = startMs) => {
      sp.startTimeUnixNano = String(BigInt(sp.startTimeUnixNano) + BigInt(Math.round(startMs * 1e6)));
      sp.endTimeUnixNano = String(BigInt(sp.endTimeUnixNano) + BigInt(Math.round(endMs * 1e6)));
    },
    queries: sp => sp.events.filter(e => e.name === 'db.query'),
    text: e => e.attributes.find(a => a.key === 'db.query.text')?.value.stringValue ?? '',
    rows: e => {
      const all: unknown = JSON.parse(rowsAttr(e)?.stringValue ?? '[]');
      return Array.isArray(all) ? all.map((r: unknown): unknown[] => (Array.isArray(r) ? r : [])) : [];
    },
    setRows: (e, rows) => {
      const a = e.attributes.find(x => x.key === 'tape.sql.rows');
      if (a) a.value = { stringValue: JSON.stringify(rows) };
    },
  };
};
export function edit(otlp: unknown, f: (e: Editor) => unknown): Doc {
  const o = docOf(otlp);
  f(editor(o));
  return o;
}

// =====================================================================================================================
// KV: the linearizability check, on histories written by hand
{
  type Hand = Omit<kv.Attempt, 'client' | 'trace' | 'span'>;
  const by = (h: Hand): kv.Attempt => ({ client: 0, trace: '', span: '', ...h });
  const W = (
    key: string,
    value: string,
    start: number,
    end: number,
    version: number,
    extra: Partial<Hand> = {},
  ): Hand => ({
    key,
    f: 'put',
    value,
    start,
    end,
    type: 'ok',
    status: version === 1 ? 201 : 200,
    version,
    ...extra,
  });
  const R = (
    key: string,
    start: number,
    end: number,
    version: number,
    read: string | undefined,
    live = true,
  ): Hand => ({
    key,
    f: 'get',
    start,
    end,
    type: 'ok',
    status: live ? 200 : 404,
    live,
    version,
    ...(live ? { read } : {}),
  });
  const lostPut = (key: string, value: string, start: number, end: number): Hand => ({
    key,
    f: 'put',
    value,
    start,
    end,
    type: 'info',
    status: 503,
  });
  const final = (version: number, value: string | undefined, live = true): kv.Final => ({
    a: { live, version, ...(live ? { value } : {}) },
  });
  const cases: [string, Hand[], kv.Final, string[]][] = [
    ['valid', [W('a', 'x', 0, 1, 1), R('a', 2, 3, 1, 'x'), W('a', 'y', 4, 5, 2)], final(2, 'y'), []],
    ['a lost write placed by a read', [lostPut('a', 'x', 0, 3), R('a', 1, 2, 1, 'x')], final(1, 'x'), []],
    ['a stale read', [W('a', 'x', 0, 1, 1), W('a', 'y', 2, 3, 2), R('a', 4, 5, 1, 'x')], final(2, 'y'), ['real-time']],
    ['two acks for one version', [W('a', 'x', 0, 3, 1), W('a', 'y', 1, 2, 1)], final(1, 'y'), ['duplicate-version']],
    ['an acked write lost', [W('a', 'x', 0, 1, 1), W('a', 'y', 2, 3, 2)], final(1, 'x'), ['lost-write']],
    ['a read of the wrong value', [W('a', 'x', 0, 1, 1), R('a', 2, 3, 1, 'z')], final(1, 'x'), ['read-wrong-value']],
    [
      'a read from the future',
      [R('a', 0, 1, 1, 'x'), lostPut('a', 'x', 2, 3)],
      final(1, 'x'),
      ['read-from-future', 'real-time'],
    ],
    [
      'a CAS that skipped a version',
      [W('a', 'x', 0, 1, 1), W('a', 'y', 2, 3, 3, { expect: 1 })],
      final(3, 'y'),
      ['cas-wrong-version', 'versions-not-dense'],
    ],
    ['versions from nowhere', [W('a', 'x', 0, 1, 1)], final(5, 'q'), ['versions-not-dense']],
    [
      'a CAS refused at the version it expected',
      [
        W('a', 'x', 0, 1, 1),
        { key: 'a', f: 'put', value: 'y', expect: 1, start: 2, end: 3, type: 'fail', status: 409, version: 1 },
      ],
      final(1, 'x'),
      ['refused-at-expected-version'],
    ],
    [
      'a delete that found no key where a put had made one',
      [W('a', 'x', 0, 1, 1), { key: 'a', f: 'del', start: 2, end: 3, type: 'fail', status: 404, version: 1 }],
      final(1, 'x'),
      ['delete-missed-live-key'],
    ],
    [
      'a live key at version 0',
      [{ key: 'a', f: 'get', start: 0, end: 1, type: 'ok', status: 200, live: true, version: 0, read: 'x' }],
      final(0, undefined, false),
      ['live-at-version-0'],
    ],
    [
      'a value nobody wrote',
      [W('a', 'x', 0, 1, 1), lostPut('a', 'y', 2, 3), R('a', 4, 5, 2, 'zz')],
      final(2, 'zz'),
      ['read-unwritten-value'],
    ],
    [
      'an acked value read at another version',
      [W('a', 'x', 0, 1, 1), lostPut('a', 'y', 2, 3), R('a', 4, 5, 2, 'x')],
      final(2, 'x'),
      ['read-value-of-other-version'],
    ],
    [
      'one lost write at two versions',
      [lostPut('a', 'x', 0, 1), lostPut('a', 'y', 0, 1), R('a', 2, 3, 1, 'x'), R('a', 4, 5, 2, 'x')],
      final(2, 'x'),
      ['value-at-two-versions'],
    ],
    [
      'a delete nobody sent',
      [W('a', 'x', 0, 1, 1), lostPut('a', 'y', 2, 3), R('a', 4, 5, 2, undefined, false)],
      final(2, undefined, false),
      ['unexplained-delete'],
    ],
    [
      'a write refused before any shard (not applied) whose value was read',
      [
        { key: 'a', f: 'put', value: 'x', start: 0, end: 1, type: 'fail', status: 503, not_sent: true },
        R('a', 2, 3, 1, 'x'),
      ],
      final(1, 'x'),
      ['read-value-of-other-version', 'versions-not-dense'],
    ],
    ['no final read of a key', [W('a', 'x', 0, 1, 1)], {}, ['no-final-read']],
    ['the final value not the last write', [W('a', 'x', 0, 1, 1)], final(1, 'y'), ['final-wrong-value']],
  ];
  for (const [what, history, f, want] of cases)
    expectTypes(`kv check: ${what}`, types(kv.check(history.map(by), f)), want);
}

// =====================================================================================================================
// KV: the real history of one key (105 attempts) and its traces
type Traces = Record<string, unknown>;
const tracesOf = (v: unknown): Traces => (typeof v === 'object' && v !== null ? { ...v } : {});
const stored = load('kv');
const K = {
    account: String(stored.account),
    cluster: String(stored.cluster),
    shards: Number(stored.shards),
    history: kv.historyOf(stored.history),
    final: kv.finalOf(stored.final),
    traces: tracesOf(stored.traces),
  },
  kopts = { account: K.account, cluster: K.cluster, shards: K.shards };
const effectOf = (h: kv.Attempt): kv.OpChecked => kv.checkOpTrace(h, K.traces[h.trace] ?? null, kopts);
type Tag = { h: kv.Attempt; kind: string; markers: unknown[] };
const tagOf = (h: kv.Attempt): Tag => {
  const r = effectOf(h);
  return { h, kind: r.effect.kind, markers: r.markers ?? [] };
};
const kTags = K.history.map(tagOf);
const pickK = (what: string, pred: (h: kv.Attempt, t: Tag) => boolean): kv.Attempt => {
  const x = kTags.find(t => pred(t.h, t));
  if (!x) throw new Error(`no KV fixture op: ${what}`);
  return x.h;
};
const ok = pickK(
  'an acked put that committed',
  (h, t) => h.f === 'put' && h.type === 'ok' && t.kind === 'committed' && t.markers.length === 0,
);
const del = pickK(
  'an acked delete that committed',
  (h, t) => h.f === 'del' && h.type === 'ok' && t.kind === 'committed',
);
const read = pickK(
  'a read of a live key',
  (h, t) => h.f === 'get' && h.type === 'ok' && h.live === true && t.markers.length === 0,
);
const replay = pickK(
  'an acked put answered from its stored reply',
  (h, t) => h.f === 'put' && h.type === 'ok' && t.kind === 'replayed' && t.markers.length === 0,
);
const unsent = pickK(
  'a put the shard never saw',
  (h, t) => h.f === 'put' && h.type === 'info' && sameSet(t.markers.map(String), ['supervisor']),
);
const rolled = pickK(
  'a put rolled back by a storage error',
  h => h.f === 'put' && (h.status === 500 || h.status === 503) && h.applied === false,
);
pickK(
  'a put whose shard stopped mid-call',
  (h, t) => h.type === 'info' && t.markers.includes('supervisor.end') && t.markers.includes('run'),
);
pickK('a CAS refused', h => h.f === 'put' && h.status === 409);
const aborted = pickK('a read the client aborted', h => h.client_fault === 'abort');
pickK('an op whose supervisor began on a stale clock', (h, t) => t.markers.includes('supervisor.start'));

// a run of the KV trace checker with one op (or more) changed: f gets a copy of { history, final, traces }
type KvCase = { history: kv.History; final: kv.Final; traces: Traces };
const kvRun = (what: string, f: (x: KvCase) => void, want: readonly string[]): void => {
  const x = { history: clone(K.history), final: clone(K.final), traces: { ...K.traces } };
  f(x);
  expectTypes(
    `kv traces: ${what}`,
    types(kv.checkTraces(x.history, x.final, new Map(Object.entries(x.traces)), kopts)),
    want,
  );
};
// one op's trace edited
const kvTrace = (
  what: string,
  h: kv.Attempt,
  f: (t: Editor) => unknown,
  want: readonly string[],
  hist?: (y: kv.Attempt) => kv.Attempt,
): void => {
  kvRun(
    what,
    x => {
      x.traces[h.trace] = edit(K.traces[h.trace], f);
      if (hist) x.history = x.history.map(y => (y.trace === h.trace ? hist({ ...y }) : y));
    },
    want,
  );
};
const isRouter = (sp: RawSpan): boolean => sp.name.endsWith('/kv/{account}/{cluster}/k/{key}');
const isInvoke = (sp: RawSpan): boolean => sp.name.endsWith('.invoke') && sp.name.startsWith('kv-');
const isSup = (_sp: RawSpan, svc: string | undefined): boolean => svc?.endsWith(' supervisor') === true;
const isRun = (sp: RawSpan, svc: string | undefined): boolean =>
  svc?.endsWith(' supervisor') !== true && svc !== 'tape-router' && sp.name.includes(' /k/');
// the shape view.ts gives a request whose router record was lost: the call span stands in for the router, marked
const routerLost = (t: Editor, { marker = true }: { marker?: boolean } = {}): void => {
  const inv = t.one(isInvoke);
  t.drop(sp => sp !== inv && (isRouter(sp) || ['kv.cluster.lookup', 'kv.route', 'kv.fault.decide'].includes(sp.name)));
  delete inv.parentSpanId;
  inv.name = 'router (not recorded)';
  inv.attributes = [];
  t.set(inv, 'tape.missing', 'router');
  inv.events = marker ? [t.marker('router')] : [];
};
// the shape of a run whose supervisor record was lost: the run under the call span, marked
const orphaned = (t: Editor, { marker = true }: { marker?: boolean } = {}): void => {
  const inv = t.one(isInvoke),
    sup = t.one(isSup),
    run = t.one(isRun);
  t.drop(sp => sp === sup);
  run.parentSpanId = inv.spanId;
  t.set(run, 'tape.supervisor.missing', true);
  if (marker) run.events.unshift(t.marker('supervisor'));
};

kvRun('the real traces pass', () => {}, []);
// the tree (traces.ts)
kvTrace(
  'a span in another trace',
  ok,
  t => {
    t.one(isInvoke).traceId = 'ab'.repeat(16);
  },
  ['trace-id-mismatch'],
);
kvTrace(
  'two spans with one id',
  ok,
  t => {
    t.copy(
      t.one(sp => sp.name === 'kv.cluster.lookup'),
      { spanId: t.one(sp => sp.name === 'kv.cluster.lookup').spanId },
    );
  },
  ['duplicate-span-id', 'lookup-span'],
);
kvTrace('the router span dropped', ok, t => t.drop(isRouter), ['trace-not-one-tree']);
kvTrace(
  'the root under another client span',
  ok,
  () => {},
  ['root-not-under-client-span'],
  h => ({ ...h, span: 'feedfacefeedface' }),
);
kvTrace(
  'a cycle',
  ok,
  t => {
    t.one(isRouter).parentSpanId = t.one(isRun).spanId;
  },
  ['span-cycle', 'trace-not-one-tree'],
);
kvTrace(
  'a span that ends before it starts',
  ok,
  t => {
    const s = t.one(sp => sp.name === 'kv.route');
    s.endTimeUnixNano = String(BigInt(s.startTimeUnixNano) - 1000000n);
  },
  ['negative-duration'],
);
kvTrace('a span outside its parent (one clock)', ok, t => t.shift(t.one(isRun), 0, 1000), ['span-outside-parent']);
kvTrace(
  'a callee outlasting its call (two clocks)',
  ok,
  t => {
    t.shift(t.one(isSup), 0, 1000);
    t.shift(t.one(isRun), 0, 1000);
  },
  ['callee-outlasts-call'],
);
kvTrace(
  'a stale-start marker on a span that fits its call',
  ok,
  t => t.one(isSup).events.push(t.marker('supervisor.start')),
  ['stale-start-marker-unfounded'],
);
// (the real stale-start marker, removed, leaves an excess within the 50 ms tolerance: no anomaly, so no case)
// fetching
kvRun(
  'a trace that could not be fetched',
  x => {
    x.traces[ok.trace] = { error: '500 test' };
  },
  ['trace-unreadable', 'committed-write-without-trace'],
);
kvRun(
  'a trace for a request never sent',
  x => {
    x.history = x.history.map(y =>
      y.trace === unsent.trace ? { ...y, client_fault: 'drop_request', type: 'fail', status: 0 } : y,
    );
  },
  ['trace-for-unsent-request'],
);
// a request the router refused before any shard (the cluster lookup failed): no trace, and the response says so
const refusedOf = (y: kv.Attempt): kv.Attempt => ({
  ...y,
  type: 'fail',
  status: 503,
  not_sent: true,
  trace_complete: 'false',
});
kvRun(
  'a refused request with no trace, said by the response: allowed',
  x => {
    x.traces[unsent.trace] = { resourceSpans: [] };
    x.history = x.history.map(y => (y.trace === unsent.trace ? refusedOf(y) : y));
  },
  [],
);
kvRun(
  'a refused request with no trace, not said by the response',
  x => {
    x.traces[unsent.trace] = { resourceSpans: [] };
    x.history = x.history.map(y => (y.trace === unsent.trace ? { ...refusedOf(y), trace_complete: 'true' } : y));
  },
  ['trace-missing'],
);
kvRun(
  'no trace at all, and the response said its trace is incomplete: allowed',
  x => {
    x.traces[unsent.trace] = { resourceSpans: [] };
    x.history = x.history.map(y => (y.trace === unsent.trace ? { ...y, status: 503, trace_complete: 'false' } : y));
  },
  [],
);
kvRun(
  'no trace of a write that committed, though the response said its trace is incomplete',
  x => {
    x.traces[ok.trace] = { resourceSpans: [] };
    x.history = x.history.map(y =>
      y.trace === ok.trace ? { ...y, type: 'info', status: 503, trace_complete: 'false' } : y,
    );
  },
  ['committed-write-without-trace'],
);
kvRun(
  'no trace of a read whose response the client dropped, the connection having failed first: allowed (K2)',
  x => {
    x.traces[aborted.trace] = { resourceSpans: [] };
    x.history = x.history.map(y =>
      y.trace === aborted.trace
        ? { ...y, client_fault: 'drop_response', sent_status: null, status: 0, error: 'fetch failed: ECONNRESET' }
        : y,
    );
  },
  [],
);
kvRun(
  'no trace of a read whose response the client dropped after it arrived',
  x => {
    x.traces[aborted.trace] = { resourceSpans: [] };
    x.history = x.history.map(y =>
      y.trace === aborted.trace ? { ...y, client_fault: 'drop_response', sent_status: 200, status: 0 } : y,
    );
  },
  ['trace-missing'],
);
kvRun(
  'the trace of an acked write gone',
  x => {
    x.traces[ok.trace] = { resourceSpans: [] };
  },
  ['trace-missing', 'committed-write-without-trace'],
);
// the router
kvTrace('the router record lost, said by the trace, not by the response', ok, t => routerLost(t), [
  'router-record-missing',
]);
kvTrace(
  'the router record lost and said by the response: allowed',
  ok,
  t => routerLost(t),
  [],
  h => ({ ...h, trace_complete: 'false' }),
);
kvTrace(
  'the router record lost without a marker',
  ok,
  t => routerLost(t, { marker: false }),
  ['missing-without-marker'],
  h => ({ ...h, trace_complete: 'false' }),
);
kvTrace(
  'the router span renamed',
  ok,
  t => {
    t.one(isRouter).name = 'PUT /elsewhere';
  },
  ['wrong-root'],
);
kvTrace('the router naming another key', ok, t => t.set(t.one(isRouter), 'kv.key', 'other'), ['router-wrong-key']);
kvTrace(
  'the router reporting a status the client did not see',
  ok,
  t => t.set(t.one(isRouter), 'http.response.status_code', 418),
  ['status-mismatch', 'router-status-not-run-status'],
);
kvTrace('the cluster lookup missing', ok, t => t.drop(sp => sp.name === 'kv.cluster.lookup'), ['lookup-span']);
kvTrace('the route step missing', ok, t => t.drop(sp => sp.name === 'kv.route'), ['route-span']);
kvTrace(
  'routed to another shard',
  ok,
  t =>
    t.set(
      t.one(sp => sp.name === 'kv.route'),
      'kv.shard',
      7,
    ),
  ['route-wrong-shard'],
);
kvTrace(
  'two shard calls',
  ok,
  t => {
    t.copy(t.one(isInvoke));
  },
  ['shard-call-span'],
);
kvTrace(
  'the shard call to another shard',
  ok,
  t => {
    t.one(isInvoke).name = 'kv-j-9.invoke';
  },
  ['shard-call-wrong'],
);
kvTrace(
  'an unexpected step under the router',
  ok,
  t => {
    t.copy(
      t.one(sp => sp.name === 'kv.route'),
      { name: 'kv.surprise' },
    );
  },
  ['unexpected-router-child'],
);
// under the shard call
kvTrace(
  'an unexpected span under the shard call',
  ok,
  t => {
    const c = t.copy(
      t.one(sp => sp.name === 'kv.route'),
      { name: 'kv.surprise' },
    );
    c.parentSpanId = t.one(isInvoke).spanId;
  },
  ['unexpected-call-child'],
);
// under the shard call
const callFailed = (t: Editor): void => {
  t.set(t.one(isInvoke), 'tape.call.outcome', 'exception');
  t.set(t.one(isInvoke), 'http.response.status_code', undefined);
  t.set(t.one(isRouter), 'http.response.status_code', 503);
};
const unknownToClient = (h: kv.Attempt): kv.Attempt => ({ ...h, type: 'info', status: 503, version: undefined });
kvTrace(
  'an unexpected span under the shard call',
  ok,
  t => {
    const c = t.copy(
      t.one(sp => sp.name === 'kv.route'),
      { name: 'kv.surprise' },
    );
    c.parentSpanId = t.one(isInvoke).spanId;
  },
  ['unexpected-call-child'],
);
kvTrace(
  'a run whose supervisor record was lost, marked, of a call that failed: allowed',
  ok,
  t => {
    orphaned(t);
    callFailed(t);
  },
  [],
  unknownToClient,
);
kvTrace(
  'a run whose supervisor record was lost, without a marker',
  ok,
  t => {
    orphaned(t, { marker: false });
    callFailed(t);
  },
  ['orphan-run-without-marker'],
  unknownToClient,
);
kvTrace('a run without its supervisor under a call that was answered', ok, t => orphaned(t), [
  'orphan-run-of-answered-call',
]);
kvTrace(
  'two runs without supervisors (two executions)',
  ok,
  t => {
    orphaned(t);
    callFailed(t);
    t.copy(t.one(isRun));
  },
  ['duplicate-execution'],
  unknownToClient,
);
kvTrace('the marker for a call the shard never saw, removed', unsent, t => t.unmark(t.one(isInvoke)), [
  'supervisor-missing-without-marker',
]);
kvTrace(
  'no supervisor for a call that was answered',
  unsent,
  t => t.set(t.one(isInvoke), 'tape.call.outcome', 'answered'),
  ['supervisor-missing'],
);
kvTrace(
  'two supervisors (two executions)',
  ok,
  t => {
    t.copy(t.one(isSup));
  },
  ['duplicate-execution'],
);
kvTrace('the supervisor of another object', ok, t => t.move(t.one(isSup), `${K.account}/kv-j-9 supervisor`), [
  'supervisor-wrong',
]);
kvTrace(
  'a run for a call that was never sent',
  ok,
  t => t.set(t.one(isInvoke), 'tape.call.outcome', 'fault:overload'),
  ['ran-after-not-sent'],
);
kvTrace(
  'an open supervisor for a call that was answered',
  ok,
  t => t.one(isSup).events.push(t.marker('supervisor.end')),
  ['open-supervisor-of-answered-call'],
);
kvTrace('the run span missing, with no marker', ok, t => t.drop(isRun), [
  'run-missing-without-marker',
  'trace-effect-mismatch',
  'committed-write-without-trace',
]);
kvTrace(
  'two runs under one supervisor',
  ok,
  t => {
    t.copy(t.one(isRun));
  },
  ['duplicate-run'],
);
kvTrace(
  'the run of another key',
  ok,
  t => {
    t.one(isRun).name = 'PUT /k/other';
  },
  ['run-wrong'],
);
kvTrace(
  'the supervisor reporting another status than its run',
  ok,
  t => t.set(t.one(isSup), 'http.response.status_code', 500),
  ['run-status-not-supervisor-status'],
);
kvTrace(
  'the run reporting another status than the router',
  ok,
  t => {
    t.set(t.one(isSup), 'http.response.status_code', 500);
    t.set(t.one(isRun), 'http.response.status_code', 500);
  },
  ['router-status-not-run-status'],
);
kvTrace('a run duration not measured', ok, t => t.set(t.one(isRun), 'tape.duration.source', 'estimated'), [
  'run-duration-unmeasured',
]);
kvTrace(
  'a statement count that does not match the statements',
  ok,
  t => t.set(t.one(isRun), 'tape.sql.statements', Number(t.get(t.one(isRun), 'tape.sql.statements')) + 1),
  ['sql-count-mismatch'],
);
// what the trace says happened, against the client
const writeOf = (t: Editor): RawEvent =>
  must(
    t.queries(t.one(isRun)).find(e => /^(INSERT INTO kv|UPDATE kv)/.test(t.text(e))),
    'write statement',
  );
const readOf = (t: Editor): RawEvent =>
  must(
    t.queries(t.one(isRun)).find(e => t.text(e).startsWith('SELECT key, value, version, live FROM kv')),
    'read statement',
  );
/** A statement's first returned row. */
const rowOf = (t: Editor, e: RawEvent): unknown[] => t.rows(e)[0] ?? [];
kvTrace(
  'the written value changed in the SQL rows',
  ok,
  t => {
    const w = writeOf(t),
      r = rowOf(t, w);
    t.setRows(w, [[r[0], 'forged', r[2], r[3]]]);
  },
  ['trace-effect-mismatch'],
);
kvTrace(
  'a replay seen by a write without an op id',
  replay,
  () => {},
  ['replay-without-op-id', 'trace-effect-mismatch'],
  h => {
    const { once: _once, attempt: _attempt, ...rest } = h;
    return rest;
  },
);
kvTrace(
  'a rolled-back write shown as committed',
  rolled,
  t => {
    const run = t.one(isRun);
    run.status = { code: 0 };
    t.set(run, 'tape.run.rolled_back', undefined);
    t.setRows(writeOf(t), [[rolled.key, rolled.value, (rolled.expect ?? 0) + 1, 1]]);
  },
  ['failed-op-committed-in-trace', 'trace-duplicate-version'],
);
kvTrace(
  'the read seeing another value',
  read,
  t => {
    const q = readOf(t),
      r = rowOf(t, q);
    t.setRows(q, [[r[0], 'forged', r[2], r[3]]]);
  },
  ['trace-read-mismatch'],
);

// exactly once, per op id; and the writes the traces say committed, per key, against the final state
const effK = (h: kv.Attempt): kv.Effect => effectOf(h).effect;
const groups = [
  ...Map.groupBy(
    K.history.filter(h => h.once !== undefined),
    h => `${h.client}/${h.once}`,
  ).values(),
];
const g1 = must(
  groups.find(a => a.some(h => effK(h).kind === 'committed') && a.some(h => effK(h).kind === 'replayed')),
  'op id that committed and was replayed',
);
const g1commit = must(
    g1.find(h => effK(h).kind === 'committed'),
    'commit',
  ),
  g1replay = must(
    g1.find(h => effK(h).kind === 'replayed'),
    'replay',
  );
// one op's trace as if it were another's: its trace id and client span
const retarget = (from: kv.Attempt, to: kv.Attempt): Doc =>
  edit(K.traces[from.trace], t => {
    for (const { sp } of t.list()) {
      sp.traceId = to.trace;
      if (sp.parentSpanId === from.span) sp.parentSpanId = to.span;
    }
  });
kvRun(
  'a retry under the same op id that committed again',
  x => {
    x.traces[g1replay.trace] = retarget(g1commit, g1replay);
    x.history = x.history.map(h =>
      h === g1replay || h.trace === g1replay.trace
        ? { ...h, ...(g1commit.status === undefined ? {} : { status: g1commit.status }) }
        : h,
    );
  },
  ['op-applied-twice', 'trace-duplicate-version'],
);
kvTrace('a replay whose first attempt committed nothing', g1commit, t => t.setRows(writeOf(t), []), [
  'replay-without-its-commit',
  'committed-write-without-trace',
]);
const finalOp = must(
  kTags.find(t => t.kind === 'committed' && effK(t.h).version === K.final[t.h.key]?.version),
  'write of the final version',
).h;
kvTrace(
  'two writes traced at one version',
  ok,
  t => {
    const w = writeOf(t),
      r = rowOf(t, w);
    t.setRows(w, [[r[0], r[1], effK(del).version, r[3]]]);
  },
  ['trace-duplicate-version', 'trace-effect-mismatch', 'committed-write-without-trace'],
);
kvTrace(
  'a traced write beyond the final version',
  ok,
  t => {
    const w = writeOf(t),
      r = rowOf(t, w);
    t.setRows(w, [[r[0], r[1], 99, r[3]]]);
  },
  ['trace-version-beyond-final', 'trace-effect-mismatch', 'committed-write-without-trace'],
);
kvTrace(
  'the last write traced with another value than the final one',
  finalOp,
  t => {
    const w = writeOf(t),
      r = rowOf(t, w);
    t.setRows(w, [[r[0], 'forged', r[2], r[3]]]);
  },
  ['trace-final-mismatch', 'read-not-from-traced-write'],
);
kvTrace(
  'a read of a value its version did not write (client and trace agree)',
  read,
  t => {
    const q = readOf(t),
      r = rowOf(t, q);
    t.setRows(q, [[r[0], 'forged', r[2], r[3]]]);
  },
  ['read-not-from-traced-write'],
  h => ({ ...h, read: 'forged' }),
);
kvTrace(
  'a read of a version no traced write made',
  read,
  t => {
    const q = readOf(t),
      r = rowOf(t, q);
    t.setRows(q, [[r[0], r[1], 999, r[3]]]);
  },
  ['read-of-untraced-version'],
  h => ({ ...h, version: 999 }),
);

// =====================================================================================================================
// The workflow (harness.ts): the real history of a whole run (296 operations, 5 programs) and its traces
/** A row a case may change. */
type Row = Record<string, unknown>;
type MutFinal = { orders: Row[]; sales: Row[]; stock: Row[]; cards: Row[]; labels: Row[]; seats: Row[] } & Row;
const mutable = (rows: readonly Readonly<Row>[]): Row[] => rows.map(r => ({ ...r }));
const mutFinal = (f: wf.Final): MutFinal => ({
  ...f,
  orders: mutable(f.orders),
  sales: mutable(f.sales),
  stock: mutable(f.stock),
  cards: mutable(f.cards),
  labels: mutable(f.labels),
  seats: mutable(f.seats),
});
/** The one of a list a case is about. */
const the = <T>(all: readonly T[], pred: (x: T) => boolean): T => must(all.find(pred), 'such row');
/** A field of a value read as JSON. */
const get = (v: unknown, field: string): unknown => (typeof v === 'object' && v !== null ? { ...v }[field] : undefined);
const numberOf = (v: unknown): number => (typeof v === 'number' ? v : Number.NaN);
/** Add to a number a row holds. */
const add = (row: Row, field: string, by: number): void => {
  row[field] = numberOf(row[field]) + by;
};
/** An answer's value with some of its fields changed. */
const changed = (value: unknown, more: Row): Row => ({
  ...(typeof value === 'object' && value !== null ? value : {}),
  ...more,
});
const storedWf = load('workflow');
const Wf = {
  account: String(storedWf.account),
  history: wf.historyOf(storedWf.history),
  final: mutFinal(wf.finalOf(storedWf.final)),
  traces: tracesOf(storedWf.traces),
};
const wDone = new Map(Wf.history.filter(h => h.type !== 'invoke').map(h => [h.i, h])),
  wInv = Wf.history.filter(h => h.type === 'invoke');
const pickW = (
  what: string,
  pred: (h: wf.Entry, done: wf.Entry | undefined) => boolean,
): wf.Entry & { trace: string } => {
  const h = wInv.find(x => pred(x, wDone.get(x.i)));
  if (!h) throw new Error(`no workflow fixture op: ${what}`);
  return { ...h, trace: h.trace ?? '' };
};
// f gets a copy of { history, final, traces }; both checks run on it
type WfCase = { history: wf.History; final: MutFinal; traces: Traces };
const wfRun = (what: string, f: (x: WfCase) => void, want: readonly string[], which = 'both'): void => {
  const x: WfCase = { history: clone(Wf.history), final: clone(Wf.final), traces: { ...Wf.traces } };
  f(x);
  const got = [
    ...(which !== 'traces' ? types(wf.check(x.history, x.final)) : []),
    ...(which !== 'state' ? types(wf.checkTraces(x.history, x.final, new Map(Object.entries(x.traces)))) : []),
  ];
  expectTypes(`workflow: ${what}`, [...new Set(got)].toSorted(), want);
};
const doneOf = (x: WfCase, h: wf.Entry): wf.Entry => the(x.history, y => y.type !== 'invoke' && y.i === h.i);
const wTrace = (
  what: string,
  h: wf.Entry & { trace: string },
  f: (t: Editor) => unknown,
  want: readonly string[],
  change?: (x: WfCase) => void,
): void => {
  wfRun(
    what,
    x => {
      x.traces[h.trace] = edit(Wf.traces[h.trace], f);
      if (change) change(x);
    },
    want,
    'traces',
  );
};
wfRun('the real run passes', () => {}, []);
// ---- the state checks (check)
const doneOrder = the(Wf.final.orders, o => o.state === 'done');
the(Wf.final.sales, x => x.state === 'paid');
const failedOrder = the(Wf.final.orders, o => o.state === 'failed' && o.steps === 3),
  declined = the(Wf.final.sales, x => x.state === 'declined');
/** What an operation was answered with. */
const answer = (h: wf.Entry): unknown => wDone.get(h.i)?.value;
const whole = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
wfRun(
  'an order left unfinished',
  x => {
    Object.assign(
      the(x.final.orders, o => o.id === failedOrder.id),
      { state: 'releasing', steps: 2 },
    );
  },
  ['order-not-finished'],
  'state',
);
wfRun(
  'a sale left pending',
  x => {
    the(x.final.sales, y => y.id === declined.id).state = 'pending';
  },
  ['sale-not-finished'],
  'state',
);
wfRun(
  'a lamp gone missing',
  x => {
    add(
      the(x.final.stock, i => i.sku === 'lamp'),
      'remaining',
      -1,
    );
  },
  ['stock-not-conserved'],
  'state',
);
wfRun(
  'a card charged one more',
  x => {
    add(
      the(x.final.cards, c => c.card === 'ann-4242'),
      'balance',
      -1,
    );
  },
  ['money-not-conserved'],
  'state',
);
wfRun(
  'a seat gone missing',
  x => {
    add(
      the(x.final.seats, c => c.name === 'balcony'),
      'seats',
      -1,
    );
  },
  ['seats-not-conserved'],
  'state',
);
wfRun(
  'a done order without its label',
  x => {
    x.final.labels = x.final.labels.filter(l => l.id !== doneOrder.label);
  },
  ['label-missing'],
  'state',
);
wfRun(
  'a label for no order',
  x => {
    x.final.labels.push({ id: 999, address: 'nowhere', sku: 'lamp', qty: 1 });
  },
  ['label-extra'],
  'state',
);
const advanced = pickW(
  'an advance answered with its order',
  (h, d) => h.f === 'advance' && d?.status === 200 && get(d.value, 'state') === 'failed',
);
wfRun(
  'an order in a state no path has',
  x => {
    const d = doneOf(x, advanced);
    d.value = changed(d.value, { steps: 9 });
  },
  ['illegal-state', 'states-on-two-paths'],
  'state',
);
wfRun(
  'an answer about an order that is not there',
  x => {
    const d = doneOf(x, advanced);
    d.value = changed(d.value, { id: 9999 });
  },
  ['lost-order'],
  'state',
);

// two observations of one order, the later one begun after the earlier one ended
type Observed = { h: wf.Entry; d: wf.Entry };
const obsOf = (id: unknown): Observed[] =>
  wInv.flatMap(h => {
    const d = wDone.get(h.i);
    return d?.type === 'ok' &&
      get(d.value, 'id') === id &&
      whole(get(d.value, 'steps')) &&
      typeof get(d.value, 'sku') === 'string'
      ? [{ h, d }]
      : [];
  });
const pair = must(
  Wf.final.orders
    .filter(o => o.state === 'done')
    .flatMap(o => {
      const obs = obsOf(o.id);
      return obs.flatMap(a =>
        obs.flatMap(b => (a.d.t < b.h.t && numberOf(get(a.d.value, 'steps')) > 0 ? [{ a, b }] : [])),
      );
    })
    .at(0),
  'order seen twice, one after the other',
);
wfRun(
  'an order seen going back a step',
  x => {
    const a = doneOf(x, pair.a.h),
      b = doneOf(x, pair.b.h),
      back = numberOf(get(a.value, 'steps')) - 1;
    b.value = changed(b.value, { steps: back, state: ['reserving', 'charging', 'shipping', 'done'][back] });
  },
  ['not-linearizable'],
  'state',
);
const seenDone = pickW(
  'an answer showing a done order',
  (_h, d) => d?.type === 'ok' && get(d.value, 'state') === 'done' && whole(get(d.value, 'steps')),
);
wfRun(
  'a done order seen with another label than it ended with',
  x => {
    const d = doneOf(x, seenDone);
    d.value = changed(d.value, { label: 777 });
  },
  ['lost-commit'],
  'state',
);
wfRun(
  'a stall note left on a done order',
  x => {
    the(x.final.orders, o => o.id === doneOrder.id).note = 'inventory did not answer in time';
  },
  ['stale-note'],
  'state',
);
const readOrder = pickW('a read of an order', (h, d) => h.f === 'read' && d?.status === 200);
wfRun(
  'an order that exists answered 404',
  x => {
    const d = doneOf(x, readOrder);
    d.status = 404;
    d.value = { error: 'no such order' };
  },
  ['phantom-404'],
  'state',
);
const bought = pickW('a sale sold at once', (h, d) => h.f === 'buy' && d?.status === 201);
const retried = pickW(
  'a sale paid by a retry, never answered 201 to its buyer',
  (h, d) =>
    h.f === 'retry' &&
    d?.status === 201 &&
    !wInv.some(b => b.f === 'buy' && wDone.get(b.i)?.status === 201 && get(answer(b), 'id') === get(d.value, 'id')),
);
wfRun(
  'a ticket answered paid whose sale ended declined (buy)',
  x => {
    the(x.final.sales, y => y.id === get(answer(bought), 'id')).state = 'declined';
  },
  ['ticket-not-paid', 'money-not-conserved', 'seats-not-conserved'],
  'state',
);
wfRun(
  'a ticket answered paid whose sale ended declined (retry)',
  x => {
    the(x.final.sales, y => y.id === get(answer(retried), 'id')).state = 'declined';
  },
  ['ticket-not-paid', 'money-not-conserved', 'seats-not-conserved'],
  'state',
);
const created = pickW(
  'an order created at once',
  (h, d) => h.f === 'create' && d?.status === 202 && whole(get(d.value, 'id')),
);
wfRun(
  'an order created with another sku than asked',
  x => {
    const d = doneOf(x, created);
    d.value = changed(d.value, { sku: get(d.value, 'sku') === 'lamp' ? 'desk' : 'lamp' });
  },
  ['wrong-order'],
  'state',
);
const twice = must(
  [
    ...Map.groupBy(
      wInv.filter(h => h.f === 'create' && whole(get(answer(h), 'id'))),
      h => h.order?.key,
    ).values(),
  ].find(hs => hs.length > 1),
  'key sent twice',
);
wfRun(
  'one client key answered with two orders',
  x => {
    const d = doneOf(x, must(twice[1], 'second answer'));
    d.value = changed(d.value, { id: numberOf(get(d.value, 'id')) + 1 });
  },
  ['key-made-two-orders'],
  'state',
);
const saleRead = pickW('a buy answered with its sale', (h, d) => h.f === 'buy' && whole(get(d?.value, 'id')));
// (no key was answered twice with an id in this run: a second answer is added, for another sale)
wfRun(
  'one client key answered with two sales',
  x => {
    const d = doneOf(x, saleRead);
    x.history.push(
      { ...saleRead, i: 9000 },
      { ...d, i: 9000, status: 200, value: changed(d.value, { id: numberOf(get(d.value, 'id')) + 1 }) },
    );
  },
  ['key-made-two-sales'],
  'state',
);
wfRun(
  'more orders than keys',
  x => {
    x.final.orders.push({ ...failedOrder, id: 999 });
  },
  ['more-orders-than-keys'],
  'state',
);
wfRun(
  'more sales than keys',
  x => {
    x.final.sales.push({ ...declined, id: 999 });
  },
  ['more-sales-than-keys'],
  'state',
);

// ---- the trace checks (checkTraces)
const madeOrder = pickW(
  'a creation that made its order, answered',
  (h, d) =>
    h.f === 'create' &&
    d?.status === 202 &&
    whole(get(d.value, 'id')) &&
    JSON.stringify(Wf.traces[h.trace ?? '']).includes('INSERT INTO orders'),
);
const wRouter = (sp: RawSpan): boolean =>
  sp.name.startsWith('POST /{account}/') || sp.name.startsWith('GET /{account}/');
const wInvoke =
  (name: string) =>
  (sp: RawSpan): boolean =>
    sp.name === `${name}.invoke`;
const wSup =
  (name: string) =>
  (_sp: RawSpan, svc: string | undefined): boolean =>
    svc === `${Wf.account}/${name} supervisor`;
const nameOf = (h: wf.Entry): string => h.path.split('/')[1] ?? '';
const wRun =
  (h: wf.Entry) =>
  (sp: RawSpan, svc: string | undefined): boolean =>
    svc === `${Wf.account}/${nameOf(h)}` &&
    sp.kind === 2 &&
    sp.name === `${h.method} /${h.path.split('/').slice(4).join('/')}`;
const dropTree = (t: Editor, top: RawSpan): void => {
  const gone = new Set([top.spanId]);
  for (let grew = true; grew;) {
    grew = false;
    for (const { sp } of t.list())
      if (!gone.has(sp.spanId) && sp.parentSpanId !== undefined && gone.has(sp.parentSpanId)) {
        gone.add(sp.spanId);
        grew = true;
      }
  }
  t.drop(sp => gone.has(sp.spanId));
};
const anyCall = (sp: RawSpan): boolean =>
  sp.kind === 3 && sp.attributes.some(a => a.key === 'rpc.system' && a.value.stringValue === 'tape');
wTrace(
  'a trace that could not be fetched',
  madeOrder,
  () => {},
  ['trace-unreadable', 'orders-created-by-no-trace'],
  x => {
    x.traces[madeOrder.trace] = { error: '500 test' };
  },
);
const aRead = pickW('a read of an order', (h, d) => h.f === 'read' && d?.status === 200);
const told = (x: WfCase, h: wf.Entry): wf.Entry =>
  Object.assign(doneOf(x, h), { status: 503, trace_complete: 'false' });
wTrace(
  'no trace of a read, and the response said its trace is incomplete: allowed',
  aRead,
  () => {},
  [],
  x => {
    x.traces[aRead.trace] = { resourceSpans: [] };
    told(x, aRead);
  },
);
wTrace(
  'no trace of a creation that made its order, though the response said its trace is incomplete',
  madeOrder,
  () => {},
  ['orders-created-by-no-trace'],
  x => {
    x.traces[madeOrder.trace] = { resourceSpans: [] };
    told(x, madeOrder);
  },
);
wTrace(
  'no trace of a read the client timed out on before any response: allowed',
  aRead,
  () => {},
  [],
  x => {
    x.traces[aRead.trace] = { resourceSpans: [] };
    const d = doneOf(x, aRead);
    delete d.status;
    Object.assign(d, { type: 'info', error: 'The operation was aborted due to timeout' });
  },
);
wTrace(
  'no trace of a creation that made its order, the client having timed out',
  madeOrder,
  () => {},
  ['orders-created-by-no-trace'],
  x => {
    x.traces[madeOrder.trace] = { resourceSpans: [] };
    const d = doneOf(x, madeOrder);
    delete d.status;
    Object.assign(d, { type: 'info', error: 'The operation was aborted due to timeout' });
  },
);
wTrace(
  'the trace of a creation gone',
  madeOrder,
  () => {},
  ['trace-missing', 'orders-created-by-no-trace'],
  x => {
    x.traces[madeOrder.trace] = { resourceSpans: [] };
  },
);
// (without its router span, the call span is the one root, under no client span)
wTrace('the router span dropped', madeOrder, t => t.drop(wRouter), [
  'root-not-under-client-span',
  'wrong-root',
  'call-span',
  'orders-created-by-no-trace',
]);
wTrace(
  'the router record lost, said by the trace, not by the response',
  madeOrder,
  t => {
    const inv = t.one(wInvoke(nameOf(madeOrder)));
    t.drop(wRouter);
    delete inv.parentSpanId;
    inv.name = 'router (not recorded)';
    inv.attributes = [];
    t.set(inv, 'tape.missing', 'router');
    inv.events = [t.marker('router')];
  },
  ['router-record-missing'],
);
// (production run jepsen-tix-g5) the same loss, the client having had no answer at all: it could not be told, so allowed
wTrace(
  'the router record lost, the client timed out before any answer: allowed',
  madeOrder,
  t => {
    const inv = t.one(wInvoke(nameOf(madeOrder)));
    t.drop(wRouter);
    delete inv.parentSpanId;
    inv.name = 'router (not recorded)';
    inv.attributes = [];
    t.set(inv, 'tape.missing', 'router');
    inv.events = [t.marker('router')];
  },
  [],
  x => {
    const d = doneOf(x, madeOrder);
    delete d.status;
    Object.assign(d, { type: 'info', error: 'The operation was aborted due to timeout' });
  },
);
// (production run jepsen-tix-g8) a rolled-back run keeps the inserts before its last call, not those after it
{
  const ev = (at: number, id: number): Span['events'][number] => ({
    name: 'db.query',
    at,
    attrs: {
      'db.query.text': 'INSERT INTO holds(client) VALUES (?1) RETURNING *',
      'tape.sql.rows': JSON.stringify([[id]]),
    },
  });
  const span = (more: Partial<Span>): Span => ({
    trace: 't',
    id: 'x',
    parent: null,
    name: '',
    kind: 2,
    service: undefined,
    start: 0,
    end: 0,
    attrs: {},
    events: [],
    status: 0,
    message: undefined,
    ...more,
  });
  const run = span({ id: 'r', attrs: { 'tape.run.rolled_back': true }, events: [ev(100, 1), ev(163, 2)] }),
    call = span({ id: 'c', parent: 'r', kind: 3, start: 100, end: 163 });
  expectTypes(
    'created: a rolled-back run keeps the insert before its call (1), not the one after (2)',
    wf.created([run, call], run, 'holds').map(String),
    ['1'],
  );
  expectTypes('created: a rolled-back run with no call kept nothing', wf.created([run], run, 'holds').map(String), []);
  expectTypes(
    'created: a run that committed kept both',
    wf.created([run, call], { ...run, attrs: {} }, 'holds').map(String),
    ['1', '2'],
  );
}
wTrace(
  'the router record lost without a marker (said by the response)',
  madeOrder,
  t => {
    const inv = t.one(wInvoke(nameOf(madeOrder)));
    t.drop(wRouter);
    delete inv.parentSpanId;
    inv.name = 'router (not recorded)';
    inv.attributes = [];
    t.set(inv, 'tape.missing', 'router');
    inv.events = [];
  },
  ['missing-without-marker'],
  x => {
    doneOf(x, madeOrder).trace_complete = 'false';
  },
);
wTrace(
  'the router span renamed',
  madeOrder,
  t => {
    t.one(wRouter).name = 'POST /elsewhere';
  },
  ['wrong-root'],
);
wTrace(
  'the router reporting another status than the client saw',
  madeOrder,
  t => t.set(t.one(wRouter), 'http.response.status_code', 418),
  ['status-mismatch', 'router-status-not-run-status'],
);
wTrace(
  'two calls under the router',
  madeOrder,
  t => {
    t.copy(t.one(wInvoke(nameOf(madeOrder))));
  },
  ['call-span', 'orders-created-by-no-trace'],
);
wTrace(
  'an unexpected span under the call',
  madeOrder,
  t => {
    const c = t.copy(t.one(wInvoke(nameOf(madeOrder))), { name: 'surprise' });
    c.parentSpanId = t.one(wInvoke(nameOf(madeOrder))).spanId;
  },
  ['unexpected-call-child'],
);
wTrace(
  'two supervisors (two executions)',
  madeOrder,
  t => {
    t.copy(t.one(wSup(nameOf(madeOrder))));
  },
  ['duplicate-execution'],
);
wTrace(
  'a run whose supervisor record was lost, without a marker',
  madeOrder,
  t => {
    const inv = t.one(wInvoke(nameOf(madeOrder))),
      sup = t.one(wSup(nameOf(madeOrder))),
      run = t.one(wRun(madeOrder));
    t.drop(sp => sp === sup);
    run.parentSpanId = inv.spanId;
    t.set(run, 'tape.supervisor.missing', true);
    t.set(inv, 'tape.call.outcome', 'exception');
  },
  ['orphan-run-without-marker'],
);
wTrace(
  'no supervisor and no marker',
  madeOrder,
  t => {
    dropTree(t, t.one(wSup(nameOf(madeOrder))));
    t.set(t.one(wInvoke(nameOf(madeOrder))), 'tape.call.outcome', 'exception');
  },
  ['supervisor-missing-without-marker', 'orders-created-by-no-trace'],
);
wTrace(
  'no supervisor for a call that was answered',
  madeOrder,
  t => {
    dropTree(t, t.one(wSup(nameOf(madeOrder))));
    t.one(wInvoke(nameOf(madeOrder))).events.push(t.marker('supervisor'));
  },
  ['supervisor-missing', 'orders-created-by-no-trace'],
);
wTrace(
  'an open supervisor for a call that was answered',
  madeOrder,
  t => t.one(wSup(nameOf(madeOrder))).events.push(t.marker('supervisor.end')),
  ['open-supervisor-of-answered-call'],
);
wTrace(
  'two runs under one supervisor',
  madeOrder,
  t => {
    t.copy(t.one(wRun(madeOrder)));
  },
  ['duplicate-run'],
);
wTrace('the run span missing, with no marker', madeOrder, t => dropTree(t, t.one(wRun(madeOrder))), [
  'run-missing-without-marker',
  'orders-created-by-no-trace',
]);
wTrace(
  'the run of another route',
  madeOrder,
  t => {
    t.one(wRun(madeOrder)).name = 'POST /elsewhere';
  },
  ['run-wrong'],
);
wTrace(
  'the supervisor reporting another status than its run',
  madeOrder,
  t => t.set(t.one(wSup(nameOf(madeOrder))), 'http.response.status_code', 500),
  ['run-status-not-supervisor-status'],
);
wTrace(
  'the run reporting another status than the router',
  madeOrder,
  t => {
    t.set(t.one(wSup(nameOf(madeOrder))), 'http.response.status_code', 500);
    t.set(t.one(wRun(madeOrder)), 'http.response.status_code', 500);
  },
  ['router-status-not-run-status'],
);
wTrace(
  'a run duration not measured',
  madeOrder,
  t => t.set(t.one(wRun(madeOrder)), 'tape.duration.source', 'estimated'),
  ['run-duration-unmeasured'],
);
wTrace(
  'a call whose callee is not joined and not marked',
  madeOrder,
  t => {
    const call = must(t.find(anyCall)[0], 'call');
    dropTree(t, must(t.find(sp => sp.parentSpanId === call.spanId && sp.kind === 2)[0], 'served span'));
  },
  ['call-without-callee-or-marker'],
);
wTrace(
  'a call served twice',
  madeOrder,
  t => {
    const call = must(t.find(anyCall)[0], 'call'),
      served = must(t.find(sp => sp.parentSpanId === call.spanId && sp.kind === 2)[0], 'served span');
    t.copy(served);
  },
  ['call-served-twice'],
);
const insertOf = (t: Editor, table: string): RawEvent =>
  must(
    t.queries(t.one(wRun(madeOrder))).find(e => t.text(e).startsWith(`INSERT INTO ${table}`)),
    `insert into ${table}`,
  );
/** The row an insert returned, with another id. */
const withId = (t: Editor, q: RawEvent, id: unknown): unknown[][] => [[id, ...rowOf(t, q).slice(1)]];
wTrace(
  'the trace saying it created another order than the client was told',
  madeOrder,
  t => {
    const q = insertOf(t, 'orders');
    t.setRows(q, withId(t, q, 999));
  },
  ['trace-effect-mismatch', 'traced-orders-not-in-final', 'orders-created-by-no-trace'],
);
wTrace('a span outside its parent (one clock)', madeOrder, t => t.shift(t.one(wRun(madeOrder)), 0, 5000), [
  'span-outside-parent',
]);
const otherCreate = pickW(
  'another creation that made its order',
  (h, d) =>
    get(d?.value, 'id') !== get(answer(madeOrder), 'id') &&
    h.f === 'create' &&
    d?.status === 202 &&
    whole(get(d.value, 'id')) &&
    JSON.stringify(Wf.traces[h.trace ?? '']).includes('INSERT INTO orders'),
);
wTrace(
  'one order created by two traced requests',
  madeOrder,
  t => {
    const q = insertOf(t, 'orders');
    t.setRows(q, withId(t, q, get(answer(otherCreate), 'id')));
  },
  ['orders-created-twice-in-traces', 'orders-created-by-no-trace'],
  x => {
    const d = doneOf(x, madeOrder);
    d.value = changed(d.value, { id: get(answer(otherCreate), 'id') });
  },
);
wTrace(
  'an order no traced request created',
  madeOrder,
  () => {},
  ['orders-created-by-no-trace'],
  x => {
    x.final.orders.push({ ...failedOrder, id: 999 });
  },
);
wTrace(
  'a traced order not in the final state',
  madeOrder,
  () => {},
  ['traced-orders-not-in-final'],
  x => {
    x.final.orders = x.final.orders.filter(o => o.id !== get(answer(madeOrder), 'id'));
  },
);

// heal (K4): a failed read of the final state is read again, never taken as "no row"; one that never reads is reported
{
  const fake = (fails: number): wf.Sender => {
    const n = new Map<string, number>();
    const answered = (method: string, path: string): { status: number; body: unknown } => {
      if (method !== 'GET') return { status: 200, body: {} };
      const k = (n.get(path) ?? 0) + 1;
      n.set(path, k);
      if (path === '/fulfill/v/1/orders/1' && k <= fails) return { status: 503, body: { error: 'jepsen: overloaded' } };
      if (path === '/fulfill/v/1/orders/1')
        return { status: 200, body: { id: 1, state: 'done', sku: 'lamp', qty: 1, card: 'bob-0001', amount: 40 } };
      if (/\/(orders|sales)\/\d+$/.test(path)) return { status: 404, body: { error: 'no such order' } };
      return { status: 200, body: [] };
    };
    return (method, path) => Promise.resolve({ ...answered(method, path), headers: {} });
  };
  const once = await wf.heal(fake(1));
  expectTypes(
    'heal: a 503 on an order read once, then the row',
    once.orders.length === 1 && once.heal?.length === 1 && once.unreadable?.length === 0 ? [] : ['heal-dropped-row'],
    [],
  );
  const never = await wf.heal(fake(99));
  expectTypes(
    'heal: an order that never reads is reported, not dropped',
    types(wf.check([], never)).filter(t => t === 'final-unreadable'),
    ['final-unreadable'],
  );
}

// ---- retention (RUNTIME-SPEC R-RET-1..6): a scenario's history as the correct shard answers it, then one thing
// changed the way a bug would, each with the anomalies it must raise and no others
{
  const W = 20000,
    S = 2000,
    T = 1000,
    t0 = 1794780000000,
    id = (t: number, n: number): string => `${t}_c-${n}`;
  const a = (once: string, sent: number, status: number | null, extra: Partial<ret.Attempt> = {}): ret.Attempt => ({
    key: 'k',
    once,
    sent,
    got: sent + 40,
    status,
    ...extra,
  });
  const exp = { error: 'expired', op_expired: true, window_ms: W };
  const good = (): ret.Attempt[] => [
    a(id(t0, 1), t0, 201, { version: 1 }),
    a(id(t0 + 50, 2), t0 + 50, 200, { version: 2 }),
    a(id(t0, 1), t0 + 100, 201, { version: 1 }), // a replay inside the window
    a(id(t0 + S + T + 600, 3), t0 + W + S + 500, 200, { version: 3 }), // sent W - T - 100 after its t: surely fresh
    a(id(t0, 1), t0 + W + S + 600, 410, { body: exp }), // past W + S
    a(id(t0 + W, 4), t0 + W + S + 700, 200, { version: 4 }), // inside W of the shard: accepted
    a('c-untimed', t0 + W + S + 800, 400),
    a(id(t0 + W + S + 900 + S + T + 100, 5), t0 + W + S + 900, 400),
    a(id(t0, 1), t0 + 200, null), // no answer: nothing to judge
  ];
  /** The attempt at a place in the history. */
  const nth = (h: ret.Attempt[], i: number): ret.Attempt => must(h[i], `attempt ${i}`);
  const run = (what: string, f: (h: ret.Attempt[]) => void, want: readonly string[]): void => {
    const h = good();
    f(h);
    expectTypes(`retention: ${what}`, types(ret.check(h, { window: W, skew: S, tolerance: T })), want);
  };
  run('the correct shard', () => {}, []);
  run(
    'a replay answers another version (applied twice)',
    h => {
      nth(h, 2).version = 3;
    },
    ['op-applied-twice'],
  );
  run(
    'a replay answered 200 with another version after the prune',
    h => {
      h[4] = { ...nth(h, 4), status: 200, version: 5, body: undefined };
    },
    ['expired-op-not-refused', 'op-applied-twice'],
  );
  run(
    'an expired op answered 409 (ran a compare-and-set)',
    h => {
      h[4] = { ...nth(h, 4), status: 409, body: undefined };
    },
    ['expired-op-not-refused'],
  );
  run(
    'a fresh op refused 410',
    h => {
      h[3] = { ...nth(h, 3), status: 410, body: exp, version: undefined };
    },
    ['fresh-op-refused'],
  );
  run(
    'a 410 that does not say op_expired',
    h => {
      nth(h, 4).body = { error: 'gone' };
    },
    ['expiry-answer-unclear'],
  );
  run(
    'a 410 with another window',
    h => {
      nth(h, 4).body = { ...exp, window_ms: 1 };
    },
    ['expiry-answer-unclear'],
  );
  run(
    'an untimed op id accepted',
    h => {
      h[6] = { ...nth(h, 6), status: 201, version: 1 };
    },
    ['untimed-op-accepted'],
  );
  run(
    'a future op id accepted',
    h => {
      h[7] = { ...nth(h, 7), status: 201, version: 1 };
    },
    ['future-op-accepted'],
  );
  run(
    'an op near the edge of the clock allowance is not judged',
    h => {
      h.push(a(id(t0 + W + S + 950 - W + 10, 6), t0 + W + S + 950, 410, { body: exp }));
    },
    [],
  );
  const fin = (what: string, f: Readonly<Record<string, number>>, want: readonly string[]): void =>
    expectTypes(`retention final: ${what}`, types(ret.checkFinal(good(), f)), want);
  fin('the version is the ops applied', { k: 4 }, []);
  fin('one op unanswered may or may not have applied', { k: 4 }, []);
  fin('a version beyond the ops sent (one applied twice)', { k: 5 }, ['versions-exceed-ops']);
  fin('a version below the ops answered 2xx', { k: 3 }, ['applied-op-lost']);
  const tr = (what: string, list: readonly ret.Traced[], want: readonly string[]): void =>
    expectTypes(`retention traces: ${what}`, types(ret.checkTraces(list, { tolerance: T })), want);
  tr(
    'a pruned old trace, a kept new one',
    [
      { op: { sent: t0 }, found: false, pruned_before: t0 + 5 },
      { op: { sent: t0 + 9000 }, found: true, pruned_before: t0 + 5 },
    ],
    [],
  );
  tr(
    'a new trace missing',
    [{ op: { sent: t0 + 9000 }, found: false, pruned_before: t0 + 5 }],
    ['trace-missing-not-pruned'],
  );
  tr(
    'a trace missing with nothing pruned',
    [{ op: { sent: t0 }, found: false, pruned_before: null }],
    ['trace-missing-not-pruned'],
  );
}

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
