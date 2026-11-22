// Jepsen-style runs of the sharded KV service in workerd: concurrent clients on a few hot keys, faults between
// the router and the shards (resets, lost and dropped replies, overload, delays), then a heal and a per-key
// linearizability check (jepsen/kv.ts). The checker itself is tested first, on histories made to be wrong.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { setup, load, heal, check, collectTraces, checkTraces, logical, CONFIG } from '../jepsen/kv.ts';
import type { Attempt, Checked, Final, History, KeyState } from '../jepsen/kv.ts';
import { clientSpan, breaks, docOf } from '../jepsen/traces.ts';
import type { Doc, RawEvent, RawSpan } from '../jepsen/traces.ts';
import { at, list, seedsIn, send } from './help.ts';

/** An attempt as the checker's own cases write one: no client, no trace. */
const hand = (more: Partial<Attempt> & Pick<Attempt, 'key' | 'f' | 'start'>): Attempt => ({
  client: 0,
  trace: '',
  span: '',
  ...more,
});
const W = (
  key: string,
  value: string,
  start: number,
  end: number,
  version: number,
  extra?: Partial<Attempt>,
): Attempt =>
  hand({ key, f: 'put', value, start, end, type: 'ok', status: version === 1 ? 201 : 200, version, ...extra });
const R = (key: string, start: number, end: number, version: number, read: string): Attempt =>
  hand({ key, f: 'get', start, end, type: 'ok', status: 200, live: true, version, read });
const lostPut = (key: string, value: string, start: number, end: number): Attempt =>
  hand({ key, f: 'put', value, start, end, type: 'info', status: 503 });
const ending = (version: number, value: string): Final => ({ a: { live: true, version, value } });

describe('kv jepsen: the checker', () => {
  const cases: [string, History, Final, string[]][] = [
    ['a valid history', [W('a', 'x', 0, 1, 1), R('a', 2, 3, 1, 'x'), W('a', 'y', 4, 5, 2)], ending(2, 'y'), []],
    ['a lost write explained by a read', [lostPut('a', 'x', 0, 3), R('a', 1, 2, 1, 'x')], ending(1, 'x'), []],
    ['a stale read', [W('a', 'x', 0, 1, 1), W('a', 'y', 2, 3, 2), R('a', 4, 5, 1, 'x')], ending(2, 'y'), ['real-time']],
    ['two acks for one version', [W('a', 'x', 0, 3, 1), W('a', 'y', 1, 2, 1)], ending(1, 'y'), ['duplicate-version']],
    ['an acked write lost', [W('a', 'x', 0, 1, 1), W('a', 'y', 2, 3, 2)], ending(1, 'x'), ['lost-write']],
    ['a read of the wrong value', [W('a', 'x', 0, 1, 1), R('a', 2, 3, 1, 'z')], ending(1, 'x'), ['read-wrong-value']],
    [
      'a read from the future',
      [R('a', 0, 1, 1, 'x'), lostPut('a', 'x', 2, 3)],
      ending(1, 'x'),
      ['read-from-future', 'real-time'],
    ],
    [
      'a CAS that skipped a version',
      [W('a', 'x', 0, 1, 1), W('a', 'y', 2, 3, 3, { expect: 1 })],
      ending(3, 'y'),
      ['cas-wrong-version', 'versions-not-dense'],
    ],
    ['versions from nowhere', [W('a', 'x', 0, 1, 1)], ending(5, 'q'), ['versions-not-dense']],
  ];
  for (const [what, history, f, want] of cases)
    it(what, () => {
      expect(check(history, f).anomalies.map(a => a.type)).toEqual(want);
    });
});

// The trace checker, on real traces: one scenario with an operation of each kind, whose traces must pass, and the
// same traces broken on purpose, each of which must be caught, with the anomaly that names what is wrong.
describe('kv jepsen: the trace checker', () => {
  const account = 'jepsen-kvtc',
    cluster = 't',
    shards = 2;
  const history: History = [];
  let healed: Final = {},
    traces = new Map<string, unknown>();
  type Plan = Readonly<Record<string, number>>;
  /** What the answer makes of the attempt, as the workload's own client records it. */
  const outcome = (f: Attempt['f'], status: number, body: unknown): Partial<Attempt> => {
    const version = at(body, 'version');
    const seen = typeof version === 'number' ? { version } : {};
    if (f === 'get')
      return status === 200
        ? { type: 'ok', live: true, ...seen, read: at(body, 'value') }
        : { type: 'ok', live: false, ...seen };
    if (status === 200 || status === 201) return { type: 'ok', ...seen };
    if ((status === 500 || status === 503) && at(body, 'applied') === false) return { type: 'fail', applied: false };
    return { type: 'info' };
  };
  const op = async (f: 'get' | 'put', key: string, value?: string, plan: Plan | null = null): Promise<Attempt> => {
    await send('PUT', `/_faults/${account}`, plan === null ? null : { seed: 7, p: plan, tail: [1, 2] });
    // every write names its operation (an unconditional PUT without ?op= is 428)
    const once = f === 'get' ? undefined : `${Date.now()}_c0-${history.length}`;
    const cs = clientSpan();
    const res = await send(
      f === 'get' ? 'GET' : 'PUT',
      `/kv/${account}/${cluster}/k/${key}${once === undefined ? '' : `?op=${once}`}`,
      value,
      { headers: { traceparent: cs.traceparent } },
    );
    const h: Attempt = {
      client: 0,
      key,
      f,
      ...(value === undefined ? {} : { value }),
      trace: cs.trace,
      span: cs.span,
      start: history.length * 2,
      end: history.length * 2 + 1,
      ...(once === undefined ? {} : { once, attempt: 0 }),
      status: res.status,
      trace_complete: res.headers['tape-trace-complete'] ?? null,
      ...outcome(f, res.status, res.body),
    };
    history.push(h);
    return h;
  };
  const opts = { account, cluster, shards };
  const types = (r: Checked): string[] => [...new Set(r.anomalies.map(a => a.type))];
  const withTrace = (h: Attempt, otlp: unknown): Map<string, unknown> => new Map([...traces, [h.trace, otlp]]);
  const isName =
      (n: string) =>
      (sp: RawSpan): boolean =>
        sp.name === n,
    endsWith =
      (n: string) =>
      (sp: RawSpan): boolean =>
        sp.name.endsWith(n);
  /** The attempts of the scenario, by what each is: made by the first test, read by the others. */
  const made = new Map<string, Attempt>();
  const the = (what: string): Attempt => {
    const h = made.get(what);
    if (h === undefined) throw new Error(`the scenario has no ${what}`);
    return h;
  };
  /** The trace of an attempt as an OTLP document, and a copy of it with some spans changed. */
  const docFor = (h: Attempt): Doc => docOf(traces.get(h.trace));
  const changed = (h: Attempt, match: (sp: RawSpan) => boolean, f: (sp: RawSpan) => RawSpan): Doc => ({
    resourceSpans: docFor(h).resourceSpans.map(r => ({
      ...r,
      scopeSpans: r.scopeSpans.map(sc => ({ ...sc, spans: sc.spans.map(sp => (match(sp) ? f(sp) : sp)) })),
    })),
  });
  const later = (ns: string, d: bigint): string => String(BigInt(ns) + d);
  it('passes the real traces of every kind of operation', async () => {
    await setup(send, { account, cluster, shards, seed: 7, plan: null });
    made.set('ok', await op('put', 'a', 'v1'));
    made.set('read', await op('get', 'a'));
    made.set('lostReply', await op('put', 'b', 'kept', { reset_callee_after: 1 }));
    made.set('failed', await op('put', 'c', 'never', { storage_error: 1 }));
    made.set('overloaded', await op('put', 'c', 'unsent', { overload: 1 }));
    expect([
      the('ok').status,
      the('read').status,
      the('lostReply').type,
      the('failed').type,
      the('overloaded').type,
    ]).toEqual([201, 200, 'info', 'fail', 'info']);
    healed = await heal(send, { account, cluster, keys: ['a', 'b', 'c'] });
    const want: Record<string, KeyState> = {
      a: { live: true, version: 1, value: 'v1' },
      b: { live: true, version: 1, value: 'kept' },
      c: { live: false, version: 0 },
    };
    expect(healed).toEqual(want);
    traces = await collectTraces(send, { account, cluster, history });
    const r = checkTraces(history, healed, traces, opts);
    expect(r.anomalies).toEqual([]);
    expect([r.stats.traced, r.stats.info_committed, r.stats.info_not_committed, r.stats.markers]).toEqual([
      5,
      1,
      1,
      { supervisor: 1 },
    ]);
  });
  type Broken = [what: string, h: Attempt, mutate: (o: Doc) => Doc, want: string[]];
  const broken = (): Broken[] => [
    [
      'the router span dropped',
      the('ok'),
      o => breaks.drop(o, isName('PUT /kv/{account}/{cluster}/k/{key}')),
      ['trace-not-one-tree'],
    ],
    [
      'the run under a span not in the trace',
      the('ok'),
      o => breaks.reparent(o, isName('PUT /k/a'), 'deadbeefdeadbeef'),
      ['trace-not-one-tree'],
    ],
    [
      'two router spans (two roots)',
      the('ok'),
      o => breaks.duplicate(o, isName('PUT /kv/{account}/{cluster}/k/{key}')),
      ['trace-not-one-tree'],
    ],
    ['a span in another trace', the('ok'), o => breaks.retrace(o, endsWith('.invoke')), ['trace-id-mismatch']],
    [
      'the supervisor under the router instead of the shard call',
      the('ok'),
      o => {
        const router = o.resourceSpans[0]?.scopeSpans[0]?.spans[0]?.spanId ?? '';
        return breaks.reparent(o, sp => sp.name.includes(' invoke v'), router);
      },
      [
        'unexpected-router-child',
        'supervisor-missing-without-marker',
        'supervisor-missing',
        'trace-effect-mismatch',
        'committed-write-without-trace',
      ],
    ],
    [
      'the run executed twice',
      the('ok'),
      o => breaks.duplicate(o, sp => sp.name.includes(' invoke v')),
      ['duplicate-execution'],
    ],
    [
      'the run span missing, with no marker',
      the('ok'),
      o => breaks.drop(o, isName('PUT /k/a')),
      ['run-missing-without-marker', 'trace-effect-mismatch', 'committed-write-without-trace'],
    ],
    [
      'the written value changed in the SQL rows',
      the('ok'),
      o =>
        breaks.eventAttr(
          o,
          isName('PUT /k/a'),
          e =>
            e.name === 'db.query' && e.attributes.some(a => a.value.stringValue?.startsWith('INSERT INTO kv') === true),
          'tape.sql.rows',
          () => ({ stringValue: '[["a","forged",1,1]]' }),
        ),
      ['trace-effect-mismatch', 'trace-final-mismatch', 'read-not-from-traced-write'],
    ],
    [
      'the router reporting another status',
      the('ok'),
      o =>
        breaks.attr(o, isName('PUT /kv/{account}/{cluster}/k/{key}'), 'http.response.status_code', () => ({
          intValue: '200',
        })),
      ['status-mismatch', 'router-status-not-run-status'],
    ],
    [
      'the read seeing another version',
      the('read'),
      o =>
        breaks.eventAttr(
          o,
          isName('GET /k/a'),
          e => e.name === 'db.query',
          'tape.sql.rows',
          () => ({ stringValue: '[["a","v1",2,1]]' }),
        ),
      ['trace-read-mismatch'],
    ],
    [
      'the trace of a write whose reply was lost, gone',
      the('lostReply'),
      () => ({ resourceSpans: [] }),
      ['trace-missing', 'committed-write-without-trace'],
    ],
    [
      'a rolled-back write shown as committed',
      the('failed'),
      () =>
        changed(the('failed'), isName('PUT /k/c'), sp => ({
          ...sp,
          status: { code: 0 },
          attributes: sp.attributes.filter(a => a.key !== 'tape.run.rolled_back'),
        })),
      ['failed-op-committed-in-trace', 'trace-version-beyond-final'],
    ],
    [
      'the marker for a call the shard never saw, removed',
      the('overloaded'),
      o => breaks.dropEvents(o, endsWith('.invoke'), e => e.name === 'tape.span.missing'),
      ['supervisor-missing-without-marker'],
    ],
    [
      'a trace for a request the client never sent',
      { ...the('overloaded'), client_fault: 'drop_request', type: 'fail' },
      o => o,
      ['trace-for-unsent-request'],
    ],
  ];
  it('rejects broken traces, each for what is wrong with it', () => {
    const results = broken().map(([what, h, mutate]) => {
      const hist = history.map(x => (x.trace === h.trace ? h : x));
      return [what, types(checkTraces(hist, healed, withTrace(h, mutate(docFor(h))), opts))];
    });
    expect(results).toEqual(broken().map(([what, , , want]) => [what, want]));
  });
  it('allows no trace for a request whose connection failed (counted), but not for one whose body broke', () => {
    const checked = (h: Attempt): Checked =>
      checkTraces(
        history.map(x => (x.trace === h.trace ? h : x)),
        healed,
        withTrace(h, { resourceSpans: [] }),
        opts,
      );
    const read = the('read');
    const failedConnection = checked({ ...read, status: 0, type: 'fail', error: 'fetch failed: ECONNRESET' });
    expect([types(failedConnection), failedConnection.stats.absent_network]).toEqual([[], 1]);
    expect(types(checked({ ...read, status: 0, type: 'fail', error: 'the body broke: terminated' }))).toEqual([
      'trace-missing',
    ]);
    expect(types(checked({ ...read, status: 0, type: 'fail' }))).toEqual(['trace-missing']);
  });
  it('rejects a span outside its parent in time (beyond the clock-skew tolerance)', () => {
    const ok = the('ok');
    const o = changed(ok, isName('PUT /k/a'), sp => ({
      ...sp,
      endTimeUnixNano: later(sp.endTimeUnixNano, 1000000000n),
    }));
    expect(types(checkTraces(history, healed, withTrace(ok, o), opts))).toEqual(['span-outside-parent']);
  });
  it('judges a callee on another clock by its length, not its position: an offset passes, outlasting the call does not', () => {
    const ok = the('ok');
    const callee = (sp: RawSpan): boolean => sp.name.endsWith(' invoke v1') || sp.name === 'PUT /k/a';
    // the shard's clock 500 ms behind the router's: its spans, all of them, earlier by that much
    const early = changed(ok, callee, sp => ({
      ...sp,
      startTimeUnixNano: later(sp.startTimeUnixNano, -500000000n),
      endTimeUnixNano: later(sp.endTimeUnixNano, -500000000n),
    }));
    expect(types(checkTraces(history, healed, withTrace(ok, early), opts))).toEqual([]);
    // the shard's spans a second longer than the call they answered
    const longer = (sp: RawSpan): RawSpan => ({ ...sp, endTimeUnixNano: later(sp.endTimeUnixNano, 1000000000n) });
    expect(types(checkTraces(history, healed, withTrace(ok, changed(ok, callee, longer)), opts))).toEqual([
      'callee-outlasts-call',
    ]);
    // the same, saying its start is stale (view.ts marks this when the window outlasts the call): allowed, counted
    const marker: RawEvent = {
      name: 'tape.span.missing',
      timeUnixNano: '0',
      attributes: [
        { key: 'tape.missing', value: { stringValue: 'supervisor.start' } },
        { key: 'tape.missing.reason', value: { stringValue: 'stale clock' } },
      ],
    };
    const supervisor = (sp: RawSpan): boolean => sp.name.endsWith(' invoke v1');
    const said = (sp: RawSpan): RawSpan => ({ ...sp, events: [...sp.events, marker] });
    const longAndSaid = changed(ok, callee, sp => (supervisor(sp) ? said(longer(sp)) : longer(sp)));
    expect(types(checkTraces(history, healed, withTrace(ok, longAndSaid), opts))).toEqual([]);
    // and the marker on a span that does not outlast its call is a false claim
    expect(types(checkTraces(history, healed, withTrace(ok, changed(ok, supervisor, said)), opts))).toEqual([
      'stale-start-marker-unfounded',
    ]);
  });
});

// KV_SEEDS=1-16 npx vitest run test/kv-jepsen.test.ts; the default is a short run. Every seed runs kv.js CONFIG: only
// the seed changes (and the shard count, 1 + seed % 4); the odd clients resend an unknown write, the even ones never.
const SEEDS = seedsIn(env.KV_SEEDS);
/** How many of each there are, leaving out what is not text. */
const counted = (all: readonly unknown[]): Record<string, number> =>
  Object.fromEntries(
    [
      ...Map.groupBy(
        all.filter(x => typeof x === 'string'),
        x => x,
      ),
    ].map(([k, v]) => [k, v.length]),
  );
describe('kv jepsen: faults between router and shards, concurrent clients on hot keys', () => {
  for (const seed of SEEDS)
    it(`seed ${seed}: every key linearizable, no acked write lost`, async ({ task }) => {
      const account = `jepsen-kv${seed}`,
        cluster = 'j',
        shards = CONFIG.shards(seed);
      await setup(send, { account, cluster, shards, seed, plan: CONFIG.plan, tail: CONFIG.tail });
      const { history, keys } = await load(send, {
        account,
        cluster,
        seed,
        clients: CONFIG.clients,
        ops: CONFIG.ops,
        keys: CONFIG.keys,
        retries: CONFIG.retries,
        clientFaults: CONFIG.clientFaults,
      });
      const injected = async (): Promise<unknown[]> =>
        list(at((await send('GET', `/_faults/${account}`)).body, 'faults'));
      const faults = (await injected()).length;
      const final = await heal(send, { account, cluster, keys }),
        r = check(logical(history), final);
      const tr = checkTraces(history, final, await collectTraces(send, { account, cluster, history }), {
        account,
        cluster,
        shards,
      });
      task.meta.jepsen = {
        seed,
        shards,
        faults,
        client_faults: counted(history.map(h => h.client_fault)),
        kinds: counted((await injected()).map(f => at(f, 'kind'))),
        stats: r.stats,
        anomalies: r.anomalies.slice(0, 10),
        traces: tr.stats,
        trace_anomalies: tr.anomalies.slice(0, 10),
        anomalous: history.filter(h => tr.anomalies.slice(0, 10).some(a => a.trace === h.trace)),
      };
      expect(faults).toBeGreaterThan(0);
      expect(r.stats.info).toBeGreaterThan(0);
      expect(r.anomalies).toEqual([]);
      expect(tr.anomalies).toEqual([]);
      expect(tr.stats.traced).toBeGreaterThan(0);
    }, 300000);
});
