// A model of the KV write protocol of RUNTIME-SPEC sections 2 and 6 and examples/kv.tape: clients that send one
// unconditional write each under an op id <t>_<id>, time out and resend it under the same id; a network that
// delays, reorders and loses requests and replies; a shard that runs each request atomically (op-id lookup, write,
// key_ops record and prune in one transaction), whose commit can fail (503, rolled back) and whose object can be
// reset before the run or after the commit; a shard clock that may lag true time by up to S (a step back); the op
// window W (R-RET-2) and the prune of R-RET-3.
//
// Bugs are flags, each the mechanism of a defect the service once had (its id in docs/defects.md):
//   r7       no op-id lookup: a resend is a second write (R7)
//   h1       a reset after the run opened does not stop it: it commits later on the state it read (H1)
//   early    the prune cutoff is now + 1, ignoring the window (plant A, 15 November 2026)
//   noWindow no window check: an op of any age runs (plant B)
//   noSkew   the prune cutoff is now - W, without the clock allowance S
// Invariants: each op id commits at most once (R-RET-4, "exactly once"); a 2xx answer carries the version its op
// committed at; versions only grow by one per commit.
import type { Step } from './explore.ts';

export type Bounds = { clients: number; retries: number; T: number; W: number; S: number };
export type Flags = { r7?: boolean; h1?: boolean; early?: boolean; noWindow?: boolean; noSkew?: boolean };
/** An op id the shard has a record of: the client, the version it committed at, its time. */
type OpRow = [client: number, version: number, t: number];
/** A client: idle, waiting, unknown outcome or done; the time in its op id; how often it has sent. */
type Client = [state: 'i' | 'w' | 'u' | 'd', t: number, tries: number];
/** In the network: a request (q) with its op id's time, or a reply (r) with its status and version. */
type Message = ['q', client: number, t: number] | ['r', client: number, status: number, version: number];
export type State = {
  /** true time */
  n: number;
  /** the key's version */
  v: number;
  ops: OpRow[];
  /** per client: how often its op committed, and at which version */
  ap: [commits: number, version: number][];
  c: Client[];
  net: Message[];
  /** runs a reset did not stop (h1): the client and the version each read */
  run: [client: number, read: number][];
  /** the first invariant broken, if any */
  x: string | null;
};
export type Outcome = 'ok' | 'fail' | 'reset_before' | 'reset_after' | 'reset_opened';
export type Reply = [status: number, version: number] | null;
export const DEFAULTS: Bounds = { clients: 2, retries: 2, T: 4, W: 2, S: 1 };

// The window rule (R-RET-2) and the prune cutoff (R-RET-3), shared with the trace conformance check.
export const windowAnswer = (t: number, cc: number, W: number, S: number, flags?: Flags): 410 | 400 | null => {
  if (flags?.noWindow !== true && t < cc - W) return 410;
  return t > cc + S ? 400 : null;
};
export const pruneCutoff = (cc: number, W: number, S: number, flags?: Flags): number => {
  if (flags?.early === true) return cc + 1;
  return flags?.noSkew === true ? cc - W : cc - W - S;
};

export const init = (b: Bounds = DEFAULTS): State => ({
  n: 0,
  v: 0,
  ops: [],
  ap: Array.from({ length: b.clients }, (): [number, number] => [0, 0]),
  c: Array.from({ length: b.clients }, (): Client => ['i', -1, 0]),
  net: [],
  run: [],
  x: null,
});
/** The network in one order whatever order its messages were added in, so equal states are equal JSON. */
const sorted = (net: readonly Message[]): Message[] =>
  net.toSorted((a, b) => {
    const [x, y] = [JSON.stringify(a), JSON.stringify(b)];
    if (x === y) return 0;
    return x < y ? -1 : 1;
  });
const message = (m: Message): Message => (m[0] === 'q' ? ['q', m[1], m[2]] : ['r', m[1], m[2], m[3]]);
const clone = (s: State): State => ({
  n: s.n,
  v: s.v,
  ops: s.ops.map((r): OpRow => [...r]),
  ap: s.ap.map((a): [number, number] => [...a]),
  c: s.c.map((c): Client => [...c]),
  net: s.net.map(message),
  run: s.run.map((r): [number, number] => [...r]),
  x: s.x,
});
/** A client of the state, to change in place. */
const clientOf = (s: State, i: number): Client => {
  const c = s.c[i];
  if (c === undefined) throw new Error(`the model has no client ${i}`);
  return c;
};

function commit(s: State, client: number, version: number, t: number, cc: number, flags: Flags, b: Bounds): void {
  if (version !== s.v + 1) s.x ??= 'version-not-next';
  s.v = version;
  const cutoff = pruneCutoff(cc, b.W, b.S, flags);
  s.ops = [...s.ops.filter(r => r[0] !== client), [client, version, t] satisfies OpRow]
    .filter(r => r[2] >= cutoff)
    .toSorted((p, q) => p[0] - q[0]);
  const commits = (s.ap[client]?.[0] ?? 0) + 1;
  s.ap[client] = [commits, version];
  if (commits > 1) s.x ??= 'op-committed-twice';
}
// One request handled by the shard at shard clock cc, with outcome o: 'ok' (runs and replies), 'fail' (the commit
// fails: rolled back, 503), 'reset_before' (no run, no reply), 'reset_after' (runs and commits, no reply), or
// 'reset_opened' (stopped after the run opened: nothing commits; under h1 the run goes on). Returns the new state
// and the reply ([status, version] or null). Shared with the trace conformance check (conformance.ts).
export function shard(
  from: State,
  client: number,
  t: number,
  cc: number,
  o: Outcome,
  flags: Flags,
  b: Bounds,
): { s: State; reply: Reply } {
  const s = clone(from);
  if (o === 'reset_before') return { s, reply: null };
  const refused = windowAnswer(t, cc, b.W, b.S, flags);
  if (refused !== null) return { s, reply: o === 'reset_after' ? null : [refused, 0] };
  const known = s.ops.find(r => r[0] === client);
  if (known && flags.r7 !== true)
    return { s, reply: o === 'reset_after' || o === 'reset_opened' ? null : [200, known[1]] };
  if (o === 'fail') return { s, reply: [503, 0] };
  if (o === 'reset_opened') {
    if (flags.h1 === true) s.run.push([client, s.v]);
    return { s, reply: null };
  }
  commit(s, client, s.v + 1, t, cc, flags, b);
  return { s, reply: o === 'reset_after' ? null : [201, s.v] };
}

const OUTCOMES: readonly Outcome[] = ['ok', 'fail', 'reset_before', 'reset_after', 'reset_opened'];
/** What the clients can do: send (the first time, or again after an unknown outcome, under the same op id), or time out. */
const clientSteps = (s: State, b: Bounds): Step<State>[] =>
  s.c.flatMap(([st, t0, tries], i): Step<State>[] => {
    const out: Step<State>[] = [];
    if (st === 'i' || (st === 'u' && tries <= b.retries)) {
      const t = clone(s);
      const tt = st === 'i' ? s.n : t0;
      t.c[i] = ['w', tt, tries + 1];
      t.net = sorted([...t.net, ['q', i, tt]]);
      out.push([`send c${i} t=${tt}`, t]);
    }
    if (st === 'w') {
      const t = clone(s);
      clientOf(t, i)[0] = 'u';
      out.push([`timeout c${i}`, t]);
    }
    return out;
  });
/** A request reaching the shard: at each clock the lag allows, with each outcome. */
const shardSteps = (s: State, rest: Message[], client: number, sent: number, flags: Flags, b: Bounds): Step<State>[] =>
  Array.from({ length: b.S + 1 }, (_, d) => d).flatMap(d =>
    OUTCOMES.map((o): Step<State> => {
      const { s: t, reply } = shard({ ...s, net: rest }, client, sent, s.n - d, o, flags, b);
      if (reply) t.net = sorted([...t.net, ['r', client, ...reply]]);
      const answered = reply ? ` -> ${reply[0]} v${reply[1]}` : '';
      return [`shard c${client} t=${sent} clock=${s.n - d} ${o}${answered}`, t];
    }),
  );
/** A reply reaching its client. */
const receive = (s: State, rest: Message[], i: number, status: number, version: number): Step<State> => {
  const t = clone(s);
  t.net = rest.map(message);
  if (status >= 200 && status < 300 && version !== s.ap[i]?.[1]) t.x = 'reply-not-its-commit';
  const c = clientOf(t, i);
  if (c[0] === 'w') c[0] = status === 503 ? 'u' : 'd';
  return [`receive c${i} ${status} v${version}`, t];
};
/** What can happen to each message in the network: it is lost, or it arrives. */
const networkSteps = (s: State, flags: Flags, b: Bounds): Step<State>[] =>
  s.net.flatMap((m, k): Step<State>[] => {
    const rest = s.net.filter((_, j) => j !== k);
    const lost = clone(s);
    lost.net = rest.map(message);
    const arrived = m[0] === 'q' ? shardSteps(s, rest, m[1], m[2], flags, b) : [receive(s, rest, m[1], m[2], m[3])];
    return [[`lose ${JSON.stringify(m)}`, lost], ...arrived];
  });
/** A run a reset did not stop commits on the state it read. */
const staleSteps = (s: State, flags: Flags, b: Bounds): Step<State>[] =>
  s.run.map(([i, snap], k): Step<State> => {
    const t = clone(s);
    t.run = t.run.filter((_, j) => j !== k);
    commit(t, i, snap + 1, clientOf(t, i)[1], s.n, flags, b);
    return [`stale run of c${i} commits v${snap + 1}`, t];
  });
export function actions(s: State, flags: Flags = {}, b: Bounds = DEFAULTS): Step<State>[] {
  if (s.x !== null) return [];
  const tick = clone(s);
  tick.n++;
  return [
    ...(s.n < b.T ? [['tick', tick] satisfies Step<State>] : []),
    ...clientSteps(s, b),
    ...networkSteps(s, flags, b),
    ...staleSteps(s, flags, b),
  ];
}
export const invariants: Readonly<Record<string, (s: State) => boolean>> = {
  'exactly-once': s => s.x !== 'op-committed-twice',
  'reply-is-its-commit': s => s.x !== 'reply-not-its-commit',
  'versions-grow-by-one': s => s.x !== 'version-not-next',
};
