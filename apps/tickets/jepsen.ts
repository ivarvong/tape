// jepsen.ts: tickets.tape and pay.tape against a running service, under the fault plan of service/jepsen
// (harness.ts PLAN, on the router hop and on tickets' calls to pay), one fresh account per seed.
// node apps/tickets/jepsen.ts --base <url> --token-file <path> --prefix jepsen-tix --seeds 1-4 [--out dir]
// Each client buys as itself: holds (4 s), checkouts with a card that may decline, releases, transfers, waitlist
// joins, and an operator who refunds and, once per run, cancels event 2. Every operation is sent once, with its
// own traceparent (service/jepsen/client.ts); an answer that is unknown is sent again later with the same key,
// as a client would. Then the faults are lifted, the timers settle everything in doubt, and the final rows
// (GET /audit, pay's /ledger and /cards) are checked against invariants.ts, the answers clients were given, and
// the traces (harness.ts checkTraces). The token is read from the file and never printed.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { faultable, flag, need, tokenFromFile } from '../../service/jepsen/cli.ts';
import { makeSender, stats as clientStats } from '../../service/jepsen/client.ts';
import type { Reply, Sender } from '../../service/jepsen/client.ts';
import { recorder, collectTraces, checkTraces, rng, PLAN } from '../../service/jepsen/harness.ts';
import type { History, Record1, TracesChecked } from '../../service/jepsen/harness.ts';
import { at, list, num } from '../../service/jepsen/json.ts';
import { seedsIn } from '../../service/jepsen/seeds.ts';
import type { Anomaly } from '../../service/jepsen/traces.ts';
import { invariantsOf } from './invariants.ts';
import { stateFrom } from './rows.ts';
import type { State } from './rows.ts';

const base = need('base'),
  token = tokenFromFile(),
  prefix = faultable(flag('prefix') ?? 'jepsen-tix'),
  out = flag('out') ?? '/tmp/tickets-jepsen';
const CLIENTS = 8,
  OPS = 24;
const here = import.meta.dirname;
// waitlist offers last 6 s here (300 in the demo), so a run settles in about a minute once the faults are lifted
const src = {
  pay: readFileSync(`${here}/pay.tape`, 'utf8'),
  tickets: readFileSync(`${here}/tickets.tape`, 'utf8').replace(
    'flag hold_seconds: Int = 300',
    'flag hold_seconds: Int = 6',
  ),
};
if (!src.tickets.includes('flag hold_seconds: Int = 6'))
  throw new Error('tickets.tape no longer has flag hold_seconds = 300');
mkdirSync(out, { recursive: true });
const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

/** What the clients of one run were told. */
type Told = {
  /** each hold a client was told it has, and the key it asked with */
  holds: Map<number, string>;
  confirmed: Set<number>;
  soldOut: Set<string>;
  refunded: Set<number>;
  transfers: { ticket: number; to: string }[];
  cancelAcked: boolean;
};
/** An operation whose answer was unknown: sent again later, with the same key. */
type Again = { f: 'hold' | 'checkout'; path: string; body: Record<string, unknown> };
/** One run: its account, its random numbers, how it sends an operation, and what its clients were told. */
type Run = {
  account: string;
  r: () => number;
  op: Record1;
  /** a path of this run's tickets version */
  T: (path: string) => string;
  told: Told;
  canceled: boolean;
};
/** One client: its number, the holds it was told it has, and what it must send again. */
type Client = { proc: number; me: string; mine: number[]; again: Again[] };
const pick = <V>(run: Run, xs: readonly V[]): V | undefined => xs[Math.floor(run.r() * xs.length)];
const acked = (res: Reply | null): boolean => res !== null && res.status >= 200 && res.status < 300;
const heldNow = (run: Run, c: Client, res: Reply, key: unknown): void => {
  const id = num(at(res.body, 'id'));
  c.mine.push(id);
  run.told.holds.set(id, String(key));
};

// The operator cancels event 2 once, and (as a person would) asks again until it is told 2xx: an unknown outcome
// may have canceled it or not (jepsen-tix-d1's one cancel answered 503 and never took effect; d6's was never sent,
// the retry branch took its turn).
const cancel = async (run: Run, c: Client): Promise<void> => {
  for (let n = 0; n < 20 && !run.told.cancelAcked; n++) {
    const res = await run.op(c.proc, 'cancel', 'POST', run.T('/events/2/cancel'));
    if (res?.status === 200 || res?.status === 202) run.told.cancelAcked = true;
    else await sleep(500);
  }
};
const resend = async (run: Run, c: Client, a: Again): Promise<void> => {
  const res = await run.op(c.proc, a.f, 'POST', a.path, a.body);
  if (a.f === 'hold' && res !== null && acked(res)) heldNow(run, c, res, a.body['key']);
};
const hold = async (run: Run, c: Client, k: number): Promise<void> => {
  const body = {
    key: `${run.account}-${c.me}-${k}`,
    tier: pick(run, [1, 3, 3, 4]),
    buyer: c.me,
    qty: 1 + Math.floor(run.r() * 3),
    seconds: 4,
  };
  const res = await run.op(c.proc, 'hold', 'POST', run.T('/holds'), body);
  if (res?.status === 201 || res?.status === 200) heldNow(run, c, res, body.key);
  else if (res?.status === 409) {
    run.told.soldOut.add(body.key);
    if (run.r() < 0.5)
      await run.op(c.proc, 'wait', 'POST', run.T('/waitlist'), {
        key: `${body.key}-w`,
        tier: body.tier,
        buyer: c.me,
        qty: body.qty,
      });
  } else c.again.push({ f: 'hold', path: run.T('/holds'), body });
};
const checkout = async (run: Run, c: Client): Promise<void> => {
  const id = pick(run, c.mine) ?? 0,
    path = run.T(`/holds/${id}/checkout`),
    body = { card: pick(run, ['visa-4242', 'visa-4242', 'amex-0005', 'poor-0002']) };
  const res = await run.op(c.proc, 'checkout', 'POST', path, body);
  if (res?.status === 200 && at(res.body, 'state') === 'confirmed') run.told.confirmed.add(id);
  else if (res === null || res.status === 0 || res.status >= 500) c.again.push({ f: 'checkout', path, body });
};
const refund = async (run: Run, c: Client): Promise<void> => {
  const id = pick(run, c.mine) ?? 0,
    res = await run.op(c.proc, 'refund', 'POST', run.T(`/holds/${id}/refund`));
  if (res?.status === 200 && at(res.body, 'state') === 'refunded') run.told.refunded.add(id);
};
const transfer = async (run: Run, c: Client): Promise<void> => {
  const res = await run.op(c.proc, 'mine', 'GET', run.T(`/users/${c.me}/tickets`));
  const valid = list(res?.body).filter(t => at(t, 'state') === 'valid');
  if (valid.length === 0) return;
  const ticket = num(at(pick(run, valid), 'id')),
    to = `c${(c.proc + 1) % CLIENTS}`;
  const given = await run.op(c.proc, 'transfer', 'POST', run.T(`/tickets/${ticket}/transfer`), { from: c.me, to });
  if (given?.status === 200) run.told.transfers.push({ ticket, to });
};
/** One operation of a client, chosen by the run's next random number. */
const step = async (run: Run, c: Client, k: number): Promise<void> => {
  const x = run.r(),
    [first] = c.again;
  if (!run.canceled && c.proc === 0 && k >= 12) {
    run.canceled = true;
    await cancel(run, c);
  } else if (first !== undefined && x < 0.15) {
    c.again.shift();
    await resend(run, c, first);
  } else if (x < 0.4 || c.mine.length === 0) await hold(run, c, k);
  else if (x < 0.75) await checkout(run, c);
  else if (x < 0.83) await run.op(c.proc, 'release', 'POST', run.T(`/holds/${pick(run, c.mine) ?? 0}/release`));
  else if (x < 0.9) await refund(run, c);
  else if (x < 0.96) await transfer(run, c);
  else await run.op(c.proc, 'get', 'GET', run.T(`/holds/${pick(run, c.mine) ?? 0}`));
};
const client = async (run: Run, proc: number): Promise<void> => {
  const c: Client = { proc, me: `c${proc}`, mine: [], again: [] };
  for (let k = 0; k < OPS; k++) await step(run, c, k);
};

/** The tiers of event 2, which the operator cancels. */
const tier2 = (state: State): Set<number> => new Set(state.tiers.filter(t => t.event === 2).map(t => t.id));
/** The audit once nothing is open (or after three minutes), and how long that took. A canceled event's confirmed
 * orders are open too: the sweep refunds an order that was paying when the event was canceled only once the
 * charge confirms it, on its next run (up to 5 s later; jepsen-tix-i6 read the audit in between and saw holds 9
 * and 18 confirmed, refunded when read again). */
const settled = async (send: Sender, run: Run): Promise<{ audit: unknown; waited: number }> => {
  for (let waited = 0; ; waited += 5000) {
    const audit = (await send('GET', run.T('/audit'))).body,
      state = stateFrom(audit, [], []);
    const canceledTiers = run.told.cancelAcked ? tier2(state) : new Set<number>();
    const open = state.holds.filter(
      h => ['paying', 'refunding', 'held'].includes(h.state) || (h.state === 'confirmed' && canceledTiers.has(h.tier)),
    );
    if (open.length === 0 || waited > 180000) return { audit, waited };
    await sleep(5000);
  }
};
/** What is wrong with the final rows: the invariants, then each answer a client was given against them. */
const judge = (state: State, told: Told): Anomaly[] => {
  const byId = new Map(state.holds.map(h => [h.id, h])),
    canceled = tier2(state);
  const unsettled = state.holds.filter(h => ['paying', 'refunding', 'held'].includes(h.state)).length;
  return [
    ...invariantsOf(state).map(m => ({ type: m.split(':')[0] ?? '', message: m })),
    ...[...told.holds]
      .filter(([id, key]) => byId.get(id)?.client !== key)
      .map(([id]) => ({ type: 'told-held-not-in-final', id })),
    ...[...told.confirmed]
      .filter(id => !['confirmed', 'refunding', 'refunded'].includes(byId.get(id)?.state ?? ''))
      .map(id => ({ type: 'told-confirmed-not-final', id, state: byId.get(id)?.state })),
    ...[...told.refunded]
      .filter(id => byId.get(id)?.state !== 'refunded')
      .map(id => ({ type: 'told-refunded-not-final', id })),
    ...[...told.soldOut]
      .filter(key => state.holds.some(h => h.client === key))
      .map(key => ({ type: 'told-sold-out-but-held', key })),
    ...(told.cancelAcked ? [] : [{ type: 'cancel-never-acknowledged' }]),
    ...state.holds
      .filter(h => canceled.has(h.tier) && !['released', 'expired', 'refunded'].includes(h.state))
      .map(h => ({ type: 'canceled-event-not-settled', id: h.id, state: h.state })),
    ...state.waitlist
      .filter(w => canceled.has(w.tier) && w.state === 'waiting')
      .map(w => ({ type: 'canceled-event-waitlist-waiting', id: w.id })),
    ...(unsettled > 0 ? [{ type: 'unsettled-after-heal', n: unsettled }] : []),
  ];
};
/** The trace check. A waitlist offer is a hold made by a release, refund or sweep: in a client's trace when a
 * client op ran it, in no client trace when a woken run (an expiry, a sweep) did. So a waitlist hold may be created
 * by no client trace, but never by two; every other check stands. */
const traced = (
  history: History,
  audit: unknown,
  state: State,
  traces: ReadonlyMap<string, unknown>,
): TracesChecked => {
  const waitlisted = new Set(state.holds.filter(h => h.client.startsWith('waitlist-')).map(h => h.id));
  const tr = checkTraces(history, { holds: list(at(audit, 'holds')) }, traces, { tables: [['holds', 'hold']] });
  const anomalies = tr.anomalies.filter(
    a => !(a.type === 'holds-created-by-no-trace' && typeof a['id'] === 'number' && waitlisted.has(a['id'])),
  );
  return { ...tr, anomalies, valid: anomalies.length === 0 };
};
const counted = (all: readonly string[]): Record<string, number> =>
  Object.fromEntries([...Map.groupBy(all, x => x)].map(([k, v]) => [k, v.length]));

let failed = 0;
for (const seed of seedsIn(flag('seeds') ?? '1')) {
  const account = `${prefix}${seed}`,
    began = Date.now();
  const send = makeSender({
    base,
    token,
    route: path => (path === '/~faults' ? `/_faults/${account}` : `/${account}${path}`),
  });
  const upload = async (name: 'pay' | 'tickets'): Promise<number> => {
    const res = await send('POST', `/${name}`, src[name]);
    if (res.status !== 201) throw new Error(`upload ${name}: ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
    return num(at(res.body, 'version'));
  };
  const versions = { pay: await upload('pay'), tickets: await upload('tickets') };
  const plan = await send('PUT', '/~faults', { seed, p: PLAN, tail: [20, 400], router: true });
  const history: History = [];
  const run: Run = {
    account,
    r: rng(seed),
    op: recorder(send, history, Date.now()),
    T: path => `/tickets/v/${versions.tickets}${path}`,
    told: {
      holds: new Map(),
      confirmed: new Set(),
      soldOut: new Set(),
      refunded: new Set(),
      transfers: [],
      cancelAcked: false,
    },
    canceled: false,
  };
  await Promise.all(Array.from({ length: CLIENTS }, (_, proc) => client(run, proc)));
  // heal: no faults; the timers expire what is held and ask again about every charge and refund in doubt
  await send('PUT', '/~faults', null);
  const { audit, waited } = await settled(send, run);
  const ledger = (await send('GET', `/pay/v/${versions.pay}/ledger`)).body,
    cards = (await send('GET', `/pay/v/${versions.pay}/cards`)).body,
    state = stateFrom(audit, ledger, cards);
  const anomalies = judge(state, run.told);
  const tr = traced(history, audit, state, await collectTraces(send, history));
  const result = {
    valid: anomalies.length === 0,
    anomalies,
    stats: {
      ops: history.filter(h => h.type === 'invoke').length,
      holds: state.holds.length,
      by_state: counted(state.holds.map(h => h.state)),
      tickets: state.tickets.length,
      ledger: state.ledger.length,
      statuses: counted(history.filter(h => h.type !== 'invoke').map(h => `${h.f}:${h.status ?? h.type}`)),
      settle_ms: waited,
    },
  };
  writeFileSync(
    `${out}/${account}.json`,
    JSON.stringify(
      {
        account,
        seed,
        versions,
        plan: at(plan.body, 'plan') ?? null,
        result,
        traces: tr,
        final: { audit, ledger, cards },
        history,
      },
      null,
      1,
    ),
  );
  if (!result.valid || !tr.valid) failed++;
  console.log(
    JSON.stringify({
      account,
      seed,
      ms: Date.now() - began,
      valid: result.valid,
      anomalies: [...new Set(anomalies.map(a => a.type))],
      stats: result.stats,
      traces_valid: tr.valid,
      trace_anomalies: [...new Set(tr.anomalies.map(a => a.type))],
      trace_stats: tr.stats,
      client: { ...clientStats },
    }),
  );
}
process.exit(failed > 0 ? 1 : 0);
