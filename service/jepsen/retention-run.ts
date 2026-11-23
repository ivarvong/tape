// node service/jepsen/retention-run.ts --base <url> --token-file <path> --account jepsen-ret1 --minutes 12 [--out dir]
// The long-running retention scenario (RUNTIME-SPEC section 6) against a deployed service: one cluster of 2 shards
// with a short op window (W = 20 s, S = 2 s) and trace_keep = 50, four clients writing for --minutes. Besides fresh
// writes, each client resends earlier ops on purpose: inside the window (must replay the first answer), near its
// edge (either answer), and long past W + S (must be 410, nothing run); and sends untimed and future op ids (400).
// Checked by retention.ts: check (the answers), checkFinal (each key's version against the ops that may have run),
// checkTraces (a missing trace only if older than what its shard pruned). Storage of both shards is sampled every
// minute, to show it levels off. The token is sent only in the authorization header and never printed.
import { writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { counted, faultable, flag, need, removeAccounts, tokenFromFile } from './cli.ts';
import { makeSender, stats as clientStats } from './client.ts';
import { at, list, messageOf, numOrNull } from './json.ts';
import { check, checkFinal, checkTraces } from './retention.ts';
import type { Attempt, Traced } from './retention.ts';

const account = faultable(need('account'), 'account'),
  minutes = Number(flag('minutes') ?? '12'),
  out = flag('out') ?? '/tmp/jepsen-ret';
const W = 20000,
  S = 2000,
  KEEP = 50,
  SHARDS = 2,
  CLIENTS = 4,
  KEYS = 8,
  cluster = 'r';
mkdirSync(out, { recursive: true });
const send = makeSender({ base: need('base'), token: tokenFromFile() });
const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });
const hex = (n: number): string => randomBytes(n).toString('hex');

const made = await send('POST', `/kv/${account}/${cluster}`, {
  shards: SHARDS,
  op_window_ms: W,
  op_skew_ms: S,
  trace_keep: KEEP,
});
if (made.status !== 201 && made.status !== 200) throw new Error(`cluster: ${made.status} ${JSON.stringify(made.body)}`);
type Kind = 'fresh' | 'resend-in-window' | 'resend-at-edge' | 'resend-expired' | 'untimed' | 'future';
/** One attempt of this run: who sent it, why, and its trace. */
type Sent = Attempt & { client: number; kind: Kind; trace: string; value: string };
const history: Sent[] = [],
  storage: Record<string, unknown>[] = [],
  offsets: number[] = [],
  began = Date.now(),
  end = began + minutes * 60000;
let n = 0;
/** What each shard holds now, or the status it answered with. */
const sample = async (): Promise<void> => {
  const row: Record<string, unknown> = { at: Date.now() };
  for (let i = 0; i < SHARDS; i++) {
    const r = await send('GET', `/${account}/kv-${cluster}-${i}/storage`);
    row[`s${i}`] =
      r.status === 200
        ? {
            name: at(r.body, 'name', 'bytes'),
            data: at(r.body, 'data', 'bytes'),
            log_rows: at(r.body, 'data', 'log_rows'),
          }
        : r.status;
  }
  storage.push(row);
};
const attempt = async (client: number, key: string, once: string, value: string, kind: Kind): Promise<Sent> => {
  const trace = hex(16),
    sent = Date.now(),
    h: Sent = { client, kind, key, once, value, trace, sent, got: sent, status: null };
  try {
    const r = await send('PUT', `/kv/${account}/${cluster}/k/${key}?op=${once}`, value, {
      headers: { traceparent: `00-${trace}-${hex(8)}-01` },
    });
    Object.assign(h, { status: r.status === 0 ? null : r.status, body: r.body, version: at(r.body, 'version') });
    // the server's clock from its Date header (1 s resolution), only from quick answers: a request that spans a
    // pause of the box (R-CLIENT-2) gives a midpoint that is not when the server answered (run of 18:10 ET)
    const date = r.headers['date'];
    if (date !== undefined && date !== '' && Date.now() - h.sent < 2000)
      offsets.push(Date.parse(date) + 500 - (h.sent + Date.now()) / 2);
  } catch (e) {
    Object.assign(h, { status: null, error: messageOf(e) });
  }
  h.got = Date.now();
  history.push(h);
  return h;
};
/** A fresh write, kept so it can be sent again. */
type Fresh = { t: number; key: string; once: string; value: string };
const fresh: Fresh[] = [];
/** A fresh write sent between lo and hi ms ago, if there is one. */
const pick = (now: number, lo: number, hi: number): Fresh | undefined => {
  const c = fresh.filter(f => now - f.t >= lo && now - f.t < hi);
  return c[Math.floor(Math.random() * c.length)];
};
const resend = async (client: number, f: Fresh | undefined, kind: Kind): Promise<void> => {
  if (f) await attempt(client, f.key, f.once, f.value, kind);
};
/** One step of a client: mostly a fresh write, else a resend of an earlier one, or an op id that must be refused. */
const stepOf = async (client: number): Promise<void> => {
  const r = Math.random(),
    key = `k${Math.floor(Math.random() * KEYS)}`,
    now = Date.now();
  if (r < 0.55) {
    const once = `${now}_c${client}-${++n}`,
      h = await attempt(client, key, once, `v${n}`, 'fresh');
    fresh.push({ t: now, key, once, value: h.value });
  } else if (r < 0.7) await resend(client, pick(now, 0, W - 4000), 'resend-in-window');
  else if (r < 0.8) await resend(client, pick(now, W - 2000, W + S + 2000), 'resend-at-edge');
  else if (r < 0.92) await resend(client, pick(now, W + S + 4000, Infinity), 'resend-expired');
  else if (r < 0.96) await attempt(client, key, `c${client}-untimed-${++n}`, 'u', 'untimed');
  else await attempt(client, key, `${now + S + 60000}_c${client}-${++n}`, 'f', 'future');
};
const worker = async (client: number): Promise<void> => {
  while (Date.now() < end) {
    await stepOf(client);
    await sleep(100 + Math.random() * 200);
  }
};
const sampling = async (): Promise<void> => {
  while (Date.now() < end) {
    await sample();
    await sleep(60000);
  }
};
await Promise.all([sampling(), ...Array.from({ length: CLIENTS }, (_, client) => worker(client))]);
await sample();

const final: Record<string, number> = {};
for (let k = 0; k < KEYS; k++) {
  const r = await send('GET', `/kv/${account}/${cluster}/k/k${k}`),
    missing = r.status === 404 ? 0 : Number.NaN;
  final[`k${k}`] = r.status === 200 ? Number(at(r.body, 'version')) : missing;
}
const skew = offsets.length > 0 ? Math.max(...offsets.map(Math.abs)) : null,
  tolerance = Math.max(1000, Math.ceil((skew ?? 0) + 1000));
// an attempt that spans a pause of the box has sent/got times that do not bound when the shard saw it: not judged
const jumps = clientStats.clock_jumps.map(j => ({
  from: Date.parse(j.at) - j.wall_ms - 2000,
  to: Date.parse(j.at) + 2000,
}));
const judged = history.filter(h => !jumps.some(j => h.sent < j.to && h.got > j.from));
const result = check(judged, { window: W, skew: S, tolerance }),
  fin = checkFinal(history, final);
// traces: the 25 oldest and the 25 newest fresh writes
const writes = history.filter(h => h.kind === 'fresh' && typeof h.status === 'number'),
  sampled = [...writes.slice(0, 25), ...writes.slice(-25)],
  traces: (Traced & { status: number })[] = [];
for (const h of sampled) {
  const r = await send('GET', `/kv/${account}/${cluster}/traces/${h.trace}?key=${h.key}&format=json`);
  traces.push({
    op: { trace: h.trace, sent: h.sent },
    status: r.status,
    found: list(at(r.body, 'requests')).length > 0,
    pruned_before: numOrNull(at(r.body, 'pruned_before')),
  });
}
const tr = checkTraces(traces, { tolerance });
const kinds = Object.fromEntries(
  [...Map.groupBy(history, h => h.kind)].map(([k, v]) => [k, counted(v.map(h => String(h.status)))]),
);
const summary = {
  account,
  minutes,
  window_ms: W,
  skew_ms: S,
  trace_keep: KEEP,
  attempts: history.length,
  judged: judged.length,
  kinds,
  tolerance,
  clock_offset_max_ms: skew,
  valid: result.valid && fin.valid && tr.valid,
  anomalies: [...result.anomalies, ...fin.anomalies, ...tr.anomalies].map(a => a.type),
  traces: {
    sampled: traces.length,
    found: traces.filter(t => t.found).length,
    pruned: traces.filter(t => !t.found).length,
  },
  storage_first: storage[0],
  storage_last: storage.at(-1),
  client: { clock_jumps: clientStats.clock_jumps.splice(0), runner_retries: clientStats.runner_retries },
};
writeFileSync(
  `${out}/${account}.json`,
  JSON.stringify({ ...summary, final, storage, result, final_check: fin, trace_check: tr, traces, history }, null, 1),
);
console.log(JSON.stringify(summary));
await removeAccounts(need('base'), [account]);
process.exit(summary.valid ? 0 : 1);
