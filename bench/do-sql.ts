// bench/do-sql.ts: what it costs, in a Durable Object's SQLite, to learn how many rows a write changed. A worker with
// one SQLite-backed Durable Object runs in local workerd (service/node_modules/.bin); each request runs n single-row
// writes (`INSERT … ON CONFLICT(k) DO NOTHING` into a table with a TEXT primary key; every other key repeats, so half
// change nothing) in one transaction, and reads the count one of these ways:
//   none        no count (the write alone)
//   ask         `SELECT changes()` after the write: what host/run.ts does for a sql_exec on a Durable Object
//   returning   the write `RETURNING 1`, its rows counted
//   rows        the cursor's rowsWritten: counts every b-tree row, so 2 for a row inserted here (wrong: not used)
// The ways take turns request by request (the order alternating each round), each on a Durable Object of its own.
// The clock inside workerd does not move while code runs, so each time is a fetch round trip from here, minus the
// median of an empty one, per write.
//   node bench/do-sql.ts [--n 2000] [--rounds 30] [--bin <dir with workerd>]
import '../node25.ts';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { loadavg, tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { median } from './suite/common.ts';

const argv = process.argv.slice(2);
const opt = (n: string, d: string): string => (argv.includes(n) ? (argv[argv.indexOf(n) + 1] ?? d) : d);
const N = Number(opt('--n', '2000'));
const ROUNDS = Number(opt('--rounds', '30'));
const bin = opt('--bin', new URL('../service/node_modules/.bin', import.meta.url).pathname);
const WAYS = ['none', 'ask', 'returning', 'rows'] as const;

const WORKER = `export class Db {
  constructor(ctx) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY NOT NULL, v INTEGER NOT NULL)');
    this.n = 0;
  }
  async fetch(req) {
    const u = new URL(req.url);
    const way = u.searchParams.get('way');
    const n = Number(u.searchParams.get('n'));
    const base = this.n;
    this.n += n;
    const q = 'INSERT INTO kv(k, v) VALUES (?, ?) ON CONFLICT(k) DO NOTHING';
    let sum = 0;
    this.ctx.storage.transactionSync(() => {
      for (let i = 0; i < n; i++) {
        const k = 'k' + (base + i - (i % 2));
        if (way === 'none') this.sql.exec(q, k, i).raw().toArray();
        else if (way === 'ask') {
          this.sql.exec(q, k, i).raw().toArray();
          sum += Number(this.sql.exec('SELECT changes()').raw().toArray()[0][0]);
        } else if (way === 'returning') sum += this.sql.exec(q + ' RETURNING 1', k, i).raw().toArray().length;
        else if (way === 'rows') sum += this.sql.exec(q, k, i).rowsWritten;
      }
    });
    return new Response(String(sum));
  }
}
export default {
  fetch(req, env) {
    return env.DB.get(env.DB.idFromName(new URL(req.url).searchParams.get('db') ?? 'x')).fetch(req);
  },
};
`;

const dir = mkdtempSync(`${tmpdir()}/tape-do-sql-`);
mkdirSync(`${dir}/store`);
writeFileSync(`${dir}/worker.js`, WORKER);
const PORT = 8890 + Math.floor(Math.random() * 100);
writeFileSync(
  `${dir}/config.capnp`,
  `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [(name = "main", worker = .w), (name = "disk", disk = (path = "${dir}/store", writable = true))],
  sockets = [(name = "http", address = "127.0.0.1:${PORT}", http = (), service = "main")],
);
const w :Workerd.Worker = (
  modules = [(name = "worker.js", esModule = embed "worker.js")],
  compatibilityDate = "2025-09-01",
  durableObjectNamespaces = [(className = "Db", uniqueKey = "tape-do-sql", enableSql = true)],
  durableObjectStorage = (localDisk = "disk"),
  bindings = [(name = "DB", durableObjectNamespace = "Db")],
);
`,
);
const server = spawn(`${bin}/workerd`, ['serve', `${dir}/config.capnp`], { stdio: ['ignore', 'ignore', 'inherit'] });
try {
  const time = async (q: string): Promise<[number, string]> => {
    const t = performance.now();
    const r = await fetch(`http://127.0.0.1:${PORT}/?${q}`);
    const body = await r.text();
    if (!r.ok) throw new Error(`${q}: ${r.status} ${body}`);
    return [performance.now() - t, body];
  };
  for (let i = 0; ; i++) {
    try {
      await time('way=none&n=0&db=empty');
      break;
    } catch (e) {
      if (i > 400) throw e;
      await sleep(25);
    }
  }
  const ms: Record<string, number[]> = Object.fromEntries(WAYS.map(w => [w, []]));
  const counts: Record<string, string> = {};
  for (let r = 0; r < ROUNDS + 5; r++)
    for (const way of r % 2 === 0 ? WAYS : WAYS.toReversed()) {
      const [took, body] = await time(`way=${way}&n=${N}&db=${way}`);
      counts[way] = body;
      if (r >= 5) ms[way]?.push(took);
    }
  const empty: number[] = [];
  for (let r = 0; r < 30; r++) empty.push((await time('way=none&n=0&db=empty'))[0]);
  const version = execFileSync(`${bin}/workerd`, ['--version'], { encoding: 'utf8' }).trim();
  console.log(
    `${version}; ${N} writes a request (${N / 2} change a row), median of ${ROUNDS}; empty fetch ${median(empty).toFixed(2)} ms; load ${loadavg()
      .map(x => x.toFixed(1))
      .join(' ')}`,
  );
  const per = (w: string): number => ((median(ms[w] ?? []) - median(empty)) / N) * 1000;
  for (const w of WAYS)
    console.log(
      `${w.padEnd(10)} ${median(ms[w] ?? [])
        .toFixed(2)
        .padStart(
          7,
        )} ms  ${per(w).toFixed(2).padStart(5)} µs a write  (+${(per(w) - per('none')).toFixed(2)} over none)  count ${counts[w]}`,
    );
} finally {
  server.kill();
}
