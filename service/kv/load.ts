// node service/kv/load.ts --base https://tape.ivar.workers.dev --token-file <path> --account kvload --cluster s4
//   --shards 4 [--concurrency 64] [--seconds 20] [--keys 10000] [--value 128] [--op put|get] [--warmup 3] [--procs 1]
// A closed-loop load test of one KV cluster: `concurrency` workers, each sending one request at a time for
// `seconds`, on keys chosen uniformly from `keys` (k0..k{keys-1}), values of `value` bytes. The cluster is created
// first (or found, if it exists with the same size). The first `warmup` seconds are not counted. Prints one JSON
// line: requests counted, throughput, latency percentiles, status counts, and requests per shard. The token is
// read from the file and sent only in the authorization header; it is never printed. --procs N forks N client
// processes with `concurrency` workers each (one Node process tops out near one core), and merges every latency.
// shard_call_ms is the router's own measure of the shard call (its server-timing header), so client latency minus
// it is the network, TLS and the router.
import { fork } from 'node:child_process';
import { Agent, fetch as undiciFetch } from 'undici';
import { flag, has, need, tokenFromFile } from '../jepsen/cli.ts';
import { fields, list, num } from '../jepsen/json.ts';

const base = need('base'),
  token = tokenFromFile(),
  account = flag('account') ?? 'kvload',
  cluster = need('cluster');
const shards = Number(need('shards')),
  concurrency = Number(flag('concurrency') ?? 64),
  seconds = Number(flag('seconds') ?? 20),
  keys = Number(flag('keys') ?? 10000);
const size = Number(flag('value') ?? 128),
  op = flag('op') ?? 'put',
  warmup = Number(flag('warmup') ?? 3),
  procs = Number(flag('procs') ?? 1),
  child = has('child');
const dispatcher = new Agent({ connections: concurrency * 2, pipelining: 1, keepAliveTimeout: 30000 });
const headers = { authorization: `Bearer ${token}` };

if (!child) {
  const made = await undiciFetch(`${base}/kv/${account}/${cluster}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ shards }),
    dispatcher,
  });
  if (made.status !== 201 && made.status !== 200) {
    console.error(made.status, await made.text());
    process.exit(1);
  }
  await made.arrayBuffer();
}

type Counts = Record<string, number>;
/** What one process measured: each counted request's latency, the shard call's, and counts. */
type Measured = { lat: number[]; shardMs: number[]; statuses: Counts; perShard: Counts; errors: Counts; n: number };
const count = (counts: Counts, key: string, by = 1): void => {
  counts[key] = (counts[key] ?? 0) + by;
};
// errors: distinct 5xx bodies, counted
const mine: Measured = { lat: [], shardMs: [], statuses: {}, perShard: {}, errors: {}, n: 0 };
const value = 'v'.repeat(size);
const t0 = performance.now(),
  countFrom = t0 + warmup * 1000,
  stop = countFrom + seconds * 1000;
/** Why a request threw: the connection's error code, or the error's name. */
const failure = (e: unknown): string => {
  const code = fields(fields(e)['cause'])['code'];
  return `error:${typeof code === 'string' ? code : e instanceof Error ? e.name : 'unknown'}`;
};
/** One request; its status, or why it failed. Counts what it learns from the answer when `counted`. */
const once = async (w: number, seq: number, counted: boolean): Promise<string> => {
  const key = `k${Math.trunc(Math.random() * keys)}`;
  // an unconditional PUT names its operation (428 without): one op id per request
  const res = await undiciFetch(
    `${base}/kv/${account}/${cluster}/k/${key}${op === 'put' ? `?op=${Date.now()}_l${w}-${seq}` : ''}`,
    {
      ...(op === 'put' ? { method: 'PUT', body: value } : {}),
      headers,
      signal: AbortSignal.timeout(10000),
      dispatcher,
    },
  );
  const body = await res.text();
  if (res.status >= 500) {
    const k = body.replaceAll(/[0-9a-f-]{36}/g, '<id>').slice(0, 240);
    if (k in mine.errors || Object.keys(mine.errors).length < 8) count(mine.errors, k);
  }
  if (counted) {
    const shard = res.headers.get('kv-shard'),
      took = /dur=(\d+)/.exec(res.headers.get('server-timing') ?? '')?.[1];
    if (shard !== null && shard !== '') count(mine.perShard, shard);
    if (took !== undefined) mine.shardMs.push(Number(took));
  }
  return String(res.status);
};
const worker = async (w: number): Promise<void> => {
  for (let seq = 0; performance.now() < stop; seq++) {
    const began = performance.now();
    const status = await once(w, seq, began >= countFrom).catch(failure);
    const end = performance.now();
    if (began >= countFrom && end <= stop) {
      mine.lat.push(end - began);
      count(mine.statuses, status);
      mine.n++;
    }
  }
};
const counts = (v: unknown): Counts => Object.fromEntries(Object.entries(fields(v)).map(([k, n]) => [k, num(n)]));
const measuredOf = (v: unknown): Measured => {
  const m = fields(v);
  return {
    lat: list(m['lat']).map(num),
    shardMs: list(m['shardMs']).map(num),
    statuses: counts(m['statuses']),
    perShard: counts(m['perShard']),
    errors: counts(m['errors']),
    n: num(m['n']),
  };
};
/** One more client process with its own workers; what it measured. */
const forked = (): Promise<Measured> =>
  new Promise((done, fail) => {
    const c = fork(new URL(import.meta.url).pathname, [...process.argv.slice(2), '--child'], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    c.on('message', message => {
      done(measuredOf(message));
    });
    c.on('error', fail);
  });
const merge = (into: Measured, p: Measured): void => {
  into.lat.push(...p.lat);
  into.shardMs.push(...p.shardMs);
  for (const [k, v] of Object.entries(p.statuses)) count(into.statuses, k, v);
  for (const [k, v] of Object.entries(p.perShard)) count(into.perShard, k, v);
  for (const [k, v] of Object.entries(p.errors)) count(into.errors, k, v);
  into.n += p.n;
};
if (procs > 1 && !child) {
  // the children start together; each runs its own clock for warmup + seconds
  for (const p of await Promise.all(Array.from({ length: procs }, forked))) merge(mine, p);
} else await Promise.all(Array.from({ length: concurrency }, (_, w) => worker(w)));
if (child) {
  process.send?.(mine, () => process.exit(0));
  await new Promise(() => {});
}
const lat = mine.lat.toSorted((a, b) => a - b),
  shardMs = mine.shardMs.toSorted((a, b) => a - b),
  { statuses } = mine;
const sq = (p: number): number | null => shardMs[Math.min(shardMs.length - 1, Math.floor(p * shardMs.length))] ?? null;
const q = (p: number): number =>
  Number((lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] ?? Number.NaN).toFixed(1));
/** The shard in a kv-shard header's value, "3/8". */
const shardOf = (header: string): number => Number(header.split('/')[0]);
const ok = (statuses['200'] ?? 0) + (statuses['201'] ?? 0) + (op === 'get' ? (statuses['404'] ?? 0) : 0);
console.log(
  JSON.stringify({
    cluster,
    shards,
    op,
    procs,
    concurrency: concurrency * procs,
    seconds,
    value_bytes: size,
    requests: mine.n,
    ok,
    ops_per_s: Number((ok / seconds).toFixed(1)),
    p50_ms: q(0.5),
    p90_ms: q(0.9),
    p99_ms: q(0.99),
    max_ms: Number((lat.at(-1) ?? Number.NaN).toFixed(1)),
    shard_call_ms: { p50: sq(0.5), p90: sq(0.9), p99: sq(0.99) },
    statuses,
    errors: mine.errors,
    per_shard: Object.fromEntries(Object.entries(mine.perShard).toSorted(([a], [b]) => shardOf(a) - shardOf(b))),
  }),
);
