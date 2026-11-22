// Machines (`machine table.column { "from" -> "to" … }`, rules.ts C57-C61, host.ts machineTriggers): each code on
// the smallest program that shows it, what the checker accepts, the bug fixtures (experiments/lang/bugs) judged with
// their machines, the triggers in SQLite (node:sqlite) refusing what the checker would, a race the ported programs
// now survive, and the machine plan the service uses when versions with and without a machine are live together.
import '../node25.ts';
import { readFileSync } from 'node:fs';
import { compile, parseProgram } from '../compiler.ts';
import { machinePlan } from '../rules.ts';
import { integerParams } from '../sql.ts';
import { instantiate, machineTriggers, machineTriggersIn, installMachines } from '../host.ts';
import { nodeSql } from '../nodesql.ts';
import { portKeys, portWith } from '../experiments/lang/port-keys.ts';
import type { Problem } from '../compiler/common.ts';
import { std } from '../std.ts';
import { built, finish, same as T, sleep } from './harness.ts';
const here = (p: string) => new URL(`../${p}`, import.meta.url).pathname,
  read = (p: string) => readFileSync(here(p), 'utf8');
const build = (text: string) => compile([...std, { name: 'program.tape', text }]);
/** The first thing refused in a program, which must refuse something. */
const refused = (text: string): Problem => {
  const [e] = build(text).errors;
  if (!e) throw new Error('nothing was refused');
  return e;
};
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** The JSON object on the second line of an answer. */
const bodyOf = (answer: string): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(answer.split('\n')[1] ?? 'null');
  return typeof parsed === 'object' && parsed !== null ? Object.fromEntries(Object.entries(parsed)) : {};
};
// Sections 1-5 judge C57-C61 on statements written through sql_exec; C62 (such a write must be a sql_move) is judged
// in section 6, so it is left out here. C77 (a way out of every state: a one-statement program that inserts a row
// and never moves it on has none) is judged in test/timers-way-out.ts, and is left out of every section here.
const codes = (text: string) =>
  build(text)
    .errors.map(e => `${e.code}:${e.line}`)
    .filter(c => !c.startsWith('C62:') && !c.startsWith('C77:'));
const enc = new TextEncoder(),
  dec = new TextDecoder();

// ---- 1. each code on the smallest program that shows it
// A sale: pending, then paid or declined. Line 1 is the schema; the machine is lines 2-5; the handler's query is line 11.
const S =
  "CREATE TABLE IF NOT EXISTS s(id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, state TEXT NOT NULL DEFAULT 'pending', note TEXT NOT NULL DEFAULT '')";
const M = 'machine s.state {\n  "pending" -> "paid"\n  "pending" -> "declined"\n}\n';
const tail = 'type N { N(n: Int) }\nfn done(n: Int) -> Buf {\n  respond(status: 200) |> write_int(value: n)\n}\n';
const one = (query: string, machine = M, schema = S) =>
  `schema "${schema}"\n${machine}${tail}fn handle(raw: View, db: Sql) -> Buf {\n  done(n: sql_exec(db, query: "${query}"${query.includes(':raw') ? ', raw' : ''}))\n}\n`;
// The same program with the write as a sql_move (C62): its query is still line 11.
const moving = (query: string, machine = M, schema = S) =>
  `schema "${schema}"\n${machine}type N { N(n: Int) }\nfn done(m: Move[N]) -> Buf {\n  respond(status: 200) |> write_int(value: seen(m))\n}\nfn handle(raw: View, db: Sql) -> Buf {\n  done(m: sql_move(db, row: N, query: "${query}"${query.includes(':raw') ? ', raw' : ''}))\n}\nfn seen(m: Move[N]) -> Int {\n  match m {\n    Moved(value) -> 1\n    Raced(now) -> 2\n    NoRow -> 0\n  }\n}\n`;
T(
  'a guarded, declared move is accepted',
  codes(one("UPDATE s SET state = 'paid' WHERE id = 1 AND state = 'pending'")),
  [],
);
T(
  'the guard may come first, be reversed, or be an IN list',
  [
    codes(one("UPDATE s SET state = 'paid' WHERE state = 'pending' AND id = 1")),
    codes(one("UPDATE s SET state = 'paid' WHERE 'pending' = s.state AND id = 1")),
    codes(one("UPDATE s SET note = 'x' WHERE id = 1 AND state IN ('pending', 'paid')")),
  ],
  [[], [], []],
);
T(
  'C58: an UPDATE of the table that names no state it expects (J3)',
  codes(one("UPDATE s SET note = 'x' WHERE id = 1")),
  ['C58:11'],
);
T(
  'C58: a guard inside a top-level OR is no guard',
  codes(one("UPDATE s SET note = 'x' WHERE id = 1 OR state = 'pending'")),
  ['C58:11'],
);
T(
  'C58: nor is a guard on another column, or an inequality',
  [
    codes(one("UPDATE s SET note = 'x' WHERE id = 1 AND note = 'pending'")),
    codes(one("UPDATE s SET note = 'x' WHERE id = 1 AND state <> 'paid'")),
  ],
  [['C58:11'], ['C58:11']],
);
T(
  'C58: an upsert whose DO UPDATE names no state',
  codes(one("INSERT INTO s(key, state) VALUES (:raw, 'pending') ON CONFLICT(key) DO UPDATE SET note = 'again'")),
  ['C58:11'],
);
T(
  'C58: with one, it is accepted',
  codes(
    one(
      "INSERT INTO s(key, state) VALUES (:raw, 'pending') ON CONFLICT(key) DO UPDATE SET note = 'again' WHERE s.state = 'pending'",
    ),
  ),
  [],
);
T(
  'C59: a literal move the machine does not declare',
  codes(one("UPDATE s SET state = 'pending' WHERE id = 1 AND state = 'paid'")),
  ['C59:11'],
);
T(
  'C59: every state an IN guard accepts is a from',
  codes(one("UPDATE s SET state = 'declined' WHERE id = 1 AND state IN ('pending', 'paid')")),
  ['C59:11'],
);
T(
  'C59: setting the state the guard names is no move',
  codes(one("UPDATE s SET state = 'paid', note = 'x' WHERE id = 1 AND state = 'paid'")),
  [],
);
T(
  'C59: an INSERT in another state than the first',
  codes(one("INSERT INTO s(key, state) VALUES (:raw, 'paid') ON CONFLICT(key) DO NOTHING")),
  ['C59:11'],
);
T(
  'C59: an INSERT that leaves the state to its DEFAULT, when the DEFAULT is the start',
  codes(one('INSERT INTO s(key) VALUES (:raw) ON CONFLICT(key) DO NOTHING')),
  [],
);
T(
  'C59: and when the column has no DEFAULT',
  codes(one('INSERT INTO s(key) VALUES (:raw) ON CONFLICT(key) DO NOTHING', M, S.replace(" DEFAULT 'pending'", ''))),
  ['C59:11', 'C69:11'],
); // C69: sql.ts, the INSERT always fails (NOT NULL, no DEFAULT)
T(
  'C59: or another DEFAULT',
  codes(
    one(
      'INSERT INTO s(key) VALUES (:raw) ON CONFLICT(key) DO NOTHING',
      M,
      S.replace("DEFAULT 'pending'", "DEFAULT 'paid'"),
    ),
  ),
  ['C59:11'],
);
T(
  'C60: a state that is not a literal or a parameter (CASE)',
  codes(
    one("UPDATE s SET state = CASE WHEN id > 1 THEN 'paid' ELSE 'declined' END WHERE id = 1 AND state = 'pending'"),
  ),
  ['C60:11'],
);
T(
  'C60: a state from the request (a parameter no literal reaches)',
  codes(one("UPDATE s SET state = :raw WHERE id = 1 AND state = 'pending'")),
  ['C60:11'],
);
T(
  'C60: a guard from the request, when the write moves',
  codes(one("UPDATE s SET state = 'paid' WHERE id = 1 AND state = :raw")),
  ['C60:11'],
);
T(
  'C60: but a guard from elsewhere on a write that does not move is a guard',
  codes(one("UPDATE s SET note = 'x' WHERE id = 1 AND state = :raw")),
  [],
);
T(
  'C60: REPLACE, INSERT OR REPLACE (a delete and a fresh start no trigger sees)',
  [
    codes(one("REPLACE INTO s(key, state) VALUES (:raw, 'pending')")),
    codes(one("INSERT OR REPLACE INTO s(key, state) VALUES (:raw, 'pending')")),
  ],
  [['C60:11'], ['C60:11']],
);
// A WITH clause is outside the SQL sql.ts reads (C67); a row-value SET is read as the assignments it is, and this
// one is a declared move
T(
  'C60: INSERT … SELECT, several rows at once; C67: a WITH clause; a row-value SET is read',
  [
    codes(one("INSERT INTO s(key, state) SELECT key, 'pending' FROM s")),
    codes(one("INSERT INTO s(key, state) VALUES (:raw, 'pending'), ('b', 'pending')")),
    codes(one("WITH x AS (SELECT 1) UPDATE s SET state = 'paid' WHERE id = 1 AND state = 'pending'")),
    codes(one("UPDATE s SET (state, note) = ('paid', '') WHERE id = 1 AND state = 'pending'")),
  ],
  [['C60:11'], ['C60:11'], ['C67:11'], []],
);
// sql.ts reads main.s, [s] and S as the table s (names are case-insensitive), so each write is checked: the first
// two make the declared move pending -> paid, the third an undeclared one
T(
  'a write is read however the table is named (main.s, [s], S)',
  [
    codes(one("UPDATE main.s SET state = 'paid' WHERE id = 1 AND state = 'pending'")),
    codes(one("UPDATE [s] SET state = 'paid' WHERE id = 1 AND state = 'pending'")),
    codes(one("UPDATE S SET state = 'void' WHERE id = 1 AND state = 'pending'")),
  ],
  [[], [], ['C59:11']],
);
T(
  'C60: an INSERT whose state is an expression, or a parameter no literal reaches',
  [
    codes(one("INSERT INTO s(key, state) VALUES ('k', lower('pending'))")),
    codes(one("INSERT INTO s(key, state) VALUES ('k', :raw)")),
  ],
  [['C60:11'], ['C60:11']],
);
T(
  'C67: a trigger the program declares (sql.ts takes no CREATE TRIGGER)',
  codes(
    `schema "CREATE TABLE IF NOT EXISTS t(x INTEGER)"\nschema "CREATE TRIGGER IF NOT EXISTS t_after AFTER INSERT ON t BEGIN UPDATE s SET state = 'void'; END"\n` +
      one('SELECT 1'),
  ),
  ['C67:1'],
);
T('C61: a misspelt state in a query', codes(one("SELECT count(*) FROM s WHERE state = 'payed'")), ['C61:11']);
T(
  'C61: in a guard, it is also an undeclared move',
  codes(one("UPDATE s SET state = 'declined' WHERE id = 1 AND state = 'pendng'")),
  ['C59:11', 'C61:11'],
);
T(
  'C61: through a parameter, in an IN list, qualified by an alias',
  [
    codes(one('SELECT count(*) FROM s WHERE state = :raw')),
    codes(one("SELECT count(*) FROM s WHERE state IN ('paid', 'refunded')")),
    codes(one("SELECT count(*) FROM s x WHERE x.state <> 'void'")),
  ],
  [[], ['C61:11'], ['C61:11']],
);
// C58 for DELETE: removing a row another request has moved on is the same lost race as writing onto it
T(
  'C58: a DELETE says which state it removes rows in',
  [
    codes(one('DELETE FROM s WHERE id = 1')),
    codes(one("DELETE FROM s WHERE id = 1 AND state = 'pending'")),
    codes(one("DELETE FROM s WHERE id = 1 OR state = 'pending'")),
    codes(one("DELETE FROM s WHERE id = 1 AND state = 'payed'")),
  ],
  [['C58:11'], [], ['C58:11'], ['C61:11']],
);
T('a program without a machine is not read', codes(one("UPDATE s SET state = 'x' WHERE id = 1", '')), []);
const decl = (machine: string, schema = S) =>
  codes(`schema "${schema}"\n${machine}${tail}fn handle(raw: View, db: Sql) -> Buf {\n  respond(status: 200)\n}\n`);
T(
  'C57: no such table, no such column, a second machine for one column',
  [decl('machine t.state {\n  "a" -> "b"\n}\n'), decl('machine s.status {\n  "a" -> "b"\n}\n'), decl(`${M}${M}`)],
  [['C57:2'], ['C57:2'], ['C57:6']],
);
T(
  'C57: a move to itself, a move twice, no moves, a quote in a state',
  [
    decl('machine s.state {\n  "a" -> "a"\n}\n'),
    decl('machine s.state {\n  "a" -> "b"\n  "a" -> "b"\n}\n'),
    decl('machine s.state {\n}\n'),
    decl('machine s.state {\n  "it\'s" -> "b"\n}\n'),
  ],
  [['C57:2'], ['C57:2'], ['C57:2'], ['C57:2']],
);
T(
  'P01: the syntax is machine table.column { "from" -> "to" }',
  [codes('machine s {\n}\n'), codes('machine s.state {\n  "a" "b"\n}\n')].map(x => x[0]?.split(':')[0]),
  ['P01', 'P01'],
);

// values traced through call sites, one path at a time
const via = (calls: string) =>
  `schema "${S}"\n${M}${tail}fn handle(raw: View, db: Sql) -> Buf {\n  ${calls}\n}\nfn go(db: Sql, from: View, to: View) -> Int {\n  sql_exec(db, query: "UPDATE s SET state = :to WHERE id = 1 AND state = :from", to, from)\n}\nfn twice(db: Sql, a: Int, b: Int) -> Buf {\n  respond(status: 200) |> write_int(value: a + b)\n}\n`;
T(
  'values are traced per path: go(pending, paid) and go(pending, declined) are two declared moves',
  codes(via('twice(db, a: go(db, from: "pending", to: "paid"), b: go(db, from: "pending", to: "declined"))')),
  [],
);
T(
  'one path with an undeclared move is refused at the query',
  codes(via('twice(db, a: go(db, from: "pending", to: "paid"), b: go(db, from: "paid", to: "declined"))')),
  ['C59:14'],
);
T(
  'a path where the value is computed makes it unknown',
  codes(via('twice(db, a: go(db, from: "pending", to: "paid"), b: go(db, from: "pending", to: raw))')),
  ['C60:14'],
);
const pass = `schema "${S}"\n${M}${tail}fn handle(raw: View, db: Sql) -> Buf {\n  done(n: hop(db, to: "paid"))\n}\nfn hop(db: Sql, to: View) -> Int {\n  go(db, to)\n}\nfn go(db: Sql, to: View) -> Int {\n  sql_exec(db, query: "UPDATE s SET state = :to WHERE id = 1 AND state = 'pending'", to)\n}\n`;
T(
  'through two calls (a parameter passed on bare)',
  [codes(pass), codes(pass.replace('to: "paid"', 'to: "pending"'))],
  [[], []],
);
T('… and refused when the value at the root is undeclared', codes(pass.replace('to: "paid"', 'to: "void"')), [
  'C59:17',
]);
const rec = `schema "${S}"\n${M}${tail}fn handle(raw: View, db: Sql) -> Buf {\n  done(n: loop(db, to: "paid", n: 3))\n}\nfn loop(db: Sql, to: View, n: Int) -> Int {\n  match n {\n    0 -> sql_exec(db, query: "UPDATE s SET state = :to WHERE id = 1 AND state = 'pending'", to)\n    _ -> loop(db, to, n: n - 1)\n  }\n}\n`;
T(
  'recursion: the values that reach a recursive function are found by fixpoint',
  [
    codes(rec),
    codes(rec.replace('loop(db, to, n: n - 1)', 'loop(db, to: "declined", n: n - 1)')),
    codes(rec.replace('loop(db, to, n: n - 1)', 'loop(db, to: "void", n: n - 1)')),
  ],
  [[], [], ['C59:15']],
);
const exportedFn = `schema "${S}"\n${M}type Pay { Pay(id: Int, to: View) }\ntype Done { Done(n: Int) }\nexport fn pay(db: Sql, message: Pay) -> Result[Done, View] {\n  Ok(value: Done(n: sql_exec(db, query: "UPDATE s SET state = :to WHERE id = :id AND state = 'pending'", to: message.to, id: message.id)))\n}\n`;
T('an exported method is checked too, and its message is unknown (C60)', codes(exportedFn), ['C60:9']);
const r0 = built(moving("UPDATE s SET state = 'paid' WHERE id = 1 AND state = 'pending' RETURNING id AS n"));
T(
  'the compile result carries the machine as the host installs it, and the module a machines section',
  [r0.machines, WebAssembly.Module.customSections(new WebAssembly.Module(r0.wasm), 'machines').length],
  [
    [
      {
        table: 's',
        column: 'state',
        start: 'pending',
        states: ['pending', 'paid', 'declined'],
        moves: [
          ['pending', 'paid'],
          ['pending', 'declined'],
        ],
      },
    ],
    1,
  ],
);
const r1 = built(one("UPDATE s SET note = 'x' WHERE id = 1", ''));
T(
  'a program without a machine has no machines section (its module is as before)',
  [r1.machines, WebAssembly.Module.customSections(new WebAssembly.Module(r1.wasm), 'machines').length],
  [[], 0],
);
const m0 = refused(one("UPDATE s SET note = 'x' WHERE id = 1"));
T(
  'the C58 error says what goes wrong and how to write the guard',
  [/moved on/.test(m0.message), m0.hint.includes("AND state = '…'")],
  [true, true],
);

// ---- 2. the bug fixtures (experiments/lang/bugs), with the machines they declare (before: rejected; after: J3 passes RM)
const fx = (f: string) =>
  compile([
    ...std,
    { name: f, text: portWith(portKeys(read(`experiments/lang/bugs/${f}`).replaceAll(/^private type /gm, 'type '))) },
  ])
    .errors.map(e => `${e.code}:${e.line}`)
    .filter(c => /^C5[7-9]|^C6[01]/.test(c));
T('J2 before: the unguarded decline and payment are refused (C58)', fx('j2-before.tape'), ['C58:63', 'C58:64']);
T(
  'J2 after: the fixed decline passes; the payment is still unguarded (fixed on main in examples/tickets.tape)',
  fx('j2-after.tape'),
  ['C58:67'],
);
T('J3 before: the note written onto an order in any state is refused at its own line (C58)', fx('j3-before.tape'), [
  'C58:149',
]);
T(
  'J3 after, J4 before and after: no machine finding',
  [fx('j3-after.tape'), fx('j4-before.tape'), fx('j4-after.tape')],
  [[], [], []],
);
T(
  'the ported programs compile',
  ['examples/tickets.tape', 'examples/orders.tape', 'examples/bump.tape', 'examples/fulfillment.tape'].map(f =>
    compile([...std, { name: f, text: read(f) }]).errors.map(e => e.code),
  ),
  [[], [], [], []],
);

// ---- 3. the triggers, in SQLite
{
  const r = built(read('examples/fulfillment.tape')),
    sql = nodeSql();
  instantiate(new WebAssembly.Module(r.wasm), { sql, name: 'fulfill', services: {} });
  const tryIt = (q: string) => {
    try {
      sql.exec(q);
      return 'ok';
    } catch (e) {
      return /machine orders\.state/.test(messageOf(e)) ? 'refused' : messageOf(e);
    }
  };
  T('instantiate installs the two triggers of the machine', machineTriggersIn(sql), [
    '_tape_machine_orders_state_move',
    '_tape_machine_orders_state_start',
  ]);
  T(
    'an INSERT in the start state (named or by DEFAULT) is taken; in another, or NULL, refused',
    [
      tryIt("INSERT INTO orders(sku, qty, card, address) VALUES ('a', 1, 'c', 'x')"),
      tryIt("INSERT INTO orders(sku, qty, card, address, state) VALUES ('a', 1, 'c', 'x', 'reserving')"),
      tryIt("INSERT INTO orders(sku, qty, card, address, state) VALUES ('a', 1, 'c', 'x', 'done')"),
    ],
    ['ok', 'ok', 'refused'],
  );
  T(
    'a declared move is taken; an undeclared one refused; a write that does not change the state is taken',
    [
      tryIt("UPDATE orders SET state = 'charging' WHERE id = 1"),
      tryIt("UPDATE orders SET state = 'done' WHERE id = 1"),
      tryIt("UPDATE orders SET state = 'charging', note = 'n' WHERE id = 1"),
      tryIt("UPDATE orders SET note = 'n2' WHERE id = 1"),
    ],
    ['ok', 'refused', 'ok', 'ok'],
  );
  T(
    'a refused statement changes nothing',
    sql
      .exec('SELECT state, note FROM orders WHERE id = 1')
      .toArray()
      .map(row => [row.state, row.note]),
    [['charging', 'n2']],
  );
  T(
    'an upsert that moves by DO UPDATE is a move like any other',
    tryIt(
      "INSERT INTO orders(id, sku, qty, card, address) VALUES (1, 'a', 1, 'c', 'x') ON CONFLICT(id) DO UPDATE SET state = 'done'",
    ),
    'refused',
  );
  T(
    'the triggers do not see the J3 write (it is no move): that is C58, at compile time',
    tryIt("UPDATE orders SET note = 'late' WHERE id = 1"),
    'ok',
  );
  T('DELETE is not checked', tryIt('DELETE FROM orders WHERE id = 2'), 'ok');
  // a rebuild of the table (a contract migration) drops its triggers; instantiate puts them back after migrating
  const more = r.migrations.concat([
    {
      n: 5,
      name: 'rebuild',
      contract: true,
      statements: [
        'CREATE TABLE orders2 AS SELECT * FROM orders',
        'DROP TABLE orders',
        'ALTER TABLE orders2 RENAME TO orders',
      ],
      hash: 'x'.repeat(64),
    },
  ]);
  instantiate(new WebAssembly.Module(r.wasm), { sql, name: 'fulfill', services: {}, migrations: more });
  T(
    'after a migration rebuilds the table, the triggers are made again on the new one',
    [machineTriggersIn(sql), tryIt("UPDATE orders SET state = 'done' WHERE id = 1")],
    [['_tape_machine_orders_state_move', '_tape_machine_orders_state_start'], 'refused'],
  );
  instantiate(new WebAssembly.Module(r.wasm), { sql, name: 'fulfill', services: {}, migrations: false });
  T(
    'a host that migrates the data itself (migrations: false) leaves the triggers as they are',
    machineTriggersIn(sql).length,
    2,
  );
  installMachines(sql, []);
  T('installMachines with none removes them', machineTriggersIn(sql), []);
  const quote = machineTriggers([{ table: 't', column: 'c', start: "a'b", moves: [["a'b", 'c']] }]);
  T('states are quoted in the trigger SQL', quote[0]?.includes("NEW.\"c\" IS 'a''b'"), true);
}
{
  // a program with a machine run through the host: a write the trigger refuses fails the request and rolls it back
  const text = moving("UPDATE s SET state = 'paid' WHERE id = 1 AND state = 'pending' RETURNING id AS n");
  const r = built(text),
    sql = nodeSql(),
    a = instantiate(new WebAssembly.Module(r.wasm), { sql, name: 's', services: {} });
  sql.exec("INSERT INTO s(key) VALUES ('k')");
  sql.exec('DROP TRIGGER "_tape_machine_s_state_move"');
  sql.exec("UPDATE s SET state = 'declined' WHERE id = 1");
  installMachines(sql, r.machines);
  let err: string | null = null;
  try {
    await a.runLogged(enc.encode('GET /\n'), { transaction: f => sql.transaction(f) });
  } catch (e) {
    err = messageOf(e);
  }
  T(
    'the trigger stops a move the checker could not see (data moved behind its back): the guard simply matches nothing',
    [err, sql.exec('SELECT state FROM s').toArray()[0]?.state],
    [null, 'declined'],
  );
}

// ---- 4. the ported programs: a retry racing the first request finds the row moved, and answers with it
{
  const r = built(read('examples/tickets.tape')),
    sql = nodeSql();
  let release = (): void => {};
  const gate = new Promise<void>(res => {
    release = res;
  });
  const a = instantiate(new WebAssembly.Module(r.wasm), {
    sql,
    name: 'tickets',
    services: {
      payments: async () => {
        await gate;
        return enc.encode('{"balance":10}');
      },
    },
  });
  const run = (head: string, body = '') =>
    a.runLogged(enc.encode(`${head}\n${body}`), { transaction: f => sql.transaction(f) }).then(x => dec.decode(x.out));
  const buy = JSON.stringify({ key: 'k1', section: 'balcony', qty: 2, card: 'ann-4242' });
  const first = run('POST /buy', buy);
  await sleep(20);
  const second = run('POST /retry/1');
  await sleep(20);
  release();
  const [x, y] = await Promise.all([first, second]);
  T(
    'tickets: a retry racing the purchase: both answer 201 with the one ticket, the sale is paid once',
    [
      x.split('\n')[0],
      y.split('\n')[0],
      bodyOf(x).id,
      bodyOf(y).id,
      sql
        .exec('SELECT state FROM sales')
        .toArray()
        .map(row => row.state),
    ],
    ['201', '201', 1, 1, ['paid']],
  );
}
{
  const r = built(read('examples/orders.tape')),
    sql = nodeSql();
  let release = (): void => {};
  const gate = new Promise<void>(res => {
    release = res;
  });
  const a = instantiate(new WebAssembly.Module(r.wasm), {
    sql,
    name: 'orders',
    services: {
      stock: async () => {
        await gate;
        return enc.encode('{"item":"lamp","remaining":4}');
      },
    },
  });
  const run = (head: string, body = '') =>
    a.runLogged(enc.encode(`${head}\n${body}`), { transaction: f => sql.transaction(f) }).then(x => dec.decode(x.out));
  const first = run('POST /orders', '{"key":"o-1","item":"lamp"}');
  await sleep(20);
  const second = run('POST /retry/1');
  await sleep(20);
  release();
  const [x, y] = await Promise.all([first, second]);
  T(
    'orders: a retry racing the order: both answer with the confirmed order, not "the order vanished"',
    [x.split('\n')[0], y.split('\n')[0], bodyOf(y).state],
    ['201', '201', 'confirmed'],
  );
}

// ---- 5. the machine plan: versions with and without a machine, live together
const prog = (text: string) => parseProgram([...std, { name: 'program.tape', text }]);
const v1 = prog(one("UPDATE s SET state = 'void' WHERE id = 1 AND state = 'paid'", '')),
  v2 = prog(one("UPDATE s SET state = 'paid' WHERE id = 1 AND state = 'pending'"));
const p12 = machinePlan([
  { version: 1, prog: v1 },
  { version: 2, prog: v2 },
]);
T(
  'an older version without the machine: its moves are allowed while it is live, and listed as notes',
  [p12.machines.map(m => [m.table, m.column, m.moves, m.by]), p12.refusals, p12.notes.map(n => [n.version, n.code])],
  [
    [
      [
        's',
        'state',
        [
          ['pending', 'paid'],
          ['pending', 'declined'],
          ['paid', 'void'],
        ],
        [2],
      ],
    ],
    [],
    [[1, 'C59']],
  ],
);
const p2 = machinePlan([{ version: 2, prog: v2 }]);
T('once it is retired, only the declared moves are', p2.machines[0]?.moves, [
  ['pending', 'paid'],
  ['pending', 'declined'],
]);
const v1b = prog(one("UPDATE s SET state = :raw WHERE id = 1 AND state = 'pending'", ''));
const pb = machinePlan([
  { version: 1, prog: v1b },
  { version: 2, prog: v2 },
]);
T(
  'an older version whose writes of the column cannot be read refuses the plan (C60), naming it',
  pb.refusals.map(r => [r.version, r.code]),
  [[1, 'C60']],
);
const v3 = prog(one("UPDATE s SET note = 'x' WHERE id = 1", ''));
const p23 = machinePlan([
  { version: 2, prog: v2 },
  { version: 3, prog: v3 },
]);
T(
  'a newer version that drops the machine is read under it: its unguarded write is a note, not a refusal',
  [p23.refusals, p23.notes.map(n => [n.version, n.code])],
  [[], [[3, 'C58']]],
);
const v4 = prog(
  one(
    "UPDATE s SET state = 'paid' WHERE id = 1 AND state = 'pending'",
    'machine s.state {\n  "pending" -> "paid"\n  "paid" -> "refunded"\n}\n',
  ),
);
const p24 = machinePlan([
  { version: 2, prog: v2 },
  { version: 4, prog: v4 },
]);
T(
  'two versions with different machines for one column: the union of their moves and states',
  [p24.machines[0]?.moves, p24.machines[0]?.states, p24.machines[0]?.by],
  [
    [
      ['pending', 'paid'],
      ['pending', 'declined'],
      ['paid', 'refunded'],
    ],
    ['pending', 'paid', 'declined', 'refunded'],
    [2, 4],
  ],
);

// ---- 6. C62, C63 and sql_move: a compare-and-set whose outcome says whether it moved the row, lost a race, or found none (J4)
const all = (text: string) =>
  build(text)
    .errors.map(e => `${e.code}:${e.line}`)
    .filter(c => !c.startsWith('C77:')); // C77: test/timers-way-out.ts
T(
  'C62: a compare-and-set on the machine column through sql_exec, or sql_first, is refused',
  [
    all(one("UPDATE s SET state = 'paid' WHERE id = 1 AND state = 'pending'")),
    all(one("UPDATE s SET note = 'x' WHERE id = 1 AND state = 'pending'")),
    all(
      one("UPDATE s SET state = 'paid' WHERE id = 1 AND state = 'pending'")
        .replace('done(n: sql_exec(db, query:', 'first(found: sql_first(db, row: N, query:')
        .replace("'pending'\"", "'pending' RETURNING id AS n\"") +
        'fn first(found: Option[N]) -> Buf {\n  match found {\n    Some(value) -> respond(status: 200)\n    None -> respond(status: 404)\n  }\n}\n',
    ),
  ],
  [['C62:11'], ['C62:11'], ['C62:11']],
);
const c62 = refused(one("UPDATE s SET state = 'paid' WHERE id = 1 AND state = 'pending'"));
T(
  'the C62 error names the confusion and the form to use',
  [
    /moved the row first and when there is no such row/.test(c62.message),
    c62.hint.includes('sql_move') && c62.hint.includes('Raced(now)'),
  ],
  [true, true],
);
T(
  'C62 is not asked of a table without a machine, nor of an upsert, nor of an INSERT',
  [
    all(one("UPDATE s SET state = 'paid' WHERE id = 1 AND state = 'pending'", '')),
    all(
      one(
        "INSERT INTO s(key, state) VALUES (:raw, 'pending') ON CONFLICT(key) DO UPDATE SET note = 'again' WHERE s.state = 'pending'",
      ),
    ),
    all(one('INSERT INTO s(key) VALUES (:raw) ON CONFLICT(key) DO NOTHING')),
  ],
  [[], [], []],
);
T(
  'sql_move: a compare-and-set by key with RETURNING is accepted, the guard in any position, a parameter or a literal',
  [
    all(moving("UPDATE s SET state = 'paid' WHERE id = 1 AND state = 'pending' RETURNING id AS n")),
    all(moving("UPDATE s SET note = 'x' WHERE state IN ('pending', 'paid') AND key = :raw RETURNING id AS n")),
    all(moving("UPDATE s SET state = 'paid' WHERE 'pending' = state AND id = 1 RETURNING id AS n", '')),
  ],
  [[], [], []],
);
const c63 = (q: string) => {
  const e = build(moving(q)).errors;
  return e.map(x => `${x.code}:${x.line}`);
};
T(
  'C63: sql_move takes an UPDATE with RETURNING, a compare-and-set, and the row named by its key alone',
  [
    c63("UPDATE s SET state = 'paid' WHERE id = 1 AND state = 'pending'"),
    c63("UPDATE s SET note = 'x' WHERE id = 1 RETURNING id AS n"),
    c63("UPDATE s SET state = 'paid' WHERE id = 1 AND state = 'pending' AND note <> '' RETURNING id AS n"),
    c63("UPDATE s SET state = 'paid' WHERE id = 1 OR state = 'pending' RETURNING id AS n"),
    c63('SELECT id AS n FROM s WHERE id = 1'),
    c63("UPDATE s SET state = 'paid' WHERE state = 'pending' RETURNING id AS n"),
    c63("UPDATE s SET state = 'paid' WHERE note = 'x' AND state = 'pending' RETURNING id AS n"),
  ],
  [['C63:11'], ['C63:11'], ['C63:11'], ['C63:11'], ['C63:11'], ['C63:11'], ['C63:11']],
);
T(
  'C63 on a key that is not unique says which keys are',
  /not a whole unique key of s \(id; key\)/.test(
    refused(moving("UPDATE s SET state = 'paid' WHERE note = 'x' AND state = 'pending' RETURNING id AS n")).message,
  ),
  true,
);
{
  // the three outcomes, run: the re-read is derived from the UPDATE and runs only when it changes nothing
  const text = `schema "${S}"\n${M}type Row { Row(id: Int, state: View) }\nfn handle(raw: View, db: Sql) -> Buf {\n  said(moved: sql_move(db, row: Row, query: "UPDATE s SET state = :state, note = :note WHERE state = 'pending' AND key = :raw RETURNING id, state", state: "paid", note: "n", raw))\n}\nfn said(moved: Move[Row]) -> Buf {\n  match moved {\n    Moved(value: Row(state)) -> append(buf: respond(status: 200), view: "moved " ++ state)\n    Raced(now: Row(state)) -> append(buf: respond(status: 200), view: "raced " ++ state)\n    NoRow -> append(buf: respond(status: 200), view: "none")\n  }\n}\n`;
  const r = built(text),
    sql = nodeSql(),
    a = instantiate(new WebAssembly.Module(r.wasm), { sql, name: 's', services: {} });
  sql.exec("INSERT INTO s(key) VALUES ('k')");
  const run = (raw: string) =>
    a
      .runLogged(enc.encode(raw), { transaction: f => sql.transaction(f) })
      .then(x => dec.decode(x.out).split('\n').at(-1));
  T(
    'the derived re-read: the RETURNING columns, by the key alone, its parameters renumbered',
    r.queries.map(q => [q.sql, q.params]),
    [
      ["UPDATE s SET state = ?1, note = ?2 WHERE state = 'pending' AND key = ?3 RETURNING id, state", 'ttt'],
      ['SELECT id, state FROM s WHERE key = ?1', 't'],
    ],
  );
  T(
    'Moved, then Raced with the row as it is now, then NoRow for a key with no row',
    [await run('k'), await run('k'), await run('nope')],
    ['moved paid', 'raced paid', 'none'],
  );
  T(
    'a lost compare-and-set changes nothing',
    sql
      .exec('SELECT state, note FROM s')
      .toArray()
      .map(x => [x.state, x.note]),
    [['paid', 'n']],
  );
}
{
  // C54 and sql_move: a dependent write that runs only when this request moved the row runs once per move
  const prog6 = (arm: string) =>
    `schema "${S}"\nschema "CREATE TABLE IF NOT EXISTS tally(name TEXT PRIMARY KEY, n INTEGER NOT NULL)"\n${M}type N { N(n: Int) }\nfn handle(raw: View, db: Sql) -> Buf {\n  paid(db, moved: sql_move(db, row: N, query: "UPDATE s SET state = 'paid' WHERE key = :raw AND state = 'pending' RETURNING id AS n", raw))\n}\nfn paid(db: Sql, moved: Move[N]) -> Buf {\n  match moved {\n    ${arm === 'Moved' ? 'Moved(value) -> count(db)\n    Raced(now) -> respond(status: 200)' : 'Moved(value) -> respond(status: 200)\n    Raced(now) -> count(db)'}\n    NoRow -> respond(status: 404)\n  }\n}\nfn count(db: Sql) -> Buf {\n  done(n: sql_exec(db, query: "UPDATE tally SET n = n + 1 WHERE name = 'paid'"))\n}\nfn done(n: Int) -> Buf {\n  respond(status: 200) |> write_int(value: n)\n}\n`;
  T(
    'C54: a dependent write reached only from the Moved arm is accepted; from the Raced arm, refused',
    [all(prog6('Moved')), all(prog6('Raced'))],
    [[], ['C54:19']],
  );
  // V1: `count` is also std's (map.tape): the rules read the call as the compiler does, the program's own function
  const v1prog = `schema "CREATE TABLE IF NOT EXISTS tally(name TEXT PRIMARY KEY, n INTEGER NOT NULL)"\nfn handle(raw: View, db: Sql) -> Buf {\n  count(db)\n}\nfn count(db: Sql) -> Buf {\n  done(n: sql_exec(db, query: "UPDATE tally SET n = n + 1 WHERE name = 'paid'"))\n}\nfn done(n: Int) -> Buf {\n  respond(status: 200) |> write_int(value: n)\n}\n`;
  T('V1: a program function that std also names is reached, and its write checked (C54)', all(v1prog), ['C54:6']);
}
const fx6 = (f: string) =>
  compile([...std, { name: f, text: portKeys(read(`experiments/lang/bugs/${f}`)) }])
    .errors.map(e => `${e.code}:${e.line}`)
    .filter(c => /^C6[23]/.test(c));
T(
  'J4 replayed on the shipped program: the lost compare-and-set is refused at its own line (C62); the port to sql_move is accepted',
  [fx6('j4-port-before.tape')[0], fx6('j4-before.tape')[0], fx6('j4-port-after.tape')],
  ['C62:180', 'C62:102', []],
);
T(
  'the ported programs have no hand-written re-read left',
  ['examples/fulfillment.tape', 'examples/orders.tape', 'examples/tickets.tape'].map(f =>
    /fn (current|paid)\(/.test(read(f)),
  ),
  [false, false, false],
);

// ---- 7. private types (C66): constructors build values only in the declaring file; J1 judged
{
  const two = (a: string, b: string) =>
    compile([...std, { name: 'trusted.tape', text: a }, { name: 'program.tape', text: b }]).errors.map(
      e => `${e.code}:${e.file}:${e.line}`,
    );
  const trusted =
    'private type Proof { Proof(reason: View) }\nfn proved(why: View) -> Proof {\n  Proof(reason: why)\n}\n';
  T(
    'C66: a private type is built in its own file; elsewhere it is matched on and passed along, not built',
    [
      two(
        trusted,
        'fn handle(raw: View) -> Buf {\n  shown(p: proved(why: raw))\n}\nfn shown(p: Proof) -> Buf {\n  match p {\n    Proof(reason) -> append(buf: respond(status: 200), view: reason)\n  }\n}\n',
      ),
      two(
        trusted,
        'fn handle(raw: View) -> Buf {\n  shown(p: Proof(reason: raw))\n}\nfn shown(p: Proof) -> Buf {\n  respond(status: 200)\n}\n',
      ),
    ],
    [[], ['C66:program.tape:2']],
  );
  T(
    '`private` is still a name a program may use',
    all(
      'fn handle(raw: View) -> Buf {\n  ok(private: 1)\n}\nfn ok(private: Int) -> Buf {\n  respond(status: 200)\n}\n',
    ),
    [],
  );
  const forged =
    'type M { M(n: Int) }\nfn handle(raw: View) -> Buf {\n  said(r: Err(error: Rejected(reason: "no")))\n}\nfn said(r: Result[M, CallError]) -> Buf {\n  match r {\n    Err(error: Rejected(reason)) -> append(buf: respond(status: 409), view: reason)\n    _ -> respond(status: 200)\n  }\n}\n';
  T(
    'CallError is private to std/core.tape: a program matches on Rejected, and cannot make one (J1 at the program level)',
    all(forged),
    ['C66:3'],
  );
  const j1 = (f: string) =>
    compile([
      ...std,
      { name: 'j1/transport.tape', text: read('experiments/lang/bugs/j1/transport.tape') },
      { name: f, text: read(`experiments/lang/bugs/j1/${f}`) },
    ]).errors.map(e => `${e.code}:${e.line}`);
  T(
    'J1: the classifier that made a transport failure a refusal is refused at its own line; the fixed one compiles',
    [j1('classify-before.tape'), j1('classify-after.tape')],
    [['C66:6'], []],
  );
}

// ---- the host binds a tape Int as an integer: the Durable Object SQL API and node:sqlite bind every JavaScript
// number as REAL (5 → 5.0), and neither takes a BigInt, so the host reads each Int/Bool parameter as CAST(?n AS INTEGER)
{
  const text =
    'schema "CREATE TABLE t(k TEXT NOT NULL)"\ntype R { R(s: View, h: Int, ty: View) }\nfn handle(raw: View, db: Sql) -> Buf {\n  show(found: sql_first(db, row: R, query: "SELECT \'k\' || :n AS s, :m * 3 AS h, typeof(:m) AS ty", n: 5, m: 5))\n}\nfn show(found: Option[R]) -> Buf {\n  match found {\n    Some(value: R(s, h, ty)) -> append(buf: append(buf: write_int(out: respond(status: 200), value: h), view: s), view: ty)\n    None -> respond(status: 500)\n  }\n}\n';
  const r = build(text);
  T(
    'the probe compiles',
    r.errors.map(e => `${e.code}: ${e.message}`),
    [],
  );
  const sql = nodeSql(),
    a = instantiate(new WebAssembly.Module(r.wasm), { sql, name: 'ints', services: {} });
  const out = dec.decode((await a.runLogged(enc.encode('GET /\n'), { transaction: f => sql.transaction(f) })).out);
  T(
    "an Int parameter is an integer in SQL: 'k' || ?1 is k5 (not k5.0), typeof(?2) is integer (not real)",
    out.endsWith('15k5integer'),
    true,
  );
  T(
    'the text run is the query with its Int parameters cast',
    integerParams("SELECT ?1, '?2', ?2 FROM t WHERE a = ?3", 'iti'),
    "SELECT CAST(?1 AS INTEGER), '?2', ?2 FROM t WHERE a = CAST(?3 AS INTEGER)",
  );
}

finish();
