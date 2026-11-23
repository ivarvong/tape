// Tape 0.3: the forms that remove what the usability benchmark measured agents tripping on
// (lab_notebook/tape-2026-11-21/usability-baseline.md). Each form is checked compiled and, where it gives a program a
// meaning, in the reference interpreter too; each refusal by its code.
import '../node25.ts';
import { compile } from '../compiler.ts';
import { interpret } from '../interp.ts';
import { std } from '../std.ts';
import { call, finish, functionsOf, same as T } from './harness.ts';

/** f(args) compiled and interpreted, as one answer when the two agree. */
const run = (src: string, fn: string, args: bigint[] = []): unknown => {
  const r = compile([...std, { name: 't.tape', text: src }], { exports: [fn] });
  const [no] = r.errors;
  if (r.wasm === null) return `ERR ${no?.code} line ${no?.line}: ${no?.message}`;
  const ex = functionsOf(new WebAssembly.Module(r.wasm));
  call(ex, 'reset');
  let compiled: unknown;
  try {
    compiled = call(ex, fn, ...args);
  } catch (e) {
    compiled = `TRAP ${e instanceof Error ? e.message : String(e)}`;
  }
  let interpreted: unknown;
  try {
    interpreted = interpret([...std, { name: 't.tape', text: src }]).call(fn, args);
  } catch (e) {
    interpreted = `TRAP ${e instanceof Error ? e.message : String(e)}`;
  }
  return typeof compiled === 'bigint' && compiled === interpreted
    ? Number(compiled)
    : `compiled ${String(compiled)}, interpreted ${String(interpreted)}`;
};
const codes = (src: string, exports: string[] = ['f']): string[] =>
  compile([...std, { name: 't.tape', text: src }], { exports }).errors.map(e => `${e.code}:${e.line}`);
const fix = (src: string, exports: string[] = ['f']): string =>
  compile([...std, { name: 't.tape', text: src }], { exports }).errors.map(
    e => `${e.code} ${e.message} | ${e.hint}`,
  )[0] ?? 'it compiles';

// ---- 1. match is an expression wherever a value is
const O = `type O {
  A(n: Int)
  B
}

`;
T(
  'match: a let value',
  run(
    `${O}fn f(o: O) -> Int {
  let n = match o {
    A(n: k) -> k * 2
    B -> 1
  }
  n + 1
}

fn t(k: Int) -> Int {
  f(o: A(n: k))
}
`,
    't',
    [5n],
  ),
  11,
);
T(
  'match: a condition match as a let value',
  run(
    `fn f(n: Int) -> Int {
  let big = match {
    n > 5 -> 100
    else -> 0
  }
  big + n
}
`,
    'f',
    [7n],
  ),
  107,
);
T(
  'match: an argument',
  run(
    `fn twice(n: Int) -> Int {
  n * 2
}

fn f(n: Int) -> Int {
  twice(match n {
    0 -> 10
    _ -> n
  })
}
`,
    'f',
    [0n],
  ),
  20,
);
T(
  'match: the left side of a pipe, and an operand',
  run(
    `fn plus(a: Int, b: Int) -> Int {
  a + b
}

fn f(n: Int) -> Int {
  let x = match n {
    1 -> 5
    _ -> 6
  }
    |> plus(b: 100)
  x + match {
    n == 1 -> 1000
    else -> 0
  }
}
`,
    'f',
    [1n],
  ),
  1105,
);
T(
  'match: in a let inside an arm inside a function value',
  run(
    `${O}fn f(k: Int) -> Int {
  let g = fn(o: O) -> Int {
    let m = match o {
      A(n) -> n
      B -> 0
    }
    m * 3
  }
  g(match k {
    0 -> B
    _ -> A(n: k)
  })
}
`,
    'f',
    [4n],
  ),
  12,
);
T(
  "match: a let's arms take steps of their own",
  run(
    `${O}fn f(k: Int) -> Int {
  let n = match k {
    0 -> {
      let A(n) = A(n: 9) else -> 0
      n
    }
    _ -> k
  }
  n + 1
}
`,
    'f',
    [0n],
  ),
  10,
);
T(
  'match: a Buf chosen by a let match is used once',
  run(
    `fn f(n: Int) -> Int {
  let out = match {
    n > 0 -> respond(status: 200)
    else -> respond(status: 404)
  }
  len(freeze(buf: out |> append(view: "ab")))
}
`,
    'f',
    [1n],
  ),
  6,
);
T(
  'match: a refined first arm gives its base type',
  run(
    `type Small = Int where self < 10

fn f(n: Int) -> Int {
  let m = match n {
    Small(s) -> s
    _ -> 99
  }
  m + 1
}
`,
    'f',
    [3n],
  ),
  4,
);
T(
  'match: a let match must still cover its subject (C24)',
  codes(`${O}fn f(o: O) -> Int {
  let n = match o {
    A(n: k) -> k
  }
  n
}
`),
  ['C24:7'],
);
T(
  'match: every arm has the first arm’s type (C14)',
  codes(`fn f(n: Int) -> Int {
  let x = match n {
    0 -> 1
    _ -> "one"
  }
  x
}
`),
  ['C14:4'],
);
T(
  'match: where nothing gives the type, the first arm says it (C21 names the fix)',
  fix(`fn f(n: Int) -> Int {
  let x = match n {
    0 -> None
    _ -> Some(value: n)
  }
  0
}
`).replace(/ \|.*/, ''),
  'C21 cannot tell which Option this None is',
);

finish();
