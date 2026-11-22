// test/remotes.ts: programs unlike the plain request handlers. webhook.tape: crypto and outbound HTTP as Remotes.
// tickets.tape and payments.tape: a with chain, a keyed call, and a callee traced from its own log.
// git.tape: byte layouts, checked against git itself.
import '../node25.ts';
import { readFileSync, mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from '../compiler.ts';
import { instantiate, isCall, isHead, isSql, migrate, replay, spans, traceOf } from '../host.ts';
import type { Effect, Service } from '../host.ts';
import { checkQueries } from '../check.ts';
import { nodeSql } from '../nodesql.ts';
import { std } from '../std.ts';
import type { Built, Options, Source } from '../compiler.ts';
import { built, finish, moduleOf, problems, read, same as T, sleep } from './harness.ts';
const src = (n: string): Source => ({ name: n, text: read(n) });
const build = (n: string, options: Partial<Options> = {}): Built => built([src(`examples/${n}.tape`)], options);
const enc = new TextEncoder(),
  dec = new TextDecoder(),
  text = (b: Uint8Array): string => dec.decode(b);
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** A message to the signer: the body and its signature. */
const signed = (message: string): { body: string; signature: string } => {
  const parsed: unknown = JSON.parse(message);
  const m: Record<string, unknown> =
    typeof parsed === 'object' && parsed !== null ? Object.fromEntries(Object.entries(parsed)) : {};
  return { body: String(m.body), signature: String(m.signature) };
};

// ---- tickets: seats held in SQL, the card charged by the payments object; every failure is a status
{
  const tk = build('tickets'),
    pay = build('payments'),
    logs: Effect[][] = [];
  const payApp = instantiate(new WebAssembly.Module(pay.wasm), {
    sql: nodeSql(),
    name: 'payments',
    sink: l => {
      logs.push(l);
    },
  });
  const module = new WebAssembly.Module(tk.wasm),
    app = instantiate(module, {
      sql: nodeSql(),
      name: 'box-office',
      sink: l => {
        logs.push(l);
      },
      services: { payments: (b, m) => payApp.serve(m, b) },
    });
  let keys = 0;
  const buy = async (section: string, qty: number, card: string, key = `k${++keys}`) => {
    const req = enc.encode(`POST /buy\n{"key":"${key}","section":"${section}","qty":${qty},"card":"${card}"}`),
      ran = await app.runLogged(req);
    return { req, out: text(ran.out), log: ran.effects };
  };
  const paid = await buy('floor', 2, 'ann-4242');
  T(
    'tickets: paid',
    paid.out.replace(/"code":\d+/, '"code":0'),
    '201\n{"id":1,"section":"floor","qty":2,"amount":240,"code":0}',
  );
  T(
    'tickets: the log is price, seats, dice, clock, insert, charge, paid',
    paid.log.slice(1).map(e => (isCall(e) ? 'call' : 'now' in e ? 'now' : 'random' in e ? 'random' : 'sql')),
    ['sql', 'sql', 'random', 'now', 'sql', 'call', 'sql'],
  );
  T('tickets: replay gives the same bytes, code and all', text(replay(module, paid.req, paid.log)), paid.out);
  T(
    'tickets: declined, and the hold undone',
    (await buy('balcony', 2, 'bob-0001')).out,
    '402\n{"error":"card declined: not enough funds"}',
  );
  T(
    'tickets: sold out',
    (await buy('floor', 2, 'ann-4242')).out,
    '409\n{"error":"not enough seats left in that section"}',
  );
  T('tickets: over the flag', (await buy('balcony', 9, 'ann-4242')).out, '400\n{"error":"qty: not a valid Qty"}');
  app.setFlags({ max_per_order: 10 });
  T(
    'tickets: the flag raised, the card is the limit',
    (await buy('balcony', 9, 'ann-4242')).out,
    '402\n{"error":"card declined: not enough funds"}',
  );
  T(
    'tickets: sales per section',
    text(await app.run(enc.encode('GET /sales\n'))),
    '200\n{"floor":{"seats":2,"revenue":240}}',
  );
  const charge = logs.find(l => l[0] !== undefined && isHead(l[0]) && l[0].method === 'charge') ?? [],
    [root] = spans(logs);
  T(
    'tickets: the charge traces from its own log',
    traceOf(new WebAssembly.Module(build('payments', { trace: true }).wasm), null, charge).error,
    null,
  );
  T(
    'tickets: one trace, two spans',
    [root?.name, root?.children.map(c => `${c.name}.${c.method}`)],
    ['box-office', ['payments.charge']],
  );
}

// ---- tickets: a charge that times out, then a retry with the same key: payments answers from its stored reply
{
  const tk = build('tickets'),
    pay = build('payments'),
    sql = nodeSql();
  const payApp = instantiate(new WebAssembly.Module(pay.wasm), { sql, name: 'payments' });
  let slow = true; // the first charge runs, and its answer arrives after the caller's 50 ms budget
  const app = instantiate(new WebAssembly.Module(tk.wasm), {
    sql: nodeSql(),
    name: 'box-office',
    services: {
      payments: async (b, m) => {
        const r = await payApp.serve(m, b);
        if (slow) await sleep(80);
        return r;
      },
    },
  });
  const run = async (r: string) => text(await app.run(enc.encode(r)));
  const balance = () => sql.exec("SELECT balance FROM cards WHERE card = 'ann-4242'").toArray()[0]?.balance;
  T(
    'retry: the first attempt times out, the seats stay held',
    await run('POST /buy\n{"key":"r1","section":"balcony","qty":2,"card":"ann-4242"}'),
    '504\n{"error":"payments did not answer in time; the seats stay held"}',
  );
  T('retry: payments did charge, once', balance(), 300 - 90);
  slow = false;
  T(
    'retry: the same key gets the stored reply: paid',
    (await run('POST /retry/1\n')).replace(/"code":\d+/, '"code":0'),
    '201\n{"id":1,"section":"balcony","qty":2,"amount":90,"code":0}',
  );
  T('retry: and nothing is charged twice', balance(), 300 - 90);
  T(
    'retry: a settled sale is not pending any more',
    await run('POST /retry/1\n'),
    '404\n{"error":"no such pending sale"}',
  );
}

// ---- migrations: one database, programs that migrate it forward, append-only
{
  const v1src = `migration 1 "notes" {
  CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT NOT NULL UNIQUE)
}
type Note { Note(id: Int) }
fn handle(raw: View, db: Sql) -> Buf {
  saved(found: sql_first(db, row: Note, query: "INSERT INTO notes(body) VALUES (:raw) RETURNING id", raw))
}
fn saved(found: Option[Note]) -> Buf {
  match found {
    Some(value: Note(id)) -> write_int(out: buf(), value: id)
    None -> buf()
  }
}
`;
  const v2src = v1src
    .replace(
      'type Note',
      `migration 2 "pins" {
  ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX notes_pinned ON notes(pinned)
}
type Note`,
    )
    .replace(
      'INSERT INTO notes(body) VALUES (:raw) RETURNING id',
      'INSERT INTO notes(body, pinned) VALUES (:raw, 1) RETURNING id',
    );
  const mk = (program: string): Built => built([{ name: 'notes.tape', text: program }]),
    m = (r: Built): WebAssembly.Module => moduleOf(r);
  const v1 = mk(v1src),
    v2 = mk(v2src),
    sql = nodeSql();
  const a1 = instantiate(m(v1), { sql });
  T(
    'migrations: the first program applies its one',
    a1.migrated.map(x => [x.migrate, x.name]),
    [[1, 'notes']],
  );
  a1.handle(enc.encode('first'));
  const a2 = instantiate(m(v2), { sql });
  T(
    'migrations: the next applies only what is new',
    a2.migrated.map(x => [x.migrate, x.statements.length]),
    [[2, 2]],
  );
  T(
    'migrations: the data is still there, and the new column is used',
    [text(a2.handle(enc.encode('second'))), sql.exec('SELECT body, pinned FROM notes ORDER BY id').toArray()],
    [
      '2',
      [
        { body: 'first', pinned: 0 },
        { body: 'second', pinned: 1 },
      ],
    ],
  );
  T(
    'migrations: the older program still runs on the expanded table',
    [instantiate(m(v1), { sql }).migrated.length, text(a1.handle(enc.encode('third')))],
    [0, '3'],
  );
  T(
    'migrations: each recorded once, with its hash',
    sql
      .exec('SELECT version, name, hash FROM schema_migrations ORDER BY version')
      .toArray()
      .map(r => [r.version, r.name, r.hash]),
    v2.migrations.map(x => [x.n, x.name, x.hash]),
  );
  const edited = mk(v2src.replace('body TEXT NOT NULL UNIQUE)', 'body TEXT NOT NULL UNIQUE, extra TEXT)'));
  let refused: string | null = null;
  try {
    instantiate(m(edited), { sql });
  } catch (e) {
    refused = messageOf(e)
      .replaceAll(/hash \w+/g, 'hash …')
      .replace(/is \w+\./, 'is ….');
  }
  T(
    'migrations: an applied migration edited afterwards is refused, and nothing runs',
    [refused, sql.exec("SELECT count(*) AS n FROM sqlite_master WHERE name = 'notes_pinned'").toArray()[0]?.n],
    [
      'migration 1 "notes" diverged: it ran with hash …, this program\'s is …. Applied migrations are append-only: add a new one instead of editing it.',
      1,
    ],
  );
  // the query reads notes.pinned, which only migration 2 adds: without it the compiler refuses the query (sql.ts,
  // C68), before check.ts would; with it, SQLite's own prepare finds nothing either
  T(
    "migrations: the queries are checked at the program's own chain point",
    [
      problems([{ name: 'notes.tape', text: v2src.replace(/migration 2[^}]*}\n/, '') }]).map(e => e.code),
      checkQueries(v2).length,
    ],
    [['C68'], 0],
  );
  {
    // whether a migration removes something is judged by what it did to the tables, however it is written. The
    // compiler refuses a migration that is not a contract unless it only adds (rules.ts, C51), so these chains are
    // compiled as contracts and then marked as expansions: what an older compiler, or a hand-made upload, could send
    const removing = (body: string, contract = false): Built => {
      const r = mk(
        `${v2src.slice(0, v2src.indexOf('type Note'))}migration 3 "tidy" contract {\n  ${body}\n}\nfn handle(raw: View, db: Sql) -> Buf {\n  buf()\n}\n`,
      );
      return contract ? r : { ...r, migrations: r.migrations.map(x => (x.n === 3 ? { ...x, contract: false } : x)) };
    };
    const tryRun = (r: Built): unknown => {
      try {
        return migrate(sql, r.migrations).map(x => [x.migrate, x.removed ?? []]);
      } catch (e) {
        return messageOf(e).split(',')[0];
      }
    };
    const indexes = () => sql.exec("SELECT count(*) AS n FROM sqlite_master WHERE name = 'notes_kept'").toArray()[0]?.n;
    T(
      'migrations: the compiler refuses a removal that does not say contract (C51), however it is written',
      [
        'DROP TABLE notes',
        'ALTER TABLE main . notes RENAME COLUMN body TO text',
        "DELETE FROM notes WHERE body = 'x'",
      ].map(
        b =>
          problems([
            { name: 'notes.tape', text: v2src.replace('type Note', `migration 3 "tidy" {\n  ${b}\n}\ntype Note`) },
          ])[0]?.code,
      ),
      ['C51', 'C51', 'C51'],
    );
    T(
      'migrations: a removal that does not say contract is refused when it runs, and nothing of it stays',
      [
        tryRun(
          removing('CREATE INDEX notes_kept ON notes(body);\n  ALTER TABLE main . notes RENAME COLUMN body TO text'),
        ),
        indexes(),
      ],
      ['migration 3 "tidy" removes notes.body', 0],
    );
    T(
      'migrations: so is a table rebuilt without a column',
      tryRun(
        removing(
          'CREATE TABLE notes2(id INTEGER PRIMARY KEY, pinned INTEGER);\n  INSERT INTO notes2 SELECT id, pinned FROM notes;\n  DROP TABLE notes;\n  ALTER TABLE notes2 RENAME TO notes',
        ),
      ),
      'migration 3 "tidy" removes notes.body',
    );
    T(
      'migrations: deleting rows changes no shape, so it is not a removal',
      tryRun(removing("DELETE FROM notes WHERE body = 'nothing'")),
      [[3, []]],
    );
    sql.exec('DELETE FROM schema_migrations WHERE version = 3');
    T(
      'migrations: a contract may remove, and says what it removed',
      tryRun(removing('DROP INDEX notes_pinned;\n  ALTER TABLE notes DROP COLUMN pinned', true)),
      [[3, ['notes.pinned']]],
    );
  }
  T('migrations: migrate itself, again: nothing to do', migrate(sql, v2.migrations), []);
}

// ---- tape.ts, the command line: compile, run, effect log, trace
{
  const cli = (args: string) =>
    execSync(`"${process.execPath}" tape.ts ${args}`, { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  const out = cli(`examples/counter.tape 'POST /visits?op=1' 'POST /visits?op=2'`);
  T(
    'cli: responses, logs and traces',
    [
      out.includes('← 200 ⏎ {"count":2}'),
      out.includes('sql     INSERT INTO counters'),
      /✓ +\d+  Request\(method: "POST"/.test(out),
    ],
    [true, true, true],
  );
}

// ---- webhook: the signer is WebCrypto, the api stands in for fetch
{
  const r = build('webhook'),
    module = new WebAssembly.Module(r.wasm);
  const key = await crypto.subtle.importKey('raw', enc.encode('secret'), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
  const hexOf = (b: ArrayBuffer) => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
  const sign = async (body: string) => hexOf(await crypto.subtle.sign('HMAC', key, enc.encode(body)));
  const sent: unknown[] = [],
    seenKeys = new Map<string | null, number>();
  const services: Record<string, Service> = {
    signer: async b => {
      const { body, signature } = signed(text(b));
      const sig = Uint8Array.from(signature.match(/../g)?.map(h => Number.parseInt(h, 16)) ?? []);
      return enc.encode(JSON.stringify({ valid: await crypto.subtle.verify('HMAC', key, sig, enc.encode(body)) }));
    },
    api: (b, { key: once }) => {
      if (!seenKeys.has(once)) {
        const message: unknown = JSON.parse(text(b));
        sent.push(message);
        seenKeys.set(once, 202);
      }
      return enc.encode(JSON.stringify({ status: seenKeys.get(once) }));
    }, // in a Worker: fetch(...)
  };
  const app = instantiate(module, { services, name: 'hooks' });
  const hook = async (body: string, sig?: string) => {
    const req = enc.encode(`POST /hook?sig=${sig ?? (await sign(body))}\n${body}`);
    const ran = await app.runLogged(req);
    return { req, out: text(ran.out), log: ran.effects };
  };
  const body = '{"id":42,"kind":"invoice.paid"}';
  const ok = await hook(body);
  T(
    'webhook: verified and forwarded',
    [ok.out, sent],
    ['200\n{"delivered":202}', [{ event: 42, text: 'invoice.paid' }]],
  );
  T(
    'webhook: log is verify then notify',
    ok.log.filter(isCall).map(e => [e.call, e.method, e.status, 'once' in e]),
    [
      ['signer', 'verify', 'ok', false],
      ['api', 'notify', 'ok', true],
    ],
  );
  T('webhook: replay needs no crypto and no network', text(replay(module, ok.req, ok.log)), ok.out);
  T('webhook: delivered twice, notified once', [(await hook(body)).out, sent.length], ['200\n{"delivered":202}', 1]);
  T(
    'webhook: bad signature stops before the api',
    [(await hook(body, '00'.repeat(32))).out, sent.length],
    ['401\n{"error":"bad signature"}', 1],
  );
  T(
    'webhook: valid signature, wrong shape',
    (await hook('{"id":"x"}')).out,
    '400\n{"error":"id: expected a whole number"}',
  );
  T('webhook: no signature', text(await app.run(enc.encode('POST /hook\n{}'))), '401\n{"error":"missing signature"}');
}

// ---- git: every object of a real repository, compared with what git says
{
  const r = build('git'),
    app = instantiate(new WebAssembly.Module(r.wasm), { log: false });
  const dir = mkdtempSync(join(tmpdir(), 'tape-git-')),
    git = (c: string) =>
      execSync(`git -C ${dir} -c user.name=T -c user.email=t@example.com -c commit.gpgsign=false ${c}`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
  git('init -q');
  writeFileSync(join(dir, 'a.txt'), 'hello\n');
  writeFileSync(join(dir, 'b "quoted".txt'), 'x'.repeat(300));
  execSync(`mkdir ${join(dir, 'sub')}`);
  writeFileSync(join(dir, 'sub', 'c.bin'), Buffer.from([0, 1, 2, 255]));
  git('add -A');
  git('commit -q -m "first commit"');
  writeFileSync(join(dir, 'a.txt'), 'hello again\n');
  git('add -A');
  git('commit -q -m "second: with a parent"');
  const kinds: Record<string, number> = { blob: 0, tree: 0, commit: 0 };
  let wrong = 0;
  for (const d of readdirSync(join(dir, '.git/objects')).filter(x => x.length === 2))
    for (const f of readdirSync(join(dir, '.git/objects', d))) {
      const id = d + f,
        raw = inflateSync(readFileSync(join(dir, '.git/objects', d, f))),
        got: unknown = JSON.parse(text(app.handle(raw))),
        kind = git(`cat-file -t ${id}`).trim();
      kinds[kind] = (kinds[kind] ?? 0) + 1;
      let want: unknown = null;
      if (kind === 'blob') want = { kind, size: Number(git(`cat-file -s ${id}`)) };
      else if (kind === 'tree')
        want = {
          kind,
          entries: git(`ls-tree -z ${id}`)
            .split('\0')
            .filter(Boolean)
            .map(l => {
              const [meta = '', name] = l.split('\t'),
                [mode, , oid] = meta.split(' ');
              return { mode: String(Number(mode)), name, id: oid };
            }),
        };
      else {
        const p = git(`cat-file -p ${id}`),
          lines = p.split('\n');
        want = {
          kind,
          tree: lines[0]?.slice(5),
          author: lines
            .find(l => l.startsWith('author '))
            ?.slice(7)
            .split('<')[0],
          parents: lines.filter(l => l.startsWith('parent ')).length,
          subject: p.split('\n\n')[1]?.split('\n')[0],
        };
      }
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        wrong++;
        console.log('DIFF', id, JSON.stringify(got), JSON.stringify(want));
      }
    }
  T(
    'git: every object agrees with git',
    [wrong, (kinds.blob ?? 0) >= 4, (kinds.tree ?? 0) >= 3, kinds.commit],
    [0, true, true, 2],
  );
  T('git: bad header', text(app.handle(enc.encode('blub 3\0abc'))), '{"error":"not a git object header"}');
  T(
    'git: wrong size',
    text(app.handle(enc.encode('blob 4\0abc'))),
    '{"error":"the size in the header is not the payload\'s length"}',
  );
  T(
    'git: truncated tree entry is an error, not a trap',
    text(app.handle(enc.encode('tree 12\u0000100644 a\u0000abc'))),
    '{"kind":"tree","entries":[{"error":"truncated entry"}]}',
  );
  console.log(`(webhook.tape and git.tape: ${build('webhook').wasm.length} and ${r.wasm.length} bytes)`);
}

// ---- rollback(out): the response is sent and the request's writes are undone
{
  const again = replay;
  const r = build('ledger'),
    module = new WebAssembly.Module(r.wasm),
    sql = nodeSql(),
    app = instantiate(module, { sql });
  const go = (s: string) => text(app.handleIn(f => sql.transaction(f), enc.encode(s))),
    balances = () => go('GET /accounts\n');
  T(
    'ledger: a transfer moves money',
    [go('POST /transfers\n{"key":"t1","from":"alice","to":"bob","amount":30}'), balances()],
    ['200\n{"moved":true}', '200\n[{"name":"alice","balance":70},{"name":"bob","balance":50}]'],
  );
  const lost = go('POST /transfers\n{"key":"t2","from":"alice","to":"carol","amount":5}'),
    log = app.effects;
  T(
    'ledger: no payee: the debit is undone and the answer still sent',
    [lost, balances()],
    ['404\n{"error":"no such payee"}', '200\n[{"name":"alice","balance":70},{"name":"bob","balance":50}]'],
  );
  T(
    'ledger: the log shows what was tried, marked undone: no earlier transfer with this key, the debit, no credit',
    [log[0] !== undefined && isHead(log[0]) && log[0].undone, log.slice(1).map(e => (isSql(e) ? e.r : undefined))],
    [true, [null, 1, 0]],
  );
  T(
    'ledger: each write the rollback undid is marked undone in the log; the read before them is not',
    log.slice(1).map(e => (isSql(e) ? e.undone === true : undefined)),
    [false, true, true],
  );
  T(
    'ledger: the undone request replays',
    text(again(module, enc.encode('POST /transfers\n{"key":"t2","from":"alice","to":"carol","amount":5}'), log)),
    lost,
  );
  T(
    'ledger: without a transaction the host refuses to pretend',
    (() => {
      try {
        app.handle(enc.encode('POST /transfers\n{"key":"t3","from":"alice","to":"carol","amount":5}'));
        return 'ran';
      } catch (e) {
        return e instanceof Error ? e.constructor.name : 'not an error';
      }
    })(),
    'Undo',
  );
  sql.exec("UPDATE accounts SET balance = 70 WHERE name = 'alice'");
}
// ---- the compiler declares every import its code uses
{
  const only = (mk: string) => {
    try {
      const { wasm } = compile([...std, { name: 'p.tape', text: mk }]);
      if (wasm === null) return 'refused';
      void new WebAssembly.Module(wasm);
      return 'valid';
    } catch (e) {
      return messageOf(e).split(':').at(-1)?.trim();
    }
  };
  // a call's reply is decoded from JSON: the json import is needed even when the program never says decode
  T(
    'imports: a program whose only JSON is a call reply validates',
    only(
      `type Ping { Ping(n: Int) }\ntype Pong { Pong(n: Int) }\nfn handle(raw: View, db: Sql, pong: Remote) -> Buf {\n  answer(reply: call(to: pong, method: "ping", send: Ping(n: 1), reply: Pong, within: 5000, once: raw))\n}\nfn answer(reply: Result[Pong, CallError]) -> Buf {\n  match reply {\n    Ok(value) -> respond(status: 200)\n    Err(error) -> respond(status: 504)\n  }\n}\n`,
    ),
    'valid',
  );
}
// ---- exported functions: a name std also defines, and the JSON Schemas for tool manifests
{
  const r = compile([
    ...std,
    {
      name: 'program.tape',
      text: 'type K = View where len(self) >= 1 and len(self) <= 8\ntype N = Int where self >= 0 and self <= 9\ntype In { In(key: K, n: Option[N], on: Bool) }\ntype Out { Out(key: View) }\nexport fn put(message: In) -> Result[Out, View] {\n  Ok(value: Out(key: message.key))\n}\n',
    },
  ]);
  // put is also std's map put: the export keeps its own name, and the module is valid
  T(
    'exports: a function named like a std one compiles and keeps its name',
    [
      r.errors.length,
      r.wasm === null ? [] : r.methods.map(m => m.name),
      r.wasm !== null && WebAssembly.validate(r.wasm),
    ],
    [0, ['put'], true],
  );
  T(
    'exports: the message and reply as JSON Schema, with bounds from refinements',
    r.wasm !== null &&
      r.schemas[0] && [
        r.schemas[0].input.properties?.key?.minLength,
        r.schemas[0].input.properties?.key?.maxLength,
        r.schemas[0].input.properties?.n?.maximum,
        r.schemas[0].input.required,
        r.schemas[0].output,
      ],
    [
      1,
      8,
      9,
      ['key', 'on'],
      { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false },
    ],
  );
}
finish();
