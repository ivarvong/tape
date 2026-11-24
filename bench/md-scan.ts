// bench/md-scan.ts: the three byte walks of corpus/md.tape (next_special, the plain-text skip, the HTML escapes),
// per byte (corpus/md-before.tape) and as scan (corpus/md-after.tape), against a byte loop here. The walks live
// beside that corpus, not as a second copy of the renderer under bench/. Then the steps and the time of each, on
// text where a stopping byte is rare.
import '../node25.ts';
import { built, read } from '../test/harness.ts';

const SPECIAL = new Set([92, 96, 60, 91, 93]);
const PLAIN = new Set([92, 96, 42, 95, 91, 33, 60, 10]);
const ESC = new Set([38, 60, 62, 34]);
const SETS = [SPECIAL, PLAIN, ESC] as const;

/** The sum of the indexes a walk stops on, the same sum the Tape programs return. */
function walk(bytes: Uint8Array, set: ReadonlySet<number>): bigint {
  let at = 0;
  let acc = 0n;
  while (at < bytes.length) {
    let j = at;
    while (j < bytes.length && !set.has(bytes[j] ?? -1)) j++;
    if (j >= bytes.length) break;
    acc += BigInt(j);
    at = j + 1;
  }
  return acc;
}

const EXPORTS = ['count_specials', 'count_plains', 'count_escs', 'count_all'];
type Exports = WebAssembly.Instance['exports'];
type Mod = {
  fns: Record<string, (...args: (number | bigint)[]) => unknown>;
  memory: WebAssembly.Memory;
  cost: WebAssembly.Global;
};
function load(path: string): Mod {
  const r = built(read(path), { exports: EXPORTS }, path);
  const ex: Exports = new WebAssembly.Instance(new WebAssembly.Module(r.wasm), {
    env: { float_text: (): number => 0, float_of: (): number => 0 },
  }).exports;
  const memory = ex['memory'];
  const cost = ex['cost'];
  if (!(memory instanceof WebAssembly.Memory) || !(cost instanceof WebAssembly.Global))
    throw new TypeError(`${path} exports no memory`);
  const fns: Mod['fns'] = {};
  for (const [name, f] of Object.entries(ex)) {
    if (f instanceof WebAssembly.Global || f instanceof WebAssembly.Memory || f instanceof WebAssembly.Table) continue;
    fns[name] = f;
  }
  return { fns, memory, cost };
}
function run(mod: Mod, fn: string, bytes: Uint8Array): { value: bigint; steps: number } {
  const reset = mod.fns['reset'],
    alloc = mod.fns['alloc'],
    f = mod.fns[fn];
  if (reset === undefined || alloc === undefined || f === undefined) throw new TypeError(`no ${fn}`);
  reset();
  const at = alloc(bytes.length);
  if (typeof at !== 'number' && typeof at !== 'bigint') throw new TypeError('alloc');
  const ptr = Number(at);
  if (bytes.length > 0) new Uint8Array(mod.memory.buffer, ptr, bytes.length).set(bytes);
  const value = f(ptr, bytes.length);
  if (typeof value !== 'bigint') throw new TypeError(`${fn} did not return an Int`);
  const steps = mod.cost.value;
  if (typeof steps !== 'bigint' && typeof steps !== 'number') throw new TypeError('no cost');
  return { value, steps: Number(steps) };
}

const before = load('corpus/md-before.tape');
const after = load('corpus/md-after.tape');
const fill = (n: number, byte = 120): Uint8Array => new Uint8Array(n).fill(byte);
const put = (n: number, pos: number, byte: number): Uint8Array => {
  const b = fill(Math.max(n, pos + 1));
  b[pos] = byte;
  return b;
};
const inputs: Uint8Array[] = [fill(0), fill(1)];
for (const n of [1, 15, 16, 17, 31, 32, 40, 100]) inputs.push(fill(n), put(n, n - 1, 60), put(n, 0, 38));
inputs.push(
  fill(40, 60),
  fill(40, 38),
  fill(40, 10),
  Uint8Array.from({ length: 64 }, (_, i) => i),
);
let seed = 3;
const rand = (n: number): number => {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return (seed >>> 8) % n;
};
const marks = [60, 38, 10, 92, 42];
for (let k = 0; k < 20; k++)
  inputs.push(Uint8Array.from({ length: rand(80) }, () => (rand(40) === 0 ? (marks[rand(marks.length)] ?? 120) : 120)));

const FNS = ['count_specials', 'count_plains', 'count_escs'] as const;
let differ = 0;
for (const bytes of inputs) {
  const want = SETS.map(s => walk(bytes, s));
  const sums = [before, after].map(ex => FNS.map(fn => run(ex, fn, bytes).value));
  const all = [before, after].map(ex => run(ex, 'count_all', bytes).value);
  const bad =
    sums.some(got => got.some((v, i) => v !== want[i])) ||
    all.some((v, i) => v !== (sums[i] ?? []).reduce((a, b) => a + b, 0n));
  if (bad) differ++;
}
console.log(`${inputs.length} inputs compared, ${differ} differ`);

/** Text of `n` bytes with a stopping byte every `gap` bytes, or none when `gap` is 0. */
function prose(n: number, gap: number): Uint8Array {
  const b = fill(n);
  if (gap > 0) for (let i = gap - 1; i < n; i += gap) b[i] = 60;
  return b;
}
const median = (xs: readonly number[]): number => xs.toSorted((x, y) => x - y)[xs.length >> 1] ?? 0;
function time(mod: Mod, bytes: Uint8Array): number {
  for (let i = 0; i < 5; i++) run(mod, 'count_all', bytes);
  return median(
    Array.from({ length: 15 }, () => {
      const t = performance.now();
      run(mod, 'count_all', bytes);
      return performance.now() - t;
    }),
  );
}
let slower = 0;
for (const [n, gap] of [
  [8192, 0],
  [8192, 40],
  [65536, 40],
  [262144, 40],
] as const) {
  const bytes = prose(n, gap);
  const b = FNS.map(fn => run(before, fn, bytes));
  const a = FNS.map(fn => run(after, fn, bytes));
  const bSteps = b.reduce((s, r) => s + r.steps, 0);
  const aSteps = a.reduce((s, r) => s + r.steps, 0);
  if (aSteps >= bSteps / 2 || b.some((r, i) => r.value !== a[i]?.value)) slower++;
  const label = gap === 0 ? 'no stops' : `a stop every ${gap}`;
  console.log(
    `${String(n).padStart(7)} bytes, ${label}: before ${bSteps} steps ${time(before, bytes).toFixed(2)} ms, after ${aSteps} steps ${time(after, bytes).toFixed(2)} ms`,
  );
}
if (differ > 0 || slower > 0) process.exit(1);
