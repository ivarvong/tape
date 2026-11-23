// `range(from:, to:)`, and `fold` over it as a counting loop that makes no list (compiler/fuse.ts). Each answer is
// checked under three builds and the reference interpreter against a reference written here (BigInt), and that the
// fold makes no list by the arena and the step count: one step a number and one more, as a fold over a list that
// long, where the list made first costs twice the steps and 24 bytes a number.
//   node test/range.ts [cases]     cases: random ranges besides the edges (default 300)
import '../node25.ts';
import { compile } from '../compiler.ts';
import type { Options } from '../compiler.ts';
import { interpret, Trap } from '../interp.ts';
import type { Value } from '../interp/value.ts';
import { finish, same, std } from './harness.ts';

const MIN = -(2n ** 63n),
  MAX = 2n ** 63n - 1n;
const BUILDS: Partial<Options>[] = [{}, { reuse: false }, { check: true }];
/** A function's answer, its steps and the bytes it took from the arena, under each build; and the interpreter's. */
type Ran = { value: string; steps: number; heap: number };
type Prepared = { builds: WebAssembly.Instance['exports'][]; it: ReturnType<typeof interpret> };
const prepared = new Map<string, Prepared>();
/** A program compiled once under each build, every function of it exported, and given to the interpreter once. */
function prepare(text: string): Prepared {
  const had = prepared.get(text);
  if (had) return had;
  // every function that takes Ints or nothing (a program's own `fold` below takes a list)
  const exports = [...text.matchAll(/^fn (\w+)\(([^)]*)\)/gm)].flatMap(m =>
    (m[2] ?? '').split(', ').every(p => p === '' || p.endsWith(': Int')) ? [m[1] ?? ''] : [],
  );
  const builds = BUILDS.map(o => {
    const r = compile([...std, { name: 't.tape', text }], { ...o, exports });
    if (r.wasm === null)
      throw new Error(`does not compile: ${r.errors.map(e => `${e.code}:${e.line} ${e.message}`).join('; ')}`);
    // a Float in a hole would ask the host for its text; nothing here writes one
    const env = { float_text: () => 0, float_of: () => 0 };
    return new WebAssembly.Instance(new WebAssembly.Module(r.wasm), { env }).exports;
  });
  const made = { builds, it: interpret([...std, { name: 't.tape', text }]) };
  prepared.set(text, made);
  return made;
}
function runs(text: string, fn: string, args: bigint[], interpreted = true): { builds: Ran[]; interp: string } {
  const p = prepare(text);
  const builds = p.builds.map(ex => {
    const g = (n: string): number => {
      const x = ex[n];
      return x instanceof WebAssembly.Global ? Number(x.value) : NaN;
    };
    const reset = ex['reset'],
      f = ex[fn];
    if (typeof reset !== 'function' || typeof f !== 'function') throw new TypeError(`no ${fn}`);
    reset();
    const before = g('heap');
    let value: string;
    try {
      value = String(f(...args));
    } catch {
      value = `trap ${g('why')}`;
    }
    return { value, steps: g('cost'), heap: g('heap') - before };
  });
  let interp = 'not run';
  try {
    if (interpreted) interp = shown(p.it.call(fn, args));
  } catch (e) {
    interp = e instanceof Trap ? `trap ${e.code}` : `error ${String(e)}`;
  }
  return { builds, interp };
}
const shown = (v: Value): string =>
  typeof v === 'boolean' ? String(v ? 1 : 0) : typeof v === 'bigint' ? String(v) : JSON.stringify(v);
/** The answer every build and the interpreter agree on, or each one's. */
const answer = (r: { builds: Ran[]; interp: string }): string =>
  [...r.builds.map(b => b.value), r.interp].every(v => v === r.interp)
    ? r.interp
    : `${r.builds.map(b => b.value).join(' ')} interp ${r.interp}`;

// ---- range, and fold over it into an Int or a Buf: a counting loop with no list
const RANGES = `
fn folded(from: Int, to: Int) -> Int {
  range(from, to) |> fold(from: 0, by: fn(acc: Int, x: Int) -> Int { wrapping_add(a: wrapping_mul(a: acc, b: 31), b: x) })
}
fn listed(from: Int, to: Int) -> Int {
  let xs = range(from, to)
  xs |> fold(from: 0, by: fn(acc: Int, x: Int) -> Int { wrapping_add(a: wrapping_mul(a: acc, b: 31), b: x) })
}
fn written(from: Int, to: Int) -> Int {
  let out = range(from, to) |> fold(from: buf(), by: fn(o: Buf, x: Int) -> Buf { o |> push(byte: 120) })
  len(freeze(buf: out))
}
fn first(from: Int, to: Int) -> Int {
  match range(from, to) {
    Cons(head) -> head
    Nil -> -1
  }
}
`;
/** The reference: the same hash over from, from + 1, … below to. */
function hashed(from: bigint, to: bigint): bigint {
  let acc = 0n;
  for (let x = from; x < to; x++) acc = BigInt.asIntN(64, BigInt.asIntN(64, acc * 31n) + x);
  return acc;
}
const n = (from: bigint, to: bigint): bigint => (to > from ? to - from : 0n);
let seed = 1;
const rand = (k: number): number => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % k);
const edges: [bigint, bigint][] = [
  [0n, 0n],
  [5n, 5n],
  [5n, 4n],
  [0n, 1n],
  [-3n, 3n],
  [-10n, -7n],
  [MAX - 3n, MAX],
  [MAX - 1n, MAX],
  [MAX, MAX],
  [MIN, MIN + 3n],
  [MIN, MIN],
  [MAX, MIN],
  [3n, MIN],
];
const cases = Number(process.argv[2] ?? 300);
const random: [bigint, bigint][] = Array.from({ length: cases }, () => {
  const base = [0n, -100n, MAX - 200n, MIN][rand(4)] ?? 0n;
  const a = base + BigInt(rand(150)),
    b = base + BigInt(rand(150));
  return [a, b];
});
const wrongRanges: string[] = [];
for (const [a, b] of [...edges, ...random]) {
  const f = runs(RANGES, 'folded', [a, b]),
    l = runs(RANGES, 'listed', [a, b]),
    w = runs(RANGES, 'written', [a, b]),
    h = runs(RANGES, 'first', [a, b]);
  const k = n(a, b);
  const bad = [
    answer(f) !== String(hashed(a, b)) && `folded ${answer(f)}`,
    answer(l) !== String(hashed(a, b)) && `listed ${answer(l)}`,
    answer(w) !== String(k) && `written ${answer(w)}`,
    answer(h) !== String(k > 0n ? a : -1n) && `first ${answer(h)}`,
    // fused: one step a number and one more, nothing from the arena; the list: twice the steps, 24 bytes a number
    f.builds.some(x => x.steps !== Number(k) + 1 || x.heap !== 0) && `fold steps/heap ${JSON.stringify(f.builds)}`,
    w.builds.some(x => x.steps !== Number(k) + 1) && `fold into a Buf: steps ${JSON.stringify(w.builds)}`,
    l.builds.some(x => x.steps !== 2 * (Number(k) + 1) || x.heap !== 24 * Number(k) + 8) &&
      `list steps/heap ${JSON.stringify(l.builds)}`,
  ].filter(x => x !== false);
  if (bad.length > 0) wrongRanges.push(`range(${a}, ${b}): ${bad.join('; ')}`);
}
same(`range: ${edges.length} edges and ${cases} random ranges, every build and the interpreter`, wrongRanges, []);
// a range too long to fold stops at the step budget, never at an overflow of its counter (the interpreter counts
// no steps, so it is not asked)
same(
  'range: the whole Int range folds until the step budget stops it',
  runs(RANGES, 'folded', [MIN, MAX], false).builds.map(b => b.value),
  ['trap 2', 'trap 2', 'trap 2'],
);
// a program's own fold or range is its own: nothing is rewritten
same(
  "range: a program's own fold is not std's",
  answer(
    runs(
      'fn fold(list: List[Int], from: Int, by: Fn2[Int, Int, Int]) -> Int {\n  from + 1000\n}\nfn f() -> Int {\n  range(from: 0, to: 3) |> fold(from: 0, by: fn(a: Int, x: Int) -> Int { a + x })\n}\n',
      'f',
      [],
    ),
  ),
  '1000',
);

finish();
