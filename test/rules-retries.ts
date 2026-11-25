// The rules (rules.ts, C51-C56): each code on the smallest program that shows it, the programs of this repository
// as they were before the rules (experiments/lang/before) refused and as they are now accepted, the bug fixtures of
// experiments/lang/bugs, the fixed programs retried with the same key doing their work once, and the rules' table
// model checked against SQLite's for every program here.
import '../node25.ts';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { compile, parseProgram } from '../compiler.ts';
import { tablesOf } from '../rules.ts';
import { TimedOut, instantiate } from '../host.ts';
import type { Service } from '../host.ts';
import { nodeSql } from '../nodesql.ts';
import { portErrors, portKeys, portJson, portWith } from '../experiments/lang/port-keys.ts';
import { std } from '../std.ts';
import { answered, built, finish, moduleOf, same as T } from './harness.ts';
const NOW = Date.now(); // R-RET-1: a kv op id is <t>_<id>, t the client's clock in ms when it was first sent
const here = (p: string) => new URL(`../${p}`, import.meta.url).pathname,
  read = (p: string) => readFileSync(here(p), 'utf8');
const codes = (text: string): string[] =>
  compile([...std, { name: 'program.tape', text }]).errors.map(e => `${e.code}:${e.line}`);
const enc = new TextEncoder(),
  dec = new TextDecoder();

// ---- 1. each code on the smallest program that shows it
const count = `type N { N(n: Int) }
fn done(n: Int) -> Response {
  buf() |> write_int(value: n) |> respond(status: 200)
}
`;
const one = (schema: string, query: string, extra = '', said = '') =>
  `schema "${schema}"\n${count}${extra}fn handle(raw: View, db: Sql) -> Response {\n  done(n: sql_exec(db, ${said}query: "${query}"))\n}\n`;
const c = 'CREATE TABLE IF NOT EXISTS c(name TEXT PRIMARY KEY, n INTEGER NOT NULL, state TEXT NOT NULL)';
T('C54: n = n + 1 from a request is refused', codes(one(c, "UPDATE c SET n = n + 1 WHERE name = 'a'")), ['C54:7']);
T(
  'C54: `repeat: True` on the call accepts it',
  codes(one(c, "UPDATE c SET n = n + 1 WHERE name = 'a'", '', 'repeat: True, ')),
  [],
);
T(
  'C54: a comment in the statement does not (the old opt-out is no longer one)',
  codes(one(c, "UPDATE c SET n = n + 1 /* each attempt counts */ WHERE name = 'a'")),
  ['C54:7'],
);
T(
  'C88: `repeat: True` on a write that a second run does not change again is refused',
  codes(one(c, "UPDATE c SET state = 'done' WHERE name = 'a'", '', 'repeat: True, ')),
  ['C88:7'],
);
T(
  'repeat takes True and nothing else',
  codes(one(c, "UPDATE c SET n = n + 1 WHERE name = 'a'", '', 'repeat: False, ')),
  ['C14:7'],
);
T(
  'C54: a compare-and-set on a changed column accepts it',
  codes(one(c, "UPDATE c SET n = n + 1, state = 'b' WHERE name = 'a' AND state = 'a'")),
  [],
);
T(
  'C54: a compare-and-set on a version column accepts it',
  codes(one(c, "UPDATE c SET n = n + 1 WHERE name = 'a' AND n = 3")),
  [],
);
T(
  'C54: SET state = state is no compare-and-set (a second run sees the same state)',
  codes(one(c, "UPDATE c SET n = n + 1, state = state WHERE name = 'a' AND state = 'a'")),
  ['C54:7'],
);
T(
  'C54: setting the value it checks for is no compare-and-set',
  codes(one(c, "UPDATE c SET n = n + 1, state = 'a' WHERE name = 'a' AND state = 'a'")),
  ['C54:7'],
);
T(
  'C54: a new value inside the IN list it checks is no compare-and-set',
  codes(one(c, "UPDATE c SET n = n + 1, state = 'b' WHERE name = 'a' AND state IN ('a', 'b')")),
  ['C54:7'],
);
T('C54: an absolute write (n = 5) is safe to run twice', codes(one(c, "UPDATE c SET n = 5 WHERE name = 'a'")), []);
T(
  'C54: an upsert that adds is refused',
  codes(one(c, "INSERT INTO c VALUES ('a', 1, 'x') ON CONFLICT(name) DO UPDATE SET n = n + 1")),
  ['C54:7'],
);
const ops =
  'CREATE TABLE IF NOT EXISTS c(name TEXT PRIMARY KEY, n INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS seen(op TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (op, name))';
const guarded = (guard: string, rec = "INSERT INTO seen VALUES (:op, 'a') ON CONFLICT DO NOTHING") =>
  `schema "${ops.split('; ')[0]}"\nschema "${ops.split('; ')[1]}"\n${count}fn handle(raw: View, db: Sql) -> Response {\n  recorded(db, n: sql_exec(db, query: "UPDATE c SET n = n + 1 WHERE name = :name AND ${guard}", op: raw, name: "a"))\n}\nfn recorded(db: Sql, n: Int) -> Response {\n  done(n: n + sql_exec(db, query: "${rec}", op: "x"))\n}\n`;
T(
  'C54: an op-id guard over a table the program records op ids in accepts it',
  codes(guarded('NOT EXISTS (SELECT 1 FROM seen WHERE op = :op AND name = :name)')),
  [],
);
T(
  'C54: the same guard over a table nothing inserts into is refused',
  codes(
    guarded(
      'NOT EXISTS (SELECT 1 FROM seen WHERE op = :op AND name = :name)',
      'SELECT count(*) FROM c WHERE name = :op',
    ),
  ),
  ['C54:8'],
);
T(
  'C56: an op-id guard that does not name the row (R11: the same op id on another key) is refused',
  codes(guarded('NOT EXISTS (SELECT 1 FROM seen WHERE op = :op)')),
  ['C56:8'],
);
const ins = 'CREATE TABLE IF NOT EXISTS t(id INTEGER PRIMARY KEY, key TEXT UNIQUE, body TEXT NOT NULL)';
T(
  'C55: an INSERT that names no unique key makes a second row on a retry',
  codes(one(ins, "INSERT INTO t(body) VALUES ('x')")),
  ['C55:7'],
);
T(
  'C55: ON CONFLICT DO NOTHING does not help without a key it names',
  codes(one(ins, "INSERT INTO t(body) VALUES ('x') ON CONFLICT DO NOTHING")),
  ['C55:7'],
);
T(
  'C55: an INSERT naming the client key is accepted',
  codes(one(ins, "INSERT INTO t(key, body) VALUES ('k', 'x') ON CONFLICT(key) DO NOTHING")),
  [],
);
T(
  'C55: so is one naming the primary key',
  codes(one(ins, "INSERT INTO t(id, body) VALUES (1, 'x') ON CONFLICT(id) DO NOTHING")),
  [],
);
T(
  'C55: a unique key added by a migration counts',
  codes(
    `migration 1 "t" {\n  CREATE TABLE t(id INTEGER PRIMARY KEY, body TEXT NOT NULL)\n}\nmigration 2 "keys" {\n  ALTER TABLE t ADD COLUMN key TEXT;\n  CREATE UNIQUE INDEX t_key ON t(key)\n}\n${count}fn handle(raw: View, db: Sql) -> Response {\n  done(n: sql_exec(db, query: "INSERT INTO t(key, body) VALUES ('k', 'x') ON CONFLICT(key) DO NOTHING"))\n}\n`,
  ),
  [],
);
T(
  'C55: a partial unique index does not count (it is not unique for every row)',
  codes(
    `migration 1 "t" {\n  CREATE TABLE t(id INTEGER PRIMARY KEY, key TEXT, body TEXT NOT NULL);\n  CREATE UNIQUE INDEX t_key ON t(key) WHERE body <> ''\n}\n${count}fn handle(raw: View, db: Sql) -> Response {\n  done(n: sql_exec(db, query: "INSERT INTO t(key, body) VALUES ('k', 'x')"))\n}\n`,
  ),
  ['C55:10'],
);
const exported = `schema "${c}"\ntype Bump { Bump(name: View) } type Refusal { Refused(reason: View) }\ntype Done { Done(n: Int) }\nexport fn bump(db: Sql, message: Bump) -> Result[Done, Refusal] {\n  Ok(value: Done(n: sql_exec(db, query: "UPDATE c SET n = n + 1 WHERE name = :name", name: message.name)))\n}\n`;
T(
  'C54: a write reached only from an exported method is not checked (a repeated once key is answered from the stored reply)',
  codes(exported),
  [],
);
T(
  'C54: the same write reached from woken is checked (a timer fires at least once)',
  codes(
    `schema "${c}"\ntype Done { Done(n: Int) }\nexport fn woken(db: Sql, message: Wake) -> Result[Done, View] {\n  Ok(value: Done(n: sql_exec(db, query: "UPDATE c SET n = n + 1 WHERE name = 'a'")))\n}\n`,
  ),
  ['C54:4'],
);
const two =
  'migration 1 "t" {\n  CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT NOT NULL);\n  CREATE TABLE tags(note INTEGER NOT NULL, tag TEXT NOT NULL)\n}\n';
const q = (s: string) =>
  `${two}${count}fn handle(raw: View, db: Sql) -> Response {\n  done(n: sql_exec(db, query: "${s}"))\n}\n`;
T(
  'C52: a bare column in a query over two tables (M1)',
  codes(q('SELECT count(body) FROM notes JOIN tags ON tags.note = notes.id')),
  ['C52:10'],
);
T(
  'C52: qualified, with tables or aliases, it is accepted',
  [
    codes(q('SELECT count(notes.body) FROM notes JOIN tags ON tags.note = notes.id')),
    codes(q('SELECT count(n.body) FROM notes n JOIN tags t ON t.note = n.id')),
  ],
  [[], []],
);
T('C52: one table needs no qualifying', codes(q('SELECT count(body) FROM notes')), []);
const mig = (body: string, contract = '') =>
  `${two}migration 2 "next"${contract} {\n  ${body}\n}\n${count}fn handle(raw: View, db: Sql) -> Response {\n  empty(status: 200)\n}\n`;
T(
  'C51: a removal, a rename, an UPDATE, a DELETE outside a contract (M2)',
  [
    'DROP TABLE tags',
    'ALTER TABLE notes RENAME COLUMN body TO text',
    'ALTER TABLE main . notes RENAME COLUMN body TO text',
    "UPDATE notes SET body = ''",
    'DELETE FROM tags',
    'ALTER TABLE notes DROP COLUMN body',
  ].map(s => codes(mig(s))),
  Array.from({ length: 6 }, () => ['C51:5']),
);
T(
  'C51: the same in a contract migration is accepted',
  ['DROP TABLE tags', 'ALTER TABLE notes RENAME COLUMN body TO text'].map(s => codes(mig(s, ' contract'))),
  [[], []],
);
T(
  'C51: the forms an expansion may take are accepted',
  [
    'ALTER TABLE tags ADD COLUMN body TEXT',
    'CREATE INDEX tags_tag ON tags(tag)',
    'CREATE TABLE more(id INTEGER PRIMARY KEY)',
    "INSERT INTO tags(note, tag) VALUES (1, 'x')",
  ].map(s => codes(mig(s))),
  [[], [], [], []],
);
T(
  'C51: an INSERT without a column list is not on the allow-list (a later ADD COLUMN changes what it means)',
  codes(mig("INSERT INTO tags VALUES (1, 'x')")),
  ['C51:5'],
);
T(
  'C53: schema statements beside migrations (M3)',
  codes(
    `schema "CREATE TABLE IF NOT EXISTS s(id INTEGER PRIMARY KEY)"\n${two}${count}fn handle(raw: View, db: Sql) -> Response {\n  empty(status: 200)\n}\n`,
  ),
  ['C53:1'],
);
const [msg] = compile([
  ...std,
  { name: 'program.tape', text: one(c, "UPDATE c SET n = n + 1 WHERE name = 'a'") },
]).errors;
T(
  'the error says what a retry does and how to fix it',
  [/applied twice|twice/.test(msg?.message ?? ''), msg?.hint?.includes('`repeat: True`')],
  [true, true],
);

// ---- 2. the programs of this repository before the rules (234f21e), refused; and as they are now, accepted. C69 in
// ledger and tickets is sql.ts's: a TEXT PRIMARY KEY of a rowid table may hold NULL, read into a View field (the
// programs now declare it NOT NULL)
const before = {
  'examples_bump.tape': ['C55:51', 'C84:65', 'C84:66'],
  'examples_counter.tape': ['C54:12'],
  'examples_fulfillment.tape': ['C55:116', 'C87:170', 'C87:177', 'C54:196'],
  'examples_hello.tape': ['C54:8'],
  'examples_kv.tape': ['C54:281', 'C74:281', 'C74:283'],
  'examples_ledger.tape': ['C69:15', 'C54:22', 'C54:29'],
  'examples_orders.tape': ['C55:30', 'C84:46'],
  'examples_ratelimit.tape': ['C54:12'],
  'examples_tickets.tape': ['C69:33', 'C54:49', 'C55:50', 'C74:67', 'C84:68'],
  'examples_todo-decode.tape': ['C14:55'],
  'examples_todo-handparsed.tape': ['C15:118'],
  'examples_todo.tape': ['C55:91'],
  'examples_tools_ledger.tape': [],
  'examples_trap.tape': ['C55:5'],
  'service_verify_notes-v1.tape': ['C55:7'],
  'service_verify_notes-v2-edited.tape': ['C55:11'],
  'service_verify_notes-v2.tape': ['C55:11'],
  'service_verify_notes-v3-rename.tape': ['C51:8', 'C55:14'],
  'service_verify_notes-v3.tape': ['C55:14'],
};
for (const [f, want] of Object.entries(before)) {
  const now = f
    .replace(/^examples_tools_/, 'examples/tools/')
    .replace(/^examples_/, 'examples/')
    .replace(/^service_verify_/, 'service/verify/');
  T(
    `before the rules ${now}: ${want.join(' ') || 'compiles (its hazard is in its meaning: see section 3)'}`,
    codes(portErrors(portWith(portJson(portKeys(read(`experiments/lang/before/${f}`)))))),
    want,
  ); // keys were Ints then, and a call's error text (port-keys.ts)
  T(`now ${now}: compiles`, codes(read(now)), now.endsWith('notes-v3-rename.tape') ? ['C51:8'] : []); // a fixture of a removal that must be a contract
}

// ---- 3. retried with the same key, each fixed program does its work once
const app = (file: string, services: Record<string, Service> = {}, name = file) => {
  const r = built(read(file));
  const sql = nodeSql();
  const a = instantiate(moduleOf(r), { sql, name, services });
  const run = async (head: string, body = ''): Promise<string> =>
    answered((await a.runLogged(enc.encode(`${head}\n${body}`), { transaction: f => sql.transaction(f) })).out);
  /** The one number a count(*) or a single-column query gives. */
  const first = (query: string, column: string): unknown => sql.exec(query).toArray()[0]?.[column];
  return { run, sql, a, r, first };
};
type Running = ReturnType<typeof app>;
const status = (s: string): string | undefined => s.split('\n')[0]?.split(' ')[0];
const json = (s: string): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(s.split('\n').slice(1).join('\n'));
  return typeof parsed === 'object' && parsed !== null ? Object.fromEntries(Object.entries(parsed)) : {};
};
/** One program served to another. */
const served =
  (to: Running): Service =>
  (bytes, o) =>
    to.a.serve(o, bytes, { transaction: f => to.sql.transaction(f) });
{
  const pay = app('examples/payments.tape');
  const box = app('examples/tickets.tape', { payments: served(pay) }, 'tickets');
  const buy = JSON.stringify({ key: 'k1', section: 'balcony', qty: 2, card: 'ann-4242' });
  const a = await box.run('POST /buy', buy),
    b = await box.run('POST /buy', buy);
  T(
    'tickets: /buy twice with one key: one sale, seats taken once, charged once, the same ticket answered',
    [
      status(a),
      status(b),
      json(a).id === json(b).id,
      box.first('SELECT count(*) AS n FROM sales', 'n'),
      box.first("SELECT seats FROM sections WHERE name = 'balcony'", 'seats'),
      pay.first("SELECT balance FROM cards WHERE card = 'ann-4242'", 'balance'),
    ],
    ['201', '201', true, 1, 8, 210],
  );
  T(
    'tickets: the key for another purchase is 422; no key is 400',
    [
      status(await box.run('POST /buy', JSON.stringify({ key: 'k1', section: 'balcony', qty: 1, card: 'ann-4242' }))),
      status(await box.run('POST /buy', '{"section":"balcony","qty":1,"card":"ann-4242"}')),
    ],
    ['422', '400'],
  );
}
{
  let charges = 0,
    reserves = 0;
  const f = app(
    'examples/fulfillment.tape',
    {
      inventory: (_b, { method }) => {
        if (method === 'reserve') reserves++;
        return enc.encode(method === 'reserve' ? '{"price":40,"remaining":4}' : '{"remaining":5}');
      },
      payments: () => {
        charges++;
        return enc.encode('{"balance":260}');
      },
      shipping: () => enc.encode('{"label":7}'),
    },
    'fulfill',
  );
  const o = JSON.stringify({ key: 'o1', sku: 'lamp', qty: 1, card: 'ann-4242', address: '1 Main St' });
  const a = await f.run('POST /orders', o),
    b = await f.run('POST /orders', o);
  T(
    'fulfillment: POST /orders twice with one key: one order, reserved once, charged once',
    [status(a), status(b), json(a).id, json(b).id, f.first('SELECT count(*) AS n FROM orders', 'n'), reserves, charges],
    ['201', '201', 1, 1, 1, 1, 1],
  );
  T(
    'fulfillment: the key for another order is 422; no key is 400',
    [
      status(
        await f.run(
          'POST /orders',
          JSON.stringify({ key: 'o1', sku: 'lamp', qty: 2, card: 'ann-4242', address: '1 Main St' }),
        ),
      ),
      status(await f.run('POST /orders', '{"sku":"lamp","qty":1,"card":"ann-4242","address":"1 Main St"}')),
    ],
    ['422', '400'],
  );
}
{
  let reserves = 0;
  const o = app(
    'examples/orders.tape',
    {
      stock: () => {
        reserves++;
        return enc.encode('{"item":"lamp","remaining":4}');
      },
    },
    'orders',
  );
  const body = '{"key":"o-1","item":"lamp"}',
    a = await o.run('POST /orders', body),
    b = await o.run('POST /orders', body);
  T(
    'orders: POST /orders twice with one key: one order, one reservation',
    [status(a), status(b), o.first('SELECT count(*) AS n FROM orders', 'n'), reserves],
    ['201', '200', 1, 1],
  );
  T(
    'orders: the key for another item is 422',
    status(await o.run('POST /orders', '{"key":"o-1","item":"desk"}')),
    '422',
  );
}
{
  const l = app('examples/ledger.tape'),
    t = '{"key":"t1","from":"alice","to":"bob","amount":30}';
  const a = await l.run('POST /transfers', t),
    b = await l.run('POST /transfers', t);
  T(
    'ledger: a transfer sent twice with one key moves the money once, and answers as the first did',
    [
      status(a),
      status(b),
      l.sql
        .exec('SELECT name, balance FROM accounts ORDER BY name')
        .toArray()
        .map(row => row.balance),
    ],
    ['200', '200', [70, 50]],
  );
  T(
    'ledger: the key for another transfer is 422',
    status(await l.run('POST /transfers', '{"key":"t1","from":"alice","to":"bob","amount":31}')),
    '422',
  );
}
for (const file of ['examples/todo.tape', 'examples/todo-decode.tape', 'examples/todo-handparsed.tape']) {
  const t = app(file),
    body = '{"key":"a","title":"milk"}',
    a = await t.run('POST /todos', body),
    b = await t.run('POST /todos', body);
  T(
    `${file}: POST /todos twice with one key: one todo, the second answered 200 with it; no key is 400`,
    [
      status(a),
      status(b),
      json(a).id === json(b).id,
      t.first('SELECT count(*) AS n FROM todos', 'n'),
      status(await t.run('POST /todos', '{"title":"milk"}')),
    ],
    ['201', '200', true, 1, '400'],
  );
}
{
  const k = app('examples/counter.tape');
  T(
    'counter: the same op id twice adds once; another adds again; no op id is 428',
    [
      await k.run('POST /a?op=x'),
      await k.run('POST /a?op=x'),
      await k.run('POST /a?op=y'),
      status(await k.run('POST /a')),
    ].map((s, i) => (i < 3 ? json(s ?? '').count : s)),
    [1, 1, 2, '428'],
  );
}
{
  const n = app('service/verify/notes-v1.tape');
  T(
    'notes v1: POST /notes/<id> twice is one note; POST /notes without an id is 428',
    [
      status(await n.run('POST /notes/1', 'milk')),
      status(await n.run('POST /notes/1', 'milk')),
      (await n.run('GET /notes')).split('\n')[1],
      status(await n.run('POST /notes', 'eggs')),
    ],
    ['200', '200', '1', '428'],
  );
}
{
  const kv = app('examples/kv.tape');
  await kv.run('PUT /placement/0?shards=1');
  T(
    'kv: an unconditional PUT without ?op= is 428 and writes nothing (R7); with one, a retry is applied once',
    [
      status(await kv.run('PUT /k/a', 'x')),
      status(await kv.run('GET /k/a')),
      await kv.run(`PUT /k/a?op=${NOW}_w1`, 'x'),
      await kv.run(`PUT /k/a?op=${NOW}_w1`, 'x'),
      json(await kv.run('GET /k/a')).version,
    ],
    ['428', '404', '201\n{"key":"a","version":1}', '201\n{"key":"a","version":1}', 1],
  );
}
{
  // the tool's once key was the amount: two payments of one amount were one charge, and a timeout said "not charged"
  const charged: (string | null)[] = [];
  const r = built(read('examples/tools/ledger.tape')),
    sql = nodeSql();
  let timeout = true;
  const a = instantiate(new WebAssembly.Module(r.wasm), {
    sql,
    name: 'ledger',
    services: {
      payments: (_b, o) => {
        charged.push(o.key);
        if (timeout) throw new TimedOut();
        return enc.encode('{"balance":1}');
      },
    },
  });
  const m = r.methods.find(x => x.name === 'pay'),
    pay = async (x: unknown): Promise<[string, string]> => {
      const y = await a.serve({ method: 'pay', fingerprint: m?.fingerprint ?? '' }, enc.encode(JSON.stringify(x)), {
        transaction: f => sql.transaction(f),
      });
      return [y.status, dec.decode(y.body)];
    };
  const t = await pay({ key: 1, card: 'c', amount: 5 });
  T(
    'tools/ledger: a charge that timed out is an unknown outcome, never "not charged"',
    [t[0], t[1].startsWith('{"Unknown":'), t[1].includes('NotCharged')],
    ['rejected', true, false],
  );
  timeout = false;
  await pay({ key: 2, card: 'c', amount: 5 });
  T(
    'tools/ledger: two payments of one amount are two charges, each under its own key',
    charged.map(k => k?.split('/').pop()),
    ['{"key":1}', '{"key":2}'],
  );
}

// ---- 4. the rules' table model (a regex reading of the schema) agrees with SQLite's for every program
{
  const corpus = [
    ...readdirSync(here('examples'))
      .filter(f => f.endsWith('.tape'))
      .map(f => `examples/${f}`),
    ...readdirSync(here('examples/tools')).map(f => `examples/tools/${f}`),
    ...readdirSync(here('service/verify'))
      .filter(f => f.endsWith('.tape'))
      .map(f => `service/verify/${f}`),
    ...readdirSync(here('experiments/lang/before')).map(f => `experiments/lang/before/${f}`),
  ];
  let compared = 0;
  const wrong = [];
  for (const f of corpus) {
    let prog;
    try {
      prog = parseProgram([...std, { name: f, text: read(f) }]);
    } catch {
      continue;
    }
    const model = tablesOf(prog);
    if (model.size === 0) continue;
    const db = new DatabaseSync(':memory:');
    try {
      for (const s of [...prog.schema, ...prog.migrations.flatMap(m => m.statements)]) db.exec(s);
    } catch (e) {
      wrong.push(`${f}: SQLite refused its schema: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    for (const [t, m] of model) {
      const cols = db
        .prepare(`SELECT name, pk, dflt_value FROM pragma_table_info(?)`)
        .all(t)
        .map(col => ({
          name: String(col['name']),
          pk: Number(col['pk']),
          dflt: typeof col['dflt_value'] === 'string' ? col['dflt_value'] : null,
        }));
      if (cols.length === 0) {
        wrong.push(`${f}: the model has ${t}, SQLite has no such table`);
        continue;
      }
      const real = cols.map(col => col.name).toSorted(),
        pk = cols
          .filter(col => col.pk > 0)
          .toSorted((x, y) => x.pk - y.pk)
          .map(col => col.name);
      const unique = db
        .prepare(`SELECT name, "unique", origin, partial FROM pragma_index_list(?)`)
        .all(t)
        .filter(i => Number(i['unique']) > 0 && Number(i['partial']) === 0)
        .map(i =>
          db
            .prepare('SELECT name FROM pragma_index_info(?)')
            .all(String(i['name']))
            .map(col => col['name']),
        )
        .flatMap(cs => (cs.every(col => typeof col === 'string') ? [cs.map(String)] : []));
      const keys = [...(pk.length > 0 ? [pk] : []), ...unique].map(k => k.toSorted().join(',')),
        mk = [...(m.pk.length > 0 ? [m.pk] : []), ...m.uniques].map(k => k.toSorted().join(','));
      if (JSON.stringify([...m.cols].toSorted()) !== JSON.stringify(real))
        wrong.push(`${f}: ${t} columns: model ${[...m.cols].toSorted().join(',')} SQLite ${real.join(',')}`);
      else if (JSON.stringify([...new Set(mk)].toSorted()) !== JSON.stringify([...new Set(keys)].toSorted()))
        wrong.push(`${f}: ${t} unique keys: model ${JSON.stringify(mk)} SQLite ${JSON.stringify(keys)}`);
      else if (cols.some(col => typeof m.defaults[col.name] === 'string' && m.defaults[col.name] !== col.dflt))
        wrong.push(
          `${f}: ${t} defaults: model ${JSON.stringify(m.defaults)} SQLite ${JSON.stringify(cols.map(col => [col.name, col.dflt]))}`,
        );
      else if (cols.some(col => col.dflt !== null && /^'.*'$/.test(col.dflt) && m.defaults[col.name] === undefined))
        wrong.push(`${f}: ${t}: SQLite has a text DEFAULT the model missed`);
      else compared++;
    }
  }
  T(`the table model agrees with SQLite on columns, unique keys and DEFAULTs (${compared} tables)`, wrong, []);
}

// ---- a statement the checker cannot read is C67, and only that: the rules that depend on it wait. A write
// guarded by an op id recorded with a statement that does not parse (`AS from`, a keyword, unquoted) was C54 too,
// and a migration that did not build gave C54 and C73 on a write that is fine.
{
  const opGuarded = (alias: string, end = ';') => `migration 1 "accounts" {
  CREATE TABLE accounts(name TEXT PRIMARY KEY NOT NULL, balance INTEGER NOT NULL)${end}
  CREATE TABLE ops(op TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL)${end}
}

fn handle(raw: View, db: Sql) -> Response {
  let n = sql_exec(
    query: "UPDATE accounts SET balance = balance - :amount WHERE name = :who AND balance >= :amount \\
        AND NOT EXISTS (SELECT 1 FROM ops WHERE op = :op AND name = :who)",
    amount: 5,
    who: "ann",
    op: "o1"
  )
  let m = sql_exec(
    query: "INSERT INTO ops(op, name) SELECT :op, a.name AS ${alias} FROM accounts AS a WHERE a.name = :who \\
        ON CONFLICT(op) DO NOTHING",
    op: "o1",
    who: "ann"
  )
  buf() |> write_int(value: n + m) |> respond(status: 200)
}
`;
  T('the op-id write quoted: nothing refused', codes(opGuarded('\\"from\\"')), []);
  T(
    'the op-id write with a keyword for an alias: C67 on it, and no C54 on the write it guards',
    codes(opGuarded('from')),
    ['C67:14'],
  );
  T('a migration that does not build: C67, and no C54 or C73 on the writes', codes(opGuarded('\\"from\\"', '')), [
    'C67:1',
  ]);
}

finish();
