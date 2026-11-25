// Language features: as-patterns and destructuring `let` (more to come: pipes, `++` in expressions, the
// formatter, doc tests). Each program runs under the default, never-release and checked builds, and through
// interp.ts, the independent meaning of the pure language; all four must agree.
import '../node25.ts';
import { readFileSync } from 'node:fs';
import { compile } from '../compiler.ts';
import { interpret } from '../interp.ts';
import { parseProgram } from '../compiler.ts';
import { format } from '../fmt.ts';
import { doctests } from '../cli/test.ts';
import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { std } from '../std.ts';
import type { Options } from '../compiler.ts';
import { TimedOut, instantiate, isHead, isWake, replay } from '../host.ts';
import { nodeSql } from '../nodesql.ts';
import type { Effect, Head, Service, Transaction } from '../host.ts';
import { bare, built, call, finish, messageOf, moduleOf, objectIn, same as T } from './harness.ts';
const NOW = Date.now(); // R-RET-1: a kv op id is <t>_<id>, t the client's clock in ms when it was first sent
const BUILDS: Partial<Options>[] = [{}, { reuse: false }, { check: true }];
/** fn(args) in one build: its answer, the first thing refused, or its trap. */
const inBuild = (text: string, fn: string, args: bigint[], o: Partial<Options>): number | string => {
  const r = compile([...std, { name: 't.tape', text }], { ...o, exports: [fn] });
  const [no] = r.errors;
  if (r.wasm === null) return `${no?.code} ${no?.line}: ${no?.message}`;
  const ex = bare(new WebAssembly.Module(r.wasm));
  call(ex.fns, 'reset');
  try {
    return Number(call(ex.fns, fn, ...args));
  } catch {
    return `trap ${ex.why()}`;
  }
};
// the answer of fn(args) under every build and the interpreter, or the first compile error
const agree = (text: string, fn: string, args: bigint[] = []): unknown => {
  const got = BUILDS.map(o => inBuild(text, fn, args, o));
  if (typeof got[0] === 'string') return got[0];
  let i: number | string = '';
  try {
    i = Number(interpret([...std, { name: 't.tape', text }]).call(fn, args));
  } catch (e) {
    i = `interp: ${messageOf(e)}`;
  }
  return got.every(g => g === got[0]) && got[0] === i ? got[0] : { builds: got, interp: i };
};
const error = (text: string, fn = 'f'): string => {
  const [no] = compile([...std, { name: 't.tape', text }], { exports: [fn] }).errors;
  return no ? `${no.code} ${no.message} | ${no.hint}` : 'compiled';
};

// ---- 1. as-patterns: `name = Pattern` binds the whole value once the pattern inside it matches
const orders = `type Order { Order(id: Int, state: View, qty: Int) }
type Pair { Pair(left: Order, right: Option[Order]) }
type Chain { Link(head: Int, tail: Chain)  Stop }
`;
T(
  'as: a nested record bound whole, with a literal field inside',
  agree(
    orders +
      `
fn pick(found: Option[Order]) -> Int {
  match found {
    Some(value: order = Order(state: "done")) -> order.id * 100 + order.qty
    Some(value: Order(id, qty, state)) if len(state) > 4 -> id + qty
    Some(value) -> value.qty
    None -> 0
  }
}
fn f(n: Int) -> Int {
  pick(found: Some(value: Order(id: n, state: "done", qty: 2))) * 1000 + pick(found: Some(value: Order(id: n, state: "waiting", qty: 2)))
}`,
    'f',
    [7n],
  ),
  702009,
);
T(
  'as: on a recursive value, the whole and its parts both used (memory reuse stays sound)',
  agree(
    orders +
      `
fn sum(xs: Chain, acc: Int) -> Int {
  match xs {
    whole = Link(head, tail: rest = Link(head: second)) -> sum(xs: rest, acc: acc + head * 1000 + second + count(xs: whole, n: 0) * 100000)
    Link(head, tail) -> sum(xs: tail, acc: acc + head)
    Stop -> acc
  }
}
fn count(xs: Chain, n: Int) -> Int {
  match xs {
    Link(tail) -> count(xs: tail, n: n + 1)
    Stop -> n
  }
}
fn f(n: Int) -> Int {
  sum(xs: Link(head: 1, tail: Link(head: 2, tail: Link(head: n, tail: Stop))), acc: 0)
}`,
    'f',
    [3n],
  ),
  503008,
);
T(
  'as: at the top of an arm, and in a `let … else` step',
  agree(
    orders +
      `
fn g(o: Option[Order]) -> Int {
  let Some(value: hit = Order(qty: 3)) = o else -> 0 - 1
  hit.id
}
fn h(o: Order) -> Int {
  match o {
    whole = Order(state: "x") -> whole.qty
    _ -> 0
  }
}
fn f(n: Int) -> Int {
  g(o: Some(value: Order(id: n, state: "a", qty: 3))) * 100 + g(o: None) + h(o: Order(id: 1, state: "x", qty: 40)) * 10
}`,
    'f',
    [5n],
  ),
  899,
);
T(
  'as: exhaustiveness sees through it (C24 still names the missing case)',
  error(
    orders +
      `
fn f(o: Option[Order]) -> Int {
  match o {
    Some(value: x = Order(state: "done")) -> x.id
    None -> 0
  }
}`,
  ),
  'C24 match does not cover Some(value: Order) | Add an arm for it, or a last arm `_ -> …`. An arm with `if` does not count: its condition can be false.',
);
T(
  'as: a name is still bound once per function',
  error(
    orders +
      `
fn f(o: Option[Order]) -> Int {
  match o {
    Some(value: id = Order(id)) -> id
    None -> 0
  }
}`,
  ),
  'C15 id is already defined | Names are never reused in a function. Pick a new name.',
);

// ---- 1. destructuring let: a pattern that cannot fail
T(
  'let: nested destructuring with an as-pattern inside',
  agree(
    orders +
      `
fn total(p: Pair) -> Int {
  let Pair(left: left = Order(id, qty), right) = p
  let Order(state) = left
  more(base: id * 10 + qty + len(state), right)
}
fn more(base: Int, right: Option[Order]) -> Int {
  match right {
    Some(value: o = Order(qty: 3)) -> base + o.id
    _ -> base
  }
}
fn f(n: Int) -> Int {
  total(p: Pair(left: Order(id: 1, state: "ab", qty: 2), right: Some(value: Order(id: n, state: "x", qty: 3))))
}`,
    'f',
    [5n],
  ),
  19,
);
T(
  'let: a pattern that can fail is refused, naming the part',
  error(
    orders +
      `
fn f(o: Option[Order]) -> Int {
  let Some(value: Order(id)) = o
  id
}`,
  ),
  'C48 this let pattern can fail: Some, but the value can also be None | `let` only takes apart a value that always matches: a type with one constructor, with names or `_` inside. To handle the other cases, add `else { … }` after it (a step: `let P = e else { other -> … }`), or use `match`.',
);
T(
  'let: a number is a pattern too; with else, the other numbers leave (go on when one row changed)',
  [1n, 0n, 7n].map(n =>
    agree(
      `
fn f(changed: Int) -> Int {
  let 1 = changed else -> 0 - changed
  100
}`,
      'f',
      [n],
    ),
  ),
  [100, 0, -7],
);
T(
  'let: a number without else is refused, as any pattern that can fail',
  error(`
fn f(changed: Int) -> Int {
  let 1 = changed
  100
}`).split(' | ')[0],
  'C48 this let pattern can fail: the number 1',
);
T(
  'let: a literal inside is refused, naming the field',
  error(
    orders +
      `
fn f(o: Order) -> Int {
  let Order(id, state: "done") = o
  id
}`,
  ).split(' | ')[0],
  'C48 this let pattern can fail: the text "done" (in field state)',
);
T(
  'let: a refined type inside is refused',
  error(`type Qty = Int where self >= 1
type Line { Line(qty: Int) }
fn f(l: Line) -> Int {
  let Line(qty: Qty(q)) = l
  q
}`).split(' | ')[0],
  'C48 this let pattern can fail: Qty(…), a refined type whose condition can be false (in field qty)',
);

// ---- 2. pipes: `a |> f(b: 1)` is `f(<f's first parameter>: a, b: 1)`
T(
  'pipe: fills the first declared parameter, whatever its name; chains read left to right',
  agree(
    `
fn scale(amount: Int, by: Int) -> Int {
  amount * by
}
fn shift(n: Int, up: Int) -> Int {
  n + up
}
fn double(n: Int) -> Int {
  n * 2
}
fn f(x: Int) -> Int {
  x |> scale(by: 10) |> shift(up: 3) |> double
}`,
    'f',
    [4n],
  ),
  86,
);
T(
  'pipe: precedence sits between arithmetic and comparison',
  agree(
    `
fn double(n: Int) -> Int {
  n * 2
}
fn f(x: Int) -> Int {
  let a = x + 1 |> double
  let b = a == x + 1 |> double
  let c = x |> double == 8
  let d = x |> double + 1
  match {
    b and c -> a * 100 + d
    else -> 0
  }
}`,
    'f',
    [4n],
  ),
  1009,
);
T(
  'pipe: into built-ins and std (append, write_int, push, until, len)',
  agree(
    `
fn f(x: Int) -> Int {
  let out = buf() |> append(view: "n=") |> write_int(value: x) |> push(byte: 33) |> freeze
  let head = "key=value" |> until(byte: 61)
  len(out) * 10 + (head |> len)
}`,
    'f',
    [42n],
  ),
  53,
);
T(
  'pipe: into a function value',
  agree(
    `
fn twice(by: Fn[Int, Int], x: Int) -> Int {
  x |> by |> by
}
fn inc(n: Int) -> Int {
  n + 1
}
fn f(x: Int) -> Int {
  twice(by: inc, x)
}`,
    'f',
    [5n],
  ),
  7,
);
T(
  'pipe: the same code as nested calls (sugar only)',
  (() => {
    const a = compile(
      [
        ...std,
        {
          name: 't.tape',
          text: 'fn f(x: Int) -> Buf {\n  push(buf: write_int(out: append(buf: buf(), view: "n="), value: x), byte: 33)\n}',
        },
      ],
      { exports: ['f'] },
    );
    const b = compile(
      [
        ...std,
        {
          name: 't.tape',
          text: 'fn f(x: Int) -> Buf {\n  buf() |> append(view: "n=") |> write_int(value: x) |> push(byte: 33)\n}',
        },
      ],
      { exports: ['f'] },
    );
    const code = (r: typeof a): string =>
      r.wasm === null
        ? 'refused'
        : `${r.functions.join(',')},${WebAssembly.Module.exports(new WebAssembly.Module(r.wasm)).length}:${r.wasm.length}`;
    return code(a) === code(b);
  })(),
  true,
);
T(
  'pipe: the first parameter given again is refused, saying why',
  error(`
fn scale(amount: Int, by: Int) -> Int {
  amount * by
}
fn f(x: Int) -> Int {
  x |> scale(amount: 2, by: 3)
}`),
  "C12 argument amount is given twice | The value before |> is already scale's first parameter, amount. Remove `amount:` here, or do not pipe.",
);
T(
  'pipe: the right side must be a call',
  error(`
fn f(x: Int) -> Int {
  x |> 3
}`).split(' | ')[0],
  'P07 the right side of |> must be a function call',
);
T(
  'pipe: into a constructor is refused with the field form',
  error(
    `
fn f(x: Int) -> Option[Int] {
  x |> Some
}`,
    'f',
  ),
  "P07 the right side of |> must be a function call | A constructor's fields are named; write `Some(field: value)` instead of piping into it.",
);
T(
  'pipe: into buf() is refused',
  error(`
fn f(x: Int) -> Buf {
  x |> buf
}`).split(' | ')[0],
  'C49 buf() takes nothing, so nothing can be piped into it',
);

// ---- 2. `++` in expressions: text joined into a new View (std/core.tape's concat)
T(
  '++: joins text, left to right, and compares as text',
  agree(
    `
fn f(x: Int) -> Int {
  let t = "ab" ++ "" ++ "c" ++ "de"
  match {
    t == "abcde" and len("" ++ "") == 0 -> len(t) * 10 + t[4] - 100
    else -> 0
  }
}`,
    'f',
    [0n],
  ),
  51,
);
T(
  '++: a refined text joins as View',
  agree(
    `
type Word = View where len(self) >= 1
fn glue(w: View) -> Int {
  match w {
    Word(word) -> len(word ++ "!" ++ word)
    _ -> 0
  }
}
fn f(x: Int) -> Int {
  glue(w: "hey")
}`,
    'f',
    [0n],
  ),
  7,
);
T(
  '++: on a Buf is refused, pointing at append',
  error(`
fn f(x: Int) -> Buf {
  buf() ++ "x"
}`),
  'C19 Buf values cannot be joined with ++ | A Buf grows in place: `out |> append(view: text)`.',
);
T(
  '++: a number is refused, pointing at write_int',
  error(`
fn f(x: Int) -> View {
  "n=" ++ x
}`),
  'C19 the right side of ++ should be View but is Int | Put the number in the text, `"… \\(n)"`, or write it into a Buf: `out |> write_int(value: n)`.',
);

// ---- 3. the formatter: canonical, idempotent, and it never changes what a program means
const here = (p: string): URL => new URL(`../${p}`, import.meta.url);
/** A field of a value that may be an object. */
const field = (v: unknown, name: string): unknown =>
  typeof v === 'object' && v !== null ? Object.fromEntries(Object.entries(v))[name] : undefined;
const headOf = (effects: readonly Effect[]): Head | undefined => {
  const [h] = effects;
  return h && isHead(h) ? h : undefined;
};
const tapeFiles = ['examples', 'examples/tools', 'std', 'service/verify', 'testdata'].flatMap(d =>
  readdirSync(here(d))
    .filter(f => f.endsWith('.tape'))
    .map(f => `${d}/${f}`),
);
// the parsed program with line numbers left out (formatting may remove blank lines)
/** A value as JSON can hold it: a Map as its entries, a bigint as text, bytes as numbers. */
const plain = (v: unknown): unknown => {
  if (v instanceof Map) return [...v];
  if (typeof v === 'bigint') return `${v}n`;
  return v instanceof Uint8Array ? [...v] : v;
};
const meaning = (text: string, name: string): string =>
  JSON.stringify(parseProgram([{ name, text }]), (k, v: unknown) =>
    k === 'line' || k === 'file' ? undefined : plain(v),
  );
{
  const notIdempotent = [],
    changedMeaning = [],
    notCanonical = [];
  for (const f of tapeFiles) {
    const a = readFileSync(here(f), 'utf8'),
      b = format(a, f);
    if (format(b, f) !== b) notIdempotent.push(f);
    if (meaning(a, f) !== meaning(b, f)) changedMeaning.push(f);
    if (a !== b && f !== 'testdata/messy.tape') notCanonical.push(f);
  }
  T(
    `fmt: every .tape file in the repository (${tapeFiles.length}), formatted twice, gives no further change`,
    notIdempotent,
    [],
  );
  T('fmt: the parsed program is the same before and after, for every file', changedMeaning, []);
  T('fmt: every file in the repository is already in the canonical layout (fmt --check)', notCanonical, []);
}
T(
  'fmt: a messy file comes out in the canonical layout',
  format(readFileSync(here('testdata/messy.tape'), 'utf8')),
  `// messy: every rule broken once
type Order { Order(id: Int, state: View) }
type Qty = Int where self >= 1 and self <= 10

fn total(o: Order, n: Int) -> Int {
  let a = -n + o.id * 2
  let b = a |> double |> add(more: -1)

  match o {
    Order(id, state: "done") if id > 0 -> b
    whole = Order(state: "x") -> whole.id  // the whole order
    _ -> 0 - 1
  }
}
fn double(n: Int) -> Int { n * 2 }
fn add(n: Int, more: Int) -> Int {
  n + more
}
migration 1 "t" {
   CREATE TABLE t(a  INTEGER)   -- kept as written
}
fn map2[A, B](list: List[A], by: Fn[A, B]) -> List[B] {
  map(list, by: fn(x: A) -> B { by(x) })
}
`,
);
T(
  "fmt: a file that does not parse is refused with the compiler's error",
  (() => {
    try {
      format('fn f( -> Int {\n  1\n}\n');
      return 'formatted';
    } catch (e) {
      return typeof e === 'object' && e !== null && 'info' in e ? field(e.info, 'code') : undefined;
    }
  })(),
  'P01',
);
T(
  'fmt: `tape fmt --check` exits 1 for a file that would change, and 0 for a canonical one',
  (() => {
    const run = (f: string) => {
      try {
        execFileSync(process.execPath, [here('tape.ts').pathname, 'fmt', '--check', here(f).pathname], {
          stdio: 'pipe',
        });
        return 0;
      } catch (e) {
        return field(e, 'status');
      }
    };
    return [run('testdata/messy.tape'), run('examples/hello.tape')];
  })(),
  [1, 0],
);
{
  // `node tape.ts program 'REQUEST' …` runs each request in a transaction, as the service does: a rollback(out)
  // undoes the claim made before it, and the log says so (it ran with none, and the claim stayed)
  const printed = execFileSync(
    process.execPath,
    [
      here('tape.ts').pathname,
      here('testdata/rollback.tape').pathname,
      'POST /a',
      'GET /',
      'GET /type\\rcontent-type: text/csv',
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  T(
    "tape run: a rollback undoes the request's writes, marked (undone) in the log; `\\r` in a request starts a header",
    [
      printed.split('\n').filter(l => l.startsWith('←')),
      printed
        .split('\n')
        .filter(l => l.includes('INSERT INTO claims'))
        .map(l => l.endsWith('(undone)')),
    ],
    [['← 409 ⏎ ', '← 200 ⏎ []', '← 200 ⏎ text/csv'], [true]],
  );
}

// ---- 3. doc tests: `//   > expression` and, on the next comment line, the pattern it should match
{
  const results = std.flatMap(s => doctests(std, s.name));
  T(
    `doctest: every example in std passes (${results.length})`,
    results.filter(r => !r.ok).map(r => `${r.file}:${r.line}`),
    [],
  );
  T('doctest: std has examples in every file', [...new Set(results.map(r => r.file))].toSorted(), [
    'std/core.tape',
    'std/http.tape',
    'std/json.tape',
    'std/list.tape',
    'std/map.tape',
    'std/math.tape',
    'std/retry.tape',
    'std/text.tape',
    'std/time.tape',
  ]);
  const bad = doctests(
    [
      ...std,
      { name: 'testdata/doctest-failures.tape', text: readFileSync(here('testdata/doctest-failures.tape'), 'utf8') },
    ],
    'testdata/doctest-failures.tape',
  );
  T(
    'doctest: a wrong value, a pattern that does not match, a type error, a trap and a missing result each fail, with the reason',
    bad.map(r => [
      r.line,
      r.ok,
      'error' in r && r.error !== null ? r.error : `got ${'got' in r ? r.got : 'undefined'}`,
    ]),
    [
      [5, true, 'got undefined'],
      [7, false, 'got 4'],
      [9, false, 'got Order(id: 6, state: "done")'],
      [11, false, 'C14 argument n should be Int but is View'],
      [13, false, 'trapped (division by zero)'],
      [15, false, 'an example needs what it should give on the next comment line'],
    ],
  );
  // a program with a flag that only `handle` reads: an example of a pure function compiles without `handle` as an
  // export, and the flag is still read (it was C38 "flag limit is never read" on every example)
  const flagged = `flag limit: Int = 3
fn handle(raw: View) -> Buf {
  respond(status: 200) |> write_int(value: twice(flags.limit))
}

//   > twice(4)
//   8
fn twice(n: Int) -> Int {
  n * 2
}
`;
  T(
    'doctest: a program whose flag only an entry point reads runs its examples',
    doctests([...std, { name: 'flagged.tape', text: flagged }], 'flagged.tape').map(r => [
      r.line,
      r.ok,
      'error' in r ? r.error : null,
    ]),
    [[6, true, null]],
  );
}

// ---- 4. timers: wake(timer, after, key), the Timer capability, `woken`, and std/retry.tape on top
{
  const enc = new TextEncoder(),
    dec = new TextDecoder();
  const build = (text: string, name = 'program.tape') => {
    return moduleOf(built(text, {}, name));
  };
  const imports = (m: WebAssembly.Module): string[] => WebAssembly.Module.imports(m).map(i => i.name);
  const errorOf = (text: string) => {
    const [no] = compile([...std, { name: 't.tape', text }]).errors;
    return no ? `${no.code} ${no.line}: ${no.message}` : 'compiled';
  };
  const timers = `schema "CREATE TABLE IF NOT EXISTS hits(key INTEGER PRIMARY KEY, n INTEGER NOT NULL)"
type Count { Count(n: Int) }
type Done { Done(key: Int, n: Int) }
fn handle(req: View, db: Sql, timer: Timer) -> Buf {
  match req {
    "POST /later/" ++ decimal(ms) -> respond(status: 202) |> write_int(value: wake(timer, after: ms, key: 7))
    "POST /backoff/" ++ decimal(n) -> respond(status: 202) |> append(view: said(decided: retry_later(timer, key: 8, policy: Backoff(first: 100, factor: 10, most: 5000, tries: 3), failed: n)))
    "POST /sooner" -> respond(status: 202) |> write_int(value: wake(timer, after: 0 - 40, key: 7))
    "POST /undo" ++ _ -> rollback(out: respond(status: 500) |> write_int(value: wake(timer, after: 10, key: 9)))
    "POST /trap" ++ _ -> respond(status: 202) |> write_int(value: wake(timer, after: 0, key: 0))
    _ -> respond(status: 404)
  }
}
fn said(decided: Retry) -> View {
  match decided {
    RetryIn(after, attempt) -> "again in " ++ decimal_text(value: after) ++ " ms, attempt " ++ decimal_text(value: attempt)
    GaveUp(tries) -> "gave up after " ++ decimal_text(value: tries)
  }
}
export fn woken(db: Sql, timer: Timer, message: Wake) -> Result[Done, View] {
  let Wake(key) = message
  match sql_first(db, row: Count, repeat: True, query: "INSERT INTO hits VALUES (:key, 1) ON CONFLICT(key) DO UPDATE SET n = n + 1 RETURNING n", key: 10 / key) {
    Some(value: Count(n)) -> Ok(value: Done(key, n))
    None -> Err(error: "no row")
  }
}`;
  const mod = build(timers),
    sql = nodeSql(),
    tx: Transaction = f => sql.transaction(f),
    app = instantiate(mod, { sql, name: 'demo' });
  const run = async (t: string) => {
    const r = await app.runLogged(enc.encode(t.trim()), { transaction: tx });
    return { ...r, text: dec.decode(r.out) };
  };
  const pending = () => sql.exec('SELECT key, due FROM _wakes ORDER BY key').toArray();
  /** When the timer a run set is due. */
  const dueOf = (effects: readonly Effect[]): number => effects.find(isWake)?.due ?? Number.NaN;
  T(
    'timer: a program that sets timers imports env.wake; one that does not (even with std/retry.tape in the build) does not',
    [imports(mod).includes('wake'), imports(build(readFileSync(here('examples/hello.tape'), 'utf8'))).includes('wake')],
    [true, false],
  );
  const set = await run('POST /later/250\n');
  T(
    'timer: wake answers the delay it set, and the log records { wake, after, due }',
    [set.text, Object.keys(set.effects[1] ?? {}), dueOf(set.effects) - (headOf(set.effects)?.at ?? 0) >= 250],
    ['202\n250', ['wake', 'after', 'due'], true],
  );
  T(
    'timer: it is kept in _wakes, and is not due yet',
    [pending().map(r => r.key), app.due(), app.next() === dueOf(set.effects)],
    [[7], [], true],
  );
  T(
    'timer: a replay answers wake from the log, setting nothing',
    [dec.decode(replay(mod, enc.encode('POST /later/250'), set.effects)), pending().length],
    ['202\n250', 1],
  );
  await run('POST /sooner');
  T(
    'timer: setting a key again moves its time; a negative delay is 0',
    [pending().length, Number(pending()[0]?.due) <= Date.now()],
    [1, true],
  );
  T('timer: a delay longer than 30 days is 30 days', (await run('POST /later/99999999999\n')).text, '202\n2592000000');
  await run('POST /later/0\n');
  const woke = await app.wake(7, { transaction: tx });
  T(
    'timer: when due, woken runs with Wake(key), as a child span of the run that set the timer, and the timer is gone',
    [
      woke?.status,
      dec.decode(woke?.body),
      headOf(woke?.effects ?? [])?.method,
      headOf(woke?.effects ?? [])?.woke?.key,
      headOf(woke?.effects ?? [])?.parent !== null,
      pending().length,
    ],
    ['ok', '{"key":7,"n":1}', 'woken', 7, true, 0],
  );
  T('timer: a key that is not due (or not set) is not run', await app.wake(7, { transaction: tx }), null);
  T('timer: a run rolled back keeps no timer', [(await run('POST /undo\n')).text, pending().length], ['500\n10', 0]);
  await run('POST /trap\n');
  T(
    'timer: a woken run that traps is not retried by the timer: its row goes, the trap reaches the host',
    [
      await app.wake(0, { transaction: tx }).then(
        () => 'ran',
        (e: unknown) => messageOf(e),
      ),
      pending().length,
    ],
    ['trap 4: division by zero', 0],
  );
  T(
    'timer: std/retry.tape sets the timer backoff picks: 100 ms, then 10 times longer, capped, three attempts',
    [
      (await run('POST /backoff/1\n')).text,
      (await run('POST /backoff/2\n')).text,
      (await run('POST /backoff/3\n')).text,
      pending().map(r => r.key),
    ],
    ['202\nagain in 100 ms, attempt 2', '202\nagain in 1000 ms, attempt 3', '202\ngave up after 3', [8]],
  );
  T(
    'timer: wake needs the Timer capability, passed in',
    error(
      `fn f(clock: Clock) -> Int {\n  wake(timer: clock, after: 1, key: 1)\n}\nexport fn woken(message: Wake) -> Result[Wake, View] {\n  Ok(value: message)\n}`,
    ),
    "C14 wake needs the Timer capability | Add `timer: Timer` to this function's parameters and pass it here, so every caller shows that it sets timers.",
  );
  T(
    'timer: setting a timer without exporting woken is a guiding error',
    errorOf(timers.replace(/export fn woken[^]*$/, '')),
    'C50 4: this program sets a timer (wake), but nothing exports `woken`',
  );
  T(
    'timer: woken must take a Wake',
    errorOf(
      timers.replace(
        'message: Wake) -> Result[Done, View] {\n  let Wake(key) = message',
        'message: Done) -> Result[Done, View] {\n  let Done(key) = message',
      ),
    ),
    'C50 20: woken takes Done, but the host sends a Wake',
  );
  T(
    'timer: wake is missing an argument',
    errorOf(timers.replace('wake(timer, after: ms, key: 7)', 'wake(timer, after: ms)')),
    'C13 6: wake is missing argument key',
  );

  // fulfillment: a step that does not answer is sent again by its timer; no POST /advance
  const fmod = build(readFileSync(here('examples/fulfillment.tape'), 'utf8')),
    fsql = nodeSql(),
    ftx: Transaction = f => fsql.transaction(f);
  /** The JSON object on the second line of an answer. */
  const second2 = (answer: Uint8Array | undefined): Record<string, unknown> =>
    objectIn(dec.decode(answer).split('\n')[1] ?? '{}');
  const bodyIn = (answer: Uint8Array | undefined): Record<string, unknown> => objectIn(dec.decode(answer));
  let reserveTimeouts = 2;
  const services: Record<string, Service> = {
    inventory: (_bytes, { method }) => {
      if (method === 'reserve' && reserveTimeouts-- > 0) throw new TimedOut();
      return enc.encode(method === 'reserve' ? '{"price":40,"remaining":4}' : '{"remaining":5}');
    },
    payments: () => enc.encode('{"balance":260}'),
    shipping: () => enc.encode('{"label":77}'),
  };
  const fapp = instantiate(fmod, { sql: fsql, name: 'fulfill', services });
  const order = await fapp.runLogged(
    enc.encode('POST /orders/wait/1\n{"key":"k1","sku":"lamp","qty":1,"card":"ann-4242","address":"1 Main St"}'),
    { transaction: ftx },
  );
  const o1 = second2(order.out);
  const id1 = Number(o1.id);
  T(
    'fulfillment: a step that timed out stalls, counts the failure, and says when it is tried again',
    [
      dec.decode(order.out).split('\n')[0],
      o1.state,
      o1.retries,
      o1.stall,
      order.effects.filter(isWake).map(e => [e.wake, e.after]),
    ],
    ['202', 'reserving', 1, 'inventory.reserve did not answer in time; attempt 2 in 1000 ms', [[o1.id, 1000]]],
  );
  const second = await fapp.wake(id1, { transaction: ftx, now: Date.now() + 1000 });
  T(
    'fulfillment: the timer resumes it; a second timeout backs off to 2000 ms',
    [second?.status, bodyIn(second?.body).stall, bodyIn(second?.body).retries],
    ['ok', 'inventory.reserve did not answer in time; attempt 3 in 2000 ms', 2],
  );
  const third = await fapp.wake(id1, { transaction: ftx, now: Date.now() + 2000 }),
    o3 = bodyIn(third?.body);
  T(
    'fulfillment: the next one finishes the order: reserved, charged, shipped, with retries back at 0 and no timer left',
    [third?.status, o3.state, o3.label, o3.retries, o3.stall, fapp.next()],
    ['ok', 'done', 77, 0, '', null],
  );
  reserveTimeouts = 99;
  const fresh = await fapp.runLogged(
    enc.encode('POST /orders/wait/1\n{"key":"k2","sku":"lamp","qty":1,"card":"ann-4242","address":"1 Main St"}'),
    { transaction: ftx },
  );
  let o = second2(fresh.out);
  for (let i = 0; i < 4; i++)
    o = bodyIn((await fapp.wake(Number(o.id), { transaction: ftx, now: Date.now() + 60000 }))?.body);
  T(
    'fulfillment: after five attempts it gives up, sets no timer, and waits for POST /advance',
    [o.retries, o.stall, fapp.next()],
    [
      5,
      'inventory.reserve did not answer in time; gave up after 5 attempts; POST /advance/<id> resumes from here',
      null,
    ],
  );
  T(
    'fulfillment: a read of an order that does not exist is 404, not the 409 of a step that lost a race (P2)',
    dec.decode((await fapp.runLogged(enc.encode('GET /orders/9999'), { transaction: ftx })).out),
    '404\n{"error":"no such order"}',
  );
  T(
    'fulfillment: woken cannot be reached from HTTP, only from the timer',
    dec.decode((await fapp.runLogged(enc.encode('POST /woken\n{"key":1}'), { transaction: ftx })).out),
    '404\n{"error":"no such route"}',
  );
}

// ---- 5. examples/kv.tape: one shard of the sharded KV service (service/src/kv.ts routes keys to shards)
{
  const enc = new TextEncoder(),
    dec = new TextDecoder();
  const kv = moduleOf(built(readFileSync(here('examples/kv.tape'), 'utf8')));
  const shard = () => {
    const sql = nodeSql(),
      app = instantiate(kv, { sql, name: 'kv' });
    return async (head: string, body: string | Uint8Array = ''): Promise<string> => {
      const h = enc.encode(`${head}\n`),
        b = typeof body === 'string' ? enc.encode(body) : body,
        all = new Uint8Array(h.length + b.length);
      all.set(h);
      all.set(b, h.length);
      return dec.decode((await app.runLogged(all, { transaction: f => sql.transaction(f) })).out);
    };
  };
  // the router's hash (service/src/kv.ts), here so the two can be compared without workerd
  const fnv1a = (bytes: Uint8Array): number => {
    let h = 0x811c9dc5;
    for (const b of bytes) h = Math.imul(h ^ b, 0x01000193) >>> 0;
    return h;
  };

  const one = shard();
  T(
    'kv: a shard with no placement serves nothing',
    [await one('GET /k/a'), await one('GET /stats')],
    [
      '503\n{"error":"this shard has no placement yet: its cluster is still being created"}',
      '503\n{"error":"this shard has no placement yet"}',
    ],
  );
  T(
    'kv: a placement is set once; the same again is 200, another is 409 with what is stored; impossible ones are 400',
    [
      await one('PUT /placement/0?shards=1'),
      await one('PUT /placement/0?shards=1'),
      await one('PUT /placement/0?shards=2'),
      await one('PUT /placement/3?shards=3'),
      await one('PUT /placement/0?shards=65'),
    ],
    [
      '200\n{"shard":0,"shards":1,"window_ms":3600000,"skew_ms":300000}',
      '200\n{"shard":0,"shards":1,"window_ms":3600000,"skew_ms":300000}',
      '409\n{"shard":0,"shards":1,"window_ms":3600000,"skew_ms":300000}',
      '400\n{"error":"a placement is shard i of n, 0 <= i < n <= 64"}',
      '400\n{"error":"a placement is shard i of n, 0 <= i < n <= 64"}',
    ],
  );
  T(
    'kv: every write is the next version; a delete is a tombstone that keeps it; ?if= is compare-and-set (0: only if absent)',
    [
      await one(`PUT /k/a?op=${NOW}_w1`, 'x'),
      await one(`PUT /k/a?op=${NOW}_w2`, 'y'),
      await one('GET /k/a'),
      await one('PUT /k/a?if=1', 'z'),
      await one('PUT /k/a?if=2', 'z'),
      await one('DELETE /k/a'),
      await one('GET /k/a'),
      await one('DELETE /k/a'),
      await one('PUT /k/a?if=0', 'w'),
      await one('PUT /k/a?if=4', 'w'),
      await one('GET /stats'),
    ],
    [
      '201\n{"key":"a","version":1}',
      '200\n{"key":"a","version":2}',
      '200\n{"key":"a","value":"y","version":2}',
      '409\n{"error":"version mismatch","key":"a","version":2,"expected":1}',
      '200\n{"key":"a","version":3}',
      '200\n{"key":"a","version":4}',
      '404\n{"error":"no such key","key":"a","version":4}',
      '404\n{"error":"no such key","key":"a","version":4}',
      '409\n{"error":"version mismatch","key":"a","version":4,"expected":0}',
      '200\n{"key":"a","version":5}',
      '200\n{"shard":0,"shards":1,"keys":1,"live":1}',
    ],
  );
  T(
    'kv: limits and malformed requests are typed errors',
    [
      (await one(`PUT /k/${'k'.repeat(257)}`, 'v')).split('\n')[0],
      (await one(`PUT /k/${'k'.repeat(256)}?op=${NOW}_l1`, 'v')).split('\n')[0],
      (await one('PUT /k/a b', 'v')).split('\n')[0],
      (await one('PUT /k/big', 'v'.repeat(65537))).split('\n')[0],
      (await one(`PUT /k/big?op=${NOW}_l2`, 'é'.repeat(32768))).split('\n')[0],
      (await one('PUT /k/bad', new Uint8Array([0x61, 0xc0, 0x80]))).split('\n')[0],
      (await one('PUT /k/a?if=-1', 'v')).split('\n')[0],
      (await one('PUT /k/a?if=99999999999999999999', 'v')).split('\n')[0],
      (await one('GET /k/a?if=1')).split('\n')[0],
      (await one('POST /k/a', 'v')).split('\n')[0],
      (await one('GET /nope')).split('\n')[0],
    ],
    ['400', '201', '400', '413', '201', '400', '400', '400', '400', '405', '404'],
  );
  T(
    'kv: a write that is not a compare-and-set needs an op id (428), so a retry cannot apply it twice; the same op id again is the same write',
    [
      await one('PUT /k/r', 'x'),
      await one(`PUT /k/r?op=${NOW}_r1`, 'x'),
      await one(`PUT /k/r?op=${NOW}_r1`, 'x'),
      await one('GET /k/r'),
      await one('PUT /k/r?if=1', 'y'),
    ],
    [
      '428\n{"error":"an unconditional write needs ?op=<id>, so that a retry cannot apply it twice"}',
      '201\n{"key":"r","version":1}',
      '201\n{"key":"r","version":1}',
      '200\n{"key":"r","value":"x","version":1}',
      '200\n{"key":"r","version":2}',
    ],
  );
  T(
    'kv: values keep their bytes through JSON',
    objectIn(
      ((await one(`PUT /k/q?op=${NOW}_q1`, 'he said "hi"\n\t✓')) && (await one('GET /k/q'))).split('\n')[1] ?? '{}',
    ).value,
    'he said "hi"\n\t✓',
  );

  // shard 5 of 64 serves exactly the keys whose router hash mod 64 is 5, and names the right shard for the rest
  const s5 = shard();
  await s5('PUT /placement/5?shards=64');
  const keys = Array.from(
    { length: 1000 },
    (_, i) => `${['user', 'k', 'a:b', 'x%2Fy', 'Z~.-_'][i % 5]}${(i * 2654435761) % 100003}`,
  );
  const answers = await Promise.all(keys.map(async k => (await s5(`PUT /k/${k}?op=${NOW}_o1`, 'v')).split('\n')));
  const named = answers.map(([status, body]) =>
    status === '201' ? 5 : Number(/belongs to shard (\d+)/.exec(body ?? '')?.[1]),
  );
  T(
    'kv: the shard and the router agree on fnv1a(key) mod 64 for 1000 keys (served by shard 5, or 421 naming the owner)',
    named.every((n, i) => n === fnv1a(enc.encode(keys[i])) % 64) && answers.every(([s]) => s === '201' || s === '421'),
    true,
  );
  T(
    'kv: and they spread: shard 5 owns about 1/64 of them',
    named.filter(n => n === 5).length > 5 && named.filter(n => n === 5).length < 35,
    true,
  );
}

finish();
