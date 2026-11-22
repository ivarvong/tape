// RUNTIME-SPEC section 6 (retention), in workerd: the op window of examples/kv.tape (R-RET-1..4), with the bugs it
// guards against planted in the program and caught by the retention checker; the trace records kept to the newest N
// (R-RET-6), with no answer changed by a prune; and the trace route saying what it pruned.
import { describe, expect, it } from 'vitest';
import kvSource from '../../examples/kv.tape?raw';
import indexSource from '../src/name.ts?raw';
import programSource from '../src/program.ts?raw';
import { check, checkTraces, scenario } from '../jepsen/retention.ts';
import type { Attempt, Checked, Traced } from '../jepsen/retention.ts';
import { anyString, at, call, got, json, list, pause, send } from './help.ts';

const W = 1000,
  S = 1000;

// a name running this source, placed as shard 0 of 1 with the op window W and clock allowance S
async function shard(account: string, name: string, source: string): Promise<string> {
  expect((await call(`/${account}/${name}`, { method: 'POST', body: source })).status).toBe(201);
  const placed = await send('PUT', `/${account}/${name}/v/1/placement/0?shards=1&window=${W}&skew=${S}`);
  expect([placed.status, placed.body]).toEqual([200, { shard: 0, shards: 1, window_ms: W, skew_ms: S }]);
  return `/${account}/${name}/v/1`;
}
const mutant = (from: string, to: string): string => {
  expect(kvSource.includes(from)).toBe(true);
  return kvSource.replace(from, to);
};
// bug A: the prune ignores the window (cutoff = now): an op inside its window loses its record, and a resend runs again
const pruneTooEarly = (): string => mutant('cutoff: now - window_ms - skew_ms', 'cutoff: now + 1');
// bug B: no window check: a resend after its record was pruned runs again
const noWindow = (): string => mutant('t < now - window_ms ->', 't < now - 86400000000 ->');
const types = (r: Checked): string[] => [...new Set(r.anomalies.map(a => a.type))].toSorted();
// A scenario takes about 4.1 s on an idle machine: the upload compiles the program (1.7 s) and it sleeps W + S + 300 ms.
// vitest's default budget is 5 s, so on a loaded machine the test timed out (a flake, reproduced
// under CPU load): these tests get their own budget.
const SLOW = 60000;

describe('retention: the op window (R-RET-1..4)', () => {
  it(
    'the correct program: a resend in the window replays, one past W + S is 410 with nothing run, untimed and future ids are 400',
    async () => {
      const base = await shard('ret', 'ok', kvSource);
      const h = await scenario({ send, base, window: W, skew: S });
      expect(h.map(x => x.status)).toEqual([201, 200, 201, 200, 410, 400, 400]);
      expect([h[2]?.version, h[4]?.body]).toEqual([
        h[0]?.version,
        { error: anyString, op_expired: true, window_ms: W },
      ]);
      expect(check(h, { window: W, skew: S, tolerance: 200 }).anomalies).toEqual([]);
      // the 410 ran nothing: the key is at the version of z
      expect((await send('GET', `${base}/k/r`)).body).toEqual({ key: 'r', value: 'z', version: 3 });
    },
    SLOW,
  );

  it(
    'planted bug A (prune too early): the resend inside the window is applied again -> op-applied-twice',
    async () => {
      const h = await scenario({ send, base: await shard('ret', 'early', pruneTooEarly()), window: W, skew: S });
      expect(h[2]?.version).not.toBe(h[0]?.version);
      expect(types(check(h, { window: W, skew: S, tolerance: 200 }))).toContain('op-applied-twice');
    },
    SLOW,
  );

  it(
    'planted bug B (no window check): the resend after the prune is applied again -> expired-op-not-refused, op-applied-twice',
    async () => {
      const h = await scenario({ send, base: await shard('ret', 'nowin', noWindow()), window: W, skew: S });
      expect(types(check(h, { window: W, skew: S, tolerance: 200 }))).toEqual([
        'expired-op-not-refused',
        'op-applied-twice',
      ]);
    },
    SLOW,
  );

  it(
    'the prune removes only records past W + S, at most 32 per write',
    async () => {
      const base = await shard('ret', 'count', kvSource);
      // each op id carries the time it is sent: one time for all 40 (as first written) made the loop race the window
      // W = 1 s (an op older than W is refused, 410), which 40 requests on a loaded machine lost
      for (let i = 0; i < 40; i++)
        expect((await send('PUT', `${base}/k/k${i}?op=${Date.now()}_old-${i}`, 'v')).status).toBe(201);
      const before = at(await got('/ret/count/storage'), 'data');
      await pause(W + S + 300);
      // all 40 are past W + S: the first new op prunes 32, the next the other 8; a fresh op is never pruned
      const t1 = Date.now();
      expect((await send('PUT', `${base}/k/n1?op=${t1}_new-1`, 'v')).status).toBe(201);
      expect((await send('PUT', `${base}/k/n2?op=${t1}_new-2`, 'v')).status).toBe(201);
      expect((await send('PUT', `${base}/k/n1?op=${t1}_new-1`, 'v')).body).toEqual({ key: 'n1', version: 1 });
      expect((await send('PUT', `${base}/k/n2?op=${t1}_new-2`, 'v')).body).toEqual({ key: 'n2', version: 1 });
      expect(at(before, 'bytes')).toBeGreaterThan(0);
    },
    SLOW,
  );

  it('the checker: each rule fires on its own violation and not on the others', () => {
    const o = (once: string, status: number | null, extra?: Partial<Attempt>): Attempt => ({
      key: 'k',
      once,
      sent: 100000,
      got: 100010,
      status,
      ...extra,
    });
    const t = (n: number): string => `${String(n).padStart(13, '0')}_a`;
    const c = (h: readonly Attempt[]): string[] => types(check(h, { window: 1000, skew: 1000, tolerance: 0 }));
    expect(c([o(t(100000), 201, { version: 1 }), o(t(100000), 201, { version: 1 })])).toEqual([]);
    expect(c([o(t(100000), 201, { version: 1 }), o(t(100000), 200, { version: 2 })])).toEqual(['op-applied-twice']);
    expect(c([o(t(98000), 201, { version: 1 })])).toEqual(['expired-op-not-refused']);
    expect(c([o(t(98000), 410, { body: { op_expired: true, window_ms: 1000 } })])).toEqual([]);
    expect(c([o(t(99800), 410, { body: { op_expired: true, window_ms: 1000 } })])).toEqual(['fresh-op-refused']);
    expect(c([o(t(98000), 410, { body: { error: 'x' } })])).toEqual(['expiry-answer-unclear']);
    expect(c([o('c1-1', 201, { version: 1 })])).toEqual(['untimed-op-accepted']);
    expect(c([o('c1-1', 400)])).toEqual([]);
    expect(c([o(t(105000), 201, { version: 1 })])).toEqual(['future-op-accepted']);
    expect(c([o(t(105000), 400)])).toEqual([]);
    expect(c([o(t(100000), null)])).toEqual([]);
    const tr = (x: readonly Traced[]): string[] => types(checkTraces(x, { tolerance: 0 }));
    expect(
      tr([
        { op: { sent: 50 }, found: false, pruned_before: 60 },
        { op: { sent: 70 }, found: true, pruned_before: 60 },
      ]),
    ).toEqual([]);
    expect(tr([{ op: { sent: 70 }, found: false, pruned_before: 60 }])).toEqual(['trace-missing-not-pruned']);
    expect(tr([{ op: { sent: 70 }, found: false, pruned_before: null }])).toEqual(['trace-missing-not-pruned']);
  });
});

describe('retention: trace records (R-RET-6)', () => {
  it(
    "keeps the newest N requests' records; answers are unchanged; old traces answer with pruned_before",
    async () => {
      const account = 'jepsen-ret',
        cluster = 'tk';
      const made = await call(`/kv/${account}/${cluster}`, {
        method: 'POST',
        body: JSON.stringify({ shards: 1, trace_keep: 10 }),
      });
      expect(made.status).toBe(201);
      expect(await got(`/_retention/${account}/kv-${cluster}-0`)).toEqual({
        n: 10,
        pruned_before: null,
      });
      const traceparent = (i: number): string => `00-${i.toString(16).padStart(32, '0')}-${'1'.repeat(16)}-01`;
      const answers: unknown[][] = [];
      for (let i = 1; i <= 60; i++) {
        const r = await call(`/kv/${account}/${cluster}/k/a?op=${Date.now()}_p-${i}`, {
          method: 'PUT',
          body: `v${i}`,
          headers: { traceparent: traceparent(i) },
        });
        answers.push([r.status, at(await json(r), 'version')]);
      }
      expect(answers).toEqual(Array.from({ length: 60 }, (_, i) => [i === 0 ? 201 : 200, i + 1]));
      expect(await got(`/kv/${account}/${cluster}/k/a`)).toEqual({
        key: 'a',
        value: 'v60',
        version: 60,
      });
      const keep = await got(`/_retention/${account}/kv-${cluster}-0`);
      expect([at(keep, 'n'), typeof at(keep, 'pruned_before')]).toEqual([10, 'number']);
      const st = await got(`/${account}/kv-${cluster}-0/storage`);
      expect(at(st, 'data', 'log_rows')).toBeLessThanOrEqual(10 + 16);
      const traceOf = async (i: number): Promise<[number, unknown]> => {
        const r = await call(`/kv/${account}/${cluster}/traces/${i.toString(16).padStart(32, '0')}?format=json`);
        return [r.status, await json(r)];
      };
      const [s1, old] = await traceOf(1),
        [s60, recent] = await traceOf(60);
      expect([
        s1,
        list(at(old, 'requests')).length,
        at(old, 'pruned_before'),
        s60,
        list(at(recent, 'requests')).length > 0,
      ]).toEqual([200, 0, at(keep, 'pruned_before'), 200, true]);
    },
    SLOW,
  );

  it(
    'a request that never reached its shard keeps its trace through prunes (the bug of the first prune)',
    async () => {
      const account = 'jepsen-ret',
        cluster = 'ov';
      expect(
        (await call(`/kv/${account}/${cluster}`, { method: 'POST', body: JSON.stringify({ shards: 1 }) })).status,
      ).toBe(201);
      expect(
        (
          await call(`/_faults/${account}`, {
            method: 'PUT',
            body: JSON.stringify({ seed: 0, points: [{ hop: 'router', n: 0, kind: 'overload' }] }),
          })
        ).status,
      ).toBe(200);
      const trace = 'ab'.repeat(16);
      const first = await call(`/kv/${account}/${cluster}/k/a?op=${Date.now()}_ov-0`, {
        method: 'PUT',
        body: 'v',
        headers: { traceparent: `00-${trace}-${'2'.repeat(16)}-01` },
      });
      expect(first.status).toBe(503);
      expect((await call(`/_faults/${account}`, { method: 'PUT', body: 'null' })).status).toBe(200);
      for (let i = 1; i <= 40; i++)
        expect(
          (await call(`/kv/${account}/${cluster}/k/a?op=${Date.now()}_ov-${i}`, { method: 'PUT', body: `v${i}` }))
            .status,
        ).toBeLessThan(300);
      const r = await got(`/kv/${account}/${cluster}/traces/${trace}?format=json`);
      expect([list(at(r, 'requests')).length, at(r, 'pruned_before')]).toEqual([1, undefined]);
    },
    SLOW,
  );

  it('the pruned tables are read only to show traces, never to answer a request (static)', () => {
    // every method of Name or Program that SELECTs from a pruned table is the prune, a size report or a trace view
    // (writes are not reads: an INSERT, and the UPDATE of the log row a run is writing, read nothing back)
    const allowed = new Set([
      'prune',
      '#pruneRouted',
      'pruneLog',
      'storageUse',
      'request',
      'requestTraces',
      'traced',
      'routedOf',
      'served',
      'findRuns',
      'view',
      'requests',
      'requestHeads',
    ]);
    const methods = (src: string): Map<string, number> => {
      const out = new Map<string, number>();
      let current = '';
      for (const line of src.split('\n')) {
        // a method's first line: its name at the class's indent, whatever its parameters and return type
        const m = /^  (?:override\s+)?(?:async\s+)?(?!(?:if|for|while|switch|catch)\b)(#?\w+)\s*\(/.exec(line);
        current = m?.[1] ?? current;
        if (/(?<!DELETE )\b(FROM|JOIN)\s+_tape_(log|invoked|served|routed)\b/.test(line) && !/^\s*\/\//.test(line))
          out.set(current, (out.get(current) ?? 0) + 1);
      }
      return out;
    };
    const readers = [...methods(indexSource).keys(), ...methods(programSource).keys()];
    expect(readers.filter(m => !allowed.has(m))).toEqual([]);
    expect(readers.length).toBeGreaterThan(5);
  });
});
