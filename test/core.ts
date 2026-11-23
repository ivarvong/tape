import '../node25.ts';
import { compile } from '../compiler.ts';
import type { Source } from '../compiler.ts';
import { bare, call, finish, functionsOf, ok, read, same as T } from './harness.ts';
import type { Bare } from './harness.ts';

const core = { name: 'std/core.tape', text: read('std/core.tape') };
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** A program compiled with these sources and instantiated; or `ERR …`, `INVALID …`. */
const loaded = (sources: Source[], exported: string[]): Bare | string => {
  const r = compile(sources, { exports: exported });
  const [no] = r.errors;
  if (r.wasm === null) return `ERR ${no?.code} line ${no?.line}: ${no?.message}`;
  try {
    return bare(new WebAssembly.Module(r.wasm));
  } catch (e) {
    return `INVALID ${messageOf(e)}`;
  }
};
/** The text at a pointer to (address, length). */
const textAt = (ex: Bare, at: number): string => {
  const d = new DataView(ex.memory.buffer);
  return new TextDecoder().decode(new Uint8Array(ex.memory.buffer, d.getInt32(at, true), d.getInt32(at + 4, true)));
};
const run = (src: string, fn: string, args: bigint[], exp = [fn]): unknown => {
  const ex = loaded([core, { name: 't', text: src }], exp);
  if (typeof ex === 'string') return ex;
  call(ex.fns, 'reset');
  try {
    const v = call(ex.fns, fn, ...args);
    return typeof v === 'number' && fn === 'text' ? textAt(ex, v) : v;
  } catch (e) {
    return `TRAP ${ex.why()} ${messageOf(e)}`;
  }
};
/** Each of these is refused with its code. */
const rejects = (cases: readonly (readonly [string, string, string])[], go: (src: string) => unknown): void => {
  for (const [n, src, code] of cases) {
    const g = String(go(src));
    ok(`reject ${n}`, g.startsWith(`ERR ${code}`), g);
  }
};
T('arith', run('fn f(a: Int, b: Int) -> Int {\n  a + b * 2 - (a / b) % 3\n}', 'f', [10n, 3n]), 16);
T(
  'cond match',
  run(
    'fn f(a: Int) -> Int {\n  match {\n    a < 0 -> 0 - 1\n    a == 0 or a == 1 -> 10\n    a > 5 and not (a > 9) -> 20\n    else -> 30\n  }\n}',
    'f',
    [7n],
  ),
  20,
);
T(
  'loop 1e6',
  run(
    'fn sum(n: Int, acc: Int) -> Int {\n  match {\n    n == 0 -> acc\n    else -> sum(n: n - 1, acc: acc + n)\n  }\n}',
    'sum',
    [1000000n, 0n],
  ),
  500000500000,
);
T(
  'mutual tail',
  run(
    'fn even(n: Int) -> Bool {\n  match {\n    n == 0 -> True\n    else -> odd(n: n - 1)\n  }\n}\nfn odd(n: Int) -> Bool {\n  match {\n    n == 0 -> False\n    else -> even(n: n - 1)\n  }\n}',
    'even',
    [300001n],
  ),
  0,
);
T(
  'adt + nested pattern + guard',
  run(
    `type Shape {
  Circle(r: Int)
  Rect(w: Int, h: Int)
  Dot
}
type Box { Box(shape: Shape, label: View) }
fn area(b: Box) -> Int {
  match b {
    Box(shape: Circle(r), label: "big") -> r * r * 300
    Box(shape: Circle(r)) -> r * r * 3
    Box(shape: Rect(w, h)) if w == h -> w * w
    Box(shape: Rect(w, h)) -> w * h + 1
    Box(shape: Dot) -> 0
    _ -> 0 - 1
  }
}
fn f(k: Int) -> Int {
  match k {
    0 -> area(Box(shape: Circle(2), label: "big"))
    1 -> area(Box(shape: Circle(2), label: "x"))
    2 -> area(Box(shape: Rect(w: 3, h: 3), label: ""))
    3 -> area(Box(shape: Rect(w: 3, h: 4), label: ""))
    _ -> area(Box(shape: Dot, label: ""))
  }
}`,
    'f',
    [0n],
  ),
  1200,
);
T(
  'option + field',
  run(
    `type P { P(x: Int, name: View) }
fn pick(k: Int) -> Option[P] {
  match {
    k > 0 -> Some(P(x: k, name: "abc"))
    else -> None
  }
}
fn f(k: Int) -> Int {
  g(o: pick(k))
}
fn g(o: Option[P]) -> Int {
  match o {
    Some(value) -> value.x + len(value.name) + value.name[1]
    None -> 0 - 5
  }
}`,
    'f',
    [4n],
  ),
  4 + 3 + 98,
);
T(
  'buf grows + text',
  String(
    run(
      `fn fill(out: Buf, n: Int) -> Buf {
  match {
    n == 0 -> out
    else -> fill(out: push(buf: append(buf: out, view: "ab"), byte: 48 + n % 10), n: n - 1)
  }
}
fn text(n: Int) -> Buf {
  let other = append(buf: buf(), view: "zz")
  let b = fill(out: buf(), n)
  let mid = size(b)
  append(buf: append(buf: b, view: freeze(other)), view: slice(v: "hello", from: 1, to: 3))
}`,
      'text',
      [40n],
    ),
  ).slice(-10),
  'ab2ab1zzel',
);
T('bounds trap', run('fn f(i: Int) -> Int {\n  "abc"[i]\n}', 'f', [3n]), 'TRAP 3 unreachable');
T('div trap', run('fn f(i: Int) -> Int {\n  10 / i\n}', 'f', [0n]), 'TRAP 4 unreachable');
T('reductions trap', run('fn f(i: Int) -> Int {\n  f(i: i + 1)\n}', 'f', [0n]), 'TRAP 2 unreachable');
rejects(
  [
    ['non-exhaustive', 'fn f(o: Option[Int]) -> Int {\n  match o {\n    Some(value) -> value\n  }\n}', 'C24'],
    [
      'guard not covering',
      'fn f(o: Option[Int]) -> Int {\n  match o {\n    Some(value) if value > 0 -> value\n    None -> 0\n  }\n}',
      'C24',
    ],
    [
      'buf used twice',
      'fn f(b: Buf) -> Buf {\n  let c = push(buf: b, byte: 1)\n  append(buf: b, view: freeze(c))\n}',
      'C25',
    ],
    ['buf dropped', 'fn f(n: Int) -> Int {\n  let c = buf()\n  n\n}', 'C27'],
    ['arms differ', 'fn f(b: Buf, n: Int) -> View {\n  match n {\n    0 -> freeze(b)\n    _ -> "x"\n  }\n}', 'C28'],
    ['positional', 'fn g(a: Int, b: Int) -> Int {\n  a\n}\nfn f(n: Int) -> Int {\n  g(1, 2)\n}', 'C10'],
    ['type mismatch', 'fn f(n: Int) -> Bool {\n  n + 1\n}', 'C14'],
    // a function nothing calls is checked too: its error is the program's, at its line (until 2026-11-23 it compiled)
    [
      'type error in a function nothing calls',
      'fn f(n: Int) -> Int {\n  n\n}\nfn g(n: Int) -> Int {\n  n + "1"\n}',
      'C14 line 5',
    ],
    [
      'unknown name in a function nothing calls',
      'fn f(n: Int) -> Int {\n  n\n}\nfn g(n: Int) -> Int {\n  m\n}',
      'C16 line 5',
    ],
    ['unknown name', 'fn f(count: Int) -> Int {\n  coumt + 1\n}', 'C16'],
    ['no else', 'fn f(n: Int) -> Int {\n  match {\n    n > 0 -> 1\n  }\n}', 'C24'],
  ],
  src => run(src, 'f', [0n]),
);

// ---- patterns as parsers
const lib = [{ name: 'std/text.tape', text: read('std/text.tape') }];
const run2 = (src: string, fn: string, args: bigint[]): unknown => {
  const ex = loaded([core, ...lib, { name: 't', text: src }], [fn]);
  if (typeof ex === 'string') return ex;
  call(ex.fns, 'reset');
  try {
    return call(ex.fns, fn, ...args);
  } catch {
    return `TRAP ${ex.why()}`;
  }
};
const P = `type Small = Int where self >= 1 and self <= 9
type Word = View where len(self) >= 2
fn pick(k: Int) -> View {
  match k {
    0 -> "/items/7"
    1 -> "/items/12"
    2 -> "/items/x"
    3 -> "/other"
    _ -> "/items/"
  }
}
fn f(k: Int) -> Int {
  route(path: pick(k))
}
fn route(path: View) -> Int {
  match path {
    "/items/" ++ decimal(Small(n)) -> double(n)
    "/items/" ++ decimal(n) -> 100 + n
    "/items/" ++ Word(w) -> 1000 + len(w)
    "/items/" ++ rest -> 2000 + len(rest)
    _ -> 0 - 1
  }
}
fn double(n: Small) -> Int {
  n * 2
}`;
for (const [k, want] of [
  [0, 14],
  [1, 112],
  [3, -1],
  [4, 2000],
] as const)
  T(`parser patterns, case ${k}`, run2(P, 'f', [BigInt(k)]), want);
T('parser patterns, case 2', run2(P, 'f', [2n]), 2001);
rejects(
  [
    ['refined built directly', 'type Small = Int where self > 0\nfn f(n: Int) -> Small {\n  Small(n)\n}', 'C36'],
    [
      'unrefined passed as refined',
      'type Small = Int where self > 0\nfn g(s: Small) -> Int {\n  s\n}\nfn f(n: Int) -> Int {\n  g(s: n)\n}',
      'C14',
    ],
    [
      'non-Option function as a pattern',
      'fn g(n: Int) -> Int {\n  n\n}\nfn f(n: Int) -> Int {\n  match n {\n    g(m) -> m\n    _ -> 0\n  }\n}',
      'C34',
    ],
    [
      'prefix pattern without fallback',
      'fn f(n: Int) -> Int {\n  g(v: "abc")\n}\nfn g(v: View) -> Int {\n  match v {\n    "a" ++ rest -> len(rest)\n  }\n}',
      'C24',
    ],
  ],
  src => run2(src, 'f', [0n]),
);

// ---- let … else: steps that can each fail, each leaving with its own answer
const W = `type Small = Int where self >= 1 and self <= 9
fn pick(k: Int) -> View {
  match k {
    0 -> "7,3"
    1 -> "7,30"
    2 -> "x,3"
    _ -> "73"
  }
}
fn f(k: Int) -> Int {
  sum(text: pick(k))
}
fn sum(text: View) -> Int {
  let Some(a) = decimal(until(v: text, byte: 44)) else -> 0 - 1
  let Small(b) = a else -> 0 - 2
  let Some(c) = decimal(after(v: text, byte: 44)) else -> 0 - 3
  let Small(d) = c else -> 0 - 4
  b * 10 + d
}`;
for (const [k, want] of [
  [0, 73],
  [1, -4],
  [2, -1],
  [3, -2],
] as const)
  T(`let else in steps, case ${k}`, run2(W, 'f', [BigInt(k)]), want);
T(
  '`with { … }` is refused, with the form that replaced it',
  compile(
    [
      core,
      ...lib,
      { name: 't', text: 'fn f(o: Option[Int]) -> Int {\n  with {\n    Some(a) <- o\n    -> a\n    else -> 0\n  }\n}' },
    ],
    { exports: ['f'] },
  ).errors?.map(e => `${e.code}:${e.line} ${e.hint.slice(0, 42)}`),
  ['C35:2 Write each step as `let pattern = expressi'],
);
{
  // traced: a step that fails is tried and not matched, and the trace shows its else taken, on that step's line
  const r = compile([core, ...lib, { name: 't', text: W }], { exports: ['f'], trace: true });
  if (r.wasm === null) throw new Error('the traced program does not compile');
  const ev: { fn: string; kind: string; line: number; what: number }[] = [];
  const trace = (site: number, what: number): void => {
    const s = r.sites[site];
    if (s) ev.push({ fn: s.fn, kind: s.kind, line: s.line, what });
  };
  const ex = functionsOf(new WebAssembly.Module(r.wasm), { env: { trace } });
  call(ex, 'reset');
  // "7,30": three steps match, the fourth (30 is not Small) does not
  call(ex, 'f', 1n);
  const lines = W.split('\n'),
    at = (k: string) => lines.findIndex(l => l.trim().startsWith(k)) + 1;
  T(
    'let else in steps, traced fall-through',
    ev.filter(e => e.fn === 'sum' && e.what !== 2).map(e => [e.kind, e.line, e.what]),
    [
      ['arm', at('let Some(a)'), 0],
      ['arm', at('let Some(a)'), 1],
      ['arm', at('let Small(b)'), 0],
      ['arm', at('let Small(b)'), 1],
      ['arm', at('let Some(c)'), 0],
      ['arm', at('let Some(c)'), 1],
      ['arm', at('let Small(d)'), 0], // the step is tried and does not match (30 is not Small)
      ['arm', at('let Small(d)'), 0], // its else, on the same line, is tried
      ['arm', at('let Small(d)'), 1], // and taken
    ],
  );
}

// ---- flags
const FL = `flag double_it: Bool = False
flag limit: Int = 5
type Small = Int where self <= flags.limit
fn f(n: Int) -> Int {
  match n {
    Small(k) if flags.double_it -> k * 2
    Small(k) -> k
    _ -> 0 - 1
  }
}`;
{
  const r = compile([core, { name: 't', text: FL }], { exports: ['f'] });
  if (r.wasm === null) throw new Error('the flags program does not compile');
  const ex = bare(new WebAssembly.Module(r.wasm));
  const d = new DataView(ex.memory.buffer);
  const at = (name: string): number => r.flags.find(x => x.name === name)?.at ?? 0;
  const f = (b: Bare, n: bigint): unknown => call(b.fns, 'f', n);
  T('flags: defaults', [f(ex, 4n), f(ex, 6n)], [4, -1]);
  d.setBigInt64(at('double_it'), 1n, true);
  d.setBigInt64(at('limit'), 6n, true);
  T('flags: set by the host', [f(ex, 4n), f(ex, 6n), f(ex, 7n)], [8, 12, -1]);
  const pinned = compile([core, { name: 't', text: FL }], { exports: ['f'], pin: { double_it: true, limit: 3 } });
  if (pinned.wasm === null) throw new Error('the pinned program does not compile');
  const px = bare(new WebAssembly.Module(pinned.wasm));
  T('flags: pinned at compile time', [f(px, 3n), f(px, 4n)], [6, -1]);
}
rejects(
  [
    ['flag never read', 'flag old: Bool = False\nfn f(n: Int) -> Int {\n  n\n}', 'C38'],
    ['unknown flag', 'flag new_ui: Bool = False\nfn f(n: Int) -> Bool {\n  flags.new_ux\n}', 'C37'],
    ['flag default of the wrong type', 'flag limit: Int = True\nfn f(n: Int) -> Int {\n  flags.limit\n}', 'C37'],
  ],
  src => run2(src, 'f', [0n]),
);
finish();
