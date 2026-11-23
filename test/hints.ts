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

finish();
