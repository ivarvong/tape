// faults.ts: fault injection on the call path, for the Jepsen-style harness in service/jepsen. Only an account
// whose name starts with "jepsen-" can have faults, and only while a plan is set for it (PUT /_faults/:account).
// Every other account's calls take the plain path and never read a plan (see Calls in index.ts).
//
// A plan is { seed, p: { <kind>: probability }, tail: [lo, hi] }. Each call is a site: caller, callee, method and
// key ("fulfill>payments.charge#jepsen-a/fulfill/charge/7"). The n-th call at a site, under one seed, always
// draws the same fault, whatever else runs at the same time: the faults are a function of (seed, site, n).
//
//   delay                 wait before sending, log-uniform in tail ms: the long tail of a slow network or object
//   slow_reply            the same wait after the callee answered, before the reply reaches the caller
//   race                  send, then hold the reply until within ±3 ms of the caller's budget: who wins is a race
//   drop                  send; the callee runs and commits; the reply is never delivered (the caller times out)
//   lost                  send; the callee commits; the caller gets an exception instead of the reply
//   overload              an exception before sending: nothing ran (a transient error, an overloaded object)
//   reset_callee_before   the callee's Durable Object is reset before it runs the call
//   reset_callee_after    the callee runs and commits, then its object is reset before it replies
//   reset_caller          the callee runs, then the caller's object is reset while it waits for the reply
//   reset_caller_first    the caller's object is reset as its call goes out, then the call is sent anyway: if
//                         the writes before a call were not yet durable, they are lost while the callee runs
//   storage_error         (KV router -> shard) the shard's transaction fails as it commits, after every statement
//                         ran: SQLite rolls it back, and the shard answers 500 {"applied": false}
//                         (a call between programs: the callee's transaction fails at commit, and the call is refused)
//   reset_callee_opened   the callee's object is reset after it opened its record of the call, before the run
//                         (a call from a router only: a call between programs opens no record before its run)
//   reset_callee_ran      the callee ran and committed, then its object is reset before it recorded the run (a
//                         router's call: before the supervisor's record of the call is completed; a call between
//                         programs: before the callee's _tape_served row that joins it to the caller's trace)
//   trace_store_error     (a router's call only) the router's record of the request cannot be stored with the
//                         object it called: every attempt fails, and the response says tape-trace-complete: false
//   lookup_error          (the KV router only) the cluster lookup fails, before any shard is called
// Kinds are only ever appended: a seed draws the same fault for the kinds it had.
//
// The seams, by hop (jepsen/seams.ts injects at each one, at each position, one fault per run):
//   router   a router (KV, or a program's /v/ route, with plan.router) calling the object it routes to: overload,
//            delay, reset_callee_before, reset_callee_opened, storage_error, reset_callee_ran, reset_callee_after,
//            lost, drop, slow_reply, trace_store_error, and lookup_error (KV)
//   call     a program calling another: overload, delay, reset_callee_before, storage_error, reset_callee_ran,
//            reset_callee_after, lost, drop, slow_reply, race, reset_caller, reset_caller_first
// A kind that has no meaning at a hop is not injected there; it is logged as ignored.
//
// A plan may instead name the faults, one per position: { points: [{ hop, n, kind }] } gives the n-th call (from 0)
// at that hop, counted from when the plan was set, exactly that fault, and every other call none.
export const FAULTY = /^jepsen-/;
export const KINDS = [
  'delay',
  'slow_reply',
  'race',
  'drop',
  'lost',
  'overload',
  'reset_callee_before',
  'reset_callee_after',
  'reset_caller',
  'reset_caller_first',
  'storage_error',
  'reset_callee_opened',
  'reset_callee_ran',
  'trace_store_error',
  'lookup_error',
] as const;
export type Kind = (typeof KINDS)[number];
export type Hop = 'router' | 'call';
/** The fault one call draws: its kind, and the wait that kind takes. */
export type Fault = { kind: Kind; ms: number };
/** A plan: probabilities per kind under a seed, or the faults named one per position. */
export type Plan = {
  seed?: number | string;
  p?: Partial<Record<Kind, number>>;
  tail?: readonly [number, number];
  router?: boolean;
  points?: readonly { hop: Hop; n: number; kind: Kind; ms?: number }[];
};
export const HOP_KINDS: Readonly<Record<Hop, readonly Kind[]>> = {
  router: [
    'overload',
    'delay',
    'reset_callee_before',
    'reset_callee_opened',
    'storage_error',
    'reset_callee_ran',
    'reset_callee_after',
    'lost',
    'drop',
    'slow_reply',
    'trace_store_error',
    'lookup_error',
  ],
  call: [
    'overload',
    'delay',
    'reset_callee_before',
    'storage_error',
    'reset_callee_ran',
    'reset_callee_after',
    'lost',
    'drop',
    'slow_reply',
    'race',
    'reset_caller',
    'reset_caller_first',
  ],
};
export const hopOf = (site: string): Hop => (/^(kv|router)>/.test(site) ? 'router' : 'call');

// xmur3 then mulberry32: a few uniform numbers from a string
const seeded = (text: string): (() => number) => {
  let h = 1779033703 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    // oxlint-disable-next-line unicorn/prefer-code-point -- the hash is over UTF-16 units: a seed draws the same faults as before
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = (h ^ (h >>> 16)) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// The fault for the n-th call at a site (at = the n-th at its hop, for a plan of points), or null.
const pointWait = (kind: Kind, withinMs: number): number => {
  if (kind === 'drop') return withinMs + 250;
  return kind === 'race' ? Math.max(0, withinMs - 1) : 30;
};
// The fault for the n-th call at a site (at = the n-th at its hop, for a plan of points), or null.
export function decide(
  plan: Plan | null | undefined,
  site: string,
  n: number,
  withinMs?: number | null,
  at: number | null = null,
): Fault | null {
  const within = withinMs ?? 0;
  if (plan?.points) {
    const hop = hopOf(site),
      point = plan.points.find(x => x.hop === hop && x.n === at);
    return point ? { kind: point.kind, ms: point.ms ?? pointWait(point.kind, within) } : null;
  }
  if (!plan?.p) return null;
  const r = seeded(`${plan.seed}|${site}|${n}`),
    u = r(),
    [lo, hi] = plan.tail ?? [50, 1500];
  let acc = 0;
  for (const kind of KINDS) {
    acc += plan.p[kind] ?? 0;
    if (u >= acc) continue;
    const ms = Math.round(lo * (hi / lo) ** r());
    if (kind === 'race') return { kind, ms: Math.max(0, Math.round(within - 3 + 6 * r())) };
    return { kind, ms: kind === 'drop' ? within + 250 : ms };
  }
  return null;
}

const sleep = (ms: number): Promise<void> =>
  new Promise(done => {
    setTimeout(done, ms);
  });
export class Injected extends Error {}

// One call through a fault: send is () => the callee's reply; resetCaller resets the caller's object.
export async function through<T>(
  fault: Fault | null | undefined,
  send: () => T | Promise<T>,
  resetCaller: () => Promise<unknown>,
): Promise<T> {
  if (!fault) return send();
  const { kind, ms } = fault,
    began = Date.now();
  if (kind === 'overload') throw new Injected('jepsen: overloaded, nothing was sent');
  if (kind === 'reset_caller_first') {
    try {
      await resetCaller();
    } catch {
      // the reset is the fault: the call is sent whether or not it reports back
    }
  }
  if (kind === 'delay') await sleep(ms);
  const reply = await send();
  if (kind === 'slow_reply') await sleep(ms);
  if (kind === 'race') await sleep(Math.max(0, began + ms - Date.now()));
  if (kind === 'drop') {
    await sleep(ms);
    throw new Injected('jepsen: the reply was dropped');
  }
  if (kind === 'lost') throw new Injected('jepsen: the connection was lost after the callee answered');
  if (kind === 'reset_caller') await resetCaller();
  return reply;
}

const isKind = (v: unknown): v is Kind => KINDS.some(k => k === v);
const pointOf = (v: unknown): NonNullable<Plan['points']>[number][] => {
  if (typeof v !== 'object' || v === null) return [];
  const { hop, n, kind, ms }: { hop?: unknown; n?: unknown; kind?: unknown; ms?: unknown } = v;
  if ((hop !== 'router' && hop !== 'call') || typeof n !== 'number' || !isKind(kind)) return [];
  return [{ hop, n, kind, ...(typeof ms === 'number' ? { ms } : {}) }];
};
const chancesOf = (v: unknown): Partial<Record<Kind, number>> => {
  const given: Record<string, unknown> = typeof v === 'object' && v !== null ? { ...v } : {};
  return Object.fromEntries(KINDS.flatMap(k => (typeof given[k] === 'number' ? [[k, given[k]]] : [])));
};
/** A plan as it was sent or stored (JSON): what of it is a plan. */
export const planOf = (v: unknown): Plan | null => {
  if (typeof v !== 'object' || v === null) return null;
  const {
    seed,
    p,
    tail,
    router,
    points,
  }: { seed?: unknown; p?: unknown; tail?: unknown; router?: unknown; points?: unknown } = v;
  const range: unknown[] = Array.isArray(tail) ? tail : [],
    [lo, hi] = range;
  return {
    ...(typeof seed === 'number' || typeof seed === 'string' ? { seed } : {}),
    ...(typeof p === 'object' && p !== null ? { p: chancesOf(p) } : {}),
    ...(typeof lo === 'number' && typeof hi === 'number' ? { tail: [lo, hi] } : {}),
    ...(router === true ? { router } : {}),
    ...(Array.isArray(points) ? { points: points.flatMap(pointOf) } : {}),
  };
};
