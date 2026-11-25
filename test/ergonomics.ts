// The ergonomics forms, pleasant without losing safety: mid-path captures in text
// patterns, `let P = e else { … }` steps, and ambient capabilities (C72). Each is checked compiled (wasm) and, where
// interp.ts gives the program a second meaning, interpreted, and each refusal is checked by code.
import '../node25.ts';
import { compile } from '../compiler.ts';
import { interpret } from '../interp.ts';
import { std } from '../std.ts';
import { call, finish, functionsOf, read, same as T } from './harness.ts';
const run = (src: string, fn: string, args: bigint[] = []): unknown => {
  const r = compile([...std, { name: 't.tape', text: src }], { exports: [fn] });
  const [no] = r.errors;
  if (r.wasm === null) return `ERR ${no?.code} line ${no?.line}: ${no?.message}`;
  const ex = functionsOf(new WebAssembly.Module(r.wasm));
  call(ex, 'reset');
  try {
    return call(ex, fn, ...args);
  } catch (e) {
    return `TRAP ${e instanceof Error ? e.message : String(e)}`;
  }
};
const codes = (src: string, exports = /fn handle/.test(src) ? undefined : ['f']): string[] =>
  compile([...std, { name: 't.tape', text: src }], exports ? { exports } : {}).errors.map(e => `${e.code}:${e.line}`);

// ---- 1. mid-path captures
const R = `fn route(path: View) -> Int {
  match path {
    "/runs/" ++ decimal(id) ++ "/advance" -> id
    "/runs/" ++ decimal(id) ++ "/steps/" ++ decimal(n) -> id * 100 + n
    "/files/" ++ name ++ ".json" -> len(name)
    _ -> 0 - 1
  }
}
`;
const cases: readonly (readonly [string, number])[] = [
  ['/runs/12/advance', 12],
  ['/runs/7/steps/3', 703],
  ['/runs/x/advance', -1],
  ['/runs/12/advance/', -1],
  ['/files/report.json', 6],
  ['/files/.json', 0],
  ['/runs/12', -1],
  ['/runs//advance', -1],
];
for (const [p, want] of cases) T(`route ${p}`, run(R + `fn t() -> Int {\n  route(path: "${p}")\n}\n`, 't'), want);
T(
  'a capture must be followed by text',
  codes('fn f(v: View) -> Int {\n  match v {\n    "/a/" ++ decimal(n) ++ rest -> n\n    _ -> 0\n  }\n}\n')[0]?.split(
    ':',
  )[0],
  'P04',
);
T(
  'a suffix pattern alone does not cover View',
  codes('fn f(v: View) -> Int {\n  match v {\n    x ++ "/" -> 1\n  }\n}\n')[0]?.split(':')[0],
  'C24',
);
{
  const it = interpret([...std, { name: 't.tape', text: R }]);
  const out = cases.map(([p]) => Number(it.call('route', [new TextEncoder().encode(p)])));
  T(
    'interp agrees on every route',
    out,
    cases.map(c => c[1]),
  );
}

// ---- 2. let … else steps
const S = `type Got {
  Found(n: Int)
  Missing
  Broken(why: Int)
}
fn get(k: Int) -> Got {
  match {
    k == 0 -> Missing
    k < 0 -> Broken(why: k)
    else -> Found(n: k * 10)
  }
}
fn sum(a: Int, b: Int) -> Int {
  let Found(n: x) = get(k: a) else {
    Missing -> 0 - 1
    Broken(why) -> why * 1000
  }
  let y = x + 1
  let Found(n: z) = get(k: b) else -> 0 - 2
  x + y + z
}
`;
T('steps: both found', run(S + 'fn t() -> Int {\n  sum(a: 1, b: 2)\n}\n', 't'), 10 + 11 + 20);
T('steps: first missing', run(S + 'fn t() -> Int {\n  sum(a: 0, b: 2)\n}\n', 't'), -1);
T('steps: first broken', run(S + 'fn t() -> Int {\n  sum(a: 0 - 3, b: 2)\n}\n', 't'), -3000);
T('steps: second missing', run(S + 'fn t() -> Int {\n  sum(a: 1, b: 0)\n}\n', 't'), -2);
T(
  'steps: the else arms must cover the rest (C24)',
  codes(S.replace('    Broken(why) -> why * 1000\n', ''), ['sum'])[0]?.split(':')[0],
  'C24',
);
T(
  'steps: irrefutable let still refused when it can fail (C48)',
  codes(S.replace(' else -> 0 - 2', ''), ['sum'])[0]?.split(':')[0],
  'C48',
);
// 0.3: a match, and so a step, is an expression anywhere (it was C40 inside a let value)
T(
  'steps: inside a function value bound by a let',
  run(
    'type O {\n  A(n: Int)\n  B\n}\nfn f(k: Int) -> Int {\n  let g = fn(p: O) -> Int {\n    let A(n) = p else -> 0\n    n\n  }\n  g(A(n: k)) + g(B)\n}\n',
    'f',
    [6n],
  ),
  6,
);
{
  const it = interpret([...std, { name: 't.tape', text: S }]);
  T(
    'interp agrees on steps',
    [
      [1, 2],
      [0, 2],
      [-3, 2],
      [1, 0],
    ].map(([a = 0, b = 0]) => Number(it.call('sum', [BigInt(a), BigInt(b)]))),
    [41, -1, -3000, -2],
  );
}

// a match (and so a step) may be an arm's value, not only a function's last expression (still not an argument)
{
  const N =
    'type O {\n  A(n: Int)\n  B\n}\nfn f(a: Int, o: O) -> Int {\n  match a {\n    0 -> match o {\n      A(n) -> n\n      B -> 1\n    }\n    _ -> {\n      let A(n) = o else -> 2\n      n * 10\n    }\n  }\n}\nfn pick(k: Int) -> O {\n  match {\n    k == 0 -> B\n    else -> A(n: k)\n  }\n}\nfn t(a: Int, k: Int) -> Int {\n  f(a, o: pick(k))\n}\n';
  T(
    'nested match in an arm',
    [
      [0, 7],
      [0, 0],
      [1, 7],
      [1, 0],
    ].map(([a = 0, k = 0]) => run(N, 't', [BigInt(a), BigInt(k)])),
    [7, 1, 70, 2],
  );
}

// ---- 3. ambient capabilities
const A = `schema "CREATE TABLE IF NOT EXISTS t(id INTEGER PRIMARY KEY, n INTEGER NOT NULL)"
type Row { Row(n: Int) }
fn count(id: Int) -> Int {
  match sql_first(db, query: "SELECT n FROM t WHERE id = :id", id, row: Row) {
    Some(value: Row(n)) -> n
    None -> 0
  }
}
fn twice(id: Int) -> Int {
  count(id) + count(id)
}
fn handle(raw: View, db: Sql) -> Response {
  empty(status: 200 + twice(id: len(raw)))
}
`;
T('ambient: db reaches count through twice', codes(A), []);
const A2 =
  A +
  'type Q { Q(id: Int) } type Refusal { Refused(reason: View) }\ntype Got { Got(n: Int) }\nexport fn peek(message: Q) -> Result[Got, Refusal] {\n  let Q(id) = message\n  Ok(value: Got(n: twice(id)))\n}\n';
T('ambient: an entry that does not declare it is C72', codes(A2)[0], 'C72:17');
{
  const e = compile([...std, { name: 't.tape', text: A2 }]).errors[0];
  T(
    'ambient: C72 names the path',
    e?.message,
    'peek uses the capability db (peek → twice → count) but does not declare it',
  );
}
T(
  'ambient: declaring it on the entry fixes it',
  codes(A2.replace('peek(message: Q)', 'peek(db: Sql, message: Q)')),
  [],
);
T(
  'ambient: an explicit argument still wins',
  codes(A.replace('count(id) + count(id)', 'count(id, db) + count(id)')),
  [],
);
T(
  'ambient: a name never declared as a capability is unknown',
  codes(A.replaceAll('db', 'dbx').replace('dbx: Sql', 'db: Sql')).length > 0,
  true,
);

// ---- 4. C54 accepts writes that settle on their first run
{
  const one = (q: string): string =>
    `schema "CREATE TABLE IF NOT EXISTS c(name TEXT PRIMARY KEY, n INTEGER NOT NULL, m INTEGER, state TEXT NOT NULL)"\ntype N { N(n: Int) }\nfn done(n: Int) -> Response {\n  empty(status: 200)\n}\nfn handle(raw: View, db: Sql) -> Response {\n  done(n: sql_exec(db, query: "${q}"${q.includes(':by') ? ', by: len(raw)' : ''}))\n}\n`;
  const c54 = (q: string): string[] => codes(one(q)).filter(x => x.startsWith('C54'));
  const C54: readonly (readonly [string, string[]])[] = [
    ["UPDATE c SET n = max(n, :by) WHERE name = 'a'", []],
    ["UPDATE c SET n = MIN(n, :by) WHERE name = 'a'", []],
    ["UPDATE c SET n = max(:by, n, 7) WHERE name = 'a'", []],
    ["UPDATE c SET m = coalesce(m, :by) WHERE name = 'a'", []],
    ["UPDATE c SET m = ifnull(m, :by), n = :by WHERE name = 'a'", []],
    ["UPDATE c SET n = max(n, :by), state = 'x' WHERE name = 'a'", []],
    ["UPDATE c SET n = max(n, m + 1), m = 5 WHERE name = 'a'", ['C54:7']], // m changes too, and e reads it
    ["UPDATE c SET n = max(n, :by) + 1 WHERE name = 'a'", ['C54:7']],
    ["UPDATE c SET n = max(m, :by), m = n WHERE name = 'a'", ['C54:7']],
    ["UPDATE c SET m = coalesce(:by, m) WHERE name = 'a'", ['C54:7']], // idempotent too, but outside the rule's forms: refused
    ["UPDATE c SET n = max(n, :by), m = n + 1 WHERE name = 'a'", ['C54:7']],
  ];
  for (const [q, want] of C54) T(`C54 ${q}`, c54(q), want);
}

// ---- 5. C73 floors and C74 implied states
{
  const prog = (schema: string, ...qs: string[]): string =>
    `schema "${schema}"\ntype N { N(n: Int) }\nfn done(n: Int) -> Response {\n  empty(status: 200)\n}\nfn handle(raw: View, db: Sql) -> Response {\n  match raw {\n${qs.map((q, i) => `    "${i}" -> done(n: sql_exec(db, query: "${q}"${q.includes(':by') ? ', by: len(raw)' : ''}))\n`).join('')}    _ -> empty(status: 404)\n  }\n}\n`;
  const take = "UPDATE t SET n = n - :by WHERE k = 'a'";
  const only = (cs: string[], ...codesWanted: string[]): string[] =>
    cs.filter(c => codesWanted.some(w => c.startsWith(w)));
  const plain = 'CREATE TABLE IF NOT EXISTS t(k TEXT PRIMARY KEY, n INTEGER NOT NULL)';
  const checked = 'CREATE TABLE IF NOT EXISTS t(k TEXT PRIMARY KEY, n INTEGER NOT NULL CHECK (n >= 0))';
  const one = 'CREATE TABLE IF NOT EXISTS t(k TEXT PRIMARY KEY, n INTEGER NOT NULL CHECK (n >= 1))';
  const C73: readonly (readonly [string, string, string, string[]])[] = [
    ['take with a guard', plain, "UPDATE t SET n = n - :by WHERE k = 'a' AND n >= :by", []],
    ['take, no guard', plain, "UPDATE t SET n = n - :by WHERE k = 'a'", ['C73:8']],
    ['take one, n > 0', checked, "UPDATE t SET n = n - 1 WHERE k = 'a' AND n > 0", []],
    ['take one, n >= 1', checked, "UPDATE t SET n = n - 1 WHERE k = 'a' AND n >= 1", []],
    [
      'take two, n > 0 is not enough for CHECK n >= 0',
      checked,
      "UPDATE t SET n = n - 2 WHERE k = 'a' AND n > 0",
      ['C73:8'],
    ],
    [
      'take :by, n >= :by is not enough for CHECK n >= 1',
      one,
      "UPDATE t SET n = n - :by WHERE k = 'a' AND n >= :by",
      ['C73:8'],
    ],
    ['take :by, n - :by >= 1', one, "UPDATE t SET n = n - :by WHERE k = 'a' AND n - :by >= 1", []],
    [
      'a guard under OR does not count',
      plain,
      "UPDATE t SET n = n - :by WHERE k = 'a' AND (n >= :by OR k = 'b')",
      ['C73:8'],
    ],
    ['adding needs no floor', plain, "UPDATE t SET n = n + :by WHERE k = 'a'", []],
  ];
  for (const [name, schema, q, want] of C73) T(`C73 ${name}`, only(codes(prog(schema, q)), 'C73'), want);
  const saying = (said: string): string =>
    prog(plain, take).replace('sql_exec(db, query:', `sql_exec(db, ${said}, query:`);
  T('C73 take, no guard, `no_floor: True` on the call', only(codes(saying('no_floor: True')), 'C73'), []);
  T(
    'C88 `no_floor: True` where nothing is taken without a guard',
    only(
      codes(
        prog(plain, "UPDATE t SET n = n - :by WHERE k = 'a' AND n >= :by").replace(
          'sql_exec(db, query:',
          'sql_exec(db, no_floor: True, query:',
        ),
      ),
      'C88',
    ),
    ['C88:8'],
  );
  T(
    'C73 a comment in the statement is no opt-out',
    only(codes(prog(plain, take.replace(' WHERE', ' /* no floor */ WHERE'))), 'C73'),
    ['C73:8'],
  );
  const st =
    "CREATE TABLE IF NOT EXISTS s(k TEXT PRIMARY KEY, state TEXT NOT NULL DEFAULT 'new', v INTEGER NOT NULL DEFAULT 0)";
  const C74: readonly (readonly [string, string[], string[]])[] = [
    [
      'every move guarded',
      [
        "UPDATE s SET state = 'paid' WHERE k = :by AND state = 'new'",
        "UPDATE s SET state = 'void' WHERE k = :by AND state = 'paid'",
      ],
      [],
    ],
    [
      'one move unguarded',
      ["UPDATE s SET state = 'paid' WHERE k = :by", "UPDATE s SET state = 'void' WHERE k = :by AND state = 'paid'"],
      ['C74:8'],
    ],
    [
      'from any state, said so',
      [
        "UPDATE s SET state = 'new' WHERE k = :by AND state IN ('new', 'paid', 'void')",
        "UPDATE s SET state = 'void' WHERE k = :by AND state = 'paid'",
      ],
      [],
    ],
    [
      'no write guards it: not a state (one unguarded write is open)',
      ["UPDATE s SET state = 'paid' WHERE k = :by"],
      [],
    ],
    [
      'a counter is not a state',
      ['UPDATE s SET v = v + 1 WHERE k = :by AND v = 3', 'UPDATE s SET v = 0 WHERE k = :by AND v >= 0'],
      [],
    ],
  ];
  for (const [name, qs, want] of C74) T(`C74 ${name}`, only(codes(prog(st, ...qs)), 'C74'), want);
  const declared = codes(
    prog(
      st,
      "UPDATE s SET state = 'paid' WHERE k = :by",
      "UPDATE s SET state = 'void' WHERE k = :by AND state = 'paid'",
    ).replace(
      'type N',
      'type SState { New Paid Void }\nmachine s.state: SState {\n  New -> Paid\n  Paid -> Void\n}\ntype N',
    ),
  );
  T(
    'C74 is left to C58 when a machine declares the column',
    [only(declared, 'C74'), only(declared, 'C58').length > 0],
    [[], true],
  );
}

// ---- 6. C71: a command built from a row names the row, and what the move before it wrote (a retry key that two
// different operations share, planted in three programs; C65 does not see the last two: their keys are not made
// only of what the message carries. C65 judged the first too, until its carried-key half went: C71 alone catches
// all three)
{
  const b2 = [
    {
      program: 'order',
      file: 'examples/fulfillment.tape',
      from: 'reply: Charged, error: PaymentError, within: wait, once: ForOrder(order: id))',
      to: 'reply: Charged, error: PaymentError, within: wait, once: card)',
      what: "the charge keyed by card: a second order on the card gets the first one's charge",
    },
    {
      program: 'billing',
      file: 'testdata/compare/billing.tape',
      from: 'once: Period(sub: id, period)))\n}',
      to: 'once: decimal_text(value: id)))\n}',
      what: 'the charge keyed by subscription, not by period',
    },
    {
      program: 'agent',
      file: 'testdata/compare/agent.tape',
      from: '    Run(id, step, tool, input, state: Acting) -> {\n      let Ok(value: Used(output)) = call(to: tools, method: "tool", send: Use(tool, input), reply: Used, error: Refusal, within: 50, once: AtStep(run: id, step))',
      to: '    Run(id, prompt, step, tool, input, state: Acting) -> {\n      let Ok(value: Used(output)) = call(to: tools, method: "tool", send: Use(tool, input), reply: Used, error: Refusal, within: 50, once: prompt ++ "/" ++ decimal_text(value: step))',
      what: 'the tool call keyed by prompt and step: two runs of one prompt share it',
    },
  ];
  for (const pl of b2) {
    const file = pl.file;
    const text = read(file),
      r = compile([...std, { name: file, text: text.replace(pl.from, pl.to) }]);
    T(
      `C71/C65 ${pl.program} B2 (${pl.what})`,
      r.errors.map(e => e.code),
      ['C71'],
    );
    T(
      `${pl.program} unplanted compiles`,
      compile([...std, { name: file, text }]).errors.map(e => e.code),
      [],
    );
  }
  const mini = (key: string, extra = '') =>
    `migration 1 "t" {\n  CREATE TABLE runs(id INTEGER PRIMARY KEY, prompt TEXT NOT NULL, step INTEGER NOT NULL DEFAULT 0)\n}\ntype Run { Run(id: Int, prompt: View, step: Int) } type Refusal { Refused(reason: View) }\ntype Use { Use(prompt: View) }\ntype AtStep { AtStep(run: Int, step: Int) }\ntype Used { Used(n: Int) }\nfn handle(raw: View, db: Sql, tools: Remote) -> Response {\n  match sql_first(db, row: Run, query: "SELECT id, prompt, step FROM runs WHERE id = :id", id: len(raw)) {\n    Some(value: Run(id, prompt, step)) -> done(r: call(to: tools, method: "tool", send: Use(prompt), reply: Used, error: Refusal, within: 50, once: ${key}))\n    None -> empty(status: 404)\n  }\n}\nfn done(r: Result[Used, CallError[Refusal]]) -> Response {\n  match r {\n    Ok(value) -> empty(status: 200)\n    Err(error) -> empty(status: 502)\n  }\n}\n${extra}`;
  T('C71 key with the row id and step', codes(mini('AtStep(run: id, step)')), []);
  T('C71 key without the row id', codes(mini('AtStep(run: step, step)')), ['C71:10']);
}
T(
  'ambient: a sql_* call without db is given the one Sql capability',
  codes(A.replace('sql_first(db, query:', 'sql_first(query:')),
  [],
);
T('ambient: …and C72 still applies to it', codes(A2.replace('sql_first(db, query:', 'sql_first(query:'))[0], 'C72:17');
T(
  'C06 for an unknown type in a signature (the compiler used to throw)',
  codes('fn f(a: Bytes) -> Int {\n  1\n}\n')[0],
  'C06:1',
);
finish();
