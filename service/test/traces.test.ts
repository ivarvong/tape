// Runs in workerd: every request's whole trace. The router's spans (spans.ts), the supervisor's, the run's, as one
// tree under the client's traceparent, with measured durations, stored before the response; and what cannot be
// there (a shard that never saw the call, a run that failed) is an explicit tape.span.missing event.
import { describe, expect, it } from 'vitest';
import type { Routed } from '../src/records.ts';
import { requestSpans } from '../src/view.ts';
import { docOf } from '../jepsen/traces.ts';
import type { Attr, AttrValue, RawEvent, RawSpan } from '../jepsen/traces.ts';
import { anyone, at, call, got, json, list, parsed } from './help.ts';
import type { Init } from './help.ts';

const hex = (n: number): string =>
  [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');
/** A span of an OTLP document, with the service its resource names. */
type Sp = RawSpan & { service: string };
type Scalar = string | number | boolean | undefined;
const scalar = (v: AttrValue | undefined): Scalar => {
  if (v === undefined) return undefined;
  if (v.stringValue !== undefined) return v.stringValue;
  return v.intValue === undefined ? (v.boolValue ?? v.doubleValue) : Number(v.intValue);
};
const attr = (of: { attributes: readonly Attr[] }, key: string): Scalar =>
  scalar(of.attributes.find(a => a.key === key)?.value);
const spansOf = (o: unknown): Sp[] =>
  docOf(o).resourceSpans.flatMap(r =>
    r.scopeSpans.flatMap(sc => sc.spans.map(sp => ({ ...sp, service: String(attr(r.resource, 'service.name')) }))),
  );
/** An event's attribute, as text. */
const evAttr = (ev: RawEvent, key: string): string => String(attr(ev, key) ?? '');
const ms = (ns: string): number => Number(BigInt(ns) / 1000000n);
const setFaults = (account: string, p: Record<string, number> | null): Promise<Response> =>
  call(`/_faults/${account}`, {
    method: 'PUT',
    body: JSON.stringify(p === null ? null : { seed: 1, p, tail: [1, 2] }),
  });
// the client's span: every request gets a fresh one, as the Jepsen clients do
const traced = (path: string, init?: Init): { trace: string; client: string; res: Promise<Response> } => {
  const trace = hex(16),
    client = hex(8);
  return {
    trace,
    client,
    res: call(path, { ...init, headers: { traceparent: `00-${trace}-${client}-01`, ...init?.headers } }),
  };
};
/** What a search found; the test fails when it found nothing. */
const must = <T>(found: T | undefined, what: string): T => {
  if (found === undefined) throw new Error(`no ${what}`);
  return found;
};
type Tree = { by: Map<string, Sp>; child: (of: Sp, name?: string) => Sp };
const tree = (spans: readonly Sp[]): Tree => ({
  by: new Map(spans.map(sp => [sp.spanId, sp])),
  child: (of, name = '') =>
    must(
      spans.find(k => k.parentSpanId === of.spanId && k.name.includes(name)),
      `child ${name} of ${of.name}`,
    ),
});
/** The OTLP document a response links to, opened without the token. */
const linked = (r: Response, header = 'tape-otlp-url', more = ''): Promise<Response> => {
  const link = new URL(`${r.headers.get(header) ?? ''}${more}`);
  return anyone(link.pathname + link.search);
};
/** The shard call among a trace's spans. */
const invokeOf = (spans: readonly Sp[]): Sp =>
  must(
    spans.find(sp => sp.name.endsWith('.invoke')),
    'shard call',
  );

describe('traces: a routed request is one tree', () => {
  it('a KV write: router -> lookup, route, shard call -> supervisor -> run, each span measured or saying why not', async () => {
    expect((await call('/kv/trc/w', { method: 'POST', body: '{"shards":4}' })).status).toBe(201);
    const { trace, client, res } = traced(`/kv/trc/w/k/user:7?op=${Date.now()}_tr1`, { method: 'PUT', body: 'ann' });
    const r = await res;
    expect([r.status, r.headers.get('tape-trace-complete')]).toEqual([201, 'true']);
    const spans = spansOf(await json(await linked(r))),
      t = tree(spans);
    // one trace, one root, the client's span its parent, and every other parent present
    expect(new Set(spans.map(s => s.traceId))).toEqual(new Set([trace]));
    const roots = spans.filter(s => !t.by.has(s.parentSpanId ?? ''));
    expect(roots.map(s => [s.name, s.parentSpanId])).toEqual([['PUT /kv/{account}/{cluster}/k/{key}', client]]);
    const router = must(roots[0], 'root'),
      lookup = t.child(router, 'kv.cluster.lookup'),
      route = t.child(router, 'kv.route'),
      invoke = t.child(router, '.invoke');
    const supervisor = t.child(invoke),
      run = t.child(supervisor);
    expect([router.kind, lookup.kind, route.kind, invoke.kind, supervisor.kind, run.kind]).toEqual([2, 1, 1, 3, 2, 2]);
    expect([
      attr(router, 'http.response.status_code'),
      attr(invoke, 'http.response.status_code'),
      attr(supervisor, 'http.response.status_code'),
      attr(run, 'http.response.status_code'),
    ]).toEqual([201, 201, 201, 201]);
    expect([attr(route, 'kv.shard'), attr(route, 'kv.shards'), r.headers.get('kv-shard')]).toEqual([
      Number((r.headers.get('kv-shard') ?? '').split('/')[0]),
      4,
      `${attr(route, 'kv.shard')}/4`,
    ]);
    // hashing does no I/O, so it reads 0 ms, and says so rather than showing an invented duration
    expect([ms(route.endTimeUnixNano) - ms(route.startTimeUnixNano), attr(route, 'tape.timing')]).toEqual([
      0,
      expect.stringContaining('does not advance'),
    ]);
    // nesting in time: run within supervisor within shard call within router (one clock here)
    const nested: [Sp, Sp][] = [
      [run, supervisor],
      [supervisor, invoke],
      [invoke, router],
      [lookup, router],
    ];
    for (const [inner, outer] of nested) {
      expect(BigInt(inner.startTimeUnixNano) >= BigInt(outer.startTimeUnixNano)).toBe(true);
      expect(BigInt(inner.endTimeUnixNano) <= BigInt(outer.endTimeUnixNano)).toBe(true);
    }
    // the router and the supervisor begin by a current clock (spans.ts fresh), and say how old the clock was: in
    // production a busy shard's clock was 170 ms stale on arrival, which made its span start before it was called
    expect([typeof attr(router, 'tape.clock.lag_ms'), typeof attr(supervisor, 'tape.clock.lag_ms')]).toEqual([
      'number',
      'number',
    ]);
    // the run's span is the supervisor's measurement of the facet call; its SQL is counted, each statement an event
    expect([
      attr(run, 'tape.duration.source'),
      Number(attr(run, 'tape.sql.statements')) >= 1,
      Number(attr(run, 'tape.sql.rows_written')) >= 0,
    ]).toEqual([expect.stringContaining('measured by the supervisor'), true, true]);
    const write = must(
      run.events.find(e => e.name === 'db.query' && evAttr(e, 'db.query.text').startsWith('INSERT INTO kv')),
      'insert',
    );
    expect([
      list(parsed(evAttr(write, 'db.query.parameters'))).slice(0, 2),
      parsed(evAttr(write, 'tape.sql.rows')),
    ]).toEqual([['user:7', 'ann'], [['user:7', 'ann', 1, 1]]]);
    // the same request by its trace id, from the key's shard; the trace page and its text show the path too
    const byId = spansOf(await got(`/kv/trc/w/traces/${trace}?key=user:7`));
    expect(byId.map(s => s.spanId).toSorted()).toEqual(spans.map(s => s.spanId).toSorted());
    const page = await (await linked(r, 'tape-trace-url', '&format=text')).text();
    expect(page).toMatch(/^router {2}PUT \/kv\/\{account\}\/\{cluster\}\/k\/\{key\} {2}-> 201/);
    expect(page).toMatch(/supervisor {2}trc\/kv-w-\d v1 {2}-> 201/);
  });

  it('the program route: router -> invoke -> supervisor -> run, and the run log link shows the whole request', async () => {
    const hello = 'fn handle(raw: View) -> Buf {\n  respond(status: 200) |> write_text(text: "hi")\n}\n';
    expect((await call('/trc/hi', { method: 'POST', body: hello })).status).toBe(201);
    const { trace, client, res } = traced('/trc/hi/v/1/x');
    const r = await res;
    expect([r.status, await r.text(), (r.headers.get('traceparent') ?? '').split('-')[1]]).toEqual([200, 'hi', trace]);
    const spans = spansOf(await json(await linked(r))),
      t = tree(spans);
    const router = must(
        spans.find(s => s.parentSpanId === client),
        'root',
      ),
      invoke = t.child(router),
      supervisor = t.child(invoke),
      run = t.child(supervisor);
    expect([router.name, invoke.name, supervisor.service, run.name]).toEqual([
      'GET /{account}/{name}/v/{version}/x',
      'hi.invoke',
      'trc/hi supervisor',
      'GET /x',
    ]);
    expect(spans.length).toBe(4);
    const byId = spansOf(await got(`/trc/hi/traces/${trace}`));
    expect(byId.length).toBe(4);
    // the run's span says what the run used. Steps: what the hosted runner counts for the same program and request
    // (mcp/src/runner.ts reads the module's `cost` itself). Memory: the hosted run's, and the 40 bytes more the
    // request takes here, held in words of 8 (7 bytes there, and 34 more with the host's tape-base header). The
    // log and the trace page say the same.
    const hosted = await anyone('/v1/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.9' },
      body: JSON.stringify({ files: [{ name: 'hi.tape', text: hello }], requests: ['GET /x'] }),
    });
    const hostedBody = await json(hosted);
    const [ran] = list(at(hostedBody, 'results')),
      steps = Number(at(ran, 'steps')),
      bytes = Number(at(ran, 'memory_bytes')) + 40;
    expect(steps).toBeGreaterThan(0);
    expect('\rtape-base: http://tape/trc/hi/v/1'.length).toBe(34);
    const stepVersion = at(hostedBody, 'step_version');
    expect([attr(run, 'tape.steps'), attr(run, 'tape.memory_bytes'), attr(run, 'tape.step_version')]).toEqual([
      steps,
      bytes,
      stepVersion,
    ]);
    const id = r.headers.get('tape-request-id') ?? '';
    expect(at(await got(`/trc/hi/log/1/${id}`), 'effects', 0, 'steps')).toBe(steps);
    expect(at(await got(`/trc/hi/log/1/${id}`), 'effects', 0, 'step_version')).toBe(stepVersion);
    expect(await (await call(`/trc/hi/trace/1/${id}?format=html`)).text()).toContain(
      `${bytes} bytes of memory, ${steps} steps, step version ${String(stepVersion)}`,
    );
  });
});

describe('traces: faults leave an explicit trace', () => {
  it('overload: the shard never saw the call, and the shard-call span says so', async () => {
    expect((await call('/kv/jepsen-trc/f', { method: 'POST', body: '{"shards":1}' })).status).toBe(201);
    await setFaults('jepsen-trc', { overload: 1 });
    const { trace, res } = traced(`/kv/jepsen-trc/f/k/a?op=${Date.now()}_tr2`, { method: 'PUT', body: 'x' });
    const r = await res;
    expect([r.status, at(await json(r), 'outcome'), r.headers.get('tape-trace-complete')]).toEqual([
      503,
      'unknown',
      'true',
    ]);
    const spans = spansOf(await got(`/kv/jepsen-trc/f/traces/${trace}?key=a`));
    const invoke = invokeOf(spans),
      gap = must(
        invoke.events.find(e => e.name === 'tape.span.missing'),
        'missing-span event',
      );
    expect([
      attr(invoke, 'tape.call.outcome'),
      evAttr(gap, 'tape.missing'),
      evAttr(gap, 'tape.missing.reason'),
    ]).toEqual(['fault:overload', 'supervisor', expect.stringContaining('never saw it')]);
    expect(spans.some(s => s.service.endsWith('supervisor'))).toBe(false);
    await setFaults('jepsen-trc', null);
  });

  it('reset after commit: the client gets 503 unknown, and the trace shows the committed write', async () => {
    await setFaults('jepsen-trc', { reset_callee_after: 1 });
    const { trace, res } = traced(`/kv/jepsen-trc/f/k/b?op=${Date.now()}_tr3`, { method: 'PUT', body: 'kept' });
    const r = await res;
    expect([r.status, at(await json(r), 'outcome')]).toEqual([503, 'unknown']);
    await setFaults('jepsen-trc', null);
    const spans = spansOf(await got(`/kv/jepsen-trc/f/traces/${trace}?key=b`)),
      t = tree(spans);
    const invoke = invokeOf(spans),
      supervisor = t.child(invoke),
      run = t.child(supervisor);
    expect([
      attr(invoke, 'tape.call.outcome'),
      attr(supervisor, 'tape.fault.kind'),
      attr(run, 'http.response.status_code'),
    ]).toEqual(['fault:reset_callee_after', 'reset_callee_after', 201]);
    expect(await got('/kv/jepsen-trc/f/k/b')).toEqual({ key: 'b', value: 'kept', version: 1 });
  });

  it('a storage error at commit: 503 not_applied with retry-after (transient), the run is rolled back in the trace, and nothing is stored', async () => {
    await setFaults('jepsen-trc', { storage_error: 1 });
    const { trace, res } = traced(`/kv/jepsen-trc/f/k/c?op=${Date.now()}_tr4`, { method: 'PUT', body: 'lost' });
    const r = await res;
    const body = await json(r);
    expect([r.status, at(body, 'outcome'), at(body, 'transient'), r.headers.get('retry-after')]).toEqual([
      503,
      'not_applied',
      true,
      '1',
    ]);
    await setFaults('jepsen-trc', null);
    const spans = spansOf(await got(`/kv/jepsen-trc/f/traces/${trace}?key=c`)),
      t = tree(spans);
    const run = t.child(t.child(invokeOf(spans)));
    expect([
      attr(run, 'tape.run.rolled_back'),
      run.status.code,
      run.events.some(e => e.name === 'tape.run.rolled_back'),
    ]).toEqual([true, 2, true]);
    // the statement ran and returned its row, then the commit failed: the trace shows both, and the key is absent
    expect(run.events.some(e => e.name === 'db.query' && evAttr(e, 'db.query.text').startsWith('INSERT INTO kv'))).toBe(
      true,
    );
    expect((await call('/kv/jepsen-trc/f/k/c')).status).toBe(404);
  });

  it('a program that traps: 500 not_applied, recorded with what it did, and its writes rolled back', async () => {
    const src = `migration 1 "t" {
  CREATE TABLE t(x INTEGER NOT NULL)
}
type N { N(n: Int) }
fn handle(raw: View, db: Sql) -> Buf {
  match request(raw) {
    Request(method: "GET") -> count(found: sql_first(db, row: N, query: "SELECT count(*) AS n FROM t"))
    _ -> divide(wrote: sql_first(db, row: N, repeat: True, query: "INSERT INTO t(x) VALUES (1) RETURNING x AS n"))
  }
}
fn count(found: Option[N]) -> Buf {
  match found {
    Some(value: N(n)) -> respond(status: 200) |> write_int(value: n)
    None -> respond(status: 500)
  }
}
fn divide(wrote: Option[N]) -> Buf {
  match wrote {
    Some(value: N(n)) -> respond(status: 200) |> write_int(value: 10 / (n - 1))
    None -> respond(status: 500)
  }
}
`;
    const up = await call('/trc/trap', { method: 'POST', body: src });
    expect(up.status).toBe(201);
    const { res } = traced('/trc/trap/v/1/go', { method: 'POST' });
    const r = await res;
    const body = await json(r);
    expect([
      r.status,
      at(body, 'outcome'),
      at(body, 'transient'),
      r.headers.get('tape-outcome'),
      r.headers.get('retry-after'),
    ]).toEqual([500, 'not_applied', undefined, 'not_applied', null]); // a trap is not transient
    expect(String(at(body, 'retry'))).toContain('cannot apply it twice');
    expect(await (await call('/trc/trap/v/1/n')).text()).toBe('0');
    const spans = spansOf(await json(await linked(r))),
      run = must(
        spans.find(s => s.name === 'POST /go'),
        'run',
      );
    expect([attr(run, 'tape.run.failed'), run.status.message]).toEqual([true, 'trap 4: division by zero']);
  });
});

describe('traces: a supervisor that began on a stale clock says so', () => {
  // In production a busy shard took two calls with a clock 140 ms behind: its window (244 ms) was longer than the
  // round trip that contained it (124 ms). The object cannot see this; the trace can, and marks the start.
  const record = (took: number): Routed => ({
    account: 'a',
    name: 'kv-c-0',
    call_span: 'c'.repeat(16),
    invoked: [
      {
        call_span: 'c'.repeat(16),
        trace: 'e'.repeat(32),
        name_span: 'd'.repeat(16),
        version: 1,
        log_id: null,
        began: 1000,
        took,
        status: 200,
        facet_began: null,
        facet_took: took,
        error: null,
        fault: null,
        clock_lag: null,
        run: null,
        missing: 'test',
        recovered: false,
      },
    ],
    route: {
      trace: 'e'.repeat(32),
      span: 'f'.repeat(16),
      client: null,
      name: 'PUT /kv',
      start: 1100,
      end: 1250,
      status: 200,
      attributes: {},
      events: [],
      steps: [
        {
          span: 'c'.repeat(16),
          parent: 'f'.repeat(16),
          name: 'kv-c-0.invoke',
          kind: 'client',
          start: 1110,
          end: 1234,
          attributes: {},
          events: [],
          error: null,
        },
      ],
    },
  });
  const marks = (took: number): string[] =>
    must(
      spansOf({ resourceSpans: requestSpans(record(took)) }).find(s => s.name === 'kv-c-0 invoke v1'),
      'supervisor span',
    )
      .events.filter(e => evAttr(e, 'tape.missing') === 'supervisor.start')
      .map(e => evAttr(e, 'tape.missing.reason'));
  it('marks a window longer than the call, with the numbers, and not one that fits', () => {
    expect(marks(244)).toEqual([
      expect.stringContaining(
        'reads 244 ms, longer than the 124 ms call that contained it, so its start is 120 ms or more too early',
      ),
    ]);
    expect(marks(100)).toEqual([]);
  });
});
