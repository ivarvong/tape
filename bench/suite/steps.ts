// bench/suite/steps.ts: what a step costs in time (LANGUAGE.md section 10, step version 3). Two measurements, in
// this process, Node's default tiers, the default build (inlined, steps counted in a local where that is allowed):
//   built-ins  the time of one recursive entry, and of 16 bytes for each built-in that is priced by its bytes
//              (append, scan, scan_plain, parse_float): each is run at several sizes, and the slope of the time
//              against the bytes is its price per 16 bytes, the intercept the fixed cost of a call; then the calls
//              of the two that ask the host (parse_float of a text the module does not read, write_float), in ns
//              and in entries, which their fixed charges are taken from (compiler/gen/intrinsic.ts)
//   suite      each workload of the suite (bench/suite/workloads.ts), one request at the benchmark size: its time,
//              its steps under version 3 and under version 2 (the same module built with priceCopies off, which leaves
//              the bytes and the host calls uncharged), and
//              the time per step of each. A cost model is one whose time per step varies least across workloads.
// Times are the least of many runs: the machine is shared, and the least is the run the least disturbed.
//   node bench/suite/steps.ts [--quick] [--only built-ins|suite]
import '../../node25.ts';
import { compile } from '../../compiler.ts';
import type { Options } from '../../compiler.ts';
import { instantiate } from '../../host.ts';
import { nodeSql } from '../../nodesql.ts';
import { std } from '../../std.ts';
import { prime, programFiles, sourcesOf } from './common.ts';
import { NAMES, load } from './workloads.ts';

const argv = process.argv.slice(2);
const quick = argv.includes('--quick');
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : undefined;
const REPEATS = quick ? 5 : 25;

/** The least time of `f` over the repeats, in nanoseconds, after warming it up. */
function least(f: () => unknown, repeats = REPEATS): number {
  for (let i = 0; i < 3; i++) f();
  let best = Infinity;
  for (let i = 0; i < repeats; i++) {
    const t = process.hrtime.bigint();
    f();
    best = Math.min(best, Number(process.hrtime.bigint() - t));
  }
  return best;
}
/** The least-squares line through the points: [slope, intercept]. */
function line(xs: readonly number[], ys: readonly number[]): [number, number] {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n,
    my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0,
    sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += ((xs[i] ?? 0) - mx) * ((ys[i] ?? 0) - my);
    sxx += ((xs[i] ?? 0) - mx) ** 2;
  }
  const slope = sxy / sxx;
  return [slope, my - slope * mx];
}

// ---- built-ins

// Each walk calls itself `times` times; a round does one call of the built-in on `text`. `entries` is the walk of
// the same shape with no built-in, so its time is the cost of the rounds themselves.
const PROGRAM = `fn entries(times: Int) -> Int {
  count(times, acc: 0)
}
fn count(times: Int, acc: Int) -> Int {
  match {
    times <= 0 -> acc
    else -> count(times: times - 1, acc: acc + times % 7)
  }
}
// a recursion that is not a loop: each call holds a frame until its two calls return
fn tree(depth: Int) -> Int {
  match {
    depth <= 0 -> 1
    else -> tree(depth: depth - 1) + tree(depth: depth - 1)
  }
}
fn appends(text: View, times: Int) -> Int {
  len(freeze(appended(out: buf(), text, times)))
}
fn appended(out: Buf, text: View, times: Int) -> Buf {
  match {
    times <= 0 -> out
    else -> appended(out: append(buf: out, view: text), text, times: times - 1)
  }
}
fn scans(text: View, times: Int) -> Int {
  scanned(text, times, acc: 0)
}
fn scanned(text: View, times: Int, acc: Int) -> Int {
  match {
    times <= 0 -> acc
    else -> scanned(text, times: times - 1, acc: acc + scan(v: text, at: 0, set: "<"))
  }
}
fn plains(text: View, times: Int) -> Int {
  plained(text, times, acc: 0)
}
fn plained(text: View, times: Int, acc: Int) -> Int {
  match {
    times <= 0 -> acc
    else -> plained(text, times: times - 1, acc: acc + scan_plain(v: text, at: 0))
  }
}
fn floats(text: View, times: Int) -> Int {
  floated(text, times, acc: 0)
}
fn floated(text: View, times: Int, acc: Int) -> Int {
  match {
    times <= 0 -> acc
    else -> floated(text, times: times - 1, acc: acc + match parse_float(text) {
      Some(value) -> trunc(value) % 2
      None -> 0
    })
  }
}
// write_float of n / 7: its text is the host's, at most 25 bytes, so its price is a fixed charge
fn writes(n: Int, times: Int) -> Int {
  len(freeze(written(out: buf(), x: float(n) / 7f, times)))
}
fn written(out: Buf, x: Float, times: Int) -> Buf {
  match {
    times <= 0 -> out
    else -> written(out: write_float(out, value: x), x, times: times - 1)
  }
}
`;
const EXPORTS = ['entries', 'tree', 'appends', 'scans', 'plains', 'floats', 'writes'];

type Mod = {
  call: (fn: string, text: Uint8Array | null, n: bigint) => number;
  ints: (fn: string, ...a: bigint[]) => number;
  cost: () => number;
};
function modOf(options: Partial<Options>): Mod {
  const r = compile([...std, { name: 'steps.tape', text: PROGRAM }], { exports: EXPORTS, ...options });
  if (!r.wasm) throw new Error(r.errors.map(e => `${e.line} ${e.code} ${e.message}`).join('; '));
  const app = instantiate(new WebAssembly.Module(r.wasm), { log: false });
  const ex = app.exports;
  const fn = (n: string): ((...a: (number | bigint)[]) => unknown) => {
    const f = ex[n];
    if (typeof f !== 'function') throw new TypeError(`no ${n}`);
    return (...a) => {
      const got: unknown = Reflect.apply(f, undefined, a);
      return got;
    };
  };
  const memory = ex['memory'],
    cost = ex['cost'];
  if (!(memory instanceof WebAssembly.Memory) || !(cost instanceof WebAssembly.Global)) throw new TypeError('exports');
  const reset = fn('reset'),
    alloc = fn('alloc');
  return {
    call(name, text, n) {
      reset();
      if (text === null) return Number(fn(name)(n));
      const at = Number(alloc(text.length));
      new Uint8Array(memory.buffer, at, text.length).set(text);
      return Number(fn(name)(at, text.length, n));
    },
    ints(name, ...a) {
      reset();
      return Number(fn(name)(...a));
    },
    cost: () => Number(cost.value),
  };
}

type Priced = { name: string; fn: string; text: (bytes: number) => Uint8Array; sizes: readonly number[] };
const filled = (n: number, byte = 120): Uint8Array => new Uint8Array(n).fill(byte);
const PRICED: readonly Priced[] = [
  { name: 'append', fn: 'appends', text: n => filled(n), sizes: [16, 64, 256, 1024, 4096] },
  { name: 'scan (a set of one)', fn: 'scans', text: n => filled(n), sizes: [16, 64, 256, 1024, 4096] },
  { name: 'scan_plain', fn: 'plains', text: n => filled(n), sizes: [16, 64, 256, 1024, 4096] },
  {
    // more than 22 digits after the point: the host reads it (compiler/math/decimal.ts reads at most that many)
    name: 'parse_float',
    fn: 'floats',
    text: n => new TextEncoder().encode(`0.${'1'.repeat(Math.max(1, n - 2))}`),
    sizes: [32, 64, 256, 1024, 4096],
  },
];

function builtIns(): void {
  const m = modOf({});
  // a round of each walk with no built-in, the loop the priced ones run in
  const ROUNDS = 200_000;
  const loop = least(() => m.call('entries', null, BigInt(ROUNDS))) / ROUNDS;
  const DEPTH = 16; // 2^17 - 1 calls, each held until its two calls return
  const calls = 2 ** (DEPTH + 1) - 1;
  const tree = least(() => m.call('tree', null, BigInt(DEPTH))) / calls;
  console.log(
    `one recursive entry: ${loop.toFixed(2)} ns as a loop (a call as the result), ${tree.toFixed(2)} ns as a call that returns`,
  );
  console.log('');
  console.log(
    '| built-in | bytes | steps a call | ns a call | ns per 16 bytes (slope) | fixed ns a call (intercept) |',
  );
  console.log('|---|---|---|---|---|---|');
  const rows: { name: string; per16: number }[] = [];
  for (const p of PRICED) {
    const xs: number[] = [],
      ys: number[] = [],
      steps: number[] = [];
    for (const bytes of p.sizes) {
      const text = p.text(bytes);
      // about 2 MB of bytes a run, so a run is long enough to time and the copies fit in memory
      const times = Math.max(64, Math.floor(2_000_000 / text.length));
      m.call(p.fn, text, 0n);
      const base = m.cost();
      m.call(p.fn, text, BigInt(times));
      steps.push((m.cost() - base) / times);
      const ns = least(() => m.call(p.fn, text, BigInt(times))) / times - loop;
      xs.push(text.length / 16);
      ys.push(ns);
    }
    const [slope, intercept] = line(xs, ys);
    rows.push({ name: p.name, per16: slope });
    p.sizes.forEach((_, i) => {
      const bytes = (xs[i] ?? 0) * 16;
      const at = i === 0 ? slope.toFixed(2) : '';
      const fixed = i === 0 ? intercept.toFixed(1) : '';
      console.log(
        `| ${i === 0 ? p.name : ''} | ${bytes} | ${((steps[i] ?? 0) - 1).toFixed(0)} | ${(ys[i] ?? 0).toFixed(1)} | ${at} | ${fixed} |`,
      );
    });
  }
  console.log('');
  // the fixed cost of the two built-ins that call the host: parse_float of a text the module cannot read, and
  // write_float. Each is shown in ns, beside the steps its call is charged and the ns those steps stand for at an
  // entry's time as a call that returns. parse_float's charge per byte is taken off, so what is left is the call
  const enc = (t: string): Uint8Array => new TextEncoder().encode(t);
  const TIMES = 20_000;
  const charged = (run: () => number): number => {
    run();
    return m.cost() / TIMES - 1;
  };
  console.log('| call | ns a call | steps charged a call | ns a call / ns an entry as a call |');
  console.log('|---|---|---|---|');
  const shown = (label: string, ns: number, steps: number): void => {
    console.log(`| ${label} | ${ns.toFixed(1)} | ${steps.toFixed(0)} | ${(ns / tree).toFixed(0)} |`);
  };
  for (const text of ['12345.678', '1e5', '-2.5e3', '1234567890123456789', '0.12345678901234567890123'])
    shown(
      `parse_float "${text}"`,
      least(() => m.call('floats', enc(text), BigInt(TIMES))) / TIMES - loop,
      charged(() => m.call('floats', enc(text), BigInt(TIMES))),
    );
  for (const [label, n] of [
    ['write_float of 1/7', 1n],
    ['write_float of 1', 7n],
    ['write_float of 1e18', 7n * 10n ** 18n],
  ] as const)
    shown(
      label,
      least(() => m.ints('writes', n, BigInt(TIMES))) / TIMES - loop,
      charged(() => m.ints('writes', n, BigInt(TIMES))),
    );
  console.log('');
  const lo = Math.min(...rows.map(r => r.per16));
  console.log(
    `ns per 16 bytes against the cheapest: ${rows.map(r => `${r.name} ${(r.per16 / lo).toFixed(1)}x`).join(', ')}; against a recursive entry as a loop: ${rows.map(r => `${r.name} ${(r.per16 / loop).toFixed(2)}`).join(', ')}`,
  );
}

// ---- the suite

const WORKLOADS = [...NAMES, 'md', 'blog-put', 'blog-get', 'blog-index', 'blog-feed'];
/** A workload's least time with each build (ns3 priced, ns2 the same module with priceCopies off) and its steps. */
type Measured = { name: string; ns: number; ns2: number; v3: number; v2: number; sql: boolean };

async function workload(name: string): Promise<Measured> {
  const w = await load(name);
  const pinned = w.now;
  const realNow = Date.now;
  if (pinned !== undefined) Date.now = () => pinned;
  const files = [...std, ...programFiles(sourcesOf(w), w.baseNames === true)];
  const steps: number[] = [];
  const times: number[] = [];
  for (const priceCopies of [true, false]) {
    let ns = Infinity;
    const r = compile(files, { priceCopies });
    if (!r.wasm) throw new Error(`${name}: ${r.errors.map(e => e.message).join('; ')}`);
    const module = new WebAssembly.Module(r.wasm);
    const db = w.sql ? nodeSql() : null;
    const app = instantiate(module, { ...(db ? { sql: db } : {}), name: w.name, log: false });
    if (db) w.seed?.(db);
    const run = (req: Uint8Array): Uint8Array => (db ? app.handleIn(f => db.transaction(f), req) : app.handle(req));
    await prime(w, run, 0);
    const cost = app.exports['cost'];
    if (!(cost instanceof WebAssembly.Global)) throw new TypeError('no cost');
    // fresh keys each request, as run.ts sends them; the steps of the first measured one
    const count = quick ? 8 : 30;
    const reqs = Array.from({ length: 10 + count }, (_, k) => w.request(k, 1));
    for (const [k, req] of reqs.entries()) {
      if (w.fresh === true && k > 0) break;
      const t = process.hrtime.bigint();
      run(req);
      const took = Number(process.hrtime.bigint() - t);
      if (k === 10 || (w.fresh === true && k === 0)) steps.push(Number(cost.value));
      if (k >= 10) ns = Math.min(ns, took);
    }
    if (w.fresh === true) {
      // a database per request: the request is timed on a fresh one each time, its schema outside the timer
      for (let k = 0; k < REPEATS; k++) {
        const d = nodeSql();
        const a = instantiate(module, { sql: d, name: w.name, log: false });
        w.seed?.(d);
        const go = (req: Uint8Array): Uint8Array => a.handleIn(f => d.transaction(f), req);
        await prime(w, go, k);
        const req = w.request(k, 1);
        const t = process.hrtime.bigint();
        go(req);
        ns = Math.min(ns, Number(process.hrtime.bigint() - t));
      }
    }
    times.push(ns);
  }
  Date.now = realNow;
  return { name, ns: times[0] ?? 0, ns2: times[1] ?? 0, v3: steps[0] ?? 0, v2: steps[1] ?? 0, sql: w.sql };
}

const spread = (xs: readonly number[]): { mean: number; cv: number } => {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  return { mean, cv: sd / mean };
};

async function suite(): Promise<void> {
  const rows: Measured[] = [];
  for (const name of WORKLOADS) rows.push(await workload(name));
  // ms: the priced build; unpriced: the same module with no charge on append and parse_float, the charge's own time
  console.log('| workload | ms | ms unpriced | steps v2 | steps v3 | added | ns/step v2 | ns/step v3 |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const r of rows)
    console.log(
      `| ${r.name}${r.sql ? ' (SQL)' : ''} | ${(r.ns / 1e6).toFixed(3)} | ${(r.ns2 / 1e6).toFixed(3)} | ${r.v2} | ${r.v3} | ${(((r.v3 - r.v2) / r.v2) * 100).toFixed(1)}% | ${(r.ns / r.v2).toFixed(2)} | ${(r.ns / r.v3).toFixed(2)} |`,
    );
  for (const [label, set] of [
    ['without SQL', rows.filter(r => !r.sql)],
    ['all', rows],
  ] as const) {
    const a = spread(set.map(r => r.ns / r.v2)),
      b = spread(set.map(r => r.ns / r.v3));
    console.log(
      `${label} (${set.length}): ns/step v2 mean ${a.mean.toFixed(2)}, coefficient of variation ${a.cv.toFixed(2)}; v3 mean ${b.mean.toFixed(2)}, coefficient of variation ${b.cv.toFixed(2)}`,
    );
  }
}

if (only !== 'suite') builtIns();
if (only !== 'built-ins') {
  console.log('');
  await suite();
}
