// test/generics.ts: generic functions and the immutable collections in std (List, Map).
import '../node25.ts';
import { compile } from '../compiler.ts';
import { std } from '../std.ts';
import type { Source } from '../compiler.ts';
import { isHead } from '../host.ts';
import { bare, built, call, finish, moduleOf, read, same as T } from './harness.ts';
/** `f` of a program, called; or what the compiler refused. */
const run = (text: string, args: bigint[] = []): number | string => {
  const r = compile([...std, { name: 't', text }], { exports: ['f'] });
  const [no] = r.errors;
  if (r.wasm === null) return `${no?.code} ${no?.file}:${no?.line} ${no?.message}`;
  const ex = bare(new WebAssembly.Module(r.wasm));
  call(ex.fns, 'reset');
  return Number(call(ex.fns, 'f', ...args));
};

T(
  'generic identity at two types',
  run(
    `fn pick[T](a: T, b: T, first: Bool) -> T {
  match {
    first -> a
    else -> b
  }
}
fn f(n: Int) -> Int {
  pick(a: n, b: 2, first: True) + len(pick(a: "xy", b: "abc", first: False))
}`,
    [10n],
  ),
  13,
);
T(
  'list: length and reverse',
  run(
    `fn fill(n: Int, acc: List[Int]) -> List[Int] {
  match {
    n == 0 -> acc
    else -> fill(n: n - 1, acc: Cons(head: n, tail: acc))
  }
}
fn first(list: List[Int]) -> Int {
  match list {
    Cons(head) -> head
    Nil -> 0
  }
}
fn f(n: Int) -> Int {
  length(list: fill(n, acc: Nil)) * 1000 + first(list: reverse(list: fill(n, acc: Nil)))
}`,
    [500n],
  ),
  500500,
);
const MAP = `fn name(n: Int) -> View {
  freeze(write_int(out: append(buf: buf(), view: "k"), value: n))
}
fn fill(n: Int, step: Int, map: Map[Int]) -> Map[Int] {
  match {
    n == 0 -> map
    else -> fill(n: n - 1, step, map: put(map, key: name(n: (n * step) % 1009), value: n))
  }
}
fn or_zero(found: Option[Int]) -> Int {
  match found {
    Some(value) -> value
    None -> 0
  }
}
`;
T(
  'map: put, get, count, overwrite',
  run(
    MAP +
      `fn f(n: Int) -> Int {
  let map = put(map: fill(n, step: 7, map: Empty), key: "k7", value: 0 - 5)
  count(map) * 1000000 + or_zero(found: get(map, key: "k14")) * 1000 + or_zero(found: get(map, key: "missing")) + or_zero(found: get(map, key: "k7")) + 5
}`,
    [1000n],
  ),
  1000 * 1000000 + 2 * 1000,
);
// put_with is get then put in one walk: the same map (keys, values, order) for the same keys, and a tree that stays
// balanced, with every stored height right, on keys that repeat (step 7 mod 1009 over 3,000: each key 2-3 times)
// and on sorted keys (step 1). sig is a checksum of the in-order walk; avl is the height, or -1 when a node breaks
// the AVL rule or stores a wrong height.
const WITH = `fn plus_one(n: Int) -> Int {
  n + 1
}
fn by_get_put(n: Int, step: Int, map: Map[Int]) -> Map[Int] {
  match {
    n == 0 -> map
    else -> {
      let key = name(n: (n * step) % 1009)
      by_get_put(n: n - 1, step, map: put(map, key, value: or_zero(found: get(map, key)) + 1))
    }
  }
}
fn by_put_with(n: Int, step: Int, map: Map[Int]) -> Map[Int] {
  match {
    n == 0 -> map
    else -> by_put_with(n: n - 1, step, map: put_with(map, key: name(n: (n * step) % 1009), from: 0, by: plus_one))
  }
}
fn sig(map: Map[Int], acc: Int) -> Int {
  match map {
    Empty -> acc
    Node(left, key, value, right) -> sig(map: right, acc: (sig(map: left, acc) * 31 + value * 1009 + len(key)) % 1000000007)
  }
}
fn avl(map: Map[Int]) -> Int {
  match map {
    Empty -> 0
    Node(left, right, height) -> {
      let l = avl(map: left)
      let r = avl(map: right)
      match {
        l < 0 or r < 0 -> 0 - 1
        l - r > 1 or r - l > 1 -> 0 - 1
        height != max(a: l, b: r) + 1 -> 0 - 1
        else -> height
      }
    }
  }
}
`;
for (const step of [7, 1])
  T(
    `map: put_with is get then put, and stays balanced (step ${step})`,
    run(
      MAP +
        WITH +
        `fn f(n: Int) -> Int {
  let a = by_get_put(n, step: ${step}, map: Empty)
  let b = by_put_with(n, step: ${step}, map: Empty)
  match {
    sig(map: a, acc: 0) != sig(map: b, acc: 0) -> 1
    count(map: a) != count(map: b) -> 2
    avl(map: b) < 0 -> 3
    avl(map: b) > 12 -> 4
    else -> 0
  }
}`,
      [3000n],
    ),
    0,
  );
T(
  'map stays balanced on sorted inserts',
  Number(
    run(
      MAP +
        `fn height(map: Map[Int]) -> Int {
  match map {
    Empty -> 0
    Node(height) -> height
  }
}
fn f(n: Int) -> Int {
  height(map: fill(n, step: 1, map: Empty))
}`,
      [1000n],
    ),
  ) <= 12,
  true,
);
T(
  'the old map is unchanged',
  run(
    MAP +
      `fn f(n: Int) -> Int {
  let old = put(map: Empty, key: "a", value: 1)
  let new = put(map: old, key: "a", value: 2)
  or_zero(found: get(map: old, key: "a")) * 10 + or_zero(found: get(map: new, key: "a"))
}`,
    [0n],
  ),
  12,
);
T(
  'map of records',
  run(
    `type Stat { Stat(count: Int, total: Int) }
fn bump(found: Option[Stat], by: Int) -> Stat {
  match found {
    Some(value: Stat(count, total)) -> Stat(count: count + 1, total: total + by)
    None -> Stat(count: 1, total: by)
  }
}
fn total(found: Option[Stat]) -> Int {
  match found {
    Some(value) -> value.count * 100 + value.total
    None -> 0
  }
}
fn f(n: Int) -> Int {
  let one = put(map: Empty, key: "US", value: bump(found: None, by: 5))
  let two = put(map: one, key: "US", value: bump(found: get(map: one, key: "US"), by: n))
  total(found: get(map: two, key: "US"))
}`,
    [7n],
  ),
  212,
);
T(
  'a type that cannot be inferred is an error',
  String(
    run(
      `fn f(n: Int) -> Int {
  count(map: Empty)
}`,
      [0n],
    ),
  ).slice(0, 3),
  'C43',
);

// ---- functions as values
const FILL = `fn fill(n: Int, acc: List[Int]) -> List[Int] {
  match {
    n == 0 -> acc
    else -> fill(n: n - 1, acc: Cons(head: n, tail: acc))
  }
}
fn add(a: Int, b: Int) -> Int {
  a + b
}
fn double(n: Int) -> Int {
  n * 2
}
`;
T(
  'fold with a named function',
  run(
    FILL +
      `fn f(n: Int) -> Int {
  fold(list: fill(n, acc: Nil), from: 0, by: add)
}`,
    [100n],
  ),
  5050,
);
T(
  'map with a named function, then fold',
  run(
    FILL +
      `fn f(n: Int) -> Int {
  fold(list: map(list: fill(n, acc: Nil), by: double), from: 0, by: add)
}`,
    [100n],
  ),
  10100,
);
T(
  'a function value captures a variable',
  run(
    FILL +
      `fn f(n: Int) -> Int {
  let scaled = map(list: fill(n: 10, acc: Nil), by: fn(x: Int) -> Int { x * n })
  fold(list: scaled, from: 0, by: add)
}`,
    [3n],
  ),
  165,
);
T(
  'filter, and a function that changes the item type',
  run(
    FILL +
      `type Pair { Pair(n: Int, even: Bool) }
fn total(acc: Int, p: Pair) -> Int {
  match p {
    Pair(n, even: True) -> acc + n
    Pair(n) -> acc - n
  }
}
fn f(n: Int) -> Int {
  let big = filter(list: fill(n, acc: Nil), keep: fn(x: Int) -> Bool { x > 5 })
  fold(list: map(list: big, by: fn(x: Int) -> Pair { Pair(n: x, even: x % 2 == 0) }), from: 0, by: total)
}`,
    [10n],
  ),
  6 - 7 + 8 - 9 + 10,
);
T(
  'a function value stored in a let and called',
  run(
    `fn f(n: Int) -> Int {
  let inc = fn(x: Int) -> Int { x + n }
  inc(inc(1))
}`,
    [20n],
  ),
  41,
);
T(
  'fold over 100,000 items',
  run(
    FILL +
      `fn f(n: Int) -> Int {
  fold(list: fill(n, acc: Nil), from: 0, by: fn(acc: Int, x: Int) -> Int { acc + x % 7 })
}`,
    [100000n],
  ),
  (() => {
    let s = 0;
    for (let i = 1; i <= 100000; i++) s += i % 7;
    return s;
  })(),
);
T(
  'capturing a Buf is rejected',
  String(
    run(
      `fn f(n: Int) -> Int {
  let out = buf()
  let g = fn(x: Int) -> Int { size(out) + x }
  g(1)
}`,
      [0n],
    ),
  ).slice(0, 3),
  'C44',
);

// ---- files are namespaces
{
  const many = (files: Source[], fn = 'f'): number | string => {
    const r = compile([...std, ...files], { exports: [fn] });
    const [no] = r.errors;
    if (r.wasm === null) return `${no?.code} ${no?.message} | ${no?.hint}`;
    const ex = bare(new WebAssembly.Module(r.wasm));
    call(ex.fns, 'reset');
    return Number(call(ex.fns, fn, 5n));
  };
  const a = {
    name: 'lib/shapes.tape',
    text: 'fn area(n: Int) -> Int {\n  scale(n) * n\n}\nfn scale(n: Int) -> Int {\n  n * 3\n}\n',
  };
  const b = {
    name: 'lib/money.tape',
    text: 'fn cents(n: Int) -> Int {\n  scale(n)\n}\nfn scale(n: Int) -> Int {\n  n * 100\n}\n',
  };
  T(
    'each file calls its own function of the same name',
    many([a, b, { name: 'main.tape', text: 'fn f(n: Int) -> Int {\n  area(n) + cents(n)\n}\n' }]),
    75 + 500,
  );
  T(
    'a third file must say which',
    String(many([a, b, { name: 'main.tape', text: 'fn f(n: Int) -> Int {\n  scale(n)\n}\n' }])),
    'C45 scale is defined in lib/shapes.tape and lib/money.tape | Say which one: `shapes.scale(…)` or `money.scale(…)`.',
  );
  T(
    'qualified calls',
    many([a, b, { name: 'main.tape', text: 'fn f(n: Int) -> Int {\n  shapes.scale(n) + money.scale(n)\n}\n' }]),
    515,
  );
  T(
    'a program may reuse a standard library name',
    many([
      {
        name: 'main.tape',
        text: 'fn until(n: Int) -> Int {\n  n + 1\n}\nfn f(n: Int) -> Int {\n  until(n) + len(text.until(v: "a,b", byte: 44))\n}\n',
      },
    ]),
    7,
  );
  T(
    'twice in one file is still an error',
    String(many([{ name: 'main.tape', text: 'fn f(n: Int) -> Int {\n  n\n}\nfn f(n: Int) -> Int {\n  n\n}\n' }])).slice(
      0,
      3,
    ),
    'C04',
  );
}

// ---- memory is a deterministic, testable number
{
  const { instantiate } = await import('../host.ts'),
    { gen } = await import('../bench/csv-gen.ts');
  const app = instantiate(moduleOf(built([{ name: 'examples/csv.tape', text: read('examples/csv.tape') }]))),
    input = gen(100_000, 7),
    rows = input.toString().split('\n').length - 2;
  app.handle(input);
  const first = app.bytesUsed,
    log = app.effects;
  app.handle(gen(5000, 3));
  app.handle(input);
  T(
    'the same request uses the same bytes every time',
    [app.bytesUsed === first, log[0] !== undefined && isHead(log[0]) && log[0].bytes === first],
    [true, true],
  );
  T(
    'csv.tape memory per row is within its budget',
    (first - input.length) / rows < (process.env.TAPE_REUSE === '0' ? 300 : 10),
    true,
  );
  console.log(`(csv.tape, 100 KB: ${first} bytes used, ${((first - input.length) / rows).toFixed(0)} per row)`);
}

// ---- the step budget covers generic functions (found by proof/verify.ts: an endless loop in one was not stopped)
{
  const r = compile(
    [
      ...std,
      {
        name: 't',
        text: 'fn spin[T](x: T, n: Int) -> T {\n  match {\n    n < 0 -> x\n    else -> spin(x, n: n + 1)\n  }\n}\nfn f(n: Int) -> Int {\n  spin(x: 1, n)\n}\n',
      },
    ],
    { exports: ['f'], reductionLimit: 100000 },
  );
  if (r.wasm === null) throw new Error('the endless loop does not compile');
  const ex = bare(new WebAssembly.Module(r.wasm));
  call(ex.fns, 'reset');
  T(
    'an endless loop in a generic function hits the step budget',
    (() => {
      try {
        call(ex.fns, 'f', 0n);
        return 'returned';
      } catch {
        return ex.why();
      }
    })(),
    2,
  );
}

// ---- holes found by proof/mutate.ts: mutants that survived until these were added
T(
  'an argument to a function value is not a tail call',
  run(
    `fn double(n: Int) -> Int {
  n * 2
}
fn f(n: Int) -> Int {
  let inc = fn(x: Int) -> Int { x + 1 }
  inc(double(n))
}`,
    [20n],
  ),
  41,
);
const WRAP = `fn wrap(n: Int) -> Option[List[Int]] {
  Some(value: Cons(head: n, tail: Nil))
}
`;
T(
  'a nested case left out is rejected',
  String(
    run(
      WRAP +
        `fn f(n: Int) -> Int {
  match wrap(n) {
    Some(value: Cons(head)) -> head
    None -> 0
  }
}`,
      [1n],
    ),
  ).slice(0, 47),
  'C24 t:5 match does not cover Some(value: Nil)',
);
T(
  'every nested case covered is accepted',
  run(
    WRAP +
      `fn f(n: Int) -> Int {
  match wrap(n) {
    Some(value: Cons(head)) -> head
    Some(value: Nil) -> 0 - 1
    None -> 0
  }
}`,
    [5n],
  ),
  5,
);
// a function value written in a generic function names its type parameter, and each copy reads it as its own type
// (std's write_rows hands fold_rows one); before, that parameter was C06, unknown type T
const PAIRS = `fn count_if[T](list: List[T], keep: Fn[T, Bool]) -> Int {
  list |> fold(from: 0, by: fn(n: Int, item: T) -> Int {
    match {
      keep(item) -> n + 1
      else -> n
    }
  })
}
fn ints() -> List[Int] {
  Cons(head: 1, tail: Cons(head: 4, tail: Cons(head: 6, tail: Nil)))
}
fn texts() -> List[View] {
  Cons(head: "a", tail: Cons(head: "bcd", tail: Nil))
}
`;
T(
  'a function value in a generic function names its type parameter, at two types',
  run(
    PAIRS +
      `fn f(n: Int) -> Int {
  count_if(list: ints(), keep: fn(x: Int) -> Bool { x > n }) * 10
    + count_if(list: texts(), keep: fn(t: View) -> Bool { len(t) > n })
}`,
    [2n],
  ),
  21,
);
finish();
