// bench/sweep-one.ts: one cell of bench/sweep.ts in this process, printed as one JSON line. sweep.ts starts it
// under the V8 flags of the tier.
//   node [flags] bench/sweep-one.ts <workload> time <scale> <samples>
//   node bench/sweep-one.ts <workload> mem <js|tape> <scale>
//   node bench/sweep-one.ts <workload> cold <js|tape>
// time: the JS twin and Tape (log on, as the service runs it), each on a fresh database of its own, warmed up
//   (≥10 requests and ≥300 ms of each, at most 2,000), then `samples` requests with fresh keys, the two taking
//   turns (the order alternating) so load from other processes falls on both alike. The first request's answers
//   are compared byte for byte. For Tape, each request's steps (the module's `cost` global, the count the
//   50,000,000-step budget holds) and arena bytes (app.bytesUsed, the log head's `bytes`) are read after it.
// mem: one way alone, 5 requests at the size, then the process's peak RSS (getrusage maxrss) against its peak
//   before the first request, V8's peak heap (sampled after each request), and for Tape the linear memory's size.
// cold: the first request of this process: Tape compiles the stored Wasm, instantiates it (its schema), then
//   answers; JS sets up its schema, then answers. The request is made before the clock starts.
// compile: the hosted compile of the workload's program with std (compiler.ts compile, as the service does on a
//   deploy): the first in this process, then the median of 10 more; the Wasm's size; WebAssembly.Module of it.
//   node bench/sweep-one.ts <workload> compile
import '../node25.ts';
import { readFileSync } from 'node:fs';
import { getHeapStatistics } from 'node:v8';
import { compile } from '../compiler.ts';
import { instantiate } from '../host.ts';
import { std } from '../std.ts';
import { prime, programFiles, ROOT, sourcesOf } from './suite/common.ts';
import { nodeSql } from '../nodesql.ts';
import type { Workload } from './suite/common.ts';
import { wasmPath } from './suite/wasm.ts';
import { load } from './suite/workloads.ts';

const [name = 'crud', kind = 'time', ...rest] = process.argv.slice(2);
const w = await load(name);
const pinnedNow = w.now;
if (pinnedNow !== undefined) Date.now = () => pinnedNow;

type Tape = {
  run: (req: Uint8Array) => Promise<Uint8Array>;
  steps: () => number;
  bytes: () => number;
  mem: () => number;
};
// TAPE_ASK_CHANGES=1: Tape's database hides the count node:sqlite gives with a write, as Durable Object SQLite's
// cursor does, so the host asks `SELECT changes()` after each sql_exec (the A side of an A/B of that)
const ASK = process.env['TAPE_ASK_CHANGES'] === '1';
function tapeWay(wl: Workload, module: WebAssembly.Module): Tape {
  const db = wl.sql ? nodeSql() : null;
  const sql =
    db && ASK
      ? {
          exec: (q: string, ...p: Parameters<typeof db.exec>[1][]) => {
            const { changes: _, ...cursor } = db.exec(q, ...p);
            return cursor;
          },
        }
      : db;
  const app = instantiate(module, { ...(sql ? { sql } : {}), name: wl.name, log: true });
  if (db) wl.seed?.(db);
  const cost = app.exports['cost'];
  const memory = app.exports['memory'];
  return {
    run: async req => (await app.runLogged(req, db ? { transaction: f => db.transaction(f) } : {})).out,
    steps: () => (cost instanceof WebAssembly.Global ? Number(cost.value) : NaN),
    bytes: () => app.bytesUsed,
    mem: () => (memory instanceof WebAssembly.Memory ? memory.buffer.byteLength : NaN),
  };
}
function jsWay(wl: Workload): (req: Uint8Array) => Uint8Array {
  const db = wl.sql ? nodeSql() : null;
  const h = wl.js(db);
  if (db) wl.seed?.(db);
  return db ? req => db.transaction(() => h(req)) : h;
}
const bytesOf = (): Uint8Array => readFileSync(wasmPath(sourcesOf(w), w.baseNames === true));
const jsAsked = kind === 'time' || ((kind === 'mem' || kind === 'cold') && (rest[0] ?? 'js') === 'js');
if (jsAsked && w.twin === false) throw new Error(`${w.name} has no JS twin; pass tape for mem or cold`);
if ((kind === 'time' || kind === 'mem') && w.fresh === true)
  throw new Error(`${w.name} starts a database per request; node bench/suite/one.ts ${w.name} tape-nolog warm 1`);
const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const print = (x: unknown): void => console.log(JSON.stringify(x));

if (kind === 'time') {
  const scale = Number(rest[0] ?? '1');
  const samples = Number(rest[1] ?? '30');
  const tape = tapeWay(w, new WebAssembly.Module(bytesOf()));
  const js = jsWay(w);
  await prime(w, js, 0);
  await prime(w, tape.run, 0);
  let k = 0;
  const first = w.request(k++, scale);
  const a = js(first);
  const b = await tape.run(first);
  const identical = same(a, b);
  // warm-up: each way at least 10 requests and 300 ms
  let spentJs = 0,
    spentTape = 0,
    warm = 1;
  while (warm < 2000 && (warm < 10 || spentJs < 300 || spentTape < 300)) {
    const req = w.request(k++, scale);
    let t = performance.now();
    js(req);
    spentJs += performance.now() - t;
    t = performance.now();
    await tape.run(req);
    spentTape += performance.now() - t;
    warm++;
  }
  const jsMs: number[] = [],
    tapeMs: number[] = [],
    steps: number[] = [],
    bytes: number[] = [];
  let requestBytes = 0;
  for (let i = 0; i < samples; i++) {
    const req = w.request(k++, scale);
    requestBytes = req.length;
    for (const j of i % 2 === 0 ? [0, 1] : [1, 0]) {
      const t = performance.now();
      if (j === 0) js(req);
      else await tape.run(req);
      const took = performance.now() - t;
      if (j === 0) jsMs.push(took);
      else {
        tapeMs.push(took);
        steps.push(tape.steps());
        bytes.push(tape.bytes());
      }
    }
  }
  print({ js: jsMs, tape: tapeMs, steps, bytes, linear: tape.mem(), requestBytes, identical, warm });
} else if (kind === 'mem') {
  const way = rest[0] ?? 'js';
  const scale = Number(rest[1] ?? '1');
  const reqs = Array.from({ length: 5 }, (_, i) => w.request(i, scale));
  const tape = way === 'tape' ? tapeWay(w, new WebAssembly.Module(bytesOf())) : null;
  const js = way === 'js' ? jsWay(w) : null;
  if (tape) await prime(w, tape.run, 0);
  else if (js) await prime(w, js, 0);
  const rss0 = process.resourceUsage().maxRSS * 1024;
  const heapBefore = getHeapStatistics().used_heap_size;
  let heapPeak = 0,
    arena = 0;
  for (const req of reqs) {
    if (tape) {
      await tape.run(req);
      arena = Math.max(arena, tape.bytes());
    } else js?.(req);
    heapPeak = Math.max(heapPeak, getHeapStatistics().used_heap_size);
  }
  const rss1 = process.resourceUsage().maxRSS * 1024;
  print({
    rssBefore: rss0,
    rssPeak: rss1,
    rssDelta: rss1 - rss0,
    heapBefore,
    heapPeak,
    arena,
    linear: tape?.mem() ?? 0,
  });
} else if (kind === 'cold') {
  const way = rest[0] ?? 'js';
  const req = w.request(0, 1);
  const bytes = way === 'tape' ? bytesOf() : null;
  const t0 = performance.now();
  const module = bytes ? new WebAssembly.Module(bytes) : null;
  const t1 = performance.now();
  const run: (r: Uint8Array) => Uint8Array | Promise<Uint8Array> = module ? tapeWay(w, module).run : jsWay(w);
  await prime(w, run, 0);
  const t2 = performance.now();
  await run(req);
  const t3 = performance.now();
  print({ compile: t1 - t0, setup: t2 - t1, request: t3 - t2, total: t3 - t0 });
} else if (kind === 'compile') {
  const files = [...std, ...programFiles(sourcesOf(w), w.baseNames === true)];
  const once = (): { ms: number; wasm: Uint8Array } => {
    const t = performance.now();
    const r = compile(files);
    const ms = performance.now() - t;
    if (!r.wasm) throw new Error(`${w.name} did not compile`);
    return { ms, wasm: r.wasm };
  };
  const first = once();
  const again = Array.from({ length: 10 }, () => once().ms).toSorted((x, y) => x - y);
  const t = performance.now();
  const compiled = new WebAssembly.Module(first.wasm);
  const module = performance.now() - t;
  if (WebAssembly.Module.exports(compiled).length === 0) throw new Error(`${w.name}: a module with no exports`);
  const source = sourcesOf(w)
    .map(p => readFileSync(`${ROOT}${p}`, 'utf8'))
    .join('\n');
  print({
    first: first.ms,
    warm: again[5],
    wasmBytes: first.wasm.length,
    module,
    sourceLines: source.split('\n').length,
  });
} else throw new Error(`no such kind ${kind}`);
