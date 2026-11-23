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
import { NO_TIMERS, TimedOut, instantiate, replay } from '../host.ts';
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
// Overlapping sends of one key. A Durable Object interleaves requests while one awaits a call, so a retry of a key
// can arrive while the first send's run waits on its own call. The callee here charges (counting its runs) and then
// calls a bank. Two sends of one key start together; at each bank call the bank answers, times out or is
// unreachable, and each commit of a run's transaction either goes through or fails with a storage error; then one
// last send of the key with nothing failing.
//   facts: the charge ran once, plus once for each run that failed after its first stretch committed (a run that
//   fails part way has committed what came before its call, and the key runs again); every send answered ok or
//   rejected got the reply stored for the key; a send that got no reply failed on storage, and nothing else; no
//   claim is left. The host before 22 November 2026 checked for a stored reply but claimed nothing, and broke them
//   in every schedule where both sends' first stretches commit: both ran the charge, and the second failed storing
//   its reply (9 of its 40 schedules).
const PAY = (() => {
  const text = `schema "CREATE TABLE IF NOT EXISTS charges(who TEXT PRIMARY KEY, n INTEGER NOT NULL)"
type Pay { Pay(who: View) }
type Done { Done(n: Int) }
type Ack { Ack(ok: Int) }
export fn pay(db: Sql, bank: Remote, message: Pay) -> Result[Done, View] {
  do sql_exec(
    query: "INSERT INTO charges(who, n) VALUES (:who, 1) ON CONFLICT(who) DO UPDATE SET n = n + 1",
    who: message.who
  )
  let Ok(value: Ack(ok)) = call(to: bank, method: "ack", send: Ack(ok: 1), reply: Ack, within: 1000, once: message.who) else -> Err(
    error: "bank"
  )
  Ok(value: Done(n: ok))
}
`;
  const r = compile([...std, { name: 'pay', text }], { rules: false });
  if (r.wasm === null) throw new Error(JSON.stringify(r.errors[0]));
  return { module: new WebAssembly.Module(r.wasm), fingerprint: r.methods[0]?.fingerprint ?? '' };
})();
const BANK = ['answers', 'times out', 'unreachable'],
  COMMIT = ['commits', 'storage error'];
class Busy extends Error {}

async function overlap(prefix: readonly number[]): Promise<{ taken: string[]; wrong: string[] }> {
  const taken: string[] = [];
  let at = 0,
    reliable = false;
  const choose = (of: string[]): number => {
    if (reliable) return 0;
    const c = prefix[at++] ?? 0;
    taken.push(of[c] ?? '?');
    return c;
  };
  const sql = nodeSql(),
    waiting: (() => void)[] = [];
  const bank: Service = async () => {
    const c = choose(BANK);
    if (!reliable)
      await new Promise<void>(go => {
        waiting.push(go);
      });
    if (c === 1) throw new TimedOut();
    return c === 2 ? { status: 'unreachable' } : enc.encode('{"ok":1}');
  };
  const callee = instantiate(PAY.module, { sql, name: 'callee', services: { bank }, timers: NO_TIMERS });
  const runs = (): number => Number(sql.exec("SELECT n FROM charges WHERE who = 'bob'").raw().toArray()[0]?.[0] ?? 0);
  let extra = 0;
  const transaction = <T>(f: () => T): T =>
    sql.transaction(() => {
      const before = runs(),
        r = f();
      if (choose(COMMIT) === 1) {
        // a stretch after the first (it charged nothing and leaves a row for the key; clearing a claim leaves none):
        // the charge made before its call stands, and the key runs again
        if (runs() === before && sql.exec('SELECT 1 FROM _calls').toArray().length > 0) extra++;
        throw new Busy('SQLITE_BUSY: injected at commit');
      }
      return r;
    });
  const meta = { method: 'pay', fingerprint: PAY.fingerprint, key: 'caller/pay/bob' };
  const body = enc.encode('{"who":"bob"}');
  const send = (): Promise<Served | Error> =>
    callee.serve(meta, body, { transaction }).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));
  let settled = 0;
  const count = (r: Served | Error): Served | Error => {
    settled++;
    return r;
  };
  const sends = [send().then(count), send().then(count)];
  while (settled < sends.length) {
    await new Promise(go => {
      setImmediate(go);
    });
    waiting.shift()?.();
  }
  reliable = true;
  const last = await send();
  const replies = [...(await Promise.all(sends)), last],
    wrong: string[] = [];
  const [stored] = sql.exec('SELECT status, body FROM _calls').raw().toArray();
  const storedText = stored ? `${cellText(stored[0])} ${cellText(stored[1])}` : 'none';
  if (stored?.[0] === 'pending') wrong.push('a claim is left');
  for (const r of replies)
    if (r instanceof Error) {
      if (!(r instanceof Busy)) wrong.push(`a send failed: ${r.message}`);
    } else if (r.status === 'ok' || r.status === 'rejected') {
      const got = `${r.status} ${dec.decode(r.body)}`;
      if (got !== storedText) wrong.push(`a send got ${got}, the key's stored reply is ${storedText}`);
    } else if (r !== last) {
      if (r.status !== 'unreachable') wrong.push(`a send got ${r.status}`);
    } else wrong.push(`the last send got ${r.status}`);
  if (runs() !== 1 + extra) wrong.push(`the charge ran ${runs()} times, expected ${1 + extra}`);
  return { taken, wrong };
}
export async function exploreOverlap(): Promise<{ schedules: number; violations: Violation[] }> {
  let schedules = 0;
  const violations: Violation[] = [];
  const visit = async (prefix: readonly number[]): Promise<void> => {
    const { taken, wrong } = await overlap(prefix);
    schedules++;
    if (wrong.length > 0) violations.push({ schedule: taken, wrong });
    for (let i = prefix.length; i < taken.length; i++) {
      const of = taken[i] !== undefined && COMMIT.includes(taken[i] ?? '') ? COMMIT : BANK;
      for (let c = 1; c < of.length; c++)
        await visit([...prefix, ...Array.from({ length: i - prefix.length }, () => 0), c]);
    }
  };
  await visit([]);
  return { schedules, violations };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const o = await exploreOverlap();
  console.log(
    `overlapping sends of one key: ${o.schedules} schedules, ${o.violations.length} violations; first: ${JSON.stringify(o.violations[0] ?? null)}`,
  );
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
    o.schedules < 60 ? `only ${o.schedules} schedules of overlapping sends` : '',
    o.violations.length > 0 ? `${o.violations.length} schedules of overlapping sends violate` : '',
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
