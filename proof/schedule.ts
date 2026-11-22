// proof/schedule.ts: every schedule of a small scenario, run on the real host and the real programs.
// All uncertainty between two objects is at the call: it is delivered and answered, delivered with the answer
// lost, never delivered, or delivered twice. The explorer runs the scenario once for every combination of those
// outcomes at every call, and checks the same facts at the end of each run.
//   scenario: one lamp in stock; two orders for it; two rounds of retries with the same uncertainty; then a
//   last round of retries with reliable delivery.
//   facts: nothing is left pending; exactly one order is confirmed and one refused; stock is 0, never negative;
//   every request replays from its log to the same bytes.
// explore({ keys: false }) removes the idempotency keys; the explorer must then find a violation.
import { readFileSync } from 'node:fs';
import { compile } from '../compiler.ts';
import { TimedOut, instantiate, replay } from '../host.ts';
import type { Effect, Service, ServiceOptions, Served } from '../host.ts';
import { nodeSql } from '../nodesql.ts';
import { std } from '../std.ts';
import { cellText } from '../host/log.ts';
const src = (n: string): { name: string; text: string } => ({
  name: n,
  text: readFileSync(new URL(`../${n}`, import.meta.url), 'utf8'),
});
const build = (n: string): WebAssembly.Module => {
  const r = compile([...std, src(`examples/${n}.tape`)]);
  if (r.wasm === null) throw new Error(JSON.stringify(r.errors[0]));
  return new WebAssembly.Module(r.wasm);
};
const ORDERS = build('orders'),
  STOCK = build('stock'),
  enc = new TextEncoder(),
  dec = new TextDecoder();
export const OUTCOMES = ['answered', 'answer lost', 'never delivered', 'delivered twice'];

type Order = { id: number; state: string };
const field = (o: unknown, name: string): unknown =>
  typeof o === 'object' && o !== null ? Object.fromEntries(Object.entries(o))[name] : undefined;
/** The orders in an answer to GET /orders. */
function ordersIn(answer: string): Order[] {
  const parsed: unknown = JSON.parse(answer.slice(4));
  return Array.isArray(parsed)
    ? parsed.map((o: unknown) => ({ id: Number(field(o, 'id')), state: String(field(o, 'state')) }))
    : [];
}

async function run(
  prefix: readonly number[],
  { keys }: { keys: boolean },
): Promise<{ taken: number[]; wrong: string[] }> {
  const taken: number[] = [];
  let reliable = false;
  const choose = (): number => {
    const c = reliable ? 0 : (prefix[taken.length] ?? 0);
    if (!reliable) taken.push(c);
    return c;
  };
  const stockSql = nodeSql(),
    stock = instantiate(STOCK, { sql: stockSql, name: 'stock' });
  stockSql.exec("UPDATE stock SET remaining = 1 WHERE item = 'lamp'");
  const serve = (b: Uint8Array, m: ServiceOptions): Promise<Served> =>
    stock.serve(keys ? m : { ...m, key: null }, b, { transaction: f => stockSql.transaction(f) });
  const service: Service = async (b, m) => {
    const c = choose();
    if (c === 2) throw new TimedOut();
    const answer = await serve(b, m);
    if (c === 3) await serve(b, m);
    if (c === 1) throw new TimedOut();
    return answer;
  };
  const sql = nodeSql(),
    orders = instantiate(ORDERS, { sql, services: { stock: service }, name: 'orders' }),
    ran: { req: Uint8Array; out: Uint8Array; log: Effect[] }[] = [];
  const send = async (text: string): Promise<string> => {
    const req = enc.encode(text),
      r = await orders.runLogged(req, { transaction: f => sql.transaction(f) });
    ran.push({ req, out: r.out, log: r.effects });
    return dec.decode(r.out);
  };
  const states = async (): Promise<Order[]> => ordersIn(await send('GET /orders\n'));
  await send('POST /orders\n{"key":"first","item":"lamp"}');
  await send('POST /orders\n{"key":"second","item":"lamp"}');
  for (let round = 0; round < 3; round++) {
    reliable = round === 2;
    for (const o of await states()) if (o.state === 'pending') await send(`POST /retry/${o.id}\n`);
  }
  const end = await states(),
    left = stockSql.exec("SELECT remaining FROM stock WHERE item = 'lamp'").raw().toArray()[0]?.[0],
    wrong: string[] = [];
  const n = (s: string): number => end.filter(o => o.state === s).length;
  if (n('pending') > 0) wrong.push(`${n('pending')} order left pending`);
  if (n('confirmed') !== 1 || n('refused') !== 1)
    wrong.push(`${n('confirmed')} confirmed and ${n('refused')} refused, for one lamp`);
  if (left !== 0) wrong.push(`stock ended at ${cellText(left)}`);
  for (const r of ran)
    if (dec.decode(replay(ORDERS, r.req, r.log)) !== dec.decode(r.out)) {
      wrong.push('a request did not replay to the same bytes');
      break;
    }
  return { taken, wrong };
}
// Every vector of outcomes: run a prefix, see how many calls that run made, then branch at each call after the prefix.
type Violation = { schedule: (string | undefined)[]; wrong: string[] };
export async function explore({ keys = true }: { keys?: boolean } = {}): Promise<{
  schedules: number;
  calls: number;
  longest: number;
  violations: Violation[];
}> {
  let schedules = 0,
    calls = 0,
    longest = 0;
  const violations: Violation[] = [];
  const visit = async (prefix: readonly number[]): Promise<void> => {
    const { taken, wrong } = await run(prefix, { keys });
    schedules++;
    calls += taken.length;
    longest = Math.max(longest, taken.length);
    if (wrong.length > 0) violations.push({ schedule: taken.map(c => OUTCOMES[c]), wrong });
    for (let i = prefix.length; i < taken.length; i++)
      for (let c = 1; c < OUTCOMES.length; c++) await visit([...taken.slice(0, i), c]);
  };
  await visit([]);
  return { schedules, calls, longest, violations };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const t = Date.now(),
    a = await explore();
  console.log(
    `with keys: ${a.schedules} schedules, ${a.calls} calls, up to ${a.longest} calls in one, ${a.violations.length} violations, ${Date.now() - t} ms`,
  );
  if (a.violations.length > 0) console.log(JSON.stringify(a.violations[0]));
  const b = await explore({ keys: false });
  console.log(
    `keys removed: ${b.schedules} schedules, ${b.violations.length} violations; first: ${JSON.stringify(b.violations[0] ?? null)}`,
  );
  // An explorer that explores nothing proves nothing: from 15 to 19 November 2026 the orders it sent lacked a key the
  // program had come to require, every request was refused, no call was made, and this printed its one schedule and
  // exited 0. It now fails unless the search is the size it is known to be, clean with keys, and dirty without.
  const wrong = [
    a.schedules < 400 || a.calls < 2000
      ? `only ${a.schedules} schedules and ${a.calls} calls: the scenario no longer reaches its calls`
      : '',
    a.violations.length > 0 ? `${a.violations.length} schedules violate with keys` : '',
    b.violations.length > 0
      ? ''
      : 'no schedule violates with the keys removed: the explorer cannot see the fault it exists to see',
  ].filter(Boolean);
  if (wrong.length > 0) {
    console.log(`FAILED: ${wrong.join('; ')}`);
    process.exit(1);
  }
}
