// test/memory.ts: the proof that releasing and reusing memory changes nothing. The build that never releases
// ({ reuse: false }) defines what a program means; the default build and the checked build ({ check: true },
// which poisons released values and traps on any read of one) must give the same bytes.
//   1. random scripts of map updates over three registers that alias each other, four ways: default build,
//      never-release build, checked build, and a JavaScript model
//   2. every other test file again with releasing turned off
//   3. the CSV benchmark inputs through the default, never-release and checked builds
import '../node25.ts';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { instantiate } from '../host.ts';
import { gen } from '../bench/csv-gen.ts';
import type { Options, Source } from '../compiler.ts';
import type { App } from '../host.ts';
import { built, finish, moduleOf, same as T, answered } from './harness.ts';
const src = (n: string) => ({ name: n, text: readFileSync(new URL(`../${n}`, import.meta.url), 'utf8') });
const appOf = (file: Source, options: Partial<Options>, log: boolean): App =>
  instantiate(moduleOf(built([file], options)), { log });
/** One program built three ways: releasing memory, never releasing, and releasing with every read checked. */
const three = (file: Source): [App, App, App] => [
  appOf(file, { reuse: true }, false),
  appOf(file, { reuse: false }, false),
  appOf(file, { reuse: true, check: true }, false),
];
const run = (app: App, b: Uint8Array): string => {
  try {
    return answered(app.handle(b));
  } catch (e) {
    return `ERROR ${e instanceof Error ? e.message : String(e)}`;
  }
};

const FUZZ: Source = {
  name: 'fuzz.tape',
  text: `type Regs { Regs(a: Map[Int], b: Map[Int], c: Map[Int]) }
fn handle(raw: View) -> Response {
  step(raw, at: 0, regs: Regs(a: Empty, b: Empty, c: Empty), out: buf()) |> respond(status: 200)
}
fn step(raw: View, at: Int, regs: Regs, out: Buf) -> Buf {
  match {
    at + 5 > len(raw) -> out
    raw[at] == 0 -> step(raw, at: at + 5, regs: store(regs, to: raw[at + 2], map: put(map: pick(regs, from: raw[at + 1]), key: slice(v: raw, from: at + 3, to: at + 4), value: raw[at + 4])), out)
    raw[at] == 1 -> step(raw, at: at + 5, regs, out: show(out, found: get(map: pick(regs, from: raw[at + 1]), key: slice(v: raw, from: at + 3, to: at + 4))))
    raw[at] == 2 -> step(raw, at: at + 5, regs: store(regs, to: raw[at + 2], map: pick(regs, from: raw[at + 1])), out)
    raw[at] == 3 -> step(raw, at: at + 5, regs, out: push(buf: write_int(out, value: count(map: pick(regs, from: raw[at + 1]))), byte: 59))
    raw[at] == 4 -> step(raw, at: at + 5, regs: update_a(regs, key: slice(v: raw, from: at + 3, to: at + 4), value: raw[at + 4]), out)
    else -> step(raw, at: at + 5, regs: a_from_b(regs, key: slice(v: raw, from: at + 3, to: at + 4), value: raw[at + 4]), out)
  }
}
fn update_a(regs: Regs, key: View, value: Int) -> Regs {
  Regs(a: put(map: regs.a, key, value), b: regs.b, c: regs.c)
}
// b is read for the new a and kept as b: two references to one map
fn a_from_b(regs: Regs, key: View, value: Int) -> Regs {
  Regs(a: put(map: regs.b, key, value), b: regs.b, c: regs.c)
}
fn pick(regs: Regs, from: Int) -> Map[Int] {
  match {
    from == 0 -> regs.a
    from == 1 -> regs.b
    else -> regs.c
  }
}
fn store(regs: Regs, to: Int, map: Map[Int]) -> Regs {
  match {
    to == 0 -> Regs(a: map, b: regs.b, c: regs.c)
    to == 1 -> Regs(a: regs.a, b: map, c: regs.c)
    else -> Regs(a: regs.a, b: regs.b, c: map)
  }
}
fn show(out: Buf, found: Option[Int]) -> Buf {
  match found {
    Some(value) -> push(buf: write_int(out, value), byte: 44)
    None -> push(buf: out, byte: 45)
  }
}
`,
};
type Reg = Map<number, number>;
const slot = (i: number): 0 | 1 | 2 => (i === 0 ? 0 : i === 1 ? 1 : 2);
const model = (b: Uint8Array<ArrayBuffer>) => {
  const regs: [Reg, Reg, Reg] = [new Map(), new Map(), new Map()];
  const pick = (i: number): Reg => regs[slot(i)];
  const store = (i: number, m: Reg): void => {
    regs[slot(i)] = m;
  };
  let out = '';
  for (let at = 0; at + 5 <= b.length; at += 5) {
    const [op = 0, from = 0, to = 0, k = 0, v = 0] = b.subarray(at, at + 5);
    if (op === 0) store(to, new Map(pick(from)).set(k, v));
    else if (op === 1) out += pick(from).has(k) ? `${pick(from).get(k)},` : '-';
    else if (op === 2) store(to, pick(from));
    else if (op === 3) out += `${pick(from).size};`;
    else if (op === 4) store(0, new Map(regs[0]).set(k, v));
    else store(0, new Map(regs[1]).set(k, v));
  }
  return out;
};
{
  const [fast, never, checked] = three(FUZZ);
  let s = 12345,
    scripts = 0,
    ops = 0,
    bad = 0;
  const rnd = (n: number) => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0), Math.floor((s / 4294967296) * n));
  for (let i = 0; i < 400; i++) {
    const n = 1 + rnd(300),
      keys = 1 + rnd(40),
      b = new Uint8Array(5 * n),
      mix =
        [
          [0, 1, 2, 3, 4, 5],
          [4, 4, 4, 1, 2, 5],
          [0, 0, 1, 4, 4, 4, 4, 3],
          [5, 5, 4, 4, 1, 1, 0],
        ][i % 4] ?? [];
    for (let j = 0; j < n; j++) b.set([mix[rnd(mix.length)] ?? 0, rnd(3), rnd(3), 97 + rnd(keys), rnd(256)], 5 * j);
    const want = `200\n${model(b)}`,
      got = [run(fast, b), run(never, b), run(checked, b)];
    scripts++;
    ops += n;
    if (got.some(g => g !== want)) {
      bad++;
      if (bad < 3)
        console.log(
          'DIFF script',
          i,
          got.map(g => g === want),
        );
    }
  }
  T(`${scripts} random scripts (${ops} operations) agree four ways`, bad, 0);
  const b = new Uint8Array(5 * 20000);
  for (let j = 0; j < 20000; j++) b.set([4, 0, 0, 97 + (j % 50), j % 256], 5 * j);
  const withReuse = appOf(FUZZ, { reuse: true }, true);
  const without = appOf(FUZZ, { reuse: false }, true);
  const checkedToo = appOf(FUZZ, { reuse: true, check: true }, true);
  for (const app of [withReuse, without, checkedToo]) app.handle(b);
  T(
    '20,000 updates of one register: reuse keeps memory flat',
    [withReuse.bytesUsed < 120_000, without.bytesUsed > 5_000_000],
    [true, true],
  );
  console.log(`(20,000 updates: ${withReuse.bytesUsed} bytes with reuse, ${without.bytesUsed} without)`);
}
{
  const [fast, never, checked] = three(src('examples/csv.tape'));
  let n = 0,
    bad = 0;
  for (let seed = 1; seed <= 30; seed++)
    for (const size of [300, 8000, 90000]) {
      const b = gen(size, seed, seed % 2 === 0),
        want = run(never, b);
      n++;
      if (run(fast, b) !== want || run(checked, b) !== want) bad++;
    }
  T(`csv.tape: ${n} inputs agree across the three builds`, bad, 0);
}
for (const t of ['core', 'calls', 'generics', 'remotes']) {
  const out = execFileSync(process.execPath, [new URL(`./${t}.ts`, import.meta.url).pathname], {
    env: { ...process.env, TAPE_REUSE: '0' },
    encoding: 'utf8',
  });
  T(
    `test/${t}.ts passes with releasing turned off`,
    [/FAIL/.test(out), (out.match(/^ok/gm) ?? []).length > 5],
    [false, true],
  );
}
finish();
