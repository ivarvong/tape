// world.ts: tickets.tape and pay.tape in node, wired as the service wires them (tickets' `pay` Remote reaches
// pay's exported methods; a once key is answered from pay's stored reply), with a clock the test moves, faults on
// the pay hop, and the invariants every scenario and planted bug is checked against.
import '../../node25.ts';
import { compile } from '../../compiler.ts';
import type { Built } from '../../compiler.ts';
import type { Problem } from '../../compiler/common.ts';
import { instantiate, responseOf } from '../../host.ts';
import type { Cell, Service } from '../../host.ts';
import { nodeSql } from '../../nodesql.ts';
import { std } from '../../std.ts';
import { invariants } from './invariants.ts';
import { readFlat } from '../../fmt.ts';

export { invariants, invariantsOf } from './invariants.ts';

const here = new URL('./', import.meta.url).pathname;
export const sources = {
  tickets: readFlat(`${here}tickets.tape`),
  pay: readFlat(`${here}pay.tape`),
};
const enc = new TextEncoder();
const dec = new TextDecoder();

// The clock: every now() and timer in both programs reads it; tests move it with world.advance(ms).
let clock = Date.parse('2026-11-17T20:00:00Z');
Date.now = (): number => clock;

export function compiled(
  text = sources.tickets,
): { errors: Problem[]; built?: undefined } | { errors?: undefined; built: Built } {
  const b = compile([...std, { name: 'program.tape', text }]);
  return b.wasm === null ? { errors: b.errors } : { built: b };
}

/** A fault on the pay hop. */
export type Fault = 'lost-before' | 'lost-after' | 'gate' | 'gate-lost';
/** What a request was answered with: `json` is the body when it is JSON, else null. */
export type Answer = { status: number; type: string | undefined; json: unknown; text: string };
type Row = Record<string, Cell>;
const jsonOf = (text: string): unknown => {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return null;
  }
};

// faults on the pay hop, taken in order, one per call:
//   'lost-before'  the call never reaches pay (an unknown outcome to the caller)
//   'lost-after'   pay runs and commits, and the reply is lost (an unknown outcome; the money moved)
//   'gate'         the call waits until world.open() (to interleave a timer or another request with it)
//   'gate-lost'    the call waits until world.open(), then never reaches pay (an unknown outcome, late)
function wired(tickets: Built, payBuilt: Built) {
  const paySql = nodeSql();
  const sql = nodeSql();
  const pay = instantiate(new WebAssembly.Module(payBuilt.wasm), { sql: paySql, name: 'ivar/pay' });
  const faults: Fault[] = [];
  const gates: (() => void)[] = [];
  const calls: { method: string; key: string | null; fault: Fault | null }[] = [];
  const service: Service = async (bytes, meta) => {
    const fault = faults.shift() ?? null;
    calls.push({ method: meta.method, key: meta.key, fault });
    if (fault === 'lost-before') throw new Error('lost before pay');
    if (fault === 'gate' || fault === 'gate-lost')
      await new Promise<void>(opened => {
        gates.push(opened);
      });
    if (fault === 'gate-lost') throw new Error('lost before pay, late');
    const r = await pay.serve({ method: meta.method, fingerprint: meta.fingerprint, key: meta.key }, bytes, {
      transaction: f => paySql.transaction(f),
    });
    if (fault === 'lost-after') throw new Error('lost after pay');
    return { status: r.status, body: r.body };
  };
  const app = instantiate(new WebAssembly.Module(tickets.wasm), {
    sql,
    name: 'ivar/tickets',
    services: { pay: service },
  });
  return { app, pay, sql, paySql, faults, gates, calls };
}

export type World = ReturnType<typeof running>;
function running(tickets: Built, payBuilt: Built) {
  const { app, pay, sql, paySql, faults, gates, calls } = wired(tickets, payBuilt);
  const tx = { transaction: <T>(f: () => T): T => sql.transaction(f) };
  const send = async (line: string, body: unknown = '', via: string | null = null): Promise<Answer> => {
    const [method = '', ...rest] = line.split(' ');
    const head = `${method} ${rest.join(' ')}${via === null ? '' : ` ${via}`}`;
    const sent = enc.encode(`${head}\n${typeof body === 'string' ? body : JSON.stringify(body)}`);
    const r = responseOf((await app.runLogged(sent, tx)).out);
    const text = dec.decode(r.body);
    return { status: r.status, type: r.type, json: jsonOf(text), text };
  };
  const rows = (q: string): Row[] =>
    sql
      .exec(q)
      .toArray()
      .map(r => ({ ...r }));
  const payRows = (q: string): Row[] =>
    paySql
      .exec(q)
      .toArray()
      .map(r => ({ ...r }));
  // every timer due now, until none is (a woken run may set more)
  const fire = async (limit = 200): Promise<{ key: number; status: string; body: string }[]> => {
    const ran: { key: number; status: string; body: string }[] = [];
    for (let i = 0; i < limit; i++) {
      const due = app.due(clock);
      if (due.length === 0) return ran;
      for (const key of due) {
        const r = await app.wake(key, { ...tx, now: clock });
        if (r) ran.push({ key, status: r.status, body: dec.decode(r.body) });
      }
    }
    throw new Error('timers kept firing');
  };
  return {
    errors: undefined,
    app,
    pay,
    sql,
    paySql,
    faults,
    calls,
    req: (line: string, body?: unknown): Promise<Answer> => send(line, body),
    pub: (line: string, body?: unknown): Promise<Answer> => send(line, body, 'public'),
    open: (): void => {
      for (const opened of gates.splice(0)) opened();
    },
    gated: (): number => gates.length,
    advance: (ms: number): void => {
      clock += ms;
    },
    now: (): number => clock,
    fire,
    rows,
    payRows,
    /** The first row of a query, or a row with no columns when there is none. */
    row: (q: string): Row => rows(q)[0] ?? {},
    payRow: (q: string): Row => payRows(q)[0] ?? {},
    check: (): string[] => invariants(rows, payRows),
  };
}

export function world({ tickets = sources.tickets }: { tickets?: string } = {}): Promise<
  World | { errors: Problem[] }
> {
  const tb = compiled(tickets);
  if (tb.errors) return Promise.resolve({ errors: tb.errors });
  const pb = compiled(sources.pay);
  if (pb.errors) throw new Error(`pay.tape: ${JSON.stringify(pb.errors)}`);
  return Promise.resolve(running(tb.built, pb.built));
}
