// A sum whose constructors have no fields is stored as text (issue 12): in a column, in a query's value and in JSON,
// a constructor is its name in snake_case (`PartlyRefunded` is 'partly_refunded'). Run here on the default build,
// the build that never releases, the checked build and the reference interpreter: a row written with a
// constructor reads back the same constructor, the column holds the text (read with plain SQL), a text that names
// no constructor stops the request as its row is read, `write_json` writes the string and `decode` reads it and
// refuses any other value with the path. Then a machine names such a type: the issue's reproduction (an event
// paused shown as canceled) is refused at the match that would take the new state (C97), and compiles once that
// match names it; a machine's column read into a View is refused (C69).
import '../node25.ts';
import { readFileSync } from 'node:fs';
import { compile } from '../compiler.ts';
import type { Options } from '../compiler.ts';
import { storedText } from '../compiler/fieldless.ts';
import { instantiate, responseOf } from '../host.ts';
import { cellText } from '../host/log.ts';
import { interpret } from '../interp.ts';
import { nodeSql } from '../nodesql.ts';
import { finish, same as T, std } from './harness.ts';

const enc = new TextEncoder(),
  dec = new TextDecoder();
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

T(
  'the stored text of a constructor is its name in snake_case',
  ['Onsale', 'PartlyRefunded', 'RefundUnresolved', 'A', 'Tier2'].map(storedText),
  ['onsale', 'partly_refunded', 'refund_unresolved', 'a', 'tier2'],
);

const PROGRAM = `migration 1 "marks" {
  CREATE TABLE marks(id INTEGER PRIMARY KEY, state TEXT NOT NULL, was TEXT)
}

type EventState { Onsale PartlyRefunded Canceled }
type Mark { Mark(id: Int, state: EventState, was: Option[EventState]) }

fn handle(raw: View, db: Sql) -> Response {
  match request(raw) {
    Request(path: "/put", body) -> put(body)
    Request(path: "/get/" ++ decimal(id)) -> got(found: sql_first(row: Mark, query: "SELECT id, state, was FROM marks WHERE id = :id", id))
    Request(path: "/list", body) -> listed(body)
    _ -> empty(status: 404)
  }
}

fn put(body: View) -> Response {
  let Ok(value: Mark(id, state, was)) = decode(json: body, as: Mark) else {
    Err(error) -> buf() |> append(view: error) |> respond(status: 400)
  }
  buf()
    |> write_int(value: sql_exec(query: "INSERT INTO marks(id, state, was) VALUES (:id, :state, :was) ON CONFLICT(id) DO NOTHING", id, state, was)) |> respond(status: 200)
}

fn got(found: Option[Mark]) -> Response {
  match found {
    Some(value) -> buf() |> write_json(value) |> respond(status: 200)
    None -> empty(status: 404)
  }
}

fn listed(body: View) -> Response {
  match decode(json: body, as: List[EventState]) {
    Ok(value) -> buf() |> write_json(value) |> respond(status: 200)
    Err(error) -> buf() |> append(view: error) |> respond(status: 400)
  }
}
`;
const sources = [...std, { name: 'marks.tape', text: PROGRAM }];
const REQUESTS = [
  'POST /put\n{"id":1,"state":"partly_refunded","was":"onsale"}',
  'POST /put\n{"id":2,"state":"canceled"}',
  'POST /put\n{"id":3,"state":"paused"}',
  'POST /put\n{"id":3,"state":7}',
  'POST /put\n{"id":3,"state":"onsale","was":"Onsale"}',
  'GET /get/1',
  'GET /get/2',
  'POST /list\n["canceled","onsale"]',
  'POST /list\n["canceled",{"Canceled":{}}]',
  'GET /get/9',
];
const WANT = [
  '200 1',
  '200 1',
  '400 state: expected one of "onsale", "partly_refunded", "canceled"',
  '400 state: expected one of "onsale", "partly_refunded", "canceled"',
  '400 was: expected one of "onsale", "partly_refunded", "canceled"',
  '200 {"id":1,"state":"partly_refunded","was":"onsale"}',
  '200 {"id":2,"state":"canceled"}',
  '200 ["canceled","onsale"]',
  '400 [1]: expected one of "onsale", "partly_refunded", "canceled"',
  'stopped',
];
/** What the table holds, read with plain SQL; then a row whose text names no constructor, put past the program. */
const STORED = [
  { id: 1, state: 'partly_refunded', was: 'onsale' },
  { id: 2, state: 'canceled', was: null },
];
const plain = (sql: ReturnType<typeof nodeSql>) =>
  sql
    .exec('SELECT id, state, was FROM marks ORDER BY id')
    .toArray()
    .map(r => ({
      id: Number(r['id']),
      state: cellText(r['state']),
      was: r['was'] === null ? null : cellText(r['was']),
    }));

const BUILDS: [string, Partial<Options>][] = [
  ['the default build', {}],
  ['the build that never releases', { reuse: false }],
  ['the checked build', { check: true }],
];
for (const [name, options] of BUILDS) {
  const b = compile(sources, options);
  T(
    `${name} compiles`,
    b.errors.map(e => `${e.code}:${e.line} ${e.message}`),
    [],
  );
  if (b.wasm === null) continue;
  const sql = nodeSql(),
    app = instantiate(new WebAssembly.Module(b.wasm), { sql });
  const answers = REQUESTS.map(text => {
    if (text === 'GET /get/9') sql.exec("INSERT INTO marks(id, state) VALUES (9, 'paused')");
    try {
      const r = responseOf(app.handleIn(f => sql.transaction(f), enc.encode(`${text}\n`)));
      return `${r.status} ${dec.decode(r.body)}`;
    } catch (e) {
      return /should be one of "onsale", "partly_refunded", "canceled" but is "paused"/.test(messageOf(e))
        ? 'stopped'
        : messageOf(e);
    }
  });
  T(`${name}: each answer`, answers, WANT);
  T(`${name}: the column holds each constructor's text`, plain(sql).slice(0, 2), STORED);
}

// the reference interpreter, over the same SQL
{
  const sql = nodeSql();
  sql.exec('CREATE TABLE marks(id INTEGER PRIMARY KEY, state TEXT NOT NULL, was TEXT)');
  const it = interpret(sources, {
    flags: {},
    exec: (q, p) => {
      sql.exec(q, ...p);
      return Number(sql.exec('SELECT changes() AS n').toArray()[0]?.['n'] ?? 0);
    },
    rows: (q, p) =>
      sql
        .exec(q, ...p)
        .toArray()
        .map(r =>
          Object.values(r).map(v => (typeof v === 'number' || typeof v === 'string' || v === null ? v : cellText(v))),
        ),
  });
  const answers = REQUESTS.map(text => {
    if (text === 'GET /get/9') sql.exec("INSERT INTO marks(id, state) VALUES (9, 'paused')");
    try {
      const r = responseOf(it.handle(enc.encode(`${text}\n`)));
      return `${r.status} ${dec.decode(r.body)}`;
    } catch (e) {
      return /"paused" in a column read as EventState: expected one of "onsale", "partly_refunded", "canceled"/.test(
        messageOf(e),
      )
        ? 'stopped'
        : messageOf(e);
    }
  });
  T('the interpreter: each answer', answers, WANT);
  T("the interpreter: the column holds each constructor's text", plain(sql).slice(0, 2), STORED);
}

// ---- a machine names its type: the issue's reproduction, on the box office
const tickets = readFileSync(new URL('../apps/tickets/tickets.tape', import.meta.url), 'utf8');
const swap = (text: string, a: string, b: string): string => {
  if (!text.includes(a)) throw new Error(`not in the program: ${a}`);
  return text.replace(a, b);
};
const codes = (text: string): string[] =>
  compile([...std, { name: 'apps/tickets/tickets.tape', text }]).errors.map(e => `${e.code}:${e.line}`);
const lineOf = (text: string, s: string): number => text.slice(0, text.indexOf(s)).split('\n').length;
// a state added to events: on sale, then paused (the issue's `"onsale" -> "paused"`)
const paused = swap(
  swap(tickets, 'type EventState { Onsale Canceled }', 'type EventState { Onsale Paused Canceled }'),
  '  Onsale -> Canceled\n',
  '  Onsale -> Canceled\n  Onsale -> Paused\n',
);
// the page asks whether each state takes holds: a paused event does not
const asked = swap(paused, '    Canceled -> False\n', '    Paused -> False\n    Canceled -> False\n');
// event_state as it was on main: everything that is not on sale shown as canceled
const lumped = swap(
  asked,
  '    Canceled -> "<span class=bad>canceled: every order is refunded</span>"',
  '    _ -> "<span class=bad>canceled: every order is refunded</span>"',
);
T('the box office compiles', codes(tickets), []);
T(
  'the reproduction: a paused event shown as canceled is refused at event_state (C97), and nothing else is',
  codes(lumped),
  [`C97:${lineOf(lumped, '    _ -> "<span class=bad>canceled')}`],
);
T('with every state named, the state added is not covered at event_state (C24)', codes(asked), [
  `C24:${lineOf(asked, 'fn event_state(') + 1}`,
]);
const said = swap(
  asked,
  '    Canceled -> "<span class=bad>canceled: every order is refunded</span>"',
  '    Paused -> "paused"\n    Canceled -> "<span class=bad>canceled: every order is refunded</span>"',
);
T('once event_state names Paused, it compiles', codes(said), []);
T(
  "a machine's column read into a View is refused, with the type to read it into (C69)",
  compile([
    ...std,
    {
      name: 'marks.tape',
      text: `${PROGRAM.replace('type Mark { Mark(id: Int, state: EventState,', 'type Mark { Mark(id: Int, state: View,')}\nmachine marks.state: EventState {\n  Onsale -> PartlyRefunded\n  PartlyRefunded -> Canceled\n}\n`,
    },
  ])
    .errors.slice(0, 1)
    .map(e => [e.code, e.message, e.hint]),
  [
    [
      'C69',
      'column state is marks.state, the column of machine marks.state: EventState, and field state is View: a state added to the machine would be read as any other value, and a match on it would take it without a word',
      'Make the field `state: EventState`, and match its constructors (`Onsale`, …).',
    ],
  ],
);

finish();
