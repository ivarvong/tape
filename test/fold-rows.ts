// fold_rows (std/list.tape), the one traversal of a query's rows, and write_rows on top of it. Each program here
// serves one route the same way and differs only in how it walks the rows, so a difference in steps is the walk's:
// fold_rows takes one step a row and one more, as fold over a list (or a range) that long, and exactly what the
// recursion a program wrote by hand on next() took; write_rows writes the bytes, and takes the steps, of the
// recursion it replaced. The example in fold_rows's comment compiles and answers the names. Run in node:sqlite.
//   node test/fold-rows.ts
import '../node25.ts';
import { instantiate, isHead } from '../host.ts';
import { nodeSql } from '../nodesql.ts';
import { built, finish, moduleOf, raw, same } from './harness.ts';

const program = (walk: string): string => `migration 1 "items" {
  CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT NOT NULL, qty INTEGER NOT NULL)
}

type Item { Item(id: Int, name: View, qty: Int) }
type NewItem { NewItem(name: View, qty: Int) }
type Count { Count(n: Int) }

fn handle(raw: View, db: Sql) -> Buf {
  match request(raw) {
    Request(method: "POST", body) -> added(body)
    _ -> walked(out: respond(status: 200))
  }
}

fn added(body: View) -> Buf {
  let Ok(value: NewItem(name, qty)) = decode(json: body, as: NewItem) else -> respond(status: 400)
  let _ = sql_exec(query: "INSERT INTO items(name, qty) VALUES (:name, :qty)", name, qty, repeat: True)
  respond(status: 201)
}

fn all() -> Rows[Item] {
  sql_all(row: Item, query: "SELECT * FROM items ORDER BY id")
}

${walk}
`;

// the sum of the quantities three ways, and no walk at all; each writes the last digit, with push, which takes no
// step (write_int takes one a digit)
const SUM = {
  rows: `fn walked(out: Buf) -> Buf {
  let total = all() |> fold_rows(from: 0, by: fn(acc: Int, item: Item) -> Int { acc + item.qty })
  out |> push(byte: 48 + total % 10)
}`,
  hand: `fn walked(out: Buf) -> Buf {
  out |> push(byte: 48 + summed(rows: all(), acc: 0) % 10)
}

fn summed(rows: Rows[Item], acc: Int) -> Int {
  match next(rows) {
    Next(value: Item(qty), rest) -> summed(rows: rest, acc: acc + qty)
    End -> acc
  }
}`,
  range: `fn walked(out: Buf) -> Buf {
  let Some(value: Count(n)) = sql_first(row: Count, query: "SELECT count(*) AS n FROM items") else -> out
  let total = range(from: 0, to: n) |> fold(from: 0, by: fn(acc: Int, k: Int) -> Int { acc + k })
  out |> push(byte: 48 + total % 10)
}`,
  none: `fn walked(out: Buf) -> Buf {
  let Some(value: Count(n)) = sql_first(row: Count, query: "SELECT count(*) AS n FROM items") else -> out
  out |> push(byte: 48 + n % 10)
}`,
};
// the rows as JSON: write_rows, and the loop it was until fold_rows (std/json.tape before this test)
const JSON_WAYS = {
  rows: `fn walked(out: Buf) -> Buf {
  out |> write_rows(rows: all())
}`,
  hand: `fn walked(out: Buf) -> Buf {
  written(out: push(buf: out, byte: 91), rows: all(), first: True)
}

fn written(out: Buf, rows: Rows[Item], first: Bool) -> Buf {
  match next(rows) {
    Next(value, rest) if first -> written(out: write_json(out, value), rows: rest, first: False)
    Next(value, rest) -> written(out: write_json(out: push(buf: out, byte: 44), value), rows: rest, first: False)
    End -> push(buf: out, byte: 93)
  }
}`,
};
// the example in fold_rows's comment, as written there
const comment = raw('std/list.tape').split('\n');
const at = comment.findIndex(l => l.startsWith('fn fold_rows'));
const above = comment.slice(0, at);
const start = above.findLastIndex(l => l.startsWith('//   fn names'));
const example = above
  .slice(start, above.indexOf('//   }', start) + 1)
  .map(l => l.replace(/^\/\/ {3}/, ''))
  .join('\n');
const EXAMPLE = `fn walked(out: Buf) -> Buf {
  names(out)
}

${example}`;

type Served = { answer: string; steps: number };
/** A program with `walk`, after `rows` posts: what GET / answers, and its steps. */
function served(walk: string, rows: number): Served {
  const app = instantiate(moduleOf(built(program(walk))), { sql: nodeSql(), log: true });
  const enc = new TextEncoder(),
    dec = new TextDecoder();
  for (let i = 0; i < rows; i++) app.handle(enc.encode(`POST /\n${JSON.stringify({ name: `n${i}`, qty: i * 3 + 1 })}`));
  const answer = dec
    .decode(app.handle(enc.encode('GET /')))
    .split('\n')
    .slice(1)
    .join('\n');
  const head = app.effects.find(isHead);
  return { answer, steps: head?.steps ?? -1 };
}

for (const n of [0, 1, 3, 10]) {
  const rows = served(SUM.rows, n),
    hand = served(SUM.hand, n),
    range = served(SUM.range, n),
    none = served(SUM.none, n);
  const sum = Array.from({ length: n }, (_, i) => i * 3 + 1).reduce((a, b) => a + b, 0);
  same(`${n} rows: fold_rows answers the sum`, rows.answer, String(sum % 10));
  same(`${n} rows: fold_rows takes a step a row and one more`, rows.steps - none.steps, n + 1);
  same(`${n} rows: fold_rows takes the steps of the recursion written on next()`, rows.steps, hand.steps);
  same(`${n} rows: fold_rows takes the steps of fold over a range that long`, rows.steps, range.steps);

  const json = served(JSON_WAYS.rows, n),
    old = served(JSON_WAYS.hand, n);
  const items = Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `n${i}`, qty: i * 3 + 1 }));
  same(`${n} rows: write_rows writes the rows as JSON`, json.answer, JSON.stringify(items));
  same(`${n} rows: write_rows writes what the recursion it replaced wrote`, json.answer, old.answer);
  same(`${n} rows: write_rows takes the steps of the recursion it replaced`, json.steps, old.steps);

  same(
    `${n} rows: the example in fold_rows's comment writes the names`,
    served(EXAMPLE, n).answer,
    items.map(x => x.name).join(''),
  );
}

finish();
