// rows.ts: the rows of tickets.tape and pay.tape as the checks read them, whether they come from SQLite (world.ts,
// the simulator) or from JSON (GET /audit in production). A column that is not there reads as 0 or ''.
type Raw = Readonly<Record<string, unknown>>;
const num = (v: unknown): number => (typeof v === 'number' || typeof v === 'bigint' ? Number(v) : 0);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');

export type Tier = { id: number; event: number; left: number; capacity: number };
export type Hold = {
  id: number;
  client: string;
  tier: number;
  state: string;
  qty: number;
  amount: number;
  note: string;
};
export type Ticket = { hold: number; state: string };
export type Wait = { id: number; state: string; hold: number; tier: number };
export type Entry = { id: number; ref: string; what: string; amount: number; card: string };
export type Card = { card: string; balance: number };
export type Event = { id: number; state: string };
/** Everything the invariants read. `events` is read only by the simulator's own checks. */
export type State = {
  tiers: Tier[];
  holds: Hold[];
  tickets: Ticket[];
  waitlist: Wait[];
  ledger: Entry[];
  cards: Card[];
  events?: Event[];
};

export const tierOf = (r: Raw): Tier => ({
  id: num(r['id']),
  event: num(r['event']),
  left: num(r['left']),
  capacity: num(r['capacity']),
});
export const holdOf = (r: Raw): Hold => ({
  id: num(r['id']),
  client: text(r['client']),
  tier: num(r['tier']),
  state: text(r['state']),
  qty: num(r['qty']),
  amount: num(r['amount']),
  note: text(r['note']),
});
export const ticketOf = (r: Raw): Ticket => ({ hold: num(r['hold']), state: text(r['state']) });
export const waitOf = (r: Raw): Wait => ({
  id: num(r['id']),
  state: text(r['state']),
  hold: num(r['hold']),
  tier: num(r['tier']),
});
export const entryOf = (r: Raw): Entry => ({
  id: num(r['id']),
  ref: text(r['ref']),
  what: text(r['what']),
  amount: num(r['amount']),
  card: text(r['card']),
});
export const cardOf = (r: Raw): Card => ({ card: text(r['card']), balance: num(r['balance']) });
export const eventOf = (r: Raw): Event => ({ id: num(r['id']), state: text(r['state']) });

/** The rows of a list that came as JSON: anything that is not a list of objects is no rows. */
export const rawRows = (v: unknown): Raw[] =>
  Array.isArray(v)
    ? v.flatMap((r: unknown) => (typeof r === 'object' && r !== null ? [Object.fromEntries(Object.entries(r))] : []))
    : [];
/** The state, read from what the service answered: tickets' GET /audit, pay's GET /ledger and /cards. */
export const stateFrom = (audit: unknown, ledger: unknown, cards: unknown): State => {
  const table = (name: string): Raw[] =>
    rawRows(typeof audit === 'object' && audit !== null ? Reflect.get(audit, name) : undefined);
  return {
    tiers: table('tiers').map(tierOf),
    holds: table('holds').map(holdOf),
    tickets: table('tickets').map(ticketOf),
    waitlist: table('waitlist').map(waitOf),
    ledger: rawRows(ledger).map(entryOf),
    cards: rawRows(cards).map(cardOf),
  };
};
type Read = (query: string) => Raw[];
/** The state, read from the two programs' databases. */
export const stateOf = (rows: Read, payRows: Read): State => ({
  tiers: rows('SELECT * FROM tiers').map(tierOf),
  holds: rows('SELECT * FROM holds').map(holdOf),
  tickets: rows('SELECT * FROM tickets').map(ticketOf),
  waitlist: rows('SELECT * FROM waitlist').map(waitOf),
  ledger: payRows('SELECT * FROM ledger').map(entryOf),
  cards: payRows('SELECT * FROM cards').map(cardOf),
});
