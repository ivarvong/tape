// The table of codes (compiler/diagnostics.ts) against the compiler. It fails on a code raised in compiler/,
// rules/ or sql/ with no row, on a row whose code nothing raises (a retired code: delete its row), and on a row with
// no test that makes the compiler give it. A test is a test file here that names the code in a string, as the
// value it expects (`'C14:3'`, `'C21 cannot tell…'`), or an edit or a refused program in LANGUAGE.md, which
// test/definition.ts compiles. The codes no other test gave have their smallest program below.
import '../node25.ts';
import { readdirSync } from 'node:fs';
import { DIAGNOSTICS, RESERVED } from '../compiler/diagnostics.ts';
import type { Diagnostic } from '../compiler/diagnostics.ts';
import { codes, finish, ok, raw, same } from './harness.ts';

const rows: ReadonlyMap<string, Diagnostic> = new Map(Object.entries(DIAGNOSTICS));

// ---- every code raised has a row, and every row is a code raised
const files = [
  ...['compiler', 'rules', 'sql'].flatMap(dir =>
    readdirSync(new URL(`../${dir}/`, import.meta.url), { recursive: true, encoding: 'utf8' })
      .filter(f => f.endsWith('.ts'))
      .map(f => `${dir}/${f}`),
  ),
  'compiler.ts',
  'rules.ts',
  'sql.ts',
].filter(f => f !== 'compiler/diagnostics.ts');
const raised = new Set(files.flatMap(f => [...raw(f).matchAll(/'([CLPM]\d{2,3})'/g)].map(m => m[1] ?? '')));
ok(`the toolchain raises codes (${raised.size})`, raised.size >= 100);
same('every code raised has a row', [...raised].filter(c => !rows.has(c)).toSorted(), []);
same(
  'every row is a code raised (a retired code has no row)',
  [...rows.keys()].filter(c => !raised.has(c)),
  [],
);
same(
  'a reserved code is neither raised nor in the table',
  Object.keys(RESERVED).filter(c => raised.has(c) || rows.has(c)),
  [],
);
same(
  'each meaning is one line that ends with a full stop and starts with no label',
  [...rows]
    .filter(([, d]) => /\n/.test(d.meaning) || !d.meaning.endsWith('.') || /^\w+:/.test(d.meaning))
    .map(([c]) => c),
  [],
);

// ---- the codes no other test gave, each on its smallest program
const f = { exports: ['f'] };
const FIXTURES: readonly (readonly [code: string, program: string, options?: { exports: string[] }])[] = [
  ['L02', 'fn f(x: Int) -> View {\n  "open\n}\n', f],
  ['L03', 'fn f(x: Int) -> View {\n  "a\\q"\n}\n', f],
  ['L04', 'migration 1 "one" {\n  CREATE TABLE t (id INTEGER PRIMARY KEY)\n'],
  ['P03', 'fn f(x: Int) -> Bool {\n  1 < x < 3\n}\n', f],
  ['P05', 'let x = 1\n'],
  ['P06', 'interface Store {\n  peek head(Int) -> Int\n}\n'],
  ['C02', 'type Empty {\n}\nfn f(x: Int) -> Int {\n  x\n}\n', f],
  // a type that holds itself through a field is boxed; a type parameter with the type's own name hides the field
  // from that, and the layout catches it
  ['C07', 'type R[R] {\n  R(n: R[Int])\n}\nfn f(x: R[Int]) -> Int {\n  1\n}\n', f],
  ['C17', 'fn f(x: Int) -> Int {\n  let o = Some(value: x)\n  o.value\n}\n', f],
  ['C18', 'type P {\n  P(a: Int)\n}\nfn f(x: Int) -> Int {\n  let p = P(a: x)\n  p.b\n}\n', f],
  ['C20', 'fn f(x: Int) -> Int {\n  let p = Nope(a: x)\n  x\n}\n', f],
  ['C23', 'fn f(x: Int) -> Int {\n  match x {\n    Some(value) -> 1\n    _ -> 0\n  }\n}\n', f],
  [
    'C26',
    'fn f(x: Int) -> Buf {\n  let out = buf()\n  match x {\n    1 if len(v: freeze(buf: out)) > 0 -> buf()\n    _ -> out\n  }\n}\n',
    f,
  ],
  ['C29', 'fn f(x: Int) -> Int {\n  size(buf())\n}\n', f],
  ['C30', 'fn g(x: Int) -> Int {\n  x\n}\n'],
  [
    'C46',
    'interface Store {\n  read head(Int) -> Int\n}\nfn handle(raw: View, s: Store) -> Response {\n  let r = s.tail(send: 1, within: 100)\n  empty(status: 200)\n}\n',
  ],
  [
    'C47',
    'migration 2 "two" {\n  CREATE TABLE t (id INTEGER PRIMARY KEY)\n}\nfn handle(raw: View, db: Sql) -> Response {\n  empty(status: 200)\n}\n',
  ],
  [
    'C70',
    'migration 1 "sales" {\n  CREATE TABLE s(id INTEGER PRIMARY KEY, state TEXT NOT NULL DEFAULT \'pending\')\n}\nmigration 2 "fix" contract {\n  UPDATE s SET state = \'payed\' WHERE id = 1\n}\ntype SaleState { Pending Paid }\nmachine s.state: SaleState {\n  Pending -> Paid\n}\nfn handle(raw: View, db: Sql) -> Response {\n  buf() |> write_int(value: sql_exec(db, query: "SELECT count(*) FROM s")) |> respond(status: 200)\n}\n',
  ],
];
for (const [code, program, options] of FIXTURES) {
  const got = codes(program, options);
  ok(
    `${code} on its smallest program`,
    got.some(c => c.startsWith(`${code}:`)),
    got.join(' ') || 'it compiles',
  );
}

// ---- every row has a test
const lines = readdirSync(new URL('./', import.meta.url))
  .filter(n => n.endsWith('.ts') && n !== 'harness.ts')
  .flatMap(n => raw(`test/${n}`).split('\n'))
  .filter(l => !/^\s*(\/\/|\/\*|\*)/.test(l));
const language = raw('LANGUAGE.md');
const tested = (code: string): boolean =>
  new RegExp(`^\`\`\`(diff|tape refused) ${code}$`, 'm').test(language) ||
  lines.some(l => new RegExp(`(['"\`])(?:(?!\\1).)*\\b${code}\\b(?:(?!\\1).)*\\1`).test(l));
const none = [...rows].filter(([, d]) => d.fixture !== undefined).map(([c]) => c);
same(
  'every row has a test that makes the compiler give it',
  [...rows.keys()].filter(c => !none.includes(c) && !tested(c)),
  [],
);
same('a row that says no program can cause it has no test either (else the reason is stale)', none.filter(tested), []);
console.log(`  ${rows.size} codes, ${FIXTURES.length} on programs here, ${none.length} that no program causes`);

finish();
