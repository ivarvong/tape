// Diagnostics that say what to write. Each case is a mistake agents made writing Tape, and each is checked two
// ways: the diagnostic points at the cause (not at a consequence elsewhere), and the code its fix shows, written
// into the program, compiles. The second is the independent check: the compiler, not the text, says the fix works.
import '../node25.ts';
import { compile } from '../compiler.ts';
import { std } from '../std.ts';
import { finish, same } from './harness.ts';

type Said = { code: string; line: number; message: string; hint: string } | 'compiled';
const said = (text: string): Said => {
  const [e] = compile([...std, { name: 't.tape', text }]).errors;
  return e ? { code: e.code, line: e.line, message: e.message, hint: e.hint ?? '' } : 'compiled';
};
const code = (s: Said): string => (s === 'compiled' ? s : `${s.code}:${s.line}`);
const hint = (s: Said): string => (s === 'compiled' ? '' : s.hint);

// ---- C65 and C71 together, when the message carries the row's id (a payment API asks for it). C71 asks that a
// command built from a row name that row in its key; C65 refused a key made only of what the message carries; so
// `once: ForOrder(order: id)` was C65, and its fix, "key it by the id of the row it is for", was the key it had
// refused. A key that names the row by its primary key names the command (same order, same charge): C65 takes it,
// held as a field (`order.id`) or bound by the row's pattern (`Order(id, …)`). A key of the amount alone is
// still C65, the defect the rule is for (the ledger keyed its charge by the amount), and so is an id that is not
// read from a row (test/calls.ts).
{
  const ORDERS = `migration 1 "t" {
  CREATE TABLE orders(id INTEGER PRIMARY KEY, order_key TEXT NOT NULL UNIQUE, amount INTEGER NOT NULL)
}

type Order { Order(id: Int, order_key: View, amount: Int) }
type Charge { Charge(order_id: Int, amount: Int) }
type Charged { Charged(payment: Int) }
type ForOrder { ForOrder(order: Int) }
type ForAmount { ForAmount(amount: Int) }

fn handle(raw: View, db: Sql, payments: Remote) -> Buf {
  let Some(value: order) = sql_first(row: Order, query: "SELECT * FROM orders WHERE id = 1") else -> respond(status: 404)
  let Ok(value: _) = call(to: payments, method: "charge", send: Charge(order_id: order.id, amount: order.amount), reply: Charged, within: 100, once: @KEY) else {
    Err(error) -> respond(status: 502)
  }
  respond(status: 200)
}
`;
  const keyed = (k: string): string => ORDERS.replace('@KEY', k);
  same(
    'C65 takes a key of the row id the message carries (held as a field)',
    said(keyed('ForOrder(order: order.id)')),
    'compiled',
  );
  const BOUND = `migration 1 "t" {
  CREATE TABLE orders(id INTEGER PRIMARY KEY, amount INTEGER NOT NULL)
}

type Order { Order(id: Int, amount: Int) }
type Charge { Charge(order_id: Int, amount: Int) }
type Charged { Charged(payment: Int) }
type ForOrder { ForOrder(order: Int) }
type ForAmount { ForAmount(amount: Int) }

fn handle(raw: View, db: Sql, payments: Remote) -> Buf {
  match sql_first(row: Order, query: "SELECT * FROM orders WHERE id = 1") {
    Some(value: Order(id, amount)) -> charged(reply: call(to: payments, method: "charge", send: Charge(order_id: id, amount), reply: Charged, within: 100, once: @KEY))
    None -> respond(status: 404)
  }
}

fn charged(reply: Result[Charged, CallError]) -> Buf {
  match reply {
    Ok(value) -> respond(status: 201)
    Err(error) -> respond(status: 502)
  }
}
`;
  same("…and bound by the row pattern, C71's form", said(BOUND.replace('@KEY', 'ForOrder(order: id)')), 'compiled');
  const refused = said(keyed('ForAmount(amount: order.amount)'));
  same('a key of the amount alone is still C65', code(refused), 'C65:13');
  same('…bound by the pattern too', code(said(BOUND.replace('@KEY', 'ForAmount(amount)'))), 'C65:13');
  same(
    "C65's fix names forms that pass: the row's primary key, and the message itself",
    [/its primary key/.test(hint(refused)), /the same record as `send:`/.test(hint(refused))],
    [true, true],
  );
}

// ---- a capability no entry point declares. `now()` in a handle with no Clock said "write `now(clock)` with the
// Clock parameter"; written so, it said "unknown name clock: `let clock = …`", which cannot make a Clock. The
// host grants capabilities to an entry point, so the diagnostic is at the call and names the parameter to add.
{
  const cases: readonly (readonly [string, string, string])[] = [
    ['respond(status: 200) |> write_int(value: now())', 'clock: Clock', 'now'],
    ['respond(status: 200) |> write_int(value: now(clock))', 'clock: Clock', 'now'],
    ['respond(status: 200) |> write_int(value: random(from))', 'from: Entropy', 'random'],
    ['respond(status: 200) |> write_int(value: answered())', 'db: Sql', 'sql_first'],
  ];
  const program = (body: string, params: string): string =>
    `type N { N(n: Int) }\n\nfn handle(raw: View${params}) -> Buf {\n  ${body}\n}\n\nfn answered() -> Int {\n  match sql_first(row: N, query: "SELECT 1 AS n") {\n    Some(value: N(n)) -> n\n    None -> 0\n  }\n}\n`;
  for (const [body, param, fn] of cases) {
    const s = said(program(body, body.includes('answered') ? '' : ', db: Sql'));
    same(
      `${fn} with no ${param} anywhere: C72 at the call, naming the parameter handle needs`,
      [code(s), s === 'compiled' ? '' : s.message, hint(s).includes(`\`${param}\` to handle's parameters`)],
      [
        body.includes('answered') ? 'C72:8' : 'C72:4',
        `${fn} needs ${/^[AEIOU]/.test(param.split(': ')[1] ?? '') ? 'an' : 'a'} ${param.split(': ')[1]}, and no entry point declares one`,
        true,
      ],
    );
    same(
      `…and with \`${param}\` added to handle, it compiles`,
      said(program(body, `, db: Sql, ${param}`).replace(', db: Sql, db: Sql', ', db: Sql')),
      'compiled',
    );
  }
}

// ---- a program's function named like a built-in takes its place in the program's files. A helper
// `push(stack, item)` made every call of the built-in push(buf, byte) a C11 at the call, naming neither the
// definition nor the built-in: the diagnostic now says both, and the rename it asks for compiles.
{
  const SHADOW = `fn handle(raw: View) -> Buf {
  respond(status: 200) |> push(byte: 65)
}

fn push(stack: Int, item: Int) -> Int {
  stack + item
}
`;
  const s = said(SHADOW);
  same('the built-in call is refused where it is', code(s), 'C11:2');
  same(
    '…and the fix names the definition and the built-in it takes the place of',
    [hint(s).includes('t.tape:5'), hint(s).includes('the built-in push(buf, byte)')],
    [true, true],
  );
  same(
    'with the program’s function renamed, it compiles',
    said(SHADOW.replace('fn push(', 'fn push_item(')),
    'compiled',
  );
}

// ---- C15 on a field's shorthand: `Missing(stack)` in a function with a parameter `stack` said "stack is already
// defined: pick a new name", though nothing was written with that name but the pattern. The fix says it is the
// field's shorthand and shows the form that binds it to another name, which compiles. Both kinds of type: a
// record of Ints is kept in locals, one with a List in memory.
for (const field of ['Int', 'List[Int]']) {
  const C15 = `type R { Missing(stack: ${field}) Found(at: Int) }

fn depth(stack: ${field}, r: R) -> Int {
  match r {
    Missing(stack) -> 1
    Found(at) -> at
  }
}

fn handle(raw: View) -> Buf {
  respond(status: 200)
}
`;
  const s = said(C15);
  same(`C15 at the shorthand (a field of ${field})`, code(s), 'C15:5');
  same(
    '…and its fix says it is shorthand and shows the rename',
    hint(s).includes('`Missing(stack)` is shorthand for `Missing(stack: stack)`') &&
      hint(s).includes('`Missing(stack: stack_found)`'),
    true,
  );
  same(
    'the rename the fix shows compiles',
    said(C15.replace('Missing(stack) ->', 'Missing(stack: stack_found) ->')),
    'compiled',
  );
}
same(
  'a name bound twice by let keeps the plain C15',
  said('fn f(n: Int) -> Int {\n  let n = 2\n  n\n}\n\nfn handle(raw: View) -> Buf {\n  respond(status: 200)\n}\n'),
  {
    code: 'C15',
    line: 2,
    message: 'n is already defined',
    hint: 'Names are never reused in a function. Pick a new name.',
  },
);

// ---- the line rules, said where they bite. An operator at the end of a line, a computed byte as a pattern and a
// tuple each gave the generic "expected an expression", whose fix lists what an expression is. Each now names its
// rule, and the form its fix shows compiles. (A line that starts with an operator, and an arm's value on the line
// after its arrow, carry the expression on: test/continuation.ts.)
{
  const fn = (body: string): string =>
    `fn f(a: Int, b: Int, o: Option[Int]) -> Int {\n${body}\n}\n\nfn handle(raw: View) -> Buf {\n  respond(status: 200)\n}\n`;
  const s2 = said(fn('  a +\n    b'));
  same(
    'an operator at the end of a line',
    [code(s2), s2 === 'compiled' ? '' : s2.message],
    ['P02:2', 'an expression does not go on past the end of a line after `+`'],
  );
  same(
    'the forms the fix names compile: the operator starting the next line, `let` parts, parentheses',
    [said(fn('  a\n    + b')), said(fn('  let part = a\n  part + b')), said(fn('  (a +\n    b)'))],
    ['compiled', 'compiled', 'compiled'],
  );
  same('a negative number arm is still a pattern', said(fn('  match a {\n    -1 -> 1\n    _ -> 0\n  }')), 'compiled');
  const s4 = said(
    'fn handle(raw: View) -> Buf {\n  match raw[0] {\n    "*"[0] -> respond(status: 200)\n    _ -> respond(status: 404)\n  }\n}\n',
  );
  same(
    'a computed byte as a pattern: P01, with the byte its text is',
    [code(s4), hint(s4).includes('`42 ->`')],
    ['P01:3', true],
  );
  same(
    '…and the number, or a guard, compiles',
    [
      said(
        'fn handle(raw: View) -> Buf {\n  match raw[0] {\n    42 -> respond(status: 200)\n    _ -> respond(status: 404)\n  }\n}\n',
      ),
      said(
        'fn handle(raw: View) -> Buf {\n  match raw[0] {\n    b if b == "*"[0] -> respond(status: 200)\n    _ -> respond(status: 404)\n  }\n}\n',
      ),
    ],
    ['compiled', 'compiled'],
  );
  const s5 = said(fn('  match (a, b) {\n    _ -> 0\n  }'));
  same(
    'a tuple: P02 that says Tape has none',
    [code(s5), s5 === 'compiled' ? '' : s5.message],
    ['P02:2', 'Tape has no tuples: values in parentheses with commas are not one value'],
  );
  same(
    '…and the record its fix shows compiles',
    said(
      `type Pair { Pair(a: Int, b: Int) }\n\n${fn('  match Pair(a, b) {\n    Pair(a: 1, b: 2) -> 1\n    _ -> 0\n  }')}`,
    ),
    'compiled',
  );
}

// ---- a keyword of SQL where a name goes. `SELECT src AS from` (a row type with fields from and to, as a transfer
// has) was C67 "expected a column alias at "from"", with the fix for SQL outside the checker's subset (no WITH, no
// triggers…). The message now says it is a keyword, the fix says to quote it, and the quoted form compiles.
{
  const ALIAS = `schema "CREATE TABLE tr(id INTEGER PRIMARY KEY, src TEXT NOT NULL, dst TEXT NOT NULL)"

type Tr { Tr(from: View, to: View) }

fn handle(raw: View, db: Sql) -> Buf {
  match sql_first(row: Tr, query: "SELECT src AS from, dst AS to FROM tr WHERE id = 1") {
    Some(value) -> respond(status: 200) |> append(view: value.from)
    None -> respond(status: 404)
  }
}
`;
  const s = said(ALIAS);
  same(
    'C67 names the keyword',
    [code(s), s === 'compiled' ? '' : s.message],
    ['C67:6', 'sql_first cannot take this query: expected a column alias at "from", which is a keyword of SQL'],
  );
  same('…and its fix shows it quoted', hint(s).includes('AS "from"'), true);
  same(
    'the quoted form compiles',
    said(ALIAS.replace('AS from, dst AS to', 'AS \\"from\\", dst AS \\"to\\"')),
    'compiled',
  );
}

// ---- C88 says why the write it refuses `repeat: True` on is safe already. It said only "a second run of its
// statement changes nothing more", which reads as false for `balance = balance - :amount` (safe because it runs
// after the transfer's claim) and gave no rule to learn. Each reason is checked on the shape the bench's agents
// wrote, and each program compiles with the argument taken out, as the fix says.
{
  const PROG = `migration 1 "t" {
  CREATE TABLE a(id TEXT PRIMARY KEY NOT NULL, balance INTEGER NOT NULL CHECK (balance >= 0));
  CREATE TABLE tr(id TEXT PRIMARY KEY NOT NULL);
  CREATE TABLE k(key TEXT PRIMARY KEY NOT NULL, used INTEGER NOT NULL)
}

fn handle(raw: View, db: Sql) -> Buf {
  match request(raw) {
    Request(path: "/t/" ++ id) -> moved(id)
    Request(path: "/k/" ++ key) -> counted(key, used: len(key))
    _ -> respond(status: 404)
  }
}

fn moved(id: View) -> Buf {
  let 1 = sql_exec(query: "INSERT INTO tr(id) VALUES (:id) ON CONFLICT(id) DO NOTHING", id) else -> respond(status: 200)
  let 1 = sql_exec(query: "UPDATE a SET balance = balance - 5 WHERE id = :id AND balance >= 5", id@DEBIT) else -> rollback(out: respond(status: 409))
  respond(status: 201)
}

fn counted(key: View, used: Int) -> Buf {
  do sql_exec(query: "UPDATE k SET used = :used WHERE key = :key", key, used@SET)
  do sql_exec(query: "INSERT INTO k(key, used) VALUES (:key, 0) ON CONFLICT(key) DO NOTHING", key@INSERT)
  respond(status: 200)
}
`;
  const at = (mark: string): string =>
    ['@DEBIT', '@SET', '@INSERT'].reduce((t, m) => t.replace(m, m === mark ? ', repeat: True' : ''), PROG);
  const cases: readonly (readonly [string, number, string])[] = [
    ['@DEBIT', 17, 'it runs only after an op-id claim'],
    ['@SET', 22, 'every column it sets is given a value, none computed from the row it changes'],
    ['@INSERT', 23, 'it inserts a whole unique key of k (key)'],
  ];
  for (const [mark, line, why] of cases) {
    const s = said(at(mark));
    same(
      `C88 says why the write is safe (${why.split(',')[0]})`,
      [code(s), s === 'compiled' ? '' : s.message.includes(`changes nothing more: ${why}`)],
      [`C88:${line}`, true],
    );
  }
  same('…and with the argument out, as the fix says, it compiles', said(at('none')), 'compiled');
}

// ---- C55 for a create meant to make a row each time. A spec where two POSTs of one title make two rows has no
// client key, and C55's fix offered `repeat: True` only "if every attempt is meant to count", which reads as a
// counter: agents found the opt-out by guessing (5 reports). The fix names the case, and the call compiles with it.
{
  const TODO = `schema "CREATE TABLE todos(id INTEGER PRIMARY KEY, title TEXT NOT NULL)"

type Todo { Todo(id: Int, title: View) }

fn handle(raw: View, db: Sql) -> Buf {
  match sql_first(row: Todo, query: "INSERT INTO todos(title) VALUES (:title) RETURNING *", title: request(raw).path@R) {
    Some(value) -> respond(status: 201) |> write_json(value)
    None -> respond(status: 500)
  }
}
`;
  const s = said(TODO.replace('@R', ''));
  same('C55 on an INSERT with no client key', code(s), 'C55:6');
  same(
    '…and its fix names a create meant to make a new row each time',
    hint(s).includes('a new row on each call'),
    true,
  );
  same(
    '…with `repeat: True` on the call, as it says, it compiles',
    said(TODO.replace('@R', ', repeat: True')),
    'compiled',
  );
}

// ---- a std function that went is named as gone, with what does its job now. A program written before 23
// November (an ephemeris with `digits(n)` in its routes, a renderer with `write_each`) was told "unknown function
// digits: a lowercase name with parentheses in a pattern is a function that returns Option", or "did you mean
// write_esc?". Each replacement the fix names compiles.
{
  const ROUTE =
    'fn handle(raw: View) -> Buf {\n  match request(raw).path {\n    "/n/" ++ @F(n) -> respond(status: 200) |> write_int(value: n)\n    _ -> respond(status: 404)\n  }\n}\n';
  const s1 = said(ROUTE.replace('@F', 'digits'));
  same(
    'digits in a pattern: C22 that says it went',
    [code(s1), hint(s1).startsWith('std `digits` went')],
    ['C22:3', true],
  );
  same('…and `decimal(n)`, which it names, compiles', said(ROUTE.replace('@F', 'decimal')), 'compiled');
  const BY = 'by: fn(out: Buf, item: Int) -> Buf { out |> write_int(value: item) }';
  const s2 = said(
    `fn handle(raw: View) -> Buf {\n  respond(status: 200) |> write_each(list: Cons(head: 1, tail: Nil), ${BY})\n}\n`,
  );
  same(
    'write_each in a call: C22 that says it went',
    [code(s2), hint(s2).startsWith('std `write_each` went')],
    ['C22:2', true],
  );
  same(
    '…and the fold it names compiles',
    said(
      `fn handle(raw: View) -> Buf {\n  fold(list: Cons(head: 1, tail: Nil), from: respond(status: 200), ${BY})\n}\n`,
    ),
    'compiled',
  );
}

// ---- C54's fix and C88 agree. C54 listed the claim-first form and `repeat: True` side by side; an agent did both
// (the claim, then `repeat: True` on the debit) and C88 refused the flag, a second round trip to learn that the claim
// alone was enough. The fix says each guard is enough alone and that `repeat: True` is for a write none applies to;
// the claim alone compiles, and the claim with the flag is still C88, as the fix now says it is.
{
  const CREDIT = `migration 1 "t" {
  CREATE TABLE a(id TEXT PRIMARY KEY NOT NULL, balance INTEGER NOT NULL);
  CREATE TABLE tr(id TEXT PRIMARY KEY NOT NULL)
}

fn handle(raw: View, db: Sql) -> Buf {
  let id = request(raw).path
  @CLAIM
  do sql_exec(query: "UPDATE a SET balance = balance + 5 WHERE id = :id", id@R)
  respond(status: 200)
}
`;
  const CLAIM =
    'let 1 = sql_exec(query: "INSERT INTO tr(id) VALUES (:id) ON CONFLICT(id) DO NOTHING", id) else -> respond(status: 200)';
  const s = said(CREDIT.replace('@CLAIM', '').replace('@R', ''));
  same('C54 on the credit with no claim', code(s), 'C54:9');
  same(
    '…and its fix says each guard is enough alone, so repeat: True is not added to one (C88)',
    hint(s).includes('Any one of these is enough: with it, `repeat: True` is refused (C88)'),
    true,
  );
  same('the claim alone compiles', said(CREDIT.replace('@CLAIM', CLAIM).replace('@R', '')), 'compiled');
  same(
    'the claim with repeat: True is C88, as the fix says',
    code(said(CREDIT.replace('@CLAIM', CLAIM).replace('@R', ', repeat: True'))),
    'C88:9',
  );
}

// ---- a reserved word called before its definition is read. `flag(True)` in handle, above `fn flag`, was P02
// "expected an expression but found `flag`" (the P01 that names the reserved word comes only at the definition).
{
  const FLAG =
    'fn handle(raw: View) -> Buf {\n  respond(status: 200) |> write_int(value: flag(b: True))\n}\n\nfn flag(b: Bool) -> Int {\n  1\n}\n';
  const s1 = said(FLAG);
  same(
    'a reserved word called: P02 that says so',
    [code(s1), s1 === 'compiled' ? '' : s1.message],
    ['P02:2', '`flag` is a reserved word, so no function has that name'],
  );
  same(
    '…and renamed where it is defined and called, as the fix says, it compiles',
    said(FLAG.replaceAll('flag(', 'flag_(')),
    'compiled',
  );
}

// ---- C65 and a row passed in as a parameter. The exemption for a key naming the row's primary key saw the row's
// pattern (`Order(id, …)`) and a field of a row read in the same function, not a field of a row the function is
// given: `fn charge(order: Order)` with `once: ForOrder(order: order.id)` was still C65 (2 Haiku orders runs), and
// the fix text wrote that very key. Both forms of a parameter row are taken; a key of the amount is still C65.
{
  const PARAM = `migration 1 "t" {
  CREATE TABLE orders(id INTEGER PRIMARY KEY, amount INTEGER NOT NULL)
}

type Order { Order(id: Int, amount: Int) }
type Charge { Charge(order_id: Int, amount: Int) }
type Charged { Charged(payment: Int) }
type ForOrder { ForOrder(order: Int) }
type ForAmount { ForAmount(amount: Int) }

fn handle(raw: View, db: Sql, payments: Remote) -> Buf {
  match sql_first(row: Order, query: "SELECT * FROM orders WHERE id = 1") {
    Some(value) -> charge(order: value)
    None -> respond(status: 404)
  }
}

fn charge(order: Order) -> Buf {
  @BODY
}

fn charged(reply: Result[Charged, CallError]) -> Buf {
  match reply {
    Ok(value) -> respond(status: 201)
    Err(error) -> respond(status: 502)
  }
}
`;
  const field = (key: string): string =>
    PARAM.replace(
      '@BODY',
      `charged(reply: call(to: payments, method: "charge", send: Charge(order_id: order.id, amount: order.amount), reply: Charged, within: 100, once: ${key}))`,
    );
  const bound = (key: string): string =>
    PARAM.replace(
      '@BODY',
      `let Order(id, amount) = order\n  charged(reply: call(to: payments, method: "charge", send: Charge(order_id: id, amount), reply: Charged, within: 100, once: ${key}))`,
    );
  same(
    'a parameter row: its primary key as a field compiles, and bound by its pattern',
    [said(field('ForOrder(order: order.id)')), said(bound('ForOrder(order: id)'))],
    ['compiled', 'compiled'],
  );
  same(
    '…and a key of its amount is still C65, both ways',
    [code(said(field('ForAmount(amount: order.amount)'))), code(said(bound('ForAmount(amount)')))],
    ['C65:19', 'C65:20'],
  );
}

finish();
