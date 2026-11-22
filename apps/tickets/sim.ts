// The box office under the simulator (../../sim.ts): tickets.tape and pay.tape, random buyers, and every call to
// pay delivered, lost, dropped or cut, with timers and the clock chosen by the simulator.
//
//   node apps/tickets/sim.ts                 tickets.tape as written: no seed may fail
//   node apps/tickets/sim.ts --plants        every planted bug of plants.ts, built with the rules off: which
//                                             does the simulator find by itself? (writes results/sim.json)
//   node apps/tickets/sim.ts --replay '<script json>' [--seed n] [--plant <words of its name>]
//   --seeds n (default 300)  --steps n (60)  --faults n (2)
//
// Safety, after every step: invariants.ts (seats, tickets, money, the waitlist). Liveness, once the faults stop
// and no timer is left: no hold is still held, paying or refunding, and a canceled event has no open hold.
import { mkdirSync, writeFileSync } from 'node:fs';
import { build, explore, replay, report, shrink } from '../../sim.ts';
import type { Answer, Mem, Model, Op, World } from '../../sim/engine.ts';
import type { Json } from '../../sim/values.ts';
import { invariantsOf } from './invariants.ts';
import { cardOf, entryOf, eventOf, holdOf, ticketOf, tierOf, waitOf } from './rows.ts';
import type { State } from './rows.ts';
import { readFlat } from '../../fmt.ts';

const here = new URL('./', import.meta.url).pathname;
const text = { tickets: readFlat(`${here}tickets.tape`), pay: readFlat(`${here}pay.tape`) };
const arg = (k: string, d: string): string => {
  const i = process.argv.indexOf(`--${k}`);
  return i < 0 ? d : (process.argv[i + 1] ?? d);
};

const pay = build(text.pay);
if (pay.errors) throw new Error(`pay.tape: ${JSON.stringify(pay.errors)}`);

/** The hold a client made last, if it made one. */
const holdOfMem = (mem: Mem): number | null => (typeof mem['hold'] === 'number' ? mem['hold'] : null);
const field = (json: unknown, name: string): unknown =>
  typeof json === 'object' && json !== null ? Object.fromEntries(Object.entries(json))[name] : undefined;
const held = (mem: Mem, res: Answer): void => {
  const id = field(res.json, 'id');
  if (typeof id === 'number' && id !== 0 && Boolean(field(res.json, 'state'))) mem['hold'] = id;
};

// Three buyers, five things each. A buyer acts on the hold it made last; seats are scarce (tier 3 has four) and
// holds are short, so expiry, the waitlist and a sold-out tier all happen. `poor-0002` is always declined.
function clients(rand: () => number): Op[][] {
  const pick = <T>(xs: readonly [T, ...T[]]): T => xs[Math.floor(rand() * xs.length)] ?? xs[0];
  const on = (name: string, path: string, body?: () => Json): Op => ({
    name,
    make: mem => {
      const hold = holdOfMem(mem);
      return hold === null ? null : { line: `POST /holds/${hold}/${path}`, body: body?.() };
    },
  });
  const firstHold = (c: number): Op => ({
    name: 'hold',
    make: () => ({
      line: 'POST /holds',
      body: { key: `k${c}-0`, tier: 3, buyer: `buyer${c}`, qty: 1 + (c % 2), seconds: 5 },
    }),
    then: held,
  });
  const anotherHold = (c: number, i: number): Op => ({
    name: 'hold',
    make: () => ({
      line: 'POST /holds',
      body: {
        key: pick([`k${c}-${i}`, `k${c}-${i}`, `k${c}-0`]),
        tier: pick([3, 3, 4]),
        buyer: `buyer${c}`,
        qty: pick([1, 2, 3]),
        seconds: pick([2, 5, 30]),
      },
    }),
    then: held,
  });
  const cancel: Op = {
    name: 'cancel',
    make: mem => {
      mem.notes['canceled'] = true;
      return { line: 'POST /events/2/cancel' };
    },
  };
  const op = (c: number, i: number): Op => {
    const x = rand();
    if (x < 0.3) return anotherHold(c, i);
    if (x < 0.6)
      return on('checkout', 'checkout', () => ({ card: pick(['visa-4242', 'visa-4242', 'amex-0005', 'poor-0002']) }));
    if (x < 0.72) return on('release', 'release');
    if (x < 0.88) return on('refund', 'refund');
    if (x < 0.96)
      return {
        name: 'wait',
        make: () => ({
          line: 'POST /waitlist',
          body: { key: `w${c}-${i}`, tier: 3, buyer: `buyer${c}`, qty: pick([1, 2]) },
        }),
      };
    return x < 0.98
      ? cancel
      : { name: 'cancel as anyone', make: () => ({ line: 'POST /events/2/cancel', via: 'public' }) };
  };
  return [0, 1, 2].map(c => [firstHold(c), ...[1, 2, 3, 4].map(i => op(c, i))]);
}

const state = (w: World): State & { events: NonNullable<State['events']> } => ({
  tiers: w.rows('tickets', 'SELECT * FROM tiers').map(tierOf),
  holds: w.rows('tickets', 'SELECT * FROM holds').map(holdOf),
  tickets: w.rows('tickets', 'SELECT * FROM tickets').map(ticketOf),
  waitlist: w.rows('tickets', 'SELECT * FROM waitlist').map(waitOf),
  events: w.rows('tickets', 'SELECT * FROM events').map(eventOf),
  ledger: w.rows('pay', 'SELECT * FROM ledger').map(entryOf),
  cards: w.rows('pay', 'SELECT * FROM cards').map(cardOf),
});
// Mid-flight, a refunding hold still has its valid tickets (tickets.tape voids them when the refund is known), so
// that one line of invariants.ts, written for rows read after a heal, is checked at the end only.
const midflight = (w: World): string[] =>
  invariantsOf(state(w)).filter(v => !/^tickets: hold \d+ is refunding with \d+ valid tickets/.test(v));
function settled(w: World): string[] {
  const s = state(w);
  const gone = new Set(s.tiers.filter(t => s.events.find(e => e.id === t.event)?.state === 'canceled').map(t => t.id));
  const unasked = s.events.find(e => e.id === 2)?.state === 'canceled' && w.notes['canceled'] !== true;
  return [
    ...invariantsOf(s),
    ...s.holds.flatMap(h =>
      ['held', 'paying', 'refunding'].includes(h.state)
        ? [`hold ${h.id} is left ${h.state} with no timer set${h.note ? ` (note: ${h.note})` : ''}`]
        : [],
    ),
    ...s.holds.flatMap(h =>
      gone.has(h.tier) && h.state === 'confirmed' ? [`hold ${h.id} is confirmed on a canceled event`] : [],
    ),
    ...(unasked ? ['event 2 is canceled, and no operator asked for it'] : []),
    ...s.waitlist.flatMap(x =>
      x.state === 'waiting' && gone.has(x.tier) ? [`waitlist entry ${x.id} still waits for a canceled event`] : [],
    ),
  ];
}
export const model = (tickets: WebAssembly.Module): Model => ({
  modules: { tickets, pay: pay.module },
  entry: 'tickets',
  clients,
  check: midflight,
  settled,
  start: Date.parse('2026-11-17T20:00:00Z'),
});

const seeds = Number(arg('seeds', '300'));
const steps = Number(arg('steps', '60'));
const faults = Number(arg('faults', '2'));
const main = process.argv[1] === new URL(import.meta.url).pathname;

type Hunt =
  | { ok: true; ran: number; actions: number; ms: number }
  | {
      ok: false;
      ran: number;
      kind: string;
      violations: string[];
      seed: number;
      choices: number;
      from: number;
      script: string[];
      text: string;
      ms: number;
    };
async function hunt(module: WebAssembly.Module): Promise<Hunt> {
  const began = performance.now();
  const r = await explore(model(module), { seeds, steps, faults });
  const ms = (): number => Math.round(performance.now() - began);
  const [first] = r.failures;
  if (!first) return { ok: true, ran: r.ran, actions: r.actions, ms: ms() };
  const small = await shrink(model(module), first);
  return {
    ok: false,
    ran: r.ran,
    kind: small.kind,
    violations: small.violations,
    seed: small.seed,
    choices: small.script.length,
    from: first.script.length,
    script: small.script,
    text: report(small),
    ms: ms(),
  };
}

/** tickets.tape with one plant's replacements made. */
const planted = (pairs: readonly (readonly [string, string])[]): string =>
  pairs.reduce((t, [a, b]) => t.replace(a, b), text.tickets);
const scriptOf = (json: string): string[] => {
  const given: unknown = JSON.parse(json);
  return Array.isArray(given) ? given.map(String) : [];
};

async function replayOne(): Promise<never> {
  const { plants } = await import('./plants.ts');
  const name = arg('plant', '');
  const p = name === '' ? undefined : plants.find(x => x.name.includes(name));
  const b = build(p ? planted(p.pairs) : text.tickets, { rules: false });
  if (b.errors) throw new Error(`it does not build: ${JSON.stringify(b.errors[0])}`);
  const r = await replay(model(b.module), scriptOf(arg('replay', '[]')), { seed: Number(arg('seed', '1')) });
  console.log(r.ok ? 'this script passes' : report(r));
  process.exit(r.ok ? 0 : 1);
}

type Found = { plant: string; error?: string; compiler?: string[]; sim?: string; ms?: number } & Record<
  string,
  unknown
>;
/** One plant, built with the rules off and hunted: what the compiler says of it and what the simulator finds. */
async function huntPlant(p: { name: string; pairs: readonly (readonly [string, string])[] }): Promise<Found> {
  if (p.pairs.some(([from]) => !text.tickets.includes(from))) {
    console.log(`??     ${p.name}`);
    return { plant: p.name, error: 'its text is not in tickets.tape' };
  }
  const src = planted(p.pairs);
  const codes = [...new Set((build(src).errors ?? []).map(e => e.code))];
  const loose = build(src, { rules: false });
  if (loose.errors) {
    console.log(`type   ${p.name}: ${codes.join(', ')}`);
    return { plant: p.name, compiler: codes, sim: 'does not build with the rules off' };
  }
  const h = await hunt(loose.module);
  if (h.ok) {
    console.log(`${'MISS'.padEnd(6)} ${codes.join(',').padEnd(8)} ${p.name}`);
    return { plant: p.name, compiler: codes, sim: 'missed', seeds: h.ran, ms: h.ms };
  }
  const short = { safety: 'safe', error: 'error' }[h.kind] ?? 'live';
  console.log(
    `${short.padEnd(6)} ${codes.join(',').padEnd(8)} ${p.name}: run ${h.ran}, ${h.choices} choices: ${h.violations[0]}`,
  );
  const { seed, ran: runs, choices, script, ms } = h;
  return {
    plant: p.name,
    compiler: codes,
    sim: h.kind,
    seed,
    runs,
    choices,
    violations: h.violations.slice(0, 2),
    script,
    ms,
  };
}

async function huntPlants(): Promise<void> {
  const { plants } = await import('./plants.ts');
  const out: Found[] = [];
  for (const p of plants) out.push(await huntPlant(p));
  mkdirSync(`${here}results`, { recursive: true });
  writeFileSync(`${here}results/sim.json`, `${JSON.stringify(out, null, 1)}\n`);
  const ran = out.filter(o => o.sim !== undefined && o.sim !== 'does not build with the rules off');
  const ruled = (o: Found): boolean => (o.compiler?.length ?? 0) > 0;
  const found = ran.filter(o => o.sim !== 'missed');
  const missed = ran.filter(o => o.sim === 'missed');
  console.log(
    `${out.length} plants, ${ran.length} run: the simulator found ${found.length} (${found.filter(ruled).length} the rules also refuse, ${found.filter(o => !ruled(o)).length} only the simulator); ${missed.filter(ruled).length} only the rules; ${missed.filter(o => !ruled(o)).length} neither`,
  );
}

if (main && process.argv.includes('--replay')) await replayOne();
else if (main && process.argv.includes('--plants')) await huntPlants();
else if (main) {
  const b = build(text.tickets);
  if (b.errors) throw new Error(`tickets.tape: ${JSON.stringify(b.errors[0])}`);
  const h = await hunt(b.module);
  console.log(h.ok ? `tickets.tape: ${h.ran} seeds, ${h.actions} choices, nothing wrong (${h.ms} ms)` : h.text);
  process.exit(h.ok ? 0 : 1);
}
