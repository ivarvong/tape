// Inlining (compiler/gen/inline.ts) changes nothing a program does: a build with it and one without give the same
// answers, the same traps and the same step count, on generated programs, on the pure examples and on the
// simulator's runs of every program that takes requests (each replayed from its effect log through both builds,
// which must take the whole log). Then the inliner itself, on modules written here: a body with a `return`, a
// tail call, several results, a local read before it is written; a function that counts steps, one that calls
// itself, and an instruction the inliner does not know are each left alone.
import '../node25.ts';
import { readFileSync, readdirSync } from 'node:fs';
import { compile } from '../compiler.ts';
import type { Options, Source } from '../compiler.ts';
import { section, uleb, vec } from '../compiler/common.ts';
import { inline } from '../compiler/gen/inline.ts';
import type { Fn } from '../compiler/gen/inline.ts';
import { gen as csvGen } from '../bench/csv-gen.ts';
import { link } from '../host/run.ts';
import { pack } from '../host/log.ts';
import type { Observed } from '../host.ts';
import { program } from '../proof/gen.ts';
import { auto, search } from '../sim.ts';
import { finish, ok, same, std } from './harness.ts';

const ROOT = new URL('../', import.meta.url).pathname;
const OFF: Partial<Options> = { inline: false };
const dec = new TextDecoder();

type Run = {
  fns: Record<string, (...a: (number | bigint)[]) => unknown>;
  memory: WebAssembly.Memory;
  g: (n: string) => bigint;
};
/** A module instantiated with no host but the Float text functions; its globals read by name. */
function instance(bytes: Uint8Array<ArrayBuffer>): Run {
  const late: { memory: WebAssembly.Memory | null; alloc: ((n: number) => unknown) | null } = {
    memory: null,
    alloc: null,
  };
  const floatText = (x: number): number => {
    const b = new TextEncoder().encode(String(x));
    const at = Number(late.alloc?.(4 + b.length) ?? 0);
    const buf = late.memory?.buffer ?? new ArrayBuffer(0);
    new DataView(buf).setUint32(at, b.length, true);
    new Uint8Array(buf, at + 4, b.length).set(b);
    return at;
  };
  const floatOf = (ptr: number, len: number): number =>
    Number(dec.decode(new Uint8Array(late.memory?.buffer ?? new ArrayBuffer(0), ptr, len)));
  const { exports } = new WebAssembly.Instance(new WebAssembly.Module(bytes), {
    env: { float_text: floatText, float_of: floatOf },
  });
  const fns: Run['fns'] = {};
  let memory: WebAssembly.Memory | null = null;
  const globals = new Map<string, WebAssembly.Global>();
  for (const [n, v] of Object.entries(exports)) {
    if (v instanceof WebAssembly.Memory) memory = v;
    else if (v instanceof WebAssembly.Global) globals.set(n, v);
    else if (typeof v === 'function') fns[n] = (...a: (number | bigint)[]): unknown => Reflect.apply(v, null, a);
  }
  if (!memory) throw new Error('no memory');
  late.memory = memory;
  late.alloc = fns['alloc'] ?? null;
  const g = (n: string): bigint => {
    const v: unknown = globals.get(n)?.value;
    return typeof v === 'bigint' ? v : BigInt(Number(v ?? 0));
  };
  return { fns, memory, g };
}
/** What a call gave (its value, or its trap), and the step count after it. */
function outcome(r: Run, f: () => string): string {
  r.fns['reset']?.();
  let got: string;
  try {
    got = f();
  } catch (e) {
    got = `trap ${r.g('why')} ${e instanceof Error ? e.message : String(e)}`;
  }
  return `${got} @${r.g('cost')}`;
}
const handled = (r: Run, input: Uint8Array): string =>
  outcome(r, () => {
    const at = Number(r.fns['alloc']?.(input.length));
    new Uint8Array(r.memory.buffer, at, input.length).set(input);
    const h = Number(r.fns['handle']?.(at, input.length));
    const d = new DataView(r.memory.buffer);
    return dec.decode(new Uint8Array(r.memory.buffer, d.getUint32(h, true), d.getUint32(h + 4, true)));
  });
const both = (sources: Source[], o: Partial<Options>): [Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>] | null => {
  const a = compile(sources, { ...o, ...OFF }).wasm,
    b = compile(sources, o).wasm;
  return a && b ? [a, b] : null;
};

// ---- generated programs: answers, traps and steps (the small budget makes some of them trap on steps)
{
  const pure = std.filter(s => !/json|http/.test(s.name));
  let cases = 0,
    differ = 0,
    first = '';
  for (let seed = 1; seed <= 200; seed++) {
    const sources = [...pure, { name: 'gen.tape', text: program(seed) }];
    for (const reductionLimit of [200_000, 300]) {
      const built = both(sources, { exports: ['f'], reductionLimit });
      if (!built) continue;
      const [a, b] = built.map(instance);
      if (!a || !b) continue;
      for (const n of [0n, 3n, 7n, 20n]) {
        cases++;
        const x = outcome(a, () => String(a.fns['f']?.(n))),
          y = outcome(b, () => String(b.fns['f']?.(n)));
        if (x !== y) {
          differ++;
          first ||= `seed ${seed} n=${n} limit ${reductionLimit}: ${x} | inlined ${y}`;
        }
      }
    }
  }
  ok(
    `generated programs: ${cases} calls, the same answer or trap and the same steps`,
    cases > 1000 && differ === 0,
    first,
  );
}

// ---- the pure examples on their inputs
{
  const inputs: [string, Uint8Array[]][] = [
    ['examples/csv.tape', Array.from({ length: 8 }, (_, i) => csvGen(200 + 3000 * i, i + 1, i % 2 === 0))],
    [
      'examples/words.tape',
      Array.from({ length: 8 }, (_, i) =>
        new TextEncoder().encode(
          Array.from(
            { length: 30 + 90 * i },
            (_w, j) => ['the', 'a', 'Tape', 'log', 'x', 'thé', '42', '--'][(i * 7 + j * 13) % 8],
          ).join(' '),
        ),
      ),
    ],
    [
      'apps/trace/trace.tape',
      readdirSync(`${ROOT}apps/trace/fixtures`)
        .filter(f => f.endsWith('.json'))
        .map(f => readFileSync(`${ROOT}apps/trace/fixtures/${f}`)),
    ],
  ];
  for (const [path, ins] of inputs) {
    const built = both([...std, { name: path, text: readFileSync(ROOT + path, 'utf8') }], {});
    if (!built) {
      ok(`${path} compiles`, false);
      continue;
    }
    const [a, b] = built.map(instance);
    const differ = ins.filter(input => a && b && handled(a, input) !== handled(b, input)).length;
    ok(`${path}: ${ins.length} inputs, the same answers and steps`, differ === 0, `${differ} differ`);
    console.log(`  ${path}: ${built[0].length} bytes, ${built[1].length} inlined`);
  }
}

// ---- every program that takes requests: the simulator's runs replayed through both builds
{
  const list = (dir: string): string[] =>
    readdirSync(ROOT + dir)
      .filter(f => f.endsWith('.tape'))
      .map(f => `${dir}/${f}`);
  const groups = [
    ['apps/tickets/tickets.tape', 'apps/tickets/pay.tape'],
    ['examples/fulfillment.tape', 'examples/inventory.tape', 'examples/payments.tape', 'examples/shipping.tape'],
    ['examples/orders.tape', 'examples/stock.tape'],
    ...[
      'apps/queue/queue.tape',
      ...list('bench/suite'),
      ...list('examples'),
      ...list('examples/timed'),
      ...list('testdata/compare'),
    ].map(f => [f]),
  ];
  let runs = 0,
    differ = 0,
    first = '';
  for (const g of groups) {
    const files = g.map(f => ({
      name: (f.split('/').pop() ?? f).replace(/\.tape$/, ''),
      text: readFileSync(ROOT + f, 'utf8'),
    }));
    const a = ((): ReturnType<typeof auto> | null => {
      try {
        return auto(files, { clients: 4, ops: 10 });
      } catch {
        return null;
      }
    })();
    if (!a || 'errors' in a) continue;
    const seen: (Observed & { prog: string })[] = [];
    await search(
      {
        ...a.model,
        observe: (prog, r) => {
          seen.push({ prog, ...r });
        },
        duplicates: false,
      },
      { runs: 4, steps: 80, faults: 2 },
    );
    const mods = new Map<string, WebAssembly.Module[]>();
    for (const f of files) {
      const built = both([...std, { name: `${f.name}.tape`, text: f.text }], {});
      if (built)
        mods.set(
          f.name,
          built.map(w => new WebAssembly.Module(w)),
        );
    }
    for (const r of seen) {
      const m = mods.get(r.prog);
      if (r.method !== null || !m) continue;
      const [x, y] = m.map(mod => {
        const app = link(mod, { recorded: r.effects });
        let out: string;
        try {
          out = JSON.stringify(pack(app.handle(r.bytes)));
        } catch (e) {
          out = `threw ${e instanceof Error ? e.message : String(e)}`;
        }
        const cost: unknown = app.exports['cost'] instanceof WebAssembly.Global ? app.exports['cost'].value : null;
        return `${out} after ${app.replayed()} effects @${String(cost)}`;
      });
      runs++;
      if (x !== y) {
        differ++;
        first ||= `${r.prog}: ${x?.slice(0, 200)} | inlined ${y?.slice(0, 200)}`;
      }
    }
  }
  ok(
    `${runs} simulated runs replayed through both builds: the same answers, effects and steps`,
    runs > 1000 && differ === 0,
    first,
  );
}

// ---- the inliner on modules written here
const I32 = 0x7f,
  I64 = 0x7e;
/** A module of the functions given (type i is function i's), its function `n` exported as fn<n>, and a cost global. */
function moduleOf(fns: readonly Fn[], bodies: readonly (readonly number[])[]): WebAssembly.Module {
  const body = (b: readonly number[]): number[] => [...uleb(b.length), ...b];
  return new WebAssembly.Module(
    new Uint8Array([
      0,
      0x61,
      0x73,
      0x6d,
      1,
      0,
      0,
      0,
      ...section(1, vec(fns.map(f => [0x60, ...vec(f.params.map(x => [x])), ...vec(f.results.map(x => [x]))]))),
      ...section(3, vec(fns.map((_, i) => uleb(i)))),
      ...section(6, vec([[I64, 1, 0x42, 0, 0x0b]])),
      ...section(7, vec([...fns.map((_, i) => [3, 0x66, 0x6e, 0x30 + i, 0, ...uleb(i)]), [1, 0x63, 3, 0]])),
      ...section(10, vec(bodies.map(body))),
    ]),
  );
}
const run = (m: WebAssembly.Module, n: number, ...args: (number | bigint)[]): string => {
  const { exports } = new WebAssembly.Instance(m, {});
  const f = exports[`fn${n}`];
  try {
    return typeof f === 'function' ? String(Reflect.apply(f, null, args)) : 'none';
  } catch (e) {
    return `trap ${e instanceof Error ? e.message : String(e)}`;
  }
};
const opts = (fns: Fn[]) => ({
  fns,
  first: 0,
  roots: new Set([0]),
  kept: new Set<number>(),
  blockSig: () => 0,
  cost: 0,
  limit: 128,
});
const L = (l: number): number[] => [0x20, l];
const S = (l: number): number[] => [0x21, l];
const C = (n: number): number[] => [0x41, n];
{
  // fn0(x) = g(x) + g(x + 1) + h(x); g(x) = x < 0 ? return 0 : 2x (a local read before it is written: it must be 0
  // on every call); h(x) = return_call g(x)
  const g: Fn = {
    params: [I32],
    results: [I32],
    body: [
      1,
      1,
      I32,
      ...L(0),
      ...C(0),
      0x48,
      0x04,
      0x40,
      ...C(0),
      0x0f,
      0x0b,
      ...L(1),
      ...L(0),
      ...C(1),
      0x74,
      0x6a,
      ...L(0),
      ...S(1),
      0x0b,
    ],
  };
  const h: Fn = { params: [I32], results: [I32], body: [0, ...L(0), 0x12, 1, 0x0b] };
  const f: Fn = {
    params: [I32],
    results: [I32],
    body: [0, ...L(0), 0x10, 1, ...L(0), ...C(1), 0x6a, 0x10, 1, 0x6a, ...L(0), 0x10, 2, 0x6a, 0x0b],
  };
  const fns = [f, g, h];
  const before = moduleOf(
    fns,
    fns.map(x => x.body),
  );
  const bodies = inline(opts(fns));
  const after = moduleOf(fns, bodies);
  same(
    'the inlined module answers as the one it came from',
    [-3, 0, 1, 5, 100].map(x => run(after, 0, x)),
    [-3, 0, 1, 5, 100].map(x => run(before, 0, x)),
  );
  const calls = !(bodies[0] ?? []).includes(0x10);
  ok('the caller calls nothing now', calls, calls ? '' : JSON.stringify(bodies[0]));
  same(
    'and the functions no one calls are left as unreachable',
    [bodies[1], bodies[2]],
    [
      [0, 0, 0x0b],
      [0, 0, 0x0b],
    ],
  );
  // with fn2 exported too, it is kept, and its own tail call of g is inlined
  const kept = inline({ ...opts(fns), roots: new Set([0, 2]) });
  same('a function the host can call is kept, with its callee inlined', run(moduleOf(fns, kept), 2, 21), '42');
}
{
  // a function of two results: inlined as a block of a type index
  const two: Fn = { params: [I32], results: [I32, I32], body: [0, ...L(0), ...L(0), ...C(1), 0x6a, 0x0b] };
  const f: Fn = { params: [I32], results: [I32], body: [0, ...L(0), 0x10, 1, 0x6b, 0x0b] };
  const fns = [f, two];
  // type 2 is () -> (i32, i32), added for the block
  const withBlock = [...fns, { params: [], results: [I32, I32], body: [0, ...C(0), ...C(0), 0x0b] }];
  const bodies = inline({ ...opts(fns), blockSig: () => 2 });
  same(
    'several results come out of a block of their type',
    run(moduleOf(withBlock, [...bodies, withBlock[2]?.body ?? []]), 0, 7),
    '-1',
  );
}
{
  // a function that counts steps (global 0), one that calls itself, and an unknown instruction
  const counts: Fn = { params: [], results: [I32], body: [0, 0x23, 0, 0x42, 1, 0x7c, 0x24, 0, ...C(1), 0x0b] };
  const self: Fn = {
    params: [I32],
    results: [I32],
    body: [0, ...L(0), 0x45, 0x04, I32, ...C(0), 0x05, ...L(0), ...C(1), 0x6b, 0x10, 2, 0x0b, 0x0b],
  };
  const f: Fn = { params: [I32], results: [I32], body: [0, 0x10, 1, ...L(0), 0x10, 2, 0x6a, 0x0b] };
  const fns = [f, counts, self];
  const bodies = inline(opts(fns));
  same('a function that counts steps, and one that calls itself, stay calls', bodies[0], f.body);
  const strange: Fn = { params: [], results: [], body: [0, 0x06, 0x0b] };
  const out = inline(opts([f, counts, self, strange]));
  same(
    'an instruction the inliner does not know leaves every function as it was',
    out,
    [f, counts, self, strange].map(x => x.body),
  );
}

finish();
