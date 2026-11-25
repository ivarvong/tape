// C95: a request sent twice claims one row, not two (apps/queue/FRICTION.md, entry 7: a `POST /lease` heard twice
// took two jobs). An UPDATE a request reaches that takes a row chosen by a column it changes, by a query before it
// or a subquery in it, is refused unless the request's key is written into the row and read back first, an op id
// keyed by the request is claimed before it, or `repeat: True` says each request takes another row. The rule is
// docs/design.md's "A claim keyed by the request: C95".
import '../node25.ts';
import { finish, lineOf, problems, raw, same as T, swap } from './harness.ts';

const codes = (text: string, name = 'program.tape'): string[] =>
  problems(text, {}, name).map(e => `${e.code}:${e.line}`);
const edit = (text: string, pairs: readonly (readonly [string, string])[]): string =>
  pairs.reduce((t, [a, b]) => swap(t, a, b), text);

// ---- 1. the queue: as it is, accepted; the reproduction (the lease key taken out of the claim), refused
const queue = raw('apps/queue/queue.tape');
const LOOKUP = [
  '  let None = sql_first(row: Job, query: "SELECT * FROM jobs WHERE lease = :key", key) else {\n    Some(value) -> Shown(status: 200, job: value)\n  }\n',
  '',
] as const;
const SET = [
  ['worker = :worker, lease = \\\n        :key, lease_until', 'worker = :worker, lease_until'],
  ['    worker,\n    key,\n    lease_until: now() + for_ms,', '    worker,\n    lease_until: now() + for_ms,'],
] as const;
const CLAIM = 'let Moved(value: job) = sql_move(';
T('apps/queue/queue.tape as it is: accepted', codes(queue, 'queue.tape'), []);
{
  const text = edit(queue, [LOOKUP]);
  T('the lease not read back by its key first: C95 at the claim', codes(text, 'queue.tape'), [
    `C95:${lineOf(text, CLAIM)}`,
  ]);
  T(
    'the message names the choice and what goes wrong',
    /takes a jobs row chosen by state, which it changes \(the query that chose its row, line \d+\): sent again, the same request finds another row/.test(
      problems(text, {}, 'queue.tape')[0]?.message ?? '',
    ),
    true,
  );
}
{
  const text = edit(queue, SET);
  T('the lease key not written into the row: C95', codes(text, 'queue.tape'), [`C95:${lineOf(text, CLAIM)}`]);
}
{
  const text = edit(queue, [LOOKUP, ...SET]);
  T('neither: C95', codes(text, 'queue.tape'), [`C95:${lineOf(text, CLAIM)}`]);
}

// ---- 2. a seat taken by one statement, its row chosen by a subquery; and the forms that are accepted
const seats = (grab: string, woken = '', extra = ''): string => `migration 1 "seats" {
  CREATE TABLE seats(id INTEGER PRIMARY KEY, state TEXT NOT NULL DEFAULT 'free', buyer TEXT NOT NULL DEFAULT '');
  CREATE TABLE ops(op TEXT PRIMARY KEY NOT NULL)
}

type Seat { Seat(id: Int, state: View, buyer: View) }
type Grab { Grab(key: View) }
type Count { Count(n: Int) }

fn handle(raw: View, db: Sql, timer: Timer) -> Response {
  match request(raw) {
    Request(method: Post, path: "/grab", body) -> {
      let Ok(value: Grab(key)) = decode(json: body, as: Grab) else -> empty(status: 400)
      ${grab}
    }
    Request(method: Post, path: "/seats/" ++ decimal(id) ++ "/take") -> buf()
      |> write_int(value: take(id, buyer: "door")) |> respond(status: 200)
    _ -> empty(status: 404)
  }
}

export fn woken(db: Sql, timer: Timer, message: Wake) -> Result[Count, View] {
  let Wake(key) = message
  ${woken || 'Ok(value: Count(n: key))'}
}

fn take(id: Int, buyer: View) -> Int uses db {
  sql_exec(
    query: "UPDATE seats SET state = 'taken', buyer = :buyer WHERE id = :id AND state = 'free'",
    buyer,
    id
  )
}
${extra}`;
const ONE = `buf() |> write_int(value: sql_exec(
        query: "UPDATE seats SET state = 'taken', buyer = :key WHERE id = (SELECT id FROM seats WHERE state = 'free' ORDER BY id LIMIT 1) AND state = 'free'",
        key
      )) |> respond(status: 200)`;
const NEXT = `let Some(value: Seat(id)) = sql_first(row: Seat, query: "SELECT * FROM seats WHERE state = 'free' ORDER BY id LIMIT 1") else -> empty(status: 204)`;
T('the seats program, taking by its key alone: accepted', codes(seats('empty(status: 200)')), []);
{
  const text = seats(ONE);
  T('a seat taken by one UPDATE whose subquery picks the next free one: C95', codes(text), [
    `C95:${lineOf(text, 'buf() |> write_int(value: sql_exec(')}`,
  ]);
  T(
    '…and with `repeat: True` (each request is meant to take another): accepted, and not C88',
    codes(text.replace('        key\n      ))', '        key,\n        repeat: True\n      ))')),
    [],
  );
}
{
  const text = seats(`${NEXT}\n      buf() |> write_int(value: take(id, buyer: key)) |> respond(status: 200)`);
  T('the next free seat chosen by a query, then taken by its id: C95 at the UPDATE', codes(text), [
    `C95:${lineOf(text, '  sql_exec(\n    query: "UPDATE seats SET state')}`,
  ]);
}
T(
  'the same, the buyer read back by the key first: accepted',
  codes(
    seats(
      `let None = sql_first(row: Seat, query: "SELECT * FROM seats WHERE buyer = :key", key) else -> empty(status: 200)\n      ${NEXT}\n      buf() |> write_int(value: take(id, buyer: key)) |> respond(status: 200)`,
    ),
  ),
  [],
);
T(
  "the same, after a claim of the request's key as an op id: accepted",
  codes(
    seats(
      `let 1 = sql_exec(query: "INSERT INTO ops(op) VALUES (:key) ON CONFLICT(op) DO NOTHING", key) else -> empty(status: 200)\n      ${NEXT}\n      buf() |> write_int(value: take(id, buyer: key)) |> respond(status: 200)`,
    ),
  ),
  [],
);
{
  // an op id made from the row chosen is another op id on another row: a second run chooses another seat
  const text = seats(
    `${NEXT}\n      let 1 = sql_exec(query: "INSERT INTO ops(op) VALUES (:op) ON CONFLICT(op) DO NOTHING", op: "seat-\\(id)") else -> empty(status: 200)\n      buf() |> write_int(value: take(id, buyer: key)) |> respond(status: 200)`,
  );
  T('the same, after a claim of an op id made from the seat chosen: C95', codes(text), [
    `C95:${lineOf(text, '  sql_exec(\n    query: "UPDATE seats SET state')}`,
  ]);
}
T(
  "the next free seat taken only by a timer's run (a sweep takes the next on each run): accepted",
  codes(
    seats(
      'empty(status: 200)',
      `let Some(value: Seat(id)) = sql_first(row: Seat, query: "SELECT * FROM seats WHERE state = 'free' ORDER BY id LIMIT 1") else -> Ok(value: Count(n: 0))\n  Ok(value: Count(n: take(id, buyer: "sweep")))`,
    ),
  ),
  [],
);

finish();
