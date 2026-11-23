// invariants.ts: what must hold of tickets.tape's and pay.tape's rows after any sequence of requests, timers and
// faults (world.ts in node; jepsen.ts over GET /audit in production). No clock of its own.
import { stateOf } from './rows.ts';
import type { Card, Entry, Hold, State, Ticket, Tier, Wait } from './rows.ts';

const TAKING = new Set(['held', 'paying', 'confirmed', 'refunding', 'unresolved']);
const START: Readonly<Record<string, number>> = { 'visa-4242': 1000000000, 'amex-0005': 1000000000, 'poor-0002': 500 };
const sum = (xs: readonly number[]): number => xs.reduce((n, x) => n + x, 0);

/** Seats: what is left of a tier and what its holds take add up to its capacity. */
function seats(t: Tier, holds: readonly Hold[]): string[] {
  const taken = sum(holds.filter(h => h.tier === t.id && TAKING.has(h.state)).map(h => h.qty));
  return [
    ...(t.left + taken === t.capacity
      ? []
      : [`seats: tier ${t.id} has ${t.left} left and ${taken} taken by holds, capacity ${t.capacity}`]),
    ...(t.left < 0 || t.left > t.capacity ? [`seats: tier ${t.id} left ${t.left} outside 0..${t.capacity}`] : []),
  ];
}

/** Tickets: a confirmed hold has its tickets valid, and only a hold that was confirmed has any. */
function ticketsOf(h: Hold, tickets: readonly Ticket[]): string[] {
  const mine = tickets.filter(k => k.hold === h.id);
  const valid = mine.filter(k => k.state === 'valid').length;
  const want = h.state === 'confirmed' ? h.qty : 0;
  return [
    ...(valid === want ? [] : [`tickets: hold ${h.id} is ${h.state} with ${valid} valid tickets, wanted ${want}`]),
    ...(!['confirmed', 'refunding', 'refunded'].includes(h.state) && mine.length > 0
      ? [`tickets: hold ${h.id} is ${h.state} and has tickets`]
      : []),
    ...(h.state === 'refunding' && mine.length !== h.qty
      ? [`tickets: hold ${h.id} is refunding with ${mine.length} tickets`]
      : []),
  ];
}

/** What a hold's card may have moved, by the hold's state. */
const mayMove = (h: Hold): number[] =>
  ({
    confirmed: [h.amount],
    refunding: [h.amount, 0],
    refunded: [0],
    held: [0],
    expired: [0],
    released: [0],
    paying: [0, h.amount],
    // asked about too many times with no answer: either, for a person to settle with pay
    unresolved: [0, h.amount],
  })[h.state] ?? [];

/** Money: a hold is charged once at most, refunded once at most, and its card moved what its state says. */
function moneyOf(h: Hold, ledger: readonly Entry[]): string[] {
  const entries = ledger.filter(e => e.ref === `hold-${h.id}`);
  const charges = entries.filter(e => e.what === 'charge');
  const refunds = entries.filter(e => e.what === 'refund');
  const net = sum(entries.map(e => e.amount));
  return [
    ...(charges.length > 1 ? [`money: hold ${h.id} was charged ${charges.length} times`] : []),
    ...(refunds.length > 1 ? [`money: hold ${h.id} was refunded ${refunds.length} times`] : []),
    ...(mayMove(h).includes(net)
      ? []
      : [`money: hold ${h.id} is ${h.state} and its card moved ${net} (amount ${h.amount})`]),
    ...(charges.some(c => c.amount !== h.amount)
      ? [`money: hold ${h.id} charged another amount than ${h.amount}`]
      : []),
  ];
}

function balanceOf(c: Card, ledger: readonly Entry[]): string[] {
  const says = (START[c.card] ?? Number.NaN) - sum(ledger.filter(e => e.card === c.card).map(e => e.amount));
  return says === c.balance ? [] : [`money: card ${c.card} has ${c.balance}, its ledger says ${says}`];
}

const offered = (w: Wait, holds: readonly Hold[]): string[] =>
  w.state === 'offered' && !holds.some(h => h.id === w.hold && h.client === `waitlist-${w.id}`)
    ? [`waitlist: entry ${w.id} offered hold ${w.hold}, which is not its hold`]
    : [];

// The checks over the rows themselves (tickets' GET /audit and pay's GET /ledger and /cards, in production).
// Each violation names the rule.
export function invariantsOf({ tiers, holds, tickets, waitlist, ledger, cards }: State): string[] {
  return [
    ...tiers.flatMap(t => seats(t, holds)),
    ...holds.flatMap(h => [...ticketsOf(h, tickets), ...moneyOf(h, ledger)]),
    ...ledger.flatMap(e =>
      holds.some(h => `hold-${h.id}` === e.ref) ? [] : [`money: ledger entry ${e.id} for ${e.ref}, which is no hold`],
    ),
    ...cards.flatMap(c => balanceOf(c, ledger)),
    ...waitlist.flatMap(w => offered(w, holds)),
  ];
}

type Read = Parameters<typeof stateOf>[0];
/** What must hold after any sequence of requests, timers and faults, read from the two databases. */
export const invariants = (rows: Read, payRows: Read): string[] => invariantsOf(stateOf(rows, payRows));
