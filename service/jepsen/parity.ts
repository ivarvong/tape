// Local/prod parity: one sequential KV workload per seed, the same requests in the same order, so a
// seeded fault plan (drawn per call site and count, faults.ts) injects the same faults in both places. What each
// side did is reduced to a record without times or random ids, and two records are compared field by field.
//   ops     each attempt: f, key, attempt, status, type, version, value read
//   faults  each injected fault: site (account removed), count at the site, kind, ms
//   final   each key's state after the heal
//   spans   each attempt's trace: the multiset of (service, span name, status code), account removed
//   verdicts  the Jepsen check, the trace check, the model conformance (model/conformance.ts)
import { conform } from '../model/conformance.ts';
import type { Sender } from './client.ts';
import { at, fields, list, num, text } from './json.ts';
import { setup, load, heal, check, logical, collectTraces, checkTraces, finalOf, PLAN } from './kv.ts';
import type { Final } from './kv.ts';
import { spans } from './traces.ts';

export const PARITY = { clients: 1, ops: 60, keys: 3, shards: (seed: number): number => 1 + (seed % 4) };
/** What one side did, without times or random ids. */
export type Record1 = {
  account: string;
  seed: number;
  shards: number;
  ops: unknown[][];
  faults: unknown[][];
  final: Final;
  spans: string[][];
  verdicts: {
    jepsen: boolean;
    anomalies: string[];
    traces: boolean;
    trace_anomalies: string[];
    conforms: boolean;
    violations: string[];
  };
};
const norm = (s: unknown, account: string): string => String(s).split(account).join('{a}');
const byText = (a: string, b: string): number => {
  if (a === b) return 0;
  return a < b ? -1 : 1;
};
const spanShape = (otlp: unknown, account: string): string[] =>
  spans(otlp)
    .map(sp => norm(`${String(sp.service)}|${sp.name}|${sp.status}`, account))
    .toSorted(byText);

export async function parityRun(send: Sender, { account, seed }: { account: string; seed: number }): Promise<Record1> {
  const cluster = 'p',
    shards = PARITY.shards(seed);
  await setup(send, { account, cluster, shards, seed, plan: PLAN, tail: [20, 300] });
  const { history, keys } = await load(send, {
    account,
    cluster,
    seed,
    clients: PARITY.clients,
    ops: PARITY.ops,
    keys: PARITY.keys,
    clientFaults: null,
    retries: () => 2,
  });
  const faults = list(at((await send('GET', `/_faults/${account}`)).body, 'faults'));
  const final = await heal(send, { account, cluster, keys });
  const result = check(logical(history), final);
  const traces = await collectTraces(send, { account, cluster, history }),
    tr = checkTraces(history, final, traces, { account, cluster, shards });
  const model = conform(history, traces, { account, cluster, shards });
  return {
    account,
    seed,
    shards,
    ops: history.map(h => [h.f, h.key, h.attempt ?? 0, h.status, h.type, h.version ?? null, h.read ?? null]),
    faults: faults.map(f => [norm(at(f, 'site'), account), at(f, 'n'), at(f, 'kind'), at(f, 'ms')]),
    final,
    spans: history.map(h => spanShape(traces.get(h.trace), account)),
    verdicts: {
      jepsen: result.valid,
      anomalies: result.anomalies.map(a => a.type),
      traces: tr.valid,
      trace_anomalies: [...new Set(tr.anomalies.map(a => a.type))],
      conforms: model.conforms,
      violations: [...new Set(model.violations.map(v => v.type))],
    },
  };
}

const texts = (v: unknown): string[] => list(v).map(String);
/** A record as a run stored it. */
export const recordOf = (v: unknown): Record1 => {
  const r = fields(v),
    verdicts = fields(r['verdicts']);
  return {
    account: text(r['account']),
    seed: num(r['seed']),
    shards: num(r['shards']),
    ops: list(r['ops']).map(list),
    faults: list(r['faults']).map(list),
    final: finalOf(r['final']),
    spans: list(r['spans']).map(texts),
    verdicts: {
      jepsen: verdicts['jepsen'] === true,
      anomalies: texts(verdicts['anomalies']),
      traces: verdicts['traces'] === true,
      trace_anomalies: texts(verdicts['trace_anomalies']),
      conforms: verdicts['conforms'] === true,
      violations: texts(verdicts['violations']),
    },
  };
};
export type Difference = [field: string, where: number | string | null, a: unknown, b: unknown];
const same = (x: unknown, y: unknown): boolean => JSON.stringify(x) === JSON.stringify(y);
/** The first 20 places two lists differ. */
const listDiff = (field: string, a: readonly unknown[], b: readonly unknown[]): Difference[] =>
  Array.from({ length: Math.max(a.length, b.length) }, (_, i) => i)
    .filter(i => !same(a[i], b[i]))
    .slice(0, 20)
    .map((i): Difference => [field, i, a[i] ?? null, b[i] ?? null]);
// The differences between two records of one seed, as [field, index, a, b], first 20 of each field.
export function parityDiff(a: Record1, b: Record1): Difference[] {
  const finals = [...new Set([...Object.keys(a.final), ...Object.keys(b.final)])]
    .filter(key => !same(a.final[key], b.final[key]))
    .map((key): Difference => ['final', key, a.final[key] ?? null, b.final[key] ?? null]);
  return [
    ...listDiff('ops', a.ops, b.ops),
    ...listDiff('faults', a.faults, b.faults),
    ...listDiff('spans', a.spans, b.spans),
    ...finals,
    ...(same(a.verdicts, b.verdicts) ? [] : [['verdicts', null, a.verdicts, b.verdicts] satisfies Difference]),
  ];
}
