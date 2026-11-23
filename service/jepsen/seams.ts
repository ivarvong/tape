// seams.ts: every fault at every position, one at a time. No runtime imports beyond the
// checkers; vitest (test/seams.test.ts, in workerd) and jepsen/seams-run.ts (Node, against production) drive it.
//
// The random runs (kv.js, harness.ts) draw faults by seed; a seam only some seeds reach, or reach only under one
// interleaving, is tested by luck. Here each seam named in src/faults.ts (a hop, a kind) is injected at each
// position (the n-th call at that hop, counted from when the plan is set: a plan of points) while a fixed script
// of operations runs, one client, one fault per script run. The scripts are short and cover each kind of operation
// the workloads have. Then the faults stop, everything is healed and read, and the same checks the random runs use
// (linearizability and the trace checker for KV; conservation, the order invariants and the trace checker for the
// workflow) run on the whole history. Anomalies are reported per case where they name a key or an operation.
import { HOP_KINDS } from '../src/faults.ts';
import type { Hop } from '../src/faults.ts';
import type { Sender } from './client.ts';
import { at, fields, list, text } from './json.ts';
import * as kv from './kv.ts';
import * as wf from './harness.ts';

export const CLIENT_KINDS: readonly kv.ClientFault[] = ['drop_request', 'drop_response', 'abort'];
/** One seam at one position, and what its script run came to. */
export type Case = {
  hop: Hop | 'client';
  kind: string;
  n: number;
  fired?: number;
  fired_kinds?: string[];
  anomalies?: string[];
};
type OnCase = (c: Case, index: number) => void;
/** The faults the service says it injected, in order. */
const faultsOf = (log: unknown): string[] => list(at(log, 'faults')).map(f => text(fields(f).kind));
const blame = (c: Case | undefined, type: string): void => {
  if (c) c.anomalies = [...(c.anomalies ?? []), type];
};

// ---- KV: per case, six operations on two fresh keys; an unknown write is sent again (op id) up to twice
const kvScript = (p: string): { key: string; op: kv.Op }[] => [
  { key: `${p}a`, op: { f: 'put', value: `${p}1` } },
  { key: `${p}a`, op: { f: 'get' } },
  { key: `${p}a`, op: { f: 'put', value: `${p}2`, expect: 1 } },
  { key: `${p}b`, op: { f: 'put', value: `${p}3` } },
  { key: `${p}a`, op: { f: 'del', expect: 2 } },
  { key: `${p}b`, op: { f: 'get' } },
];
const isClientFault = (kind: string): kind is kv.ClientFault => CLIENT_KINDS.some(k => k === kind);
export type KvSeams = kv.Cluster & {
  shards: number;
  kinds?: readonly string[];
  clientKinds?: readonly string[];
  retries?: number;
  onCase?: OnCase;
};
export async function kvSeams(
  send: Sender,
  {
    account,
    cluster,
    shards,
    kinds = HOP_KINDS.router,
    clientKinds = CLIENT_KINDS,
    retries = 2,
    onCase = () => {},
  }: KvSeams,
): Promise<{
  cases: Case[];
  history: kv.History;
  final: kv.Final;
  traces: Map<string, unknown>;
  result: kv.Checked;
  tr: kv.Checked;
}> {
  await kv.setup(send, { account, cluster, shards, seed: 0, plan: null });
  const history: kv.History = [],
    attempt = kv.attempter(send, { account, cluster, history, clock: { n: 0 } }),
    keys: string[] = [],
    positions = Array.from({ length: kvScript('x').length }, (_, n) => n);
  const cases: Case[] = [
    ...kinds.flatMap(kind => positions.map((n): Case => ({ hop: 'router', kind, n }))),
    ...clientKinds.flatMap(kind => positions.map((n): Case => ({ hop: 'client', kind, n }))),
  ];
  /** One operation of a case's script, sent again while its outcome is unknown. */
  const scripted = async (
    c: Case,
    ci: number,
    i: number,
    key: string,
    op: kv.Op,
    seen: Map<string, number>,
  ): Promise<void> => {
    if (!keys.includes(key)) keys.push(key);
    const once = op.f === 'get' ? undefined : `${Date.now()}_s${ci}-${i}`; // R-RET-1
    for (let a = 0; ; a++) {
      const fault = c.hop === 'client' && i === c.n && a === 0 && isClientFault(c.kind) ? c.kind : null;
      const h = await attempt(0, key, `/kv/${account}/${cluster}/k/${key}`, op, once, a, fault, 5, seen);
      h.case = ci;
      if (h.type !== 'info' || a >= retries || once === undefined) break;
    }
  };
  let logged = 0;
  for (const [ci, c] of cases.entries()) {
    const seen = new Map<string, number>();
    await send('PUT', `/_faults/${account}`, {
      seed: 0,
      points: c.hop === 'router' ? [{ hop: 'router', n: c.n, kind: c.kind }] : [],
    });
    for (const [i, { key, op }] of kvScript(`s${ci}-`).entries()) await scripted(c, ci, i, key, op, seen);
    const faults = faultsOf((await send('GET', `/_faults/${account}`)).body);
    c.fired =
      c.hop === 'client'
        ? history.filter(h => h.case === ci && h.client_fault !== undefined).length
        : faults.length - logged;
    c.fired_kinds = faults.slice(logged);
    logged = faults.length;
    onCase(c, ci);
  }
  const final = await kv.heal(send, { account, cluster, keys });
  const result = kv.check(kv.logical(history), final);
  const traces = await kv.collectTraces(send, { account, cluster, history });
  const tr = kv.checkTraces(history, final, traces, { account, cluster, shards });
  // anomalies by case, by the key they name
  const caseOf = (key: unknown): number => Number(/^s(\d+)-/.exec(text(key))?.[1] ?? -1);
  for (const a of [...result.anomalies, ...tr.anomalies]) blame(cases[caseOf(a.key)], a.type);
  return { cases, history, final, traces, result, tr };
}

// ---- the workflow: per case, three orders (one that ships, one to Atlantis that the carrier refuses, one on a
// card without the funds), one of them sent twice with its key, an advance and a read of each, a ticket bought,
// retried and read
type Order = { key: string; sku: string; qty: number; card: string; address: string };
const order = (key: string, address: string, card: string): Order => ({ key, sku: 'lamp', qty: 1, card, address });
const idOf = (body: unknown): number | null => {
  const id = at(body, 'id');
  return typeof id === 'number' && Number.isInteger(id) ? id : null;
};
export type WorkflowSeams = {
  hops?: readonly Hop[];
  onCase?: OnCase;
  positions?: Readonly<Record<string, number>> | null;
  /** [i, n]: run only the cases whose index is i modulo n (a slice of the run, for one account; the slices of a
   * run, each on its own account, run side by side and together are every case). */
  slice?: readonly [index: number, of: number];
};
export async function workflowSeams(
  send: Sender,
  sources: wf.Sources,
  { hops = ['router', 'call'], onCase = () => {}, positions = null, slice = [0, 1] }: WorkflowSeams = {},
): Promise<{
  counts: Readonly<Record<string, unknown>>;
  cases: Case[];
  history: wf.History;
  final: wf.Final;
  traces: Map<string, unknown>;
  result: wf.Checked;
  tr: wf.TracesChecked;
}> {
  await wf.setup(send, sources, { seed: 0, plan: null });
  const history: wf.History = [],
    op = wf.recorder(send, history, Date.now(), { next: 0 }),
    sales = { max: 0 };
  const script = async (p: string, ci: number): Promise<void> => {
    const first = history.length,
      orders = [
        order(`${p}o1`, '1 Main St', 'ann-4242'),
        order(`${p}o2`, 'Atlantis', 'ann-4242'),
        order(`${p}o3`, '2 Main St', 'cat-0000'),
      ];
    for (const [j, o] of orders.entries()) {
      const send1 = (): ReturnType<wf.Record1> =>
        op(0, 'create', 'POST', '/fulfill/v/1/orders/wait/2000', JSON.stringify(o), { order: o });
      const res = await send1();
      if (j === 0) await send1(); // the same key again: a client that heard nothing, retrying
      const id = idOf(res?.body);
      if (id === null) continue;
      await op(0, 'advance', 'POST', `/fulfill/v/1/advance/${id}`, '', { id });
      await op(0, 'read', 'GET', `/fulfill/v/1/orders/${id}`, undefined, { id });
    }
    const t = { key: `${p}t1`, section: 'balcony', qty: 1, card: 'ann-4242' };
    const bought = await op(0, 'buy', 'POST', '/tickets/v/1/buy', JSON.stringify(t), { order: t });
    // a 504 does not say its sale's id; with one client the ids are sequential
    sales.max = idOf(bought?.body) ?? sales.max + 1;
    const sid = sales.max;
    await op(0, 'retry', 'POST', `/tickets/v/1/retry/${sid}`, '', { id: sid });
    await op(0, 'sale', 'GET', `/tickets/v/1/sales/${sid}`, undefined, { id: sid });
    for (const h of history.slice(first)) h.case = ci;
  };
  // the positions each hop has: a script run with a plan of no points counts them
  await send('PUT', '/~faults', { seed: 0, points: [], router: true });
  await script('base-', -1);
  const counts = positions ?? fields(at((await send('GET', '/~faults')).body, 'counts'));
  const countOf = (hop: Hop): number => {
    const n = counts[hop];
    return typeof n === 'number' ? n : 0;
  };
  const cases = hops.flatMap(hop =>
    HOP_KINDS[hop]
      .filter(k => k !== 'lookup_error')
      .flatMap(kind => Array.from({ length: countOf(hop) }, (_, n): Case => ({ hop, kind, n }))),
  );
  const [index, of] = slice,
    mine = (ci: number): boolean => ci % of === index;
  let logged = faultsOf((await send('GET', '/~faults')).body).length;
  for (const [ci, c] of cases.entries()) {
    if (!mine(ci)) continue;
    await send('PUT', '/~faults', { seed: 0, points: [{ hop: c.hop, n: c.n, kind: c.kind }], router: true });
    await script(`s${ci}-`, ci);
    const faults = faultsOf((await send('GET', '/~faults')).body);
    c.fired = faults.length - logged;
    c.fired_kinds = faults.slice(logged);
    logged = faults.length;
    onCase(c, ci);
  }
  const final = await wf.heal(send);
  const result = wf.check(history, final);
  const traces = await wf.collectTraces(send, history);
  const tr = wf.checkTraces(history, final, traces);
  const caseOfOp = new Map(history.filter(h => h.type === 'invoke').map(h => [h.i, h.case]));
  for (const a of [...result.anomalies, ...tr.anomalies]) {
    const ci = typeof a.op === 'number' ? caseOfOp.get(a.op) : undefined;
    blame(cases[typeof ci === 'number' ? ci : -1], a.type);
  }
  return { counts, cases: cases.filter((_, ci) => mine(ci)), history, final, traces, result, tr };
}

// What each seam got: { "<hop>/<kind>": { positions, fired } }
export type Coverage = Record<string, { positions: number; fired: number; anomalies: number }>;
export const coverage = (cases: readonly Case[]): Coverage => {
  const out: Coverage = {};
  for (const c of cases) {
    const k = `${c.hop}/${c.kind}`,
      was = out[k] ?? { positions: 0, fired: 0, anomalies: 0 };
    out[k] = {
      positions: was.positions + 1,
      fired: was.fired + ((c.fired ?? 0) > 0 ? 1 : 0),
      anomalies: was.anomalies + (c.anomalies?.length ?? 0),
    };
  }
  return out;
};
