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

// ---- C65 when the message carries the row's id: its fix once said "key it by the id of the row it is for", which
// is the key it had just refused. A key of that id alone adds nothing the message does not say; the forms that
// pass are the message itself, or the row's id with what the message does not carry (C71 wants the id).
{
  const ORDERS = `migration 1 "t" {
  CREATE TABLE orders(id INTEGER PRIMARY KEY, order_key TEXT NOT NULL UNIQUE, amount INTEGER NOT NULL)
}

type Order { Order(id: Int, order_key: View, amount: Int) }
type Charge { Charge(order_id: Int, amount: Int) }
type Charged { Charged(payment: Int) }
type ForOrder { ForOrder(order: Int) }
type ForOrderKey { ForOrderKey(order: Int, key: View) }

fn handle(raw: View, db: Sql, payments: Remote) -> Buf {
  let Some(value: order) = sql_first(row: Order, query: "SELECT * FROM orders WHERE id = 1") else -> respond(status: 404)
  let Ok(value: _) = call(to: payments, method: "charge", send: Charge(order_id: order.id, amount: order.amount), reply: Charged, within: 100, once: @KEY) else {
    Err(error) -> respond(status: 502)
  }
  respond(status: 200)
}
`;
  const keyed = (k: string): string => ORDERS.replace('@KEY', k);
  const refused = said(keyed('ForOrder(order: order.id)'));
  same('C65: a key of the row id the message carries is refused', code(refused), 'C65:13');
  same(
    "C65's fix does not offer the key it refused (the row's id alone)",
    /the id of the row it is for/.test(hint(refused)),
    false,
  );
  same(
    "C65's fix names both forms that pass: the message itself, and the row's id with a key the client sent",
    [/the same record as `send:`/.test(hint(refused)), /the row's id and/.test(hint(refused))],
    [true, true],
  );
  same(
    'each form the fix names compiles (C65 and C71 alike)',
    [
      said(keyed('Charge(order_id: order.id, amount: order.amount)')),
      said(keyed('ForOrderKey(order: order.id, key: order.order_key)')),
    ],
    ['compiled', 'compiled'],
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

finish();
