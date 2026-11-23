// 0.4: what the 0.3 usability bench (48 runs, Sonnet and Haiku) and its feedback asked of the language, each
// checked here against something other than the code that does it.
import '../node25.ts';
import { compile } from '../compiler.ts';
import { std } from '../std.ts';
import { instantiate, responseOf } from '../host.ts';
import { interpret } from '../interp.ts';
import { effectLine, queryNames } from '../apps/playground/src/lines.ts';
import { nodeSql } from '../nodesql.ts';
import { bare, built, call, finish, same } from './harness.ts';

const said = (text: string): string => {
  const [e] = compile([...std, { name: 't.tape', text }], { exports: ['f'] }).errors;
  return e ? `${e.code} ${e.line}: ${e.message} | ${e.hint}` : 'compiled';
};

// ---- the fallback arm of each match (feedback 20261123T015148.926Z-8896b9c5701d): `_ ->` in a match of
// conditions was "expected an expression but found `_`", and `else ->` in a match on a value "expected a pattern"
same(
  '`_ ->` in a match with no subject says its fallback is `else ->`',
  said('fn f(n: Int) -> Int {\n  match {\n    n > 1 -> 1\n    _ -> 2\n  }\n}\n'),
  'P02 4: a match with no subject takes conditions; its fallback arm is `else -> …`, not `_ -> …` | Write `else -> …` as the last arm, or give the match a subject (`match n { 1 -> … _ -> … }`) to match patterns.',
);
same(
  '`else ->` in a match on a value says its fallback is `_ ->`',
  said('fn f(n: Int) -> Int {\n  match n {\n    1 -> 1\n    else -> 2\n  }\n}\n'),
  'P04 4: a match on a value takes patterns; its fallback arm is `_ -> …`, not `else -> …` | Write `_ -> …` as the last arm, or drop the subject (`match { n > 1 -> … else -> … }`) to match conditions.',
);
same(
  'each written as the doc says compiles',
  [
    said('fn f(n: Int) -> Int {\n  match {\n    n > 1 -> 1\n    else -> 2\n  }\n}\n'),
    said('fn f(n: Int) -> Int {\n  match n {\n    1 -> 1\n    _ -> 2\n  }\n}\n'),
  ],
  ['compiled', 'compiled'],
);

// ---- C54 across a call (the webhook task, C54 on all 3 Haiku runs, 7 refusals): the caller claims the delivery
// id (`let 1 = sql_exec("INSERT … ON CONFLICT DO NOTHING") else …`), then calls the helper that credits. Every
// call of the helper is after a claim, so its write runs once per claim. A helper also called where nothing was
// claimed is still refused: the reason 0.3 kept the claim to one function (apps/tickets' "promotion without its
// op-id guard" plant, proof/all.ts).
{
  const WEBHOOK = `migration 1 "c" {
  CREATE TABLE d(id TEXT PRIMARY KEY NOT NULL, n INTEGER NOT NULL);
  CREATE TABLE a(k TEXT PRIMARY KEY NOT NULL, b INTEGER NOT NULL)
}

fn handle(raw: View, db: Sql) -> Buf {
  let r = request(raw)
  match r.path {
    "/in/" ++ id -> received(id)
    OTHER
    _ -> respond(status: 404)
  }
}

fn received(id: View) -> Buf {
  let 1 = sql_exec(query: "INSERT INTO d(id, n) VALUES (:id, 1) ON CONFLICT(id) DO NOTHING", id) else -> respond(status: 200) |> append(view: "dup")
  match id {
    "refund" -> credit(k: "acme", by: -5)
    _ -> credit(k: "acme", by: 5)
  }
}

fn credit(k: View, by: Int) -> Buf {
  do sql_exec(query: "INSERT INTO a(k, b) VALUES (:k, :by) ON CONFLICT(k) DO UPDATE SET b = b + :by", k, by)
  respond(status: 200) |> append(view: "ok")
}
`;
  const codesOf = (text: string): string[] =>
    compile([...std, { name: 't.tape', text }]).errors.map(e => `${e.code}:${e.line}`);
  const claimed = WEBHOOK.replace('    OTHER\n', '');
  same('C54: a write in a helper every call of which comes after a claim is taken', codesOf(claimed), []);
  same(
    '…and it runs once: the same delivery twice credits once',
    (() => {
      const r = compile([...std, { name: 't.tape', text: claimed }]);
      if (!r.wasm) return 'does not compile';
      const sql = nodeSql();
      const app = instantiate(new WebAssembly.Module(r.wasm), { sql, log: false });
      const send = (): string => new TextDecoder().decode(app.handle(new TextEncoder().encode('POST /in/x1\n')));
      return [send(), send(), sql.exec("SELECT b FROM a WHERE k = 'acme'").toArray()[0]?.['b']];
    })(),
    ['200\nok', '200\ndup', 5],
  );
  same(
    'C54: the same helper also called with no claim before it is refused',
    codesOf(WEBHOOK.replace('    OTHER\n', '    "/adjust" -> credit(k: "acme", by: 1)\n')),
    ['C54:24'],
  );
  same(
    'C54: a call where the claim failed (its else) is refused',
    codesOf(claimed.replace('else -> respond(status: 200) |> append(view: "dup")', 'else -> credit(k: "acme", by: 1)')),
    ['C54:23'],
  );
}

// ---- decode takes a body with keys its type does not name (7 reports: todo, webhook, shortener, invoice; real
// clients and providers send more than a service reads). Of a type with several constructors it takes the one
// that names the most of the body's keys, so declaring the smaller first changes nothing. Compiled and
// interpreted, each against the answer written here from that rule.
{
  const EV = `type Ev {
  Refunded(id: Int)
  Paid(id: Int, amount: Int)
}

type Note {
  Note(text: View, at: Option[Int])
}

fn handle(raw: View) -> Buf {
  let r = request(raw)
  match r.path {
    "/ev" -> match decode(json: r.body, as: Ev) {
      Ok(value: Paid(id, amount)) -> respond(status: 200) |> append(view: "paid \\(id) \\(amount)")
      Ok(value: Refunded(id)) -> respond(status: 200) |> append(view: "refunded \\(id)")
      Err(error) -> respond(status: 400) |> append(view: error)
    }
    _ -> match decode(json: r.body, as: Note) {
      Ok(value: Note(text)) -> respond(status: 200) |> append(view: text)
      Err(error) -> respond(status: 400) |> append(view: error)
    }
  }
}
`;
  const cases: [string, string][] = [
    ['POST /note\n{"text":"hi","from":"app","v":2}', '200\nhi'],
    ['POST /note\n{"text":"hi","at":null}', '400\nat: expected a whole number'],
    ['POST /note\n{"from":"app"}', '400\nmissing key "text"'],
    ['POST /ev\n{"id":1,"amount":2}', '200\npaid 1 2'],
    ['POST /ev\n{"id":1,"amount":2,"currency":"usd"}', '200\npaid 1 2'],
    ['POST /ev\n{"id":1}', '200\nrefunded 1'],
    ['POST /ev\n{"id":1,"reason":"dup"}', '200\nrefunded 1'],
    ['POST /ev\n{"id":1,"amount":"2"}', '400\namount: expected a whole number'],
  ];
  const r = compile([...std, { name: 't.tape', text: EV }]);
  const app = r.wasm ? instantiate(new WebAssembly.Module(r.wasm), { sql: nodeSql(), log: false }) : null;
  const it = interpret([...std, { name: 't.tape', text: EV }]);
  const enc = new TextEncoder(),
    dec = new TextDecoder();
  for (const [req, want] of cases) {
    const got = app ? responseOf(app.handle(enc.encode(req))) : null;
    same(
      `decode: ${req.replace('\n', ' ')}`,
      [got ? `${got.status}\n${dec.decode(got.body)}` : 'does not compile', dec.decode(it.handle(enc.encode(req)))],
      [want, want],
    );
  }
}

// ---- isqrt (feedback 20261123T015153.800Z-7782f1b2045b: a square root for fixed-point maths): the floor of the
// square root, None below 0, for every Int up to the largest. The oracle is BigInt's: r * r <= n < (r + 1) ^ 2.
{
  const P = 'fn root(n: Int) -> Int {\n  match isqrt(n) {\n    Some(value) -> value\n    None -> -1\n  }\n}\n';
  const b = built(P, { exports: ['root'] });
  const fns = bare(new WebAssembly.Module(b.wasm)).fns;
  const it = interpret([...std, { name: 't.tape', text: P }]);
  const MAX = 2n ** 63n - 1n;
  const floorSqrt = (n: bigint): bigint => {
    if (n < 0n) return -1n;
    let r = BigInt(Math.floor(Math.sqrt(Number(n))));
    while (r * r > n) r -= 1n;
    while ((r + 1n) * (r + 1n) <= n) r += 1n;
    return r;
  };
  const edges = [-(2n ** 63n), -1n, 0n, 1n, 2n, 3n, 4n, 15n, 16n, 17n, 99n, 100n, 2n ** 52n - 1n, 2n ** 53n + 1n];
  for (const r of [3037000499n, 3037000498n, 94906265n, 2n ** 26n]) edges.push(r * r - 1n, r * r, r * r + 1n);
  edges.push(MAX - 1n, MAX);
  const bad = edges.filter(n => {
    const want = floorSqrt(n);
    call(fns, 'reset');
    return call(fns, 'root', n) !== want || it.call('root', [n]) !== want;
  });
  same(`isqrt: ${edges.length} edge values, compiled and interpreted, as BigInt says`, bad, []);
  same('isqrt of the largest Int is 3037000499', floorSqrt(MAX), 3037000499n);
}

// ---- a CSV answer is text/csv (the sales task, 3 of 3 Haiku runs: finance opens the report in a spreadsheet, and
// the only types were Html, Json, Text, Css and Svg). The type and charset are RFC 4180's and the WHATWG's.
{
  const P =
    'fn handle(raw: View) -> Buf {\n  respond_as(status: 200, content: Csv) |> append(view: "day,total\\n1,5\\n")\n}\n';
  const r = compile([...std, { name: 't.tape', text: P }]);
  const got = r.wasm
    ? responseOf(instantiate(new WebAssembly.Module(r.wasm), {}).handle(new TextEncoder().encode('GET /\n')))
    : null;
  same(
    'respond_as(content: Csv) is served as text/csv',
    got ? [got.status, got.type, new TextDecoder().decode(got.body)] : r.errors.map(e => e.message),
    [200, 'text/csv; charset=utf-8', 'day,total\n1,5\n'],
  );
}

// ---- the effect log in the program's words (feedback 20261123T013350.931Z-e65cf778d550, ledger): two queries that
// differ only in a placeholder's name, `WHERE id = :id` and `WHERE id = :to`, are one statement, `WHERE id = ?1`,
// and the log named both runs with the last literal's names: `:to` for a lookup written with `:id`. The statement
// cannot say which literal ran, so its names are shown only when every literal that makes it gives the same ones.
{
  const LOOKUPS = `migration 1 "a" {
  CREATE TABLE accounts(id TEXT PRIMARY KEY NOT NULL, balance INTEGER NOT NULL)
}

type Account { Account(id: View, balance: Int) }

fn handle(raw: View, db: Sql) -> Buf {
  match request(raw) {
    Request(path: "/accounts/" ++ id) -> shown(found: sql_first(row: Account, query: "SELECT id, balance FROM accounts WHERE id = :id", id))
    Request(path: "/to/" ++ to) -> shown(found: sql_first(row: Account, query: "SELECT id, balance FROM accounts WHERE id = :to", to))
    Request(path: "/n/" ++ id) -> shown(found: sql_first(row: Account, query: "SELECT id, balance FROM accounts WHERE id = :id AND balance > 0", id))
    _ -> respond(status: 404)
  }
}

fn shown(found: Option[Account]) -> Buf {
  match found {
    Some(value: Account(balance)) -> respond(status: 200) |> append(view: "\\(balance)")
    None -> respond(status: 404)
  }
}
`;
  const b = built(LOOKUPS);
  const names = queryNames(LOOKUPS);
  const shownFor = (sql: string): string => {
    const q = b.queries.findIndex(x => x.sql === sql);
    return q < 0 ? `no statement ${sql}` : (effectLine(b, { q, p: ['alice'], rows: [] }, names).sql?.query ?? '');
  };
  same(
    'two literals that number alike, :id and :to, are one statement, shown as numbered',
    [b.queries.length, shownFor('SELECT id, balance FROM accounts WHERE id = ?1')],
    [2, 'SELECT id, balance FROM accounts WHERE id = ?1'],
  );
  same(
    'a statement only one literal makes is shown with its names',
    shownFor('SELECT id, balance FROM accounts WHERE id = ?1 AND balance > 0'),
    'SELECT id, balance FROM accounts WHERE id = :id AND balance > 0',
  );
}

finish();
