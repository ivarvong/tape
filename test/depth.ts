// The depth budget (compiler/common.ts DEPTH_BUDGET): a recursion too deep is trap 9, at the same depth in every
// build (plain, traced, without inlining, without reuse), on every tier of V8 (each in a process of its own:
// Liftoff only, TurboFan only, both), and in the reference interpreter given the build's weights. The deepest call
// that answers is what the weights say, read from the module itself: a function's weight is 12 and its parameters
// and locals (the code section, inlining off), and its deepest is the budget divided by it. A generic function has
// one weight for its copies; a tail call between two functions holds nothing; the frame of a function with 400
// values is held to its size, so it traps before the engine's stack runs out; a request after a trap starts at 0.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { compile } from '../compiler.ts';
import type { Built } from '../compiler.ts';
import { DEPTH_BUDGET, LEVEL_BASE } from '../compiler/common.ts';
import { instantiate } from '../host.ts';
import { interpret, Trap } from '../interp.ts';
import { std } from '../std.ts';
import { finish, same } from './harness.ts';

const DEPTH = `fn handle(raw: View) -> Buf {
  match request(raw) {
    Request(method: "GET", path: "/depth/" ++ decimal(n)) -> respond(status: 200) |> write_int(value: depth(n))
    Request(method: "GET", path: "/ints/" ++ decimal(n)) -> respond(status: 200) |> write_int(value: count(list: ints(n, acc: Nil)))
    Request(method: "GET", path: "/texts/" ++ decimal(n)) -> respond(status: 200) |> write_int(value: count(list: texts(n, acc: Nil)))
    Request(method: "GET", path: "/ping/" ++ decimal(n)) -> respond(status: 200) |> write_int(value: ping(n))
    _ -> respond(status: 404)
  }
}

fn depth(n: Int) -> Int {
  match {
    n <= 0 -> 0
    else -> 1 + depth(n - 1)
  }
}

fn count[T](list: List[T]) -> Int {
  match list {
    Cons(tail) -> 1 + count(list: tail)
    Nil -> 0
  }
}

fn ints(n: Int, acc: List[Int]) -> List[Int] {
  match {
    n <= 0 -> acc
    else -> ints(n: n - 1, acc: Cons(head: n, tail: acc))
  }
}

fn texts(n: Int, acc: List[View]) -> List[View] {
  match {
    n <= 0 -> acc
    else -> texts(n: n - 1, acc: Cons(head: "x", tail: acc))
  }
}

fn ping(n: Int) -> Int {
  match {
    n <= 0 -> 0
    else -> pong(n: n - 1)
  }
}

fn pong(n: Int) -> Int {
  match {
    n <= 0 -> 1
    else -> ping(n: n - 1)
  }
}
`;
// a frame of 400 values live across the call
const lets = Array.from({ length: 400 }, (_, i) => `  let a${i} = n * ${i + 3} + ${i + 1}`).join('\n');
const sum = Array.from({ length: 400 }, (_, i) => ` + a${i}`).join('');
const WIDE = `fn handle(raw: View) -> Buf {
  match request(raw) {
    Request(method: "GET", path: "/wide/" ++ decimal(n)) -> respond(status: 200) |> write_int(value: wide(n))
    _ -> respond(status: 404)
  }
}

fn wide(n: Int) -> Int {
${lets}
  match {
    n <= 0 -> 0
    else -> wide(n - 1)${sum}
  }
}
`;
const sourcesOf = (text: string): { name: string; text: string }[] => [...std, { name: 'depth.tape', text }];
const builtOf = (text: string, options: Record<string, unknown> = {}): Built => {
  const r = compile(sourcesOf(text), options);
  if (!r.wasm) throw new Error(`refused: ${JSON.stringify(r.errors[0])}`);
  return r;
};
const enc = new TextEncoder(),
  dec = new TextDecoder();

/** The answer to `GET <path>`: its status and body, or the error it stopped with. */
const askerOf = (b: Built): ((path: string) => string) => {
  const app = instantiate(new WebAssembly.Module(b.wasm), { log: false });
  return path => {
    try {
      return dec.decode(app.handle(enc.encode(`GET ${path}`))).replace('\n', ' ');
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };
};
/** The deepest n that `GET <prefix><n>` answers 200 for, and what the next one gives. */
function deepest(ask: (path: string) => string, prefix: string): { n: number; next: string } {
  let lo = 0,
    hi = 1;
  while (ask(`${prefix}${hi}`).startsWith('200')) {
    lo = hi;
    hi *= 2;
  }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (ask(`${prefix}${mid}`).startsWith('200')) lo = mid;
    else hi = mid;
  }
  return { n: lo, next: ask(`${prefix}${lo + 1}`) };
}
const ROUTES = ['/depth/', '/ints/', '/texts/'] as const;

// one tier's numbers, in a process of its own (`node [flags] test/depth.ts --tier`): printed as JSON
if (process.argv.includes('--tier')) {
  const ask = askerOf(builtOf(DEPTH));
  const wide = askerOf(builtOf(WIDE));
  console.log(
    JSON.stringify({ ...Object.fromEntries(ROUTES.map(r => [r, deepest(ask, r)])), wide: deepest(wide, '/wide/') }),
  );
  process.exit(0);
}
// the interpreter given the build's weights, in a process with a larger stack (its own frames are many per call)
if (process.argv.includes('--interp')) {
  const b = builtOf(DEPTH);
  const it = interpret(sourcesOf(DEPTH), null, b.levels);
  const n = Number(process.argv[process.argv.indexOf('--interp') + 1]);
  const at = (k: number): string => {
    try {
      const v = it.call('depth', [BigInt(k)]);
      return `is ${typeof v === 'bigint' ? v : JSON.stringify(v)}`;
    } catch (e) {
      return e instanceof Trap ? `trap ${e.code}: ${e.detail ?? ''}` : e instanceof Error ? e.message : String(e);
    }
  };
  console.log(JSON.stringify([at(n), at(n + 1), at(10)]));
  process.exit(0);
}

// the weights, read from the module: a function's parameters and locals (inlining off: as the function compiler
// wrote it), 12 more
function slotsOf(wasm: Uint8Array, name: RegExp): number {
  let i = 8;
  const u = (): number => {
    let n = 0,
      s = 0;
    for (;;) {
      const c = wasm[i++] ?? 0;
      n += (c & 127) * 2 ** s;
      s += 7;
      if (c < 128) return n;
    }
  };
  const params: number[] = [],
    fnType: number[] = [],
    locals: number[] = [];
  let imports = 0;
  const names = new Map<string, number>();
  // the name section's function names (subsection 1), up to `end`
  const readNames = (end: number): void => {
    while (i < end) {
      const sub = wasm[i++] ?? 0,
        sl = u(),
        se = i + sl;
      for (let n = sub === 1 ? u() : 0; n > 0; n--) {
        const index = u(),
          l = u();
        names.set(dec.decode(wasm.subarray(i, i + l)), index);
        i += l;
      }
      i = se;
    }
  };
  while (i < wasm.length) {
    const id = wasm[i++] ?? 0;
    const len = u();
    const end = i + len;
    if (id === 1)
      for (let n = u(); n > 0; n--) {
        i++;
        const p = u();
        i += p;
        const r = u();
        i += r;
        params.push(p);
      }
    else if (id === 2)
      for (let n = u(); n > 0; n--) {
        const m = u();
        i += m;
        const f = u();
        i += f;
        if (wasm[i++] === 0) {
          u();
          imports++;
        }
      }
    else if (id === 3) for (let n = u(); n > 0; n--) fnType.push(u());
    else if (id === 10)
      for (let n = u(); n > 0; n--) {
        const size = u(),
          start = i;
        let l = 0;
        for (let runs = u(); runs > 0; runs--) {
          l += u();
          i++;
        }
        locals.push(l);
        i = start + size;
      }
    else if (id === 0) {
      const nl = u();
      const section = dec.decode(wasm.subarray(i, i + nl));
      i += nl;
      if (section === 'name') readNames(end);
    }
    i = end;
  }
  // the most of any function whose name matches (a generic function's copies: count[Int], count[View])
  const of = [...names].filter(([n]) => name.test(n)).map(([, index]) => index - imports);
  if (of.length === 0) throw new Error(`no function ${String(name)} in the module`);
  return Math.max(...of.map(at => (params[fnType[at] ?? 0] ?? 0) + (locals[at] ?? 0)));
}

const plain = builtOf(DEPTH);
const flat = builtOf(DEPTH, { inline: false });
const weight = LEVEL_BASE + slotsOf(flat.wasm, /^depth$/);
const generic = LEVEL_BASE + slotsOf(flat.wasm, /^depth\.count\[(Int|View)\]$/);
// count is depth.count: std has a count too, so the program's is known by its file's name
same(
  'the weights the build says are its frames',
  [plain.levels['depth'], plain.levels['depth.count']],
  [weight, generic],
);
// a call of n holds n + 1 frames (n down to 0): the deepest n holds at most the budget, the next one passes it
const deepestFor = (w: number): number => Math.floor(DEPTH_BUDGET / w) - 1;
const expect = { '/depth/': deepestFor(weight), '/ints/': deepestFor(generic), '/texts/': deepestFor(generic) };
const trapOf = (fn: string, w: number, n: number): string =>
  `trap 9: recursion too deep in ${fn} (${w * (n + 1)} units)`;
const wantOf = (r: (typeof ROUTES)[number]): { n: number; next: string } => {
  const fn = r === '/depth/' ? 'depth' : 'depth.count',
    w = r === '/depth/' ? weight : generic;
  return { n: expect[r], next: trapOf(fn, w, expect[r] + 1) };
};

for (const [label, options] of [
  ['plain', {}],
  ['traced', { trace: true }],
  ['inline off', { inline: false }],
  ['reuse off', { reuse: false }],
] as const) {
  const ask = askerOf(builtOf(DEPTH, options));
  same(
    `${label}: the deepest call that answers, and the trap one deeper`,
    ROUTES.map(r => [r, deepest(ask, r)]),
    ROUTES.map(r => [r, wantOf(r)]),
  );
}
const ask = askerOf(plain);
same('a tail call between two functions holds nothing: ping/pong 1,000,001 deep', ask('/ping/1000001'), '200 1');
const tooDeep = `/depth/${expect['/depth/'] + 1}`;
same('a request after a trap starts at depth 0', [ask(tooDeep), ask('/depth/10')], [wantOf('/depth/').next, '200 10']);

// every tier, in its own process: the same numbers, and the 400-value frame traps before the engine's stack ends
const node = process.execPath,
  self = new URL(import.meta.url).pathname;
const wideWeight = plainWeightOfWide();
function plainWeightOfWide(): number {
  return LEVEL_BASE + slotsOf(builtOf(WIDE, { inline: false }).wasm, /^wide$/);
}
const wideWant = { n: deepestFor(wideWeight), next: trapOf('wide', wideWeight, deepestFor(wideWeight) + 1) };
for (const flags of [[], ['--liftoff-only'], ['--no-liftoff']]) {
  const got: unknown = JSON.parse(execFileSync(node, [...flags, self, '--tier'], { encoding: 'utf8' }));
  same(
    `V8 ${flags.join(' ') || 'default'}: the same deepest calls, and a frame of 400 values traps 9 at its weight`,
    got,
    { ...Object.fromEntries(ROUTES.map(r => [r, wantOf(r)])), wide: wideWant },
  );
}

// the reference interpreter: the same answer one short of the budget, the same trap one past it
const interp: unknown = JSON.parse(
  execFileSync(node, ['--stack-size=16000', self, '--interp', String(expect['/depth/'])], { encoding: 'utf8' }),
);
same('the interpreter, given the weights: the same answer, the same trap, and depth 0 after it', interp, [
  `is ${expect['/depth/']}`,
  wantOf('/depth/').next.replace(/^trap 9: /, 'trap 9: '),
  'is 10',
]);
// LANGUAGE.md section 10 says the budget, the base, and the two depths measured here
const language = readFileSync(new URL('../LANGUAGE.md', import.meta.url), 'utf8').replaceAll('\n', ' ');
const said = (n: number): string => n.toLocaleString('en-US');
same(
  'LANGUAGE.md states the budget, the base and the two depths this measures',
  [
    language.includes(`hold ${said(DEPTH_BUDGET)} units of recursion`),
    language.includes(`${LEVEL_BASE} units and one for each value`),
    language.includes(`goes ${said(expect['/depth/'])} deep and one keeping 400 values ${said(wideWant.n)}`),
    language.includes(wantOf('/depth/').next),
  ],
  [true, true, true, true],
);
finish();
