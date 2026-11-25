// Brief of Nov 17, 14:48 (apps/tickets): the false refusals writing the ticketing service found, each fixed, with
// the true positives beside it so the fix is no wider than the finding; and std/http's caller, content types,
// form fields and HTML escaping.
import '../node25.ts';
import { framed, responseOf } from '../host.ts';
import { parse } from '../sql.ts';
import type { Select } from '../sql/ast.ts';
import { built, codes as codesOf, finish, moduleOf, read, same as T, sectionText } from './harness.ts';

const codes = (src: string): string[] => codesOf(src, {}, 't.tape');
const fromOf = (query: string): Select['from'] => {
  const s = parse(query);
  return s.k === 'select' ? s.from : [];
};
const prog = (tables: string, body: string, machines = '') =>
  `migration 1 "t" {\n${tables}\n}\n${machines}\ntype Id { Id(id: Int) }\ntype W { W(id: Int, tier: Int, state: View) }\nfn handle(raw: View, db: Sql) -> Response {\n${body}\n}\ntype HoldState { Held Released }\ntype EventState { Onsale Canceled }\n`;
const H = `CREATE TABLE events(id INTEGER PRIMARY KEY, state TEXT NOT NULL DEFAULT 'onsale' CHECK (state IN ('onsale', 'canceled')));
  CREATE TABLE holds(id INTEGER PRIMARY KEY, client TEXT NOT NULL UNIQUE, tier INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'held');
  CREATE TABLE tiers(id INTEGER PRIMARY KEY, event INTEGER NOT NULL, left INTEGER NOT NULL CHECK (left >= 0))`;
const M = `machine holds.state: HoldState {\n  Held -> Released\n}\nmachine events.state: EventState {\n  Onsale -> Canceled\n}`;

// ---- 1. a column named `left` (SQLite's JOIN_KW are names)
T(
  'sql: a join keyword is a column name (CREATE, UPDATE, RETURNING)',
  [
    'CREATE TABLE t(id INTEGER PRIMARY KEY, left INTEGER, right INTEGER)',
    'UPDATE t SET left = left - 1 WHERE id = 1 AND left >= 1 RETURNING left',
  ].map(q => parse(q).k),
  ['create_table', 'update'],
);
T(
  'sql: and LEFT JOIN still reads as a join, not an alias',
  fromOf('SELECT a.id FROM t AS a LEFT JOIN u AS b ON b.id = a.id').map(f => f.join),
  [null, 'left'],
);
T(
  'sql: a bare table followed by LEFT JOIN: no alias taken',
  fromOf('SELECT t.id FROM t LEFT JOIN u ON u.id = t.id').map(f => [f.name, f.alias]),
  [
    ['t', null],
    ['u', null],
  ],
);
T(
  'compiler: a program with a `left` column compiles',
  codes(
    prog(
      H,
      `  match sql_first(row: Id, query: "UPDATE tiers SET left = left - 1 WHERE id = :id AND left >= 1 RETURNING id", id: 1) {\n    Some(value: Id(id)) -> empty(status: 200)\n    None -> empty(status: 409)\n  }`,
    ),
  ),
  ['C54:10'],
);

// ---- 2. C61 in a migration reads only statements over the machine's table
T("C61: another table's CHECK on its own `state` is not the machine's", codes(prog(H, '  empty(status: 200)', M)), []);
T(
  "C61: the machine table's own CHECK with a state it does not declare still is",
  codes(
    prog(
      H.replace(
        "state TEXT NOT NULL DEFAULT 'held')",
        "state TEXT NOT NULL DEFAULT 'held' CHECK (state IN ('held', 'released', 'lost')))",
      ),
      '  empty(status: 200)',
      M,
    ),
  ),
  ['C61:1'],
);

// ---- 3. `t.*` with row: in a join
const J = (q: string) =>
  prog(
    H,
    `  match sql_first(row: W, query: "${q}", n: 1) {\n    Some(value: W(id)) -> empty(status: 200)\n    None -> empty(status: 404)\n  }`,
  );
T(
  'C75: w.* in a join is the fields of the table it names',
  codes(J('SELECT h.* FROM holds AS h JOIN tiers AS t ON t.id = h.tier WHERE t.event = :n')),
  [],
);
T(
  'C75: a bare * over a join is still refused',
  codes(J('SELECT * FROM holds AS h JOIN tiers AS t ON t.id = h.tier WHERE t.event = :n')),
  ['C75:10'],
);
{
  const r = built(J('SELECT h.* FROM holds AS h JOIN tiers AS t ON t.id = h.tier WHERE t.event = :n'), {}, 't.tape');
  const [q] = /SELECT [^"]*/.exec(sectionText(moduleOf(r), 'queries')) ?? [];
  T(
    'C75: and it is written out qualified',
    q,
    'SELECT h.id, h.tier, h.state FROM holds AS h JOIN tiers AS t ON t.id = h.tier WHERE t.event = ?1',
  );
}

// ---- 4. C62 is one row's compare-and-set: a set update is not
const S = (q: string) => prog(H, `  let _ = sql_exec(query: "${q}", n: 1)\n  empty(status: 200)`, M);
T(
  'C62: a set update by state (no key) is not a compare-and-set to type',
  codes(
    S("UPDATE holds SET state = 'released' WHERE state = 'held' AND tier IN (SELECT id FROM tiers WHERE event = :n)"),
  ),
  [],
);
T(
  'C62: one row by its primary key still is',
  codes(S("UPDATE holds SET state = 'released' WHERE id = :n AND state = 'held'")),
  ['C62:15'],
);
T(
  'C62: one row by a UNIQUE column still is',
  codes(S("UPDATE holds SET state = 'released' WHERE client = 'k' || :n AND state = 'held'")),
  ['C62:15'],
);
T(
  'C62: one row by a key from a subquery still is',
  codes(
    S("UPDATE holds SET state = 'released' WHERE id = (SELECT max(id) FROM holds WHERE tier = :n) AND state = 'held'"),
  ),
  ['C62:15'],
);

// ---- 5. C60: INSERT … SELECT that leaves the machine column out starts in its DEFAULT
const I = (q: string) => prog(H, `  let _ = sql_exec(query: "${q}", n: 1)\n  empty(status: 200)`, M);
// (the fragment enters 'held' and nothing leaves it: C77, judged in test/timers-way-out.ts)
T(
  'C60: INSERT … SELECT without the machine column: its DEFAULT, the start state',
  codes(
    I(
      "INSERT INTO holds(client, tier) SELECT 'k' || id, id FROM tiers WHERE event = :n ON CONFLICT(client) DO NOTHING",
    ),
  ).filter(c => !c.startsWith('C77:')),
  [],
);
T(
  'C59: a DEFAULT that is not the start state is still refused',
  codes(
    prog(
      H.replace("DEFAULT 'held')", "DEFAULT 'released')"),
      `  let _ = sql_exec(query: "INSERT INTO holds(client, tier) SELECT 'k' || id, id FROM tiers WHERE event = :event ON CONFLICT(client) DO NOTHING", event: 1)\n  empty(status: 200)`,
      M,
    ),
  ),
  ['C59:15'],
);
T(
  'C60: INSERT … SELECT naming the machine column is still refused',
  codes(
    I(
      "INSERT INTO holds(client, tier, state) SELECT 'k' || id, id, 'held' FROM tiers WHERE event = :n ON CONFLICT(client) DO NOTHING",
    ),
  ),
  ['C60:15'],
);

// ---- 6. the service's answer head (host.ts responseOf): a frame's status and content, the type a closed list
const head = (status: number, content: number) => {
  const r = responseOf(framed({ status, content }));
  return [r.status, r.type];
};
T(
  'responseOf: the status and the content of a frame (Text 2, Html 0, Json 1)',
  [head(201, 2), head(200, 0), head(404, 1)],
  [
    [201, 'text/plain; charset=utf-8'],
    [200, 'text/html; charset=utf-8'],
    [404, 'application/json'],
  ],
);
T(
  'responseOf: a content Content does not have is a 500, not a type',
  [head(200, 9), head(200, 255)],
  [
    [500, 'text/plain; charset=utf-8'],
    [500, 'text/plain; charset=utf-8'],
  ],
);
T(
  'responseOf: Atom, RSS and XML are those types, with charset=utf-8',
  [head(200, 6), head(200, 7), head(200, 8)],
  [
    [200, 'application/atom+xml; charset=utf-8'],
    [200, 'application/rss+xml; charset=utf-8'],
    [200, 'application/xml; charset=utf-8'],
  ],
);
T(
  'responseOf: the text that named a type before 25 November 2026 is no frame: a 500, never that type',
  ['200 application/xhtml+xml\n<html/>', '200 text/xml\n<a/>', '200 text/html; a=b\nx'].map(t => {
    const r = responseOf(new TextEncoder().encode(t));
    return [r.status, r.type];
  }),
  [
    [500, 'text/plain; charset=utf-8'],
    [500, 'text/plain; charset=utf-8'],
    [500, 'text/plain; charset=utf-8'],
  ],
);
// 0.3: a carriage return on the status line opened a header; a header is a field of the frame now, and one whose
// name is empty or whose value holds CR LF is refused, 500
T(
  'responseOf: a header with no name, or a value with CR LF in it, is refused, 500',
  [
    { name: '', value: 'x' },
    { name: 'x-a', value: 'b\r\nset-cookie: c' },
  ].map(h => {
    const r = responseOf(framed({ status: 200, content: 0, headers: [h] }));
    return [r.status, r.type];
  }),
  [
    [500, 'text/plain; charset=utf-8'],
    [500, 'text/plain; charset=utf-8'],
  ],
);

// ---- 7. the tickets app compiles, and its pay program
for (const f of ['apps/tickets/tickets.tape', 'apps/tickets/pay.tape']) T(`${f} compiles`, codes(read(f)), []);

finish();
