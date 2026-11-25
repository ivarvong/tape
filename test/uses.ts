// test/uses.ts: a function's signature says which capabilities it reaches (issue #15). A function that is not an
// entry point and uses a capability by name, itself or through a function it calls, writes `uses` and those names
// after its result type, in alphabetical order; one that reaches none writes none; an entry point declares each as
// a parameter and writes none (C101 for each, with the clause to write). `tape fmt` writes the clause, and only
// when the program compiles otherwise. The clause is checked, not compiled: the module is the same without it.
import '../node25.ts';
import { compile } from '../compiler.ts';
import { format, usesStripped, usesWritten } from '../fmt.ts';
import { built, codes, finish, ok, problems, same, std } from './harness.ts';

const PROGRAM = `migration 1 "orders" {
  CREATE TABLE orders(id INTEGER PRIMARY KEY, amount INTEGER NOT NULL)
}

type Order {
  Order(id: Int, amount: Int)
}

fn handle(raw: View, db: Sql, clock: Clock) -> Response {
  match shown(id: 1) {
    Some(value) -> json(status: 200, value)
    None -> empty(status: 404)
  }
}

fn shown(id: Int) -> Option[Order] uses clock, db {
  let _ = now()
  load(id)
}

fn load(id: Int) -> Option[Order] uses db {
  sql_first(row: Order, query: "SELECT * FROM orders WHERE id = :id", id)
}

fn doubled(n: Int) -> Int {
  n * 2
}
`;
const swap = (text: string, from: string, to: string): string => {
  if (!text.includes(from)) throw new Error(`not found: ${from}`);
  return text.replace(from, to);
};
const first = (text: string) => problems(text)[0];

same('a program whose clauses are as inferred compiles', codes(PROGRAM), []);

// ---- a helper with no clause that reaches db through another helper: the fix is the clause
{
  const bare = swap(PROGRAM, 'Option[Order] uses clock, db {', 'Option[Order] {');
  const e = first(bare);
  same('no clause on a function that reaches db through load: C101 at it', codes(bare), ['C101:16']);
  same('…saying the path', e?.message, 'shown uses the capability clock (shown), and its signature does not say so');
  same(
    '…and the clause to write, every capability it reaches in alphabetical order',
    e?.hint,
    "Write `uses clock, db` after shown's result type: `fn shown(…) -> Option[Order] uses clock, db {`. `tape fmt` writes it.",
  );
  const half = swap(PROGRAM, 'Option[Order] uses clock, db {', 'Option[Order] uses clock {');
  same(
    'a clause without db, which shown reaches only through load: C101 names the path',
    first(half)?.message,
    'shown uses the capability db (shown → load), and its signature does not say so',
  );
}

// ---- a clause that names what the function does not reach
{
  const extra = swap(PROGRAM, 'fn doubled(n: Int) -> Int {', 'fn doubled(n: Int) -> Int uses db {');
  same('a clause on a function that reaches nothing: C101', codes(extra), ['C101:25']);
  same('…naming it', first(extra)?.message, 'doubled names db in its `uses`, and does not reach it by name');
  same('…and the fix takes the clause away', first(extra)?.hint, 'Remove `uses db`: `fn doubled(…) -> Int {`.');
  const more = swap(PROGRAM, 'Option[Order] uses db {', 'Option[Order] uses clock, db {');
  same(
    'a capability more than it reaches: C101 names it',
    first(more)?.message,
    'load names clock in its `uses`, and does not reach it by name',
  );
  const order = swap(PROGRAM, 'Option[Order] uses clock, db {', 'Option[Order] uses db, clock {');
  same(
    'the right names in another order: C101, and the order to write',
    [first(order)?.message, first(order)?.hint.slice(0, 26)],
    [
      'shown writes `uses db, clock`: a clause names each capability once, in alphabetical order',
      'Write `uses clock, db` aft',
    ],
  );
  // a capability passed as a parameter is in the signature already
  const param = swap(
    swap(
      PROGRAM,
      'fn load(id: Int) -> Option[Order] uses db {',
      'fn load(id: Int, db: Sql) -> Option[Order] uses db {',
    ),
    '  load(id)\n',
    '  load(id, db)\n',
  );
  same(
    'a clause that names a parameter: C101',
    first(param)?.message,
    'load names db in its `uses`, and db is its parameter: its signature says so already',
  );
  same('…which compiles without it', codes(swap(param, 'Option[Order] uses db {', 'Option[Order] {')), []);
}

// ---- a clause on an entry point
{
  const entry = swap(PROGRAM, '-> Response {', '-> Response uses db {');
  same('a clause on handle: C101', codes(entry), ['C101:9']);
  same(
    '…saying an entry point declares its capabilities as parameters',
    first(entry)?.message,
    'handle is an entry point, and writes `uses db`: an entry point declares its capabilities as parameters',
  );
  const exported = `${PROGRAM}
type Q {
  Q(id: Int)
}

type Missing {
  NoSuchOrder
}

export fn peek(db: Sql, clock: Clock, message: Q) -> Result[Order, Missing] uses db {
  let Q(id) = message
  match load(id) {
    Some(value) -> Ok(value)
    None -> Err(error: NoSuchOrder)
  }
}
`;
  same('…and on an exported function', codes(exported), ['C101:37']);
}

// ---- `uses` is a word only where a clause stands
{
  const named = `fn handle(raw: View) -> Response {
  let uses = len(raw)
  empty(status: 200 + uses)
}
`;
  same('a variable may be named uses', codes(named), []);
  same('a clause names at least one capability', codes(swap(PROGRAM, 'uses db {', 'uses {'))[0]?.slice(0, 4), 'P01:');
}

// ---- fmt writes the clause
{
  const bare = usesStripped(PROGRAM);
  ok('the program with no clause has none', !bare.includes(' uses '));
  same('fmt with std writes each clause as inferred', format(bare, 'p.tape', std), PROGRAM);
  same('…and formatting again changes nothing', format(PROGRAM, 'p.tape', std), PROGRAM);
  const wrong = swap(
    swap(PROGRAM, 'Option[Order] uses clock, db {', 'Option[Order] uses db, http {'),
    'fn doubled(n: Int) -> Int {',
    'fn doubled(n: Int) -> Int uses clock {',
  );
  same(
    'fmt corrects a wrong clause and takes away one on a function that reaches nothing',
    format(wrong, 'p.tape', std),
    PROGRAM,
  );
  same(
    'fmt takes a clause off an entry point',
    format(swap(PROGRAM, '-> Response {', '-> Response uses clock, db {'), 'p.tape', std),
    PROGRAM,
  );
  same('a file formatted alone keeps its clauses as written', format(bare, 'p.tape'), bare);
  const broken = swap(bare, 'n * 2', 'n * "2"');
  same('a program refused for another reason keeps them too', format(broken, 'p.tape', std).includes(' uses '), false);
  same('usesWritten puts them back without laying a line out again', usesWritten(bare, 'p.tape', std), PROGRAM);
}

// ---- checked, not compiled: the module is the same, but for the build id (a hash of the source text)
{
  const a = built(PROGRAM),
    b = compile([...std, { name: 'program.tape', text: usesStripped(PROGRAM) }], { rules: false });
  const masked = (wasm: Uint8Array, id: string): string =>
    Buffer.from(wasm).toString('latin1').replaceAll(id, '#'.repeat(id.length));
  ok(
    'the module with the clauses is the module without them, byte for byte but for the build id',
    b.wasm !== null && masked(a.wasm, a.build) === masked(b.wasm, b.build) && a.build !== b.build,
  );
}

finish();
