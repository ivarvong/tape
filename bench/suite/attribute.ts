// bench/suite/attribute.ts: where a Tape request's time goes, by bucket, with counts. Nothing in host/ is changed:
// the module's imports are wrapped as it is instantiated (WebAssembly.Instance is replaced for this process), the
// database's exec is wrapped, and JSON.parse / JSON.stringify are wrapped while a request runs. Each wrapper reads
// performance.now() twice per call; the instrumented total is printed beside the plain one so that cost is seen.
//   node bench/suite/attribute.ts [workload …] [--scale 1] [--samples 20] [--no-reductions]
// Buckets for Tape (log on, as shipped, and log off):
//   env.json    the host's JSON decode (decodeJson): JSON.parse, the shape check, nested values re-stringified
//               for their second decode, the copy into linear memory. JSON.parse and JSON.stringify inside it are
//               shown on their own lines.
//   env.sql     the host's SQL call: reading the parameters out of memory, the effect log entry, the database
//               (shown on its own: node:sqlite's prepare-cached statement and the stand-in's row objects, the
//               same code the JS twin calls), writing the rows into memory.
//   other env   ask, call, wake, allocated, trace.
//   copy        the request copied in, the answer copied out (and, log on, the effect log's head).
//   wasm        everything else between the start and the end of the request: the module's own code.
// The JS twin is split the same way: its JSON.parse / JSON.stringify, its database calls, and the rest.
import { compile } from '../../compiler.ts';
import { instantiate } from '../../host.ts';
import { nodeSql } from '../../nodesql.ts';
import type { NodeSql } from '../../nodesql.ts';
import { std } from '../../std.ts';
import { median, prime, programFiles, sourcesOf } from './common.ts';
import { NAMES, load } from './workloads.ts';

const argv = process.argv.slice(2);
const opt = (n: string): string | undefined => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
const scale = Number(opt('--scale') ?? '1');
const SAMPLES = Number(opt('--samples') ?? '20');
const names = argv.filter(
  (a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--scale') && !argv[i - 1]?.startsWith('--samples'),
);

// ---- the meters
type Meter = { n: number; ms: number };
const meters = new Map<string, Meter>();
let on = false;
const meter = (k: string): Meter => {
  const m = meters.get(k) ?? { n: 0, ms: 0 };
  meters.set(k, m);
  return m;
};
// the env call being answered, so a JSON.parse is charged to env.json or env.sql (the log) or the JS twin
let inside = '';
function timed<A extends unknown[], R>(k: string, f: (...a: A) => R, nest = false): (...a: A) => R {
  return (...a: A): R => {
    if (!on) return f(...a);
    const m = meter(nest ? k : `${k}@${inside}`);
    const was = inside;
    if (nest) inside = k;
    const t = performance.now();
    try {
      return f(...a);
    } finally {
      m.ms += performance.now() - t;
      m.n++;
      inside = was;
    }
  };
}
const isFunction = (x: unknown): x is (...a: never[]) => unknown => typeof x === 'function';
const RealInstance = WebAssembly.Instance;
// @ts-expect-error -- replaced for this process only, to wrap the imports the host passes
WebAssembly.Instance = function (module: WebAssembly.Module, imports?: WebAssembly.Imports): WebAssembly.Instance {
  const env = imports?.['env'] ?? {};
  const wrapped = Object.fromEntries(
    Object.entries(env).map(([n, f]) => [n, isFunction(f) ? timed(`env.${n}`, f, true) : f]),
  );
  return new RealInstance(module, { ...imports, env: wrapped });
};
const realParse = JSON.parse,
  realStringify = JSON.stringify;
JSON.parse = timed('JSON.parse', realParse);
// the wrapper has only the last overload's type, and passes every argument on: defined, not assigned, for that
Object.defineProperty(JSON, 'stringify', { value: timed('JSON.stringify', realStringify), writable: true });
function meteredDb(): NodeSql {
  const db = nodeSql();
  return { exec: timed('db.exec', db.exec), transaction: db.transaction };
}

const fmt = (x: number): string => (x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2));
type Row = { bucket: string; ms: number; n: number };
async function measure(
  run: (req: Uint8Array) => Promise<Uint8Array> | Uint8Array,
  reqs: Uint8Array[],
): Promise<{ total: number; rows: Map<string, { ms: number[]; n: number[] }> }> {
  const WARM = 10;
  const rows = new Map<string, { ms: number[]; n: number[] }>();
  const totals: number[] = [];
  for (const [k, req] of reqs.entries()) {
    meters.clear();
    on = true;
    const t = performance.now();
    await run(req);
    const took = performance.now() - t;
    on = false;
    if (k < WARM) continue;
    totals.push(took);
    for (const [b, m] of meters) {
      const r = rows.get(b) ?? { ms: [], n: [] };
      rows.set(b, r);
      r.ms.push(m.ms);
      r.n.push(m.n);
    }
    const r = rows.get('total') ?? { ms: [], n: [] };
    rows.set('total', r);
    r.ms.push(took);
    r.n.push(1);
  }
  return { total: median(totals), rows };
}
async function plain(run: (req: Uint8Array) => Promise<Uint8Array> | Uint8Array, reqs: Uint8Array[]): Promise<number> {
  const ms: number[] = [];
  for (const [k, req] of reqs.entries()) {
    const t = performance.now();
    await run(req);
    if (k >= 10) ms.push(performance.now() - t);
  }
  return median(ms);
}
const med = (r: { ms: number[]; n: number[] } | undefined): Row | null =>
  r ? { bucket: '', ms: median(r.ms), n: median(r.n) } : null;

function print(title: string, plainMs: number, m: Awaited<ReturnType<typeof measure>>, kind: 'tape' | 'js'): void {
  const get = (k: string): Row => med(m.rows.get(k)) ?? { bucket: k, ms: 0, n: 0 };
  const total = get('total').ms;
  const lines: [string, number, number][] = [];
  if (kind === 'tape') {
    const json = get('env.json'),
      sql = get('env.sql'),
      db = get('db.exec@env.sql'),
      parse = get('JSON.parse@env.json'),
      str = get('JSON.stringify@env.json'),
      logStr = get('JSON.stringify@env.sql'),
      outside = get('JSON.stringify@');
    const otherEnv = [...m.rows.keys()]
      .filter(k => k.startsWith('env.') && k !== 'env.json' && k !== 'env.sql')
      .reduce((s, k) => s + get(k).ms, 0);
    const otherN = [...m.rows.keys()]
      .filter(k => k.startsWith('env.') && k !== 'env.json' && k !== 'env.sql')
      .reduce((s, k) => s + get(k).n, 0);
    // JSON.parse inside env.json; outside it (the log's own JSON.stringify of parameters) counts in env.sql / copy
    lines.push(
      ['env.json (host JSON decode)', json.ms, json.n],
      ['  of which JSON.parse (body, then each element)', parse.ms, parse.n],
      ['  of which JSON.stringify (elements handed on)', str.ms, str.n],
      ['  of which shape check + copy into memory', json.ms - parse.ms - str.ms, 0],
      ['env.sql (host SQL call)', sql.ms, sql.n],
      ['  of which the database (db.exec)', db.ms, db.n],
      ['  of which JSON.stringify of params (log)', logStr.ms, logStr.n],
      ['  of which params, rows, log entry', sql.ms - db.ms - logStr.ms, sql.n],
      ...(outside.n > 0
        ? [((): [string, number, number] => ['JSON.stringify outside env (log)', outside.ms, outside.n])()]
        : []),
      ['other env.* calls', otherEnv, otherN],
      ['wasm + copy in/out (the rest)', total - (json.ms + sql.ms + otherEnv + outside.ms), 0],
    );
  } else {
    const db = get('db.exec@'),
      parse = get('JSON.parse@'),
      str = get('JSON.stringify@');
    lines.push(
      ['JSON.parse', parse.ms, parse.n],
      ['JSON.stringify', str.ms, str.n],
      ['the database (db.exec)', db.ms, db.n],
      ['JS (the rest)', total - parse.ms - str.ms - db.ms, 0],
    );
  }
  console.log(`  ${title}: ${fmt(total)} ms instrumented, ${fmt(plainMs)} ms plain`);
  for (const [b, ms, n] of lines)
    console.log(
      `    ${b.padEnd(40)} ${fmt(ms).padStart(7)} ms ${((ms / total) * 100).toFixed(0).padStart(4)}%  ${n ? `${n} calls` : ''}`,
    );
}

for (const name of names.length > 0 ? names : NAMES) {
  const w = await load(name);
  const realNow = Date.now;
  const pinned = w.now;
  if (pinned !== undefined) Date.now = () => pinned;
  const r = compile(
    [...std, ...programFiles(sourcesOf(w), w.baseNames === true)],
    argv.includes('--no-reductions') ? { reductions: false } : {},
  );
  if (!r.wasm) throw new Error(`${w.name} does not compile`);
  const module = new WebAssembly.Module(r.wasm);
  const reqs = Array.from({ length: 10 + SAMPLES }, (_, k) => w.request(k, scale));
  console.log(`${name}: ${w.describe}; ${reqs[0]?.length} bytes a request (scale ${scale})`);
  const modes = w.twin === false ? (['tape-log', 'tape-nolog'] as const) : (['js', 'tape-log', 'tape-nolog'] as const);
  for (const mode of modes) {
    const make = (): ((req: Uint8Array) => Promise<Uint8Array> | Uint8Array) => {
      const db = w.sql ? meteredDb() : null;
      if (mode === 'js') {
        const h = w.js(db);
        if (db) w.seed?.(db);
        return db ? req => db.transaction(() => h(req)) : h;
      }
      const app = instantiate(module, { ...(db ? { sql: db } : {}), name, log: mode === 'tape-log' });
      if (db) w.seed?.(db);
      if (mode === 'tape-nolog') return db ? req => app.handleIn(f => db.transaction(f), req) : req => app.handle(req);
      return async req => (await app.runLogged(req, db ? { transaction: f => db.transaction(f) } : {})).out;
    };
    // one database for the plain pass and another for the measured pass; opening runs before either is timed.
    // fresh starts a database inside the request, so a write is never a cache hit
    const ready = async (): Promise<(req: Uint8Array) => Promise<Uint8Array> | Uint8Array> => {
      if (w.fresh === true) {
        return async req => {
          const one = make();
          await prime(w, one, 0);
          return one(req);
        };
      }
      const one = make();
      await prime(w, one, 0);
      return one;
    };
    const p = await plain(await ready(), reqs);
    const m = await measure(await ready(), reqs);
    print(mode, p, m, mode === 'js' ? 'js' : 'tape');
  }
  Date.now = realNow;
}
