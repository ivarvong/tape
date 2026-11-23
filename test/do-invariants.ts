// `do` steps, invariants, the state named in a pattern (C81), and the three older ways `do` replaces (C83-C85).
import '../node25.ts';
import { readFileSync } from 'node:fs';
import { compile } from '../compiler.ts';
import type { Options } from '../compiler.ts';
import { instantiate, responseOf } from '../host.ts';
import { nodeSql } from '../nodesql.ts';
import { flat, format } from '../fmt.ts';
import { ok, finish, std } from './harness.ts';
import { cellText } from '../host/log.ts';

type Compiled = ReturnType<typeof compile>;
const build = (text: string, options: Partial<Options> = {}): Compiled =>
  compile([...std, { name: 'program.tape', text }], options);
const codes = (b: Compiled): string => b.errors.map(e => e.code).join(',');
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const dec = new TextDecoder(),
  enc = new TextEncoder();

const jars = `migration 1 "jars" {
  CREATE TABLE jars(
    id INTEGER PRIMARY KEY,
    state TEXT NOT NULL DEFAULT 'open'
  );
  CREATE TABLE purse(
    id INTEGER PRIMARY KEY,
    coins INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE notes(
    key TEXT PRIMARY KEY NOT NULL,
    coins INTEGER NOT NULL
  );
  INSERT INTO jars(id) VALUES (1);
  INSERT INTO purse(id) VALUES (1)
}

machine jars.state {
  "open" -> "sealed"
}

type Jar { Jar(id: Int, state: View) }
type Purse { Purse(id: Int, coins: Int) }

fn handle(raw: View, db: Sql) -> Buf {
  match request(raw) {
    Request(method: "POST", path: "/set/" ++ decimal(coins) ++ "/" ++ key) -> set(coins, key)
    Request(method: "POST", path: "/break") -> broken()
    Request(method: "GET", path: "/jar") -> shown(found: sql_first(row: Jar, query: "SELECT * FROM jars WHERE id = 1"), purse: sql_first(row: Purse, query: "SELECT * FROM purse WHERE id = 1"))
    _ -> respond(status: 404)
  }
}

fn set(coins: Int, key: View) -> Buf {
  do sql_exec(query: "INSERT INTO notes(key, coins) VALUES (:key, :coins) ON CONFLICT(key) DO NOTHING", key, coins)
  do sql_exec(query: "UPDATE purse SET coins = (SELECT coalesce(max(coins), 0) FROM notes) WHERE id = 1")
  respond(status: 200) |> append(view: "set")
}

fn broken() -> Buf {
  do sql_exec(query: "UPDATE purse SET coins = 0 - 1 WHERE id = 1")
  respond(status: 200) |> append(view: "broken")
}

fn shown(found: Option[Jar], purse: Option[Purse]) -> Buf {
  match found {
    Some(value: Jar(state: "open")) -> respond(status: 200) |> append(view: "open ") |> write_int(value: coins_of(purse))
    Some(value: Jar(state: "sealed")) -> respond(status: 200) |> append(view: "sealed")
    _ -> respond(status: 404)
  }
}

fn coins_of(purse: Option[Purse]) -> Int {
  match purse {
    Some(value: Purse(coins)) -> coins
    None -> 0
  }
}

invariant "the purse never holds less than nothing" {
  SELECT id, coins FROM purse WHERE coins < 0
}

invariant "every jar is sealed in the end" settled {
  SELECT id FROM jars WHERE state = 'open'
}
`;
const b = build(jars);
ok('do steps and invariants build', b.wasm !== null, codes(b));
ok(
  'the module lists its invariants',
  b.wasm !== null &&
    b.invariants.length === 2 &&
    b.invariants[1]?.settled === true &&
    b.invariants[0]?.sql.startsWith('SELECT id, coins FROM purse') === true,
);
if (!b.errors?.length) {
  const sql = nodeSql(),
    app = instantiate(new WebAssembly.Module(b.wasm), { sql });
  const req = (line: string) => {
    const r = responseOf(app.handleIn(f => sql.transaction(f), enc.encode(`${line}\n`)));
    return `${r.status} ${dec.decode(r.body)}`;
  };
  ok(
    'do runs its steps in order, and the block answers',
    req('POST /set/3/a') === '200 set' && req('POST /set/7/b') === '200 set' && req('GET /jar') === '200 open 7',
    req('GET /jar'),
  );
  ok(
    'the second step saw what the first wrote, each time',
    sql.exec('SELECT count(*) AS n FROM notes').toArray()[0]?.n === 2,
  );
  ok('invariants(): nothing is wrong', app.invariants().length === 0);
  const end = app.invariants({ settled: true });
  ok(
    'invariants({ settled: true }) also runs the settled ones',
    end.length === 1 && end[0]?.name === 'every jar is sealed in the end' && end[0].rows[0]?.id === 1,
    JSON.stringify(end),
  );
  req('POST /break');
  const now = app.invariants();
  ok(
    'a broken invariant is returned with the rows that break it',
    now.length === 1 && now[0]?.rows[0]?.coins === -1,
    JSON.stringify(now),
  );
}
ok(
  'a module with no invariants has no such section',
  (() => {
    const x = build(jars.slice(0, jars.indexOf('invariant "the purse')));
    return (
      x.wasm !== null &&
      x.invariants.length === 0 &&
      WebAssembly.Module.customSections(new WebAssembly.Module(x.wasm), 'invariants').length === 0
    );
  })(),
);
ok('fmt keeps a do step and an invariant as written', flat(format(jars)) === jars);

const swap = (a: string, c: string) => {
  if (!jars.includes(a)) throw new Error('not in the program: ' + a);
  return jars.replace(a, c);
};
ok(
  'C82: do drops only an Int: a Move must be matched',
  codes(
    build(
      swap(
        `  do sql_exec(query: "UPDATE purse SET coins = 0 - 1 WHERE id = 1")`,
        `  do sql_first(row: Purse, query: "SELECT * FROM purse WHERE id = 1")`,
      ),
    ),
  ) === 'C82',
);
ok(
  'C82: do takes a call',
  codes(build(swap(`  do sql_exec(query: "UPDATE purse SET coins = 0 - 1 WHERE id = 1")`, `  do 1 + 1`))) === 'C82',
);
ok(
  'C81: a state in a pattern that the machine does not have',
  codes(build(swap(`Jar(state: "sealed")`, `Jar(state: "seeled")`))) === 'C81',
  build(swap(`Jar(state: "sealed")`, `Jar(state: "seeled")`)).errors?.[0]?.message.slice(0, 90),
);
ok('C81 does not fire on a state the machine has', !build(jars).errors?.length);
// a machine's states are a known set in a match
{
  const all = swap(
    '    _ -> respond(status: 404)\n  }\n}\n\nfn coins_of',
    '    None -> respond(status: 404)\n  }\n}\n\nfn coins_of',
  );
  const full = build(all);
  ok('a match that names every state needs no default', !full.errors?.length, codes(full));
  const less = build(
    all.replace('    Some(value: Jar(state: "sealed")) -> respond(status: 200) |> append(view: "sealed")\n', ''),
  );
  ok(
    'C24: a state the match misses is named',
    codes(less) === 'C24' && less.errors[0]?.message === 'match does not cover Some(value: Jar(state: "sealed"))',
    less.errors[0]?.message,
  );
  const more = build(all.replace('"open" -> "sealed"', '"open" -> "sealed"\n  "sealed" -> "buried"'));
  ok(
    'C24: a state added to the machine breaks the match that does not name it',
    codes(more) === 'C24' && /Jar\(state: "buried"\)/.test(more.errors[0]?.message ?? ''),
    more.errors[0]?.message,
  );
  if (full.wasm !== null) {
    const sql = nodeSql(),
      app = instantiate(new WebAssembly.Module(full.wasm), { sql });
    const req = (line: string) => {
      try {
        const r = responseOf(app.handleIn(f => sql.transaction(f), enc.encode(`${line}\n`)));
        return `${r.status} ${dec.decode(r.body)}`;
      } catch (e) {
        return `threw ${messageOf(e)}`;
      }
    };
    ok('it runs', req('GET /jar') === '200 open 0', req('GET /jar'));
    for (const n of sql.exec("SELECT name FROM sqlite_master WHERE type = 'trigger'").toArray())
      sql.exec(`DROP TRIGGER "${cellText(n.name)}"`);
    sql.exec("UPDATE jars SET state = 'smashed'");
    ok(
      'a state forced into the data past the triggers traps at the match: no wrong arm is taken',
      req('GET /jar').startsWith('threw '),
      req('GET /jar'),
    );
  }
}
const C86: readonly (readonly [string, string, RegExp])[] = [
  ['not a SELECT', 'DELETE FROM purse', /only reads/],
  ['a placeholder', 'SELECT id FROM purse WHERE id = :id', /placeholder/],
  ['a column the schema lacks', 'SELECT id FROM purse WHERE pennies < 0', /pennies/],
  ['not SQL', 'coins are never negative', /./],
];
for (const [what, text, want] of C86) {
  const x = build(jars + `\ninvariant "x" {\n  ${text}\n}\n`);
  ok(`C86: ${what}`, codes(x) === 'C86' && want.test(x.errors[0]?.message ?? ''), x.errors[0]?.message.slice(0, 90));
}
ok(
  'C86: two invariants with one name',
  codes(
    build(
      jars + `\ninvariant "the purse never holds less than nothing" {\n  SELECT id FROM purse WHERE coins < 0\n}\n`,
    ),
  ) === 'C86',
);

// tidy
const untidy = swap(
  `fn broken() -> Buf {
  do sql_exec(query: "UPDATE purse SET coins = 0 - 1 WHERE id = 1")
  respond(status: 200) |> append(view: "broken")
}`,
  `fn broken() -> Buf {
  let wrote = sql_exec(query: "UPDATE purse SET coins = 0 - 1 WHERE id = 1")
  after(done: sql_exec(query: "UPDATE purse SET coins = 0 - 2 WHERE id = 1"))
}

fn after(done: Int) -> Buf {
  respond(status: 200 + 0 * sql_exec(query: "UPDATE purse SET coins = 0 - 3 WHERE id = 1")) |> append(view: "broken")
}`,
);
const t = build(untidy);
ok(
  'rules: false builds the old forms, and says what the rules found',
  (() => {
    const x = build(untidy, { rules: false });
    return (
      x.wasm !== null &&
      x.refused
        .map(e => e.code)
        .toSorted()
        .join(',') === 'C83,C84,C85'
    );
  })(),
);
ok(
  'C83 a let never read, C84 a parameter never read, C85 multiplied by 0',
  [...new Set(t.errors.map(e => e.code))].toSorted().join(',') === 'C83,C84,C85',
  codes(t),
);
ok(
  'handle may leave its capabilities unread, and std has none of the three',
  !build(jars).errors?.length,
  codes(build(jars)),
);

const tix = build(readFileSync(new URL('../apps/tickets/tickets.tape', import.meta.url), 'utf8'));
ok(
  'apps/tickets/tickets.tape builds, and declares nine invariants, one across two programs',
  tix.wasm !== null && tix.invariants.length === 9 && tix.invariants[8]?.with?.join(',') === 'pay',
  codes(tix),
);

finish();
