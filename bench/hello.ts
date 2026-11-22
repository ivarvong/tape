// bench/hello.ts: one request of examples/hello.tape (a route, an upsert in SQLite, a greeting) against the same
// request written by hand in JavaScript on the same database, each in a transaction of its own. It says what the
// effect log costs: the program is run with the log on (as it ships: every statement, its values and its rows
// recorded, and the trace computed from that) and with it off. First the same answers, then microseconds per
// request (median of 15 batches after warm-up). Local numbers, one machine, SQLite in memory.
import '../node25.ts';
import { instantiate } from '../host.ts';
import { nodeSql } from '../nodesql.ts';
import type { NodeSql } from '../nodesql.ts';
import { built, moduleOf, read } from '../test/harness.ts';

const dec = new TextDecoder();
const enc = new TextEncoder();
const module = moduleOf(built([{ name: 'examples/hello.tape', text: read('examples/hello.tape') }]));

/** The request by hand: the route, the statement, the answer, as the program writes them. */
const byHand =
  (sql: NodeSql) =>
  (bytes: Uint8Array): Uint8Array => {
    // the method, a space, and the path up to the end of the line
    const [line = ''] = dec.decode(bytes).split('\n');
    const space = line.indexOf(' ');
    const [method, path] = [line.slice(0, Math.max(space, 0)), line.slice(space + 1)];
    const name = path.slice('/hello/'.length);
    if (method !== 'GET' || !path.startsWith('/hello/') || name === '') return enc.encode('404\nno such route');
    return sql.transaction(() => {
      const [row] = sql
        .exec('INSERT INTO greeted(name, n) VALUES (?1, 1) ON CONFLICT(name) DO UPDATE SET n = n + 1 RETURNING n', name)
        .toArray();
      const n = Number(row?.['n']);
      return enc.encode(n === 1 ? `200\nHello, ${name}` : `200\nHello again, ${name} #${n}!`);
    });
  };

type Run = (bytes: Uint8Array) => Promise<Uint8Array> | Uint8Array;
/** The three ways to answer, each on a database of its own. */
const ways = (): readonly (readonly [string, Run])[] => {
  const logged = nodeSql(),
    plain = nodeSql(),
    hand = nodeSql();
  const withLog = instantiate(module, { sql: logged, name: 'hello' });
  const withoutLog = instantiate(module, { sql: plain, name: 'hello', log: false });
  hand.exec('CREATE TABLE IF NOT EXISTS greeted(name TEXT PRIMARY KEY, n INTEGER NOT NULL)');
  return [
    ['by hand', byHand(hand)],
    ['tape, log off', b => plain.transaction(() => withoutLog.handle(b))],
    ['tape, log on', async b => (await withLog.runLogged(b, { transaction: f => logged.transaction(f) })).out],
  ];
};

// ---- the same answers: new names, names seen before, and requests that are no route
const requests = [
  ...Array.from({ length: 200 }, (_, i) => `GET /hello/name-${i % 37}`),
  'GET /hello/',
  'POST /hello/ada',
  'GET /nope',
  'GET /hello/é ü',
].map(t => enc.encode(t));
const answers: string[][] = [];
for (const [, run] of ways()) {
  const got: string[] = [];
  for (const b of requests) got.push(dec.decode(await run(b)));
  answers.push(got);
}
const [want = [], ...others] = answers;
const wrong = others.flatMap(got =>
  got.flatMap((a, i) => (a === want[i] ? [] : [`${dec.decode(requests[i])}: ${a} / ${want[i]}`])),
);
for (const w of wrong.slice(0, 5)) console.log(`DIFF ${w}`);
console.log(`${requests.length} requests answered three ways, ${wrong.length} differ`);

// ---- time per request
const median = (a: readonly number[]): number => a.toSorted((x, y) => x - y)[a.length >> 1] ?? 0;
const EACH = 2000;
const time = async (run: Run): Promise<number> => {
  const request = (i: number): Uint8Array => enc.encode(`GET /hello/name-${i % 500}`);
  for (let i = 0; i < EACH; i++) await run(request(i));
  const batches: number[] = [];
  for (let k = 0; k < 15; k++) {
    const t = performance.now();
    for (let i = 0; i < EACH; i++) await run(request(i));
    batches.push(((performance.now() - t) / EACH) * 1000);
  }
  return median(batches);
};
const times: (readonly [string, number])[] = [];
for (const [name, run] of ways()) times.push([name, await time(run)]);
const base = times[0]?.[1] ?? 1;
for (const [name, t] of times)
  console.log(`${name.padEnd(14)} ${t.toFixed(1).padStart(6)} µs per request  ${(t / base).toFixed(2)}× by hand`);
process.exit(wrong.length > 0 ? 1 : 0);
