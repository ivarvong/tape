// harness.ts: a Jepsen-style test of Tape's calls and workflows. No runtime imports: vitest (in workerd) and
// jepsen/run.ts (Node, against production) both drive it, each with its own `send`.
//
//   1. setup:  upload the programs, scaled up (more stock, money and seats) so most operations do real work,
//              into one fresh account named jepsen-*; set the fault plan (faults.ts) for it.
//   2. load:   `clients` concurrent clients, each doing `ops` operations chosen by a seeded generator: start
//              orders with short or long budgets, advance them (often twice at once: a retry racing the
//              original), read them; buy tickets, retry sales (also racing), read sales. Every order and
//              purchase carries a client key, and about one in five is sent twice with it (at once or after
//              the first answer): a client that got no answer, retrying. Every operation is recorded as an
//              invocation and a completion (or `info`: no answer, outcome unknown).
//   3. heal:   faults off; advance every order and retry every pending sale until it is finished.
//   4. final:  read every order and sale, the stock, the cards, the labels, the seats.
//   5. check:  see check() below.
//   6. traces: every operation carried its own traceparent; fetch each one's trace by id and check it
//              (checkTraces below, and traces.ts).
//
// send(method, path, body, { headers }) -> { status, body, headers } (body parsed as JSON when it is), or throws.
// Paths are under the account: "/fulfill/v/1/orders".
import type { Reply, Sender } from './client.ts';
import { at, fields, list, messageOf, num, text } from './json.ts';
import type { Fields } from './json.ts';
import { clientSpan, spans as spansOf, tree, nesting, missingEvents } from './traces.ts';
import type { Anomaly, Span } from './traces.ts';

export type { Sender };
// a seeded generator (mulberry32)
export const rng = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
/** One of a list that is not empty, by the generator. */
const pick = <T>(r: () => number, xs: readonly [T, ...T[]]): T => xs[Math.floor(r() * xs.length)] ?? xs[0];
const sleep = (ms: number): Promise<void> =>
  new Promise(done => {
    setTimeout(done, ms);
  });

// What each program starts with, after scaling, and the edits that scale it.
export const INIT = {
  stock: { lamp: { price: 40, remaining: 400 }, desk: { price: 150, remaining: 60 } },
  cards: { 'ann-4242': 1000000, 'bob-0001': 900 },
  seats: { floor: { price: 120, seats: 40 }, balcony: { price: 45, seats: 400 } },
};
export type Sources = Readonly<Record<'inventory' | 'payments' | 'tickets' | 'shipping' | 'fulfillment', string>>;
export const scaled: Readonly<Record<keyof Sources, (s: string) => string>> = {
  inventory: s => s.replace("('lamp', 40, 5), ('desk', 150, 2)", "('lamp', 40, 400), ('desk', 150, 60)"),
  payments: s => s.replace("('ann-4242', 300), ('bob-0001', 50)", "('ann-4242', 1000000), ('bob-0001', 900)"),
  tickets: s => s.replace("('floor', 120, 3), ('balcony', 45, 10)", "('floor', 120, 40), ('balcony', 45, 400)"),
  shipping: s => s,
  fulfillment: s => s,
};

// The fault plan a run uses unless it is given one: about 30% of calls get a fault.
// router: true puts the program's router hop (a client's request to /v/) under the plan as well; the kinds that
// have no meaning at a hop are not injected there (src/faults.ts HOP_KINDS).
export const PLAN: Readonly<Record<string, number>> = {
  delay: 0.06,
  slow_reply: 0.04,
  race: 0.05,
  drop: 0.03,
  lost: 0.03,
  overload: 0.03,
  reset_callee_before: 0.02,
  reset_callee_opened: 0.01,
  reset_callee_ran: 0.02,
  reset_callee_after: 0.03,
  reset_caller: 0.02,
  reset_caller_first: 0.02,
  storage_error: 0.02,
  trace_store_error: 0.01,
};
// The one config every seed runs with, locally (test/jepsen.test.ts) and against the deployed service (run.ts).
export const CONFIG = { clients: 6, ops: 20, plan: PLAN, router: true, tail: [20, 400] };

const PROGRAMS: readonly (readonly [string, keyof Sources])[] = [
  ['inventory', 'inventory'],
  ['payments', 'payments'],
  ['shipping', 'shipping'],
  ['fulfill', 'fulfillment'],
  ['tickets', 'tickets'],
];
export type Setup = {
  seed: number;
  plan?: Readonly<Record<string, number>> | null;
  tail?: readonly number[];
  router?: boolean;
};
export async function setup(
  send: Sender,
  sources: Sources,
  { seed, plan = PLAN, tail = [20, 400], router = true }: Setup,
): Promise<Reply> {
  for (const [name, key] of PROGRAMS) {
    const res = await send('POST', `/${name}`, scaled[key](sources[key]));
    if (res.status !== 201) throw new Error(`upload ${name}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return send('PUT', '/~faults', plan ? { seed, p: plan, tail, router } : null);
}

// ---- load
/** One entry of a history: an operation invoked, or how it completed (`info`: no answer, the outcome unknown). */
export type Entry = {
  i: number;
  proc: number;
  type: 'invoke' | 'ok' | 'info';
  f: string;
  method?: string;
  path: string;
  body?: unknown;
  t: number;
  mono: number;
  trace?: string;
  span?: string;
  status?: number;
  value?: unknown;
  error?: string;
  trace_complete?: string | null;
  trace_lost?: string | null;
  /** what the operation was about: the id it named, the order or sale it asked for */
  id?: number;
  order?: Fields;
  [more: string]: unknown;
};
export type History = Entry[];
export type Record1 = (
  proc: number,
  f: string,
  method: string,
  path: string,
  body?: unknown,
  extra?: Fields,
) => Promise<Reply | null>;
const completed = (res: Reply): Pick<Entry, 'type' | 'status' | 'value' | 'trace_complete' | 'trace_lost'> => {
  const complete = res.headers['tape-trace-complete'] ?? null;
  return {
    type: res.status === 0 || (res.status >= 500 && typeof res.body !== 'object') ? 'info' : 'ok',
    status: res.status,
    value: res.body,
    trace_complete: complete,
    ...(complete === 'false' ? { trace_lost: res.headers['tape-trace-lost'] ?? null } : {}),
  };
};
// One operation, recorded in history as an invocation and a completion (or info: no answer). counter: { next }, the
// operation ids; t0: the run's start. seams.ts records its scripted operations with it, too.
export const recorder = (send: Sender, history: History, t0: number, counter?: { next: number }): Record1 => {
  const ids = counter ?? { next: 0 };
  return async (proc, f, method, path, body, extra = {}) => {
    const i = ids.next++,
      cs = clientSpan(),
      now = (): { t: number; mono: number } => ({ t: Date.now() - t0, mono: Math.round(performance.now()) });
    history.push({
      i,
      proc,
      type: 'invoke',
      f,
      method,
      path,
      body,
      ...now(),
      trace: cs.trace,
      span: cs.span,
      ...extra,
    });
    try {
      const res = await send(method, path, body, { headers: { traceparent: cs.traceparent } });
      history.push({ i, proc, f, path, ...completed(res), ...now() });
      return res;
    } catch (e) {
      history.push({ i, proc, type: 'info', f, path, error: messageOf(e).slice(0, 200), ...now() });
      return null;
    }
  };
};

const CARDS = ['ann-4242', 'ann-4242', 'bob-0001', 'cat-0000'] as const;
/** What a load's clients share: the orders made so far, and the highest sale id seen. */
type Shared = { orders: number[]; sales: { max: number } };
type Client = { r: () => number; op: Record1; proc: number; seed: number; shared: Shared };
/** Send one keyed request; about one in five is sent twice with its key: at once, or after the first answer. */
const maybeTwice = async (
  r: () => number,
  proc: number,
  send1: (p: number) => Promise<Reply | null>,
): Promise<Reply | null> => {
  const twice = r();
  if (twice < 0.1) return (await Promise.all([send1(proc), send1(proc + 200)]))[0];
  const res = await send1(proc);
  if (twice < 0.2) await send1(proc + 200);
  return res;
};
/** One operation, and often a retry of it racing the original. */
const maybeRaced = async ({ r, op, proc }: Client, f: string, path: string, id: number): Promise<void> => {
  const one = op(proc, f, 'POST', path, '', { id });
  if (r() < 0.4) {
    await sleep(Math.floor(r() * 15));
    await Promise.all([one, op(proc + 100, f, 'POST', path, '', { id })]);
  } else await one;
};
const idOf = (res: Reply | null): number | null => {
  const id = at(res?.body, 'id');
  return typeof id === 'number' && Number.isInteger(id) ? id : null;
};
const fulfill = async (c: Client, k: number): Promise<void> => {
  const { r, op, proc, seed, shared } = c,
    { orders } = shared,
    u = r(),
    [first, ...rest] = orders;
  if (u < 0.35 || first === undefined) {
    const wait = pick(r, [1, 3, 10, 30, 2000, 2000]);
    const body = {
      key: `o${seed}-${proc}-${k}`,
      sku: pick(r, ['lamp', 'lamp', 'desk']),
      qty: 1 + Math.floor(r() * 3),
      card: pick(r, CARDS),
      address: r() < 0.15 ? 'Atlantis' : `${1 + Math.floor(r() * 99)} Main St`,
    };
    const id = idOf(
      await maybeTwice(r, proc, p =>
        op(p, 'create', 'POST', `/fulfill/v/1/orders/wait/${wait}`, JSON.stringify(body), { order: body }),
      ),
    );
    if (id !== null) orders.push(id);
  } else if (u < 0.75) {
    // a hot order: one of the last few, so advances of the same order overlap
    const [hot = first, ...others] = orders.slice(-4),
      id = pick(r, [hot, ...others]);
    await maybeRaced(c, 'advance', `/fulfill/v/1/advance/${id}`, id);
  } else {
    const id = pick(r, [first, ...rest]);
    await op(proc, 'read', 'GET', `/fulfill/v/1/orders/${id}`, undefined, { id });
  }
};
const boxoffice = async (c: Client, k: number): Promise<void> => {
  const { r, op, proc, seed, shared } = c,
    { sales } = shared,
    u = r();
  if (u < 0.45 || sales.max === 0) {
    const body = {
      key: `s${seed}-${proc}-${k}`,
      section: pick(r, ['floor', 'balcony', 'balcony']),
      qty: 1 + Math.floor(r() * 3),
      card: pick(r, CARDS),
    };
    const id = idOf(
      await maybeTwice(r, proc, p => op(p, 'buy', 'POST', '/tickets/v/1/buy', JSON.stringify(body), { order: body })),
    );
    // a 504 does not say its id; ids are sequential
    sales.max = id === null ? sales.max + 1 : Math.max(sales.max, id);
  } else if (u < 0.8) {
    const id = 1 + Math.floor(r() * (sales.max + 1));
    await maybeRaced(c, 'retry', `/tickets/v/1/retry/${id}`, id);
  } else {
    const id = 1 + Math.floor(r() * sales.max);
    await op(proc, 'sale', 'GET', `/tickets/v/1/sales/${id}`, undefined, { id });
  }
};
export type Load = { seed: number; clients?: number; ops?: number; workloads?: readonly [string, ...string[]] };
export async function load(
  send: Sender,
  { seed, clients = 8, ops = 30, workloads = ['fulfill', 'boxoffice'] }: Load,
): Promise<History> {
  const history: History = [],
    shared: Shared = { orders: [], sales: { max: 0 } },
    op = recorder(send, history, Date.now());
  const client = async (proc: number): Promise<void> => {
    const c: Client = { r: rng(seed * 1000 + proc), op, proc, seed, shared };
    for (let k = 0; k < ops; k++) await (pick(c.r, workloads) === 'fulfill' ? fulfill(c, k) : boxoffice(c, k));
  };
  await Promise.all(Array.from({ length: clients }, (_, p) => client(p)));
  return history;
}

// ---- heal and read: faults off, then finish every order and sale, then read everything
export type Row = Fields;
/** The state of everything once the faults stopped and every order and sale was finished. */
export type Final = {
  orders: Row[];
  sales: Row[];
  stock: Row[];
  cards: Row[];
  labels: Row[];
  seats: Row[];
  faults?: unknown;
  heal?: { path: string; status: number; body: unknown }[];
  unreadable?: string[];
  [table: string]: unknown;
};
const rows = (v: unknown): Row[] => list(v).map(fields);
const truthy: (v: unknown) => boolean = Boolean;
const shown = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));
export async function heal(send: Sender): Promise<Final> {
  await send('PUT', '/~faults', null);
  // A read of the final state is believed only as a 200 (the row) or a 404 (no such row). Anything else (a 5xx from
  // an injected fault still in flight, a broken body) is read again, and every such answer is kept in final.heal;
  // one that never reads is final.unreadable, which check() reports. Before this, a failed read of an order was
  // taken as "no order", which reads as a lost order and unbalanced money and stock (K4, seed 236 of run 3).
  const healed: NonNullable<Final['heal']> = [],
    unreadable: string[] = [];
  const read = async (path: string): Promise<Reply | null> => {
    for (let k = 0; k < 10; k++) {
      const r = await send('GET', path);
      if (r.status === 200 || r.status === 404) return r;
      healed.push({ path, status: r.status, body: typeof r.body === 'object' ? r.body : shown(r.body).slice(0, 200) });
      await sleep(200 * (k + 1));
    }
    unreadable.push(path);
    return null;
  };
  const scan = async (
    path: string,
    finish: (id: number) => Promise<unknown>,
    done: (row: Row) => boolean,
  ): Promise<Row[]> => {
    const out: Row[] = [];
    for (let id = 1, misses = 0; misses < 3; id++) {
      const r = await read(`${path}/${id}`);
      let row = fields(r?.body);
      // unreadable: reported (final.unreadable), and counted as a miss so the scan ends
      if (!r || r.status === 404 || !truthy(row.id)) {
        misses++;
        continue;
      }
      misses = 0;
      for (let k = 0; k < 6 && !done(row); k++) {
        await finish(id);
        const again = await read(`${path}/${id}`);
        if (again?.body !== undefined && again.body !== null) row = fields(again.body);
      }
      out.push(row);
    }
    return out;
  };
  const orders = await scan(
    '/fulfill/v/1/orders',
    id => send('POST', `/fulfill/v/1/advance/${id}`, ''),
    o => o.state === 'done' || o.state === 'failed',
  );
  const sales = await scan(
    '/tickets/v/1/sales',
    id => send('POST', `/tickets/v/1/retry/${id}`, ''),
    s => s.state !== 'pending',
  );
  const get = async (p: string): Promise<unknown> => (await read(p))?.body;
  return {
    orders,
    sales,
    stock: rows(await get('/inventory/v/1/stock')),
    cards: rows(await get('/payments/v/1/cards')),
    labels: rows(await get('/shipping/v/1/labels')),
    seats: rows(await get('/tickets/v/1/sections')),
    faults: await get('/~faults'),
    heal: healed,
    unreadable,
  };
}

// ---- check
// The legal histories of one order, as (state, steps) along each path of the workflow.
const PATHS = [
  ['reserving:0', 'charging:1', 'shipping:2', 'done:3'],
  ['reserving:0', 'charging:1', 'shipping:2', 'refunding:3', 'releasing:4', 'failed:5'],
  ['reserving:0', 'charging:1', 'releasing:2', 'failed:3'],
  ['reserving:0', 'failed:1'],
];
const whole = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
/** An order as an answer shows it. */
type Order = Row & { id: number; steps: number; sku: string };
const isOrder = (v: unknown): v is Order => {
  const o = fields(v);
  return whole(o.id) && whole(o.steps) && typeof o.sku === 'string';
};
const sumOf = (all: readonly Row[], field: string): number => all.reduce((n, x) => n + num(x[field]), 0);
const finished = (o: Row): boolean => o.state === 'done' || o.state === 'failed';
type Bad = (type: string, detail: Fields) => void;
const diffOf = (got: unknown, want: number): number | null => (typeof got === 'number' ? got - want : null);

// 2-4. stock, money and seats are conserved: what is gone is what done orders and paid sales took
const conserved = (final: Final, done: readonly Row[], bad: Bad): void => {
  for (const [sku, { remaining }] of Object.entries(INIT.stock)) {
    const want =
        remaining -
        sumOf(
          done.filter(o => o.sku === sku),
          'qty',
        ),
      got = final.stock.find(i => i.sku === sku)?.remaining;
    if (got !== want) bad('stock-not-conserved', { sku, want, got, diff: diffOf(got, want) });
  }
  // each card is down by its done orders and its paid sales, no more and no less
  const paid = final.sales.filter(s => s.state === 'paid');
  for (const [card, start] of Object.entries(INIT.cards)) {
    const want =
      start -
      sumOf(
        done.filter(o => o.card === card),
        'amount',
      ) -
      sumOf(
        paid.filter(s => s.card === card),
        'amount',
      );
    const got = final.cards.find(c => c.card === card)?.balance;
    if (got !== want) bad('money-not-conserved', { card, want, got, diff: diffOf(got, want) });
  }
  for (const [section, { seats }] of Object.entries(INIT.seats)) {
    const want =
        seats -
        sumOf(
          paid.filter(s => s.section === section),
          'qty',
        ),
      got = final.seats.find(x => x.name === section)?.seats;
    if (got !== want) bad('seats-not-conserved', { section, want, got, diff: diffOf(got, want) });
  }
};
// 5. labels: exactly one per done order, matching it; none for an order that did not ship
const labelled = (final: Final, done: readonly Row[], bad: Bad): void => {
  const labels = new Map(final.labels.map(l => [l.id, l]));
  for (const o of done) {
    const l = labels.get(o.label);
    if (!l || l.address !== o.address || l.sku !== o.sku || l.qty !== o.qty) bad('label-missing', { order: o });
    labels.delete(o.label);
  }
  for (const l of labels.values()) bad('label-extra', { label: l });
};
/** One answer that showed an order: when its operation began and ended, and how far the order had got. */
type Seen = { start: number; end: number; steps: number; at: string; op: number; value: Order };
/** The history as the checks read it: the completions that answered, and each operation's invocation. */
type Read = { completions: Entry[]; invoked: Map<number, Entry> };
const read = (history: History): Read => ({
  completions: history.filter(h => h.type === 'ok'),
  invoked: new Map(history.filter(h => h.type === 'invoke').map(h => [h.i, h])),
});
// 6. each order's observations: legal (state, steps), all on one path of the workflow, ending where it ended,
//    and in real-time order (a monotone register: an operation that began after another finished sees at least
//    as far). With states that only move forward, that is linearizability for each order.
const observed = ({ completions, invoked }: Read, bad: Bad): Map<number, Seen[]> => {
  const seen = new Map<number, Seen[]>();
  for (const h of completions) {
    if (!isOrder(h.value)) continue;
    const here = `${String(h.value.state)}:${h.value.steps}`;
    if (!PATHS.some(p => p.includes(here))) bad('illegal-state', { op: h.i, order: h.value });
    const obs = seen.get(h.value.id) ?? [];
    seen.set(h.value.id, obs);
    obs.push({ start: invoked.get(h.i)?.t ?? 0, end: h.t, steps: h.value.steps, at: here, op: h.i, value: h.value });
  }
  return seen;
};
const STALLED = / did not answer in time| is unreachable/;
const oneOrder = (id: number, obs: readonly Seen[], f: Row | undefined, bad: Bad): void => {
  if (!f) {
    bad('lost-order', { id, seen: obs.at(-1)?.value });
    return;
  }
  const all = [...obs.map(o => o.at), `${String(f.state)}:${String(f.steps)}`];
  if (!PATHS.some(p => all.every(a => p.includes(a)))) bad('states-on-two-paths', { id, states: [...new Set(all)] });
  for (const a of obs) {
    const b = obs.find(x => a.end < x.start && x.steps < a.steps);
    if (b)
      bad('not-linearizable', {
        id,
        earlier: { op: a.op, at: a.at, end: a.end },
        later: { op: b.op, at: b.at, start: b.start },
      });
  }
  // a committed step, once seen, is never lost: a done order stays done with the same label
  for (const a of obs)
    if (a.value.state === 'done' && (f.state !== 'done' || f.label !== a.value.label))
      bad('lost-commit', { id, seen: a.value, final: f });
  // a stall note belongs to the state it was written in
  if (finished(f) && (Boolean(f.stall) || STALLED.test(String(f.note)))) bad('stale-note', { order: f });
};
// 7. no answer claims that an order which exists does not
// (the first answer that showed the order: from then on it exists; a later answer's time would excuse a 404 sent
// between the two, which selftest.ts showed the first version of this check did)
const phantoms = ({ completions, invoked }: Read, bad: Bad): void => {
  const created = new Map<unknown, number>();
  for (const h of completions)
    if (isOrder(h.value) && !((created.get(h.value.id) ?? Infinity) <= h.t)) created.set(h.value.id, h.t);
  for (const h of completions) {
    const began = invoked.get(h.i),
      made = created.get(began?.id);
    if (h.status === 404 && (h.f === 'advance' || h.f === 'read') && made !== undefined && made < (began?.t ?? 0))
      bad('phantom-404', { op: h.i, id: began?.id, f: h.f, value: h.value });
  }
};
// 8. each answer agrees with the order or sale as it ended: a ticket is paid, a created order is the one asked for
const agreeing = (final: Final, { completions, invoked }: Read, bad: Bad): void => {
  const saleOf = new Map(final.sales.map(s => [s.id, s]));
  for (const h of completions) {
    const sale = saleOf.get(at(h.value, 'id'));
    if ((h.f === 'buy' || h.f === 'retry') && h.status === 201 && sale?.state !== 'paid')
      bad('ticket-not-paid', { op: h.i, ticket: h.value, final: sale });
    if (h.f === 'create' && isOrder(h.value)) {
      const want = invoked.get(h.i)?.order ?? {},
        got = h.value;
      if (['sku', 'qty', 'card', 'address'].some(k => got[k] !== want[k]))
        bad('wrong-order', { op: h.i, asked: want, got });
    }
  }
};
const keyOf = (h: Entry | undefined): unknown => h?.order?.key;
// 9. a client key makes one order (one sale): every answer for a key names the same one, and there are no more
//    orders (sales) than keys sent. Without keys a retried POST made a second order.
const keyedOnce = (history: History, final: Final, { completions, invoked }: Read, bad: Bad): void => {
  const tables: readonly (readonly [string, readonly Row[], string])[] = [
    ['create', final.orders, 'orders'],
    ['buy', final.sales, 'sales'],
  ];
  for (const [f, table, what] of tables) {
    const byKey = new Map<unknown, Set<number>>(),
      keys = new Set(history.filter(h => h.type === 'invoke' && h.f === f).map(keyOf));
    for (const h of completions) {
      const id = at(h.value, 'id');
      if (h.f !== f || !whole(id)) continue;
      const k = keyOf(invoked.get(h.i)),
        ids = byKey.get(k) ?? new Set<number>();
      byKey.set(k, ids.add(id));
    }
    for (const [k, ids] of byKey) if (ids.size > 1) bad(`key-made-two-${what}`, { key: k, ids: [...ids] });
    if (table.length > keys.size) bad(`more-${what}-than-keys`, { rows: table.length, keys: keys.size });
  }
};
/** How many of each there are, by a name. */
const tally = <T>(all: readonly T[], name: (x: T) => unknown): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const x of all) counts[String(name(x))] = (counts[String(name(x))] ?? 0) + 1;
  return counts;
};
export type Checked = { valid: boolean; anomalies: Anomaly[]; stats: Record<string, unknown> };
const statsOf = (
  history: History,
  final: Final,
  completions: readonly Entry[],
  done: readonly Row[],
): Checked['stats'] => {
  const invokes = history.filter(h => h.type === 'invoke'),
    count = (f: string): number => invokes.filter(h => h.f === f).length;
  const twice = (f: string): number =>
    Object.values(
      tally(
        invokes.filter(h => h.f === f),
        keyOf,
      ),
    ).filter(x => x > 1).length;
  return {
    ops: invokes.length,
    info: history.filter(h => h.type === 'info').length,
    by: Object.fromEntries(['create', 'advance', 'read', 'buy', 'retry', 'sale'].map(f => [f, count(f)])),
    keys_sent_twice: twice('create') + twice('buy'),
    statuses: tally(completions, h => h.status),
    orders: final.orders.length,
    done: done.length,
    failed: final.orders.filter(o => o.state === 'failed').length,
    sales: final.sales.length,
    paid: final.sales.filter(s => s.state === 'paid').length,
    faults: tally(rows(at(final.faults, 'faults')), f => f.kind),
  };
};

export function check(history: History, final: Final): Checked {
  const anomalies: Anomaly[] = [],
    bad: Bad = (type, detail) => {
      anomalies.push({ type, ...detail });
    };
  const done = final.orders.filter(o => o.state === 'done'),
    answers = read(history);
  for (const path of final.unreadable ?? [])
    bad('final-unreadable', { path, answers: (final.heal ?? []).filter(h => h.path === path).map(h => h.status) });
  // 1. every order and sale finished once the faults stopped (a refusal while compensating needs a person)
  for (const o of final.orders) if (!finished(o)) bad('order-not-finished', { order: o });
  for (const s of final.sales) if (s.state === 'pending') bad('sale-not-finished', { sale: s });
  conserved(final, done, bad);
  labelled(final, done, bad);
  const finalOf = new Map(final.orders.map(o => [o.id, o]));
  for (const [id, obs] of observed(answers, bad)) oneOrder(id, obs, finalOf.get(id), bad);
  phantoms(answers, bad);
  agreeing(final, answers, bad);
  keyedOnce(history, final, answers, bad);
  return { valid: anomalies.length === 0, anomalies, stats: statsOf(history, final, answers.completions, done) };
}

// ---- traces
/** One operation's trace as it was fetched, with the error when it could not be. */
const fetched = async (send: Sender, path: string): Promise<unknown> => {
  for (let attempt = 0; ; attempt++) {
    let res: Pick<Reply, 'status' | 'body'>;
    try {
      res = await send('GET', path);
    } catch (e) {
      res = { status: 0, body: messageOf(e) };
    }
    if (res.status === 200) return res.body;
    if (attempt >= 5) return { error: `${res.status} ${JSON.stringify(res.body).slice(0, 200)}` };
    await sleep(200 * (attempt + 1));
  }
};
// Every operation's trace by its trace id, from the program it was sent to: Map trace id -> OTLP/JSON.
export async function collectTraces(
  send: Sender,
  history: History,
  { parallel = 8 }: { parallel?: number } = {},
): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>(),
    queue = history.filter(h => h.type === 'invoke' && h.trace !== undefined && h.trace !== '');
  const worker = async (): Promise<void> => {
    for (let h = queue.shift(); h; h = queue.shift()) {
      const [, name = ''] = h.path.split('/'),
        trace = h.trace ?? '';
      out.set(trace, await fetched(send, `/${name}/traces/${trace}`));
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));
  return out;
}

// What a run's SQL says it created: the ids an INSERT INTO <table> returned. A run that failed (rolled back) kept
// only what it wrote before its last call (each call is a commit point): its inserts count when a call followed
// them, by time (the clock moves only at I/O, so a write after a call is at or after the call's end, and one before
// it at or before its start; production run jepsen-tix-g8, where a hold inserted after the refund's call and rolled
// back was counted, and its id given to the next hold). One that stopped on a call (partial) kept everything.
export const created = (all: readonly Span[], run: Span, table: string): unknown[] => {
  const inserts = run.events.filter(
    e => e.name === 'db.query' && String(e.attrs['db.query.text']).startsWith(`INSERT INTO ${table}`),
  );
  const ids = (es: readonly Span['events'][number][]): unknown[] =>
    es.flatMap(e => {
      const returned: unknown = JSON.parse(
        text(e.attrs['tape.sql.rows']) === '' ? '[]' : text(e.attrs['tape.sql.rows']),
      );
      return list(returned).map(r => list(r)[0]);
    });
  if (run.attrs['tape.run.rolled_back'] !== true) return ids(inserts);
  const calls = all.filter(s => s.parent === run.id && s.kind === 3);
  if (calls.length === 0) return [];
  const last = Math.max(...calls.map(c => c.start));
  return ids(inserts.filter(e => !(e.at > last)));
};

export type TraceStats = {
  ops: number;
  traced: number;
  spans: number;
  markers: Record<string, number>;
  calls: number;
  calls_joined: number;
  worst_skew_ms: number;
  clock_offset_ms: [number, number] | null;
  absent_told?: number;
  absent_network?: number;
  router_missing_unanswered?: number;
};
export type TracesChecked = { valid: boolean; anomalies: Anomaly[]; anomaly_count: number; stats: TraceStats };
type Flag = (type: string, extra?: Fields) => void;
/** The client got no response at all: a timeout or a dropped connection. */
const unanswered = (c: Entry | undefined): boolean =>
  c?.type === 'info' && c.status === undefined && c.error !== undefined && c.error !== '';
const statusOf = (s: Span): unknown => s.attrs['http.response.status_code'];
const marks = (s: Span, what: string): boolean => missingEvents(s).some(e => e.attrs['tape.missing'] === what);

/** The span of the call to the object: under the router's span, or standing in for a router that left no record. */
const invokeOf = (
  h: Entry,
  c: Entry | undefined,
  t: ReturnType<typeof tree>,
  root: Span,
  stats: TraceStats,
  bad: Flag,
): Span | null => {
  const [, name, , , ...rest] = h.path.split('/'),
    sub = `/${rest.join('/')}`;
  if (root.attrs['tape.missing'] === 'router') {
    if (missingEvents(root).length === 0) bad('missing-without-marker', { span: root.name });
    // the client is told the record is missing (trace_complete: false) in the answer; with no answer (it timed
    // out, or the reply was lost) it cannot be, so the absence is allowed and counted (production run jepsen-tix-g5)
    if (unanswered(c)) stats.router_missing_unanswered = (stats.router_missing_unanswered ?? 0) + 1;
    else if (c?.trace_complete !== 'false') bad('router-record-missing', { status: c?.status });
    return root;
  }
  if (
    root.name !== `${h.method} /{account}/{name}/v/{version}${sub}` ||
    root.kind !== 2 ||
    root.service !== 'tape-router'
  )
    bad('wrong-root', { name: root.name });
  if (c?.type === 'ok' && statusOf(root) !== c.status)
    bad('status-mismatch', { router: statusOf(root), client: c.status });
  const kids = t.kids(root),
    [only] = kids;
  if (kids.length === 1 && only?.name === `${name}.invoke` && only.kind === 3) return only;
  bad('call-span', { kids: kids.map(k => k.name) });
  return null;
};
/** The run under a supervisor's span, checked against the supervisor, the router and the client's request. */
const runUnder = (
  h: Entry,
  t: ReturnType<typeof tree>,
  root: Span,
  sup: Span,
  outcome: unknown,
  bad: Flag,
): Span | null => {
  const [, , , , ...rest] = h.path.split('/'),
    sub = `/${rest.join('/')}`,
    runs = t.kids(sup),
    [run = null] = runs,
    open = marks(sup, 'supervisor.end');
  if (open && outcome === 'answered') bad('open-supervisor-of-answered-call');
  if (runs.length > 1) bad('duplicate-run', { n: runs.length });
  if (!run) {
    if (!marks(sup, 'run')) bad('run-missing-without-marker');
    return null;
  }
  if (run.kind !== 2 || run.name !== `${h.method} ${sub}`) bad('run-wrong', { name: run.name });
  // (a supervisor that stopped before the end of the call recorded no status: there is nothing to compare)
  if (!open && statusOf(run) !== statusOf(sup) && !truthy(run.attrs['tape.run.incomplete']))
    bad('run-status-not-supervisor-status', { run: statusOf(run), supervisor: statusOf(sup) });
  if (outcome === 'answered' && statusOf(root) !== undefined && statusOf(root) !== statusOf(run))
    bad('router-status-not-run-status', { router: statusOf(root), run: statusOf(run) });
  if (!open && !text(run.attrs['tape.duration.source']).startsWith('measured')) bad('run-duration-unmeasured');
  return run;
};
/** The run an operation led to, with everything between the call and it checked. */
const runOf = (h: Entry, t: ReturnType<typeof tree>, root: Span, invoke: Span, bad: Flag): Span | null => {
  const [, name = ''] = h.path.split('/'),
    outcome = invoke.attrs['tape.call.outcome'],
    under = t.kids(invoke);
  const sups = under.filter(k => text(k.service).endsWith(`/${name} supervisor`)),
    orphans = under.filter(k => k.attrs['tape.supervisor.missing'] === true),
    [sup] = sups,
    [orphan = null] = orphans;
  if (under.length !== sups.length + orphans.length) bad('unexpected-call-child', { spans: under.map(k => k.name) });
  if (sups.length + orphans.length > 1) bad('duplicate-execution', { n: sups.length + orphans.length });
  if (orphan && missingEvents(orphan).length === 0) bad('orphan-run-without-marker');
  if (!sup && !orphan) {
    if (missingEvents(invoke).length === 0) bad('supervisor-missing-without-marker', { outcome });
    if (outcome === 'answered') bad('supervisor-missing', { outcome });
  }
  return sup ? runUnder(h, t, root, sup, outcome, bad) : orphan;
};
// every call in the trace (the run's and its callees', at any depth): what the callee did, or why nothing
const callsJoined = (all: readonly Span[], t: ReturnType<typeof tree>, stats: TraceStats, bad: Flag): void => {
  for (const call of all.filter(s => s.kind === 3 && s.attrs['rpc.system'] === 'tape')) {
    stats.calls++;
    const served = t.kids(call).filter(k => k.kind === 2);
    if (served.length > 0) stats.calls_joined++;
    else if (missingEvents(call).length === 0) bad('call-without-callee-or-marker', { call: call.name });
    if (served.length > 1) bad('call-served-twice', { call: call.name, n: served.length });
  }
};
/** Is there a trace to check? When there is none, says whether that is allowed (and counts it) or an anomaly. */
const present = (all: readonly Span[], c: Entry | undefined, stats: TraceStats, bad: Flag): boolean => {
  if (all.length > 0) return true;
  // no spans, and the response said its trace is incomplete (the router's record was not stored): the program
  // never opened a record of the call (that record is written before the run, R2), so the absence is allowed and
  // counted; it vouches for nothing (an order or sale no trace made is still an anomaly)
  if (c?.trace_complete === 'false') stats.absent_told = (stats.absent_told ?? 0) + 1;
  // no spans, and the client's request failed in transit (no response: a timeout or a dropped connection): it may
  // never have reached the Worker; allowed and counted, as in kv.js, and it vouches for nothing either
  else if (unanswered(c)) stats.absent_network = (stats.absent_network ?? 0) + 1;
  else bad('trace-missing', { status: c?.status });
  return false;
};
type Makers = Map<string, Map<unknown, number[]>>;
type Tables = readonly (readonly [table: string, f: string])[];
/** One operation's trace, checked; what its run created is added to `makers`. */
const oneTrace = (
  h: Entry,
  c: Entry | undefined,
  otlp: unknown,
  o: { tolerance: number; tables: Tables; makers: Makers; stats: TraceStats; anomalies: Anomaly[] },
): void => {
  const { stats, makers } = o,
    bad: Flag = (type, extra = {}) => {
      o.anomalies.push({ type, op: h.i, f: h.f, path: h.path, trace: h.trace, ...extra });
    };
  const failed = fields(otlp).error;
  if (otlp === undefined || otlp === null || Boolean(failed)) {
    bad('trace-unreadable', { error: failed ?? 'not fetched' });
    return;
  }
  const all = spansOf(otlp);
  if (!present(all, c, stats, bad)) return;
  stats.traced++;
  stats.spans += all.length;
  for (const e of all.flatMap(missingEvents)) {
    const what = String(e.attrs['tape.missing']);
    stats.markers[what] = (stats.markers[what] ?? 0) + 1;
  }
  const t = tree(all, { trace: h.trace ?? '', client: h.span ?? '' });
  for (const a of t.anomalies) bad(a.type, a);
  const { root } = t;
  if (!root) return;
  const invoke = invokeOf(h, c, t, root, stats, bad);
  if (!invoke) return;
  const run = runOf(h, t, root, invoke, bad);
  callsJoined(all, t, stats, bad);
  for (const [table, f] of run ? o.tables : []) {
    const told = at(c?.value, 'id');
    for (const id of run ? created(all, run, table) : []) {
      const by = makers.get(table)?.get(id) ?? [];
      makers.get(table)?.set(id, [...by, h.i]);
      // what the client was told it created is what the trace says it created
      if (c?.type === 'ok' && whole(told) && h.f === f && told !== id)
        bad('trace-effect-mismatch', { table, client: told, trace: id });
    }
  }
  const n = nesting(all, t.by, o.tolerance);
  for (const a of n.anomalies) bad(a.type, a);
  stats.worst_skew_ms = Math.max(stats.worst_skew_ms, n.worst);
  for (const off of n.offsets) {
    const [lo, hi] = stats.clock_offset_ms ?? [off, off];
    stats.clock_offset_ms = [Math.min(lo, off), Math.max(hi, off)];
  }
};

// Each operation's trace: one tree under the client's span; router -> <name>.invoke -> supervisor -> run; every
// call from a run joined to what its callee did, or explicitly missing; the status the client saw; and the orders
// and sales the traces say were created, against the final state: each created by exactly one traced operation.
// tables: [table, the operation f whose answer's id is the row it created] (tickets.tape's runner passes holds)
export function checkTraces(
  history: History,
  final: Readonly<Record<string, unknown>>,
  traces: ReadonlyMap<string, unknown>,
  {
    tolerance = 50,
    tables = [
      ['orders', 'create'],
      ['sales', 'buy'],
    ],
  }: { tolerance?: number; tables?: Tables } = {},
): TracesChecked {
  const anomalies: Anomaly[] = [],
    stats: TraceStats = {
      ops: 0,
      traced: 0,
      spans: 0,
      markers: {},
      calls: 0,
      calls_joined: 0,
      worst_skew_ms: 0,
      clock_offset_ms: null,
    };
  const done = new Map(history.filter(h => h.type !== 'invoke').map(h => [h.i, h]));
  const makers: Makers = new Map(tables.map(([t]) => [t, new Map<unknown, number[]>()]));
  for (const h of history.filter(x => x.type === 'invoke')) {
    stats.ops++;
    oneTrace(h, done.get(h.i), traces.get(h.trace ?? ''), { tolerance, tables, makers, stats, anomalies });
  }
  // each order and sale in the final state was created by exactly one traced operation, and each traced creation is there
  for (const [table] of tables) {
    const made = makers.get(table) ?? new Map<unknown, number[]>(),
      ids = new Set(rows(final[table]).map(r => r.id));
    for (const id of ids) {
      const by = made.get(id) ?? [];
      if (by.length !== 1)
        anomalies.push({
          type: by.length > 0 ? `${table}-created-twice-in-traces` : `${table}-created-by-no-trace`,
          id,
          ops: by,
        });
    }
    for (const [id, ops] of made) if (!ids.has(id)) anomalies.push({ type: `traced-${table}-not-in-final`, id, ops });
  }
  return { valid: anomalies.length === 0, anomalies: anomalies.slice(0, 50), anomaly_count: anomalies.length, stats };
}

// ---- a history and a final state as they were stored (JSON)
const isKind = (v: unknown): v is Entry['type'] => v === 'invoke' || v === 'ok' || v === 'info';
/** One entry as a stored history has it: its known fields checked, the rest kept as they are. */
export const entryOf = (v: unknown): Entry => {
  const { i, proc, type, f, path, t, mono, order, ...rest } = fields(v);
  return {
    ...rest,
    i: num(i),
    proc: num(proc),
    type: isKind(type) ? type : 'info',
    f: text(f),
    path: text(path),
    t: num(t),
    mono: num(mono),
    ...(order === undefined ? {} : { order: fields(order) }),
  };
};
export const historyOf = (v: unknown): History => list(v).map(entryOf);
/** A final state as it was stored. */
export const finalOf = (v: unknown): Final => {
  const { orders, sales, stock, cards, labels, seats, ...rest } = fields(v);
  return {
    ...rest,
    orders: rows(orders),
    sales: rows(sales),
    stock: rows(stock),
    cards: rows(cards),
    labels: rows(labels),
    seats: rows(seats),
  };
};
