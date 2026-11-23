// decode's reasons, as LANGUAGE.md section 6 defines them: `<path>: <problem>`, the path a field's name or an
// element's index from the top (`items[2].price`), the problem `missing`, `null` or `expected <what>`, and for a
// refinement its condition (`1 to 64 bytes`). Breaking in 0.4 (they were `items[2]: price: not a Dec[2]`,
// `missing key "qty"`, `not a valid Key`), so each answer here is written from that section, not from a run, and
// the program is run compiled and interpreted, which decode on their own. An Option field that is null is None
// (it was refused).
import '../node25.ts';
import { compile } from '../compiler.ts';
import { instantiate, responseOf } from '../host.ts';
import { interpret } from '../interp.ts';
import { nodeSql } from '../nodesql.ts';
import { std } from '../std.ts';
import { finish, same } from './harness.ts';

const PROGRAM = `type Key = View where len(self) >= 1 and len(self) <= 64
type Qty = Int where self >= 1 and self <= 9
type Rate = Dec[2] where self > 0.00
type Slug = View where every_byte(v: self, keep: is_lower)

type Line { Line(sku: Key, price: Dec[2], qty: Qty) }
type Order {
  Order(key: Key, items: List[Line], note: Option[View], slug: Slug, paid: Bool, at: Option[Int], rate: Option[Rate], grid: List[List[Int]], weight: Option[Float])
}

fn handle(raw: View) -> Buf {
  match decode(json: request(raw).body, as: Order) {
    Ok(value: Order(at: None, note: None)) -> respond(status: 200) |> append(view: "ok, no at, no note")
    Ok -> respond(status: 200) |> append(view: "ok")
    Err(error) -> respond(status: 400) |> append(view: error)
  }
}
`;
const good = { key: 'a', items: [{ sku: 'x', price: '1.50', qty: 1 }], slug: 'ab', paid: true, grid: [] };
const body = (over: Record<string, unknown>): string => JSON.stringify({ ...good, ...over });
const without = (k: string): string =>
  JSON.stringify(Object.fromEntries(Object.entries(good).filter(([n]) => n !== k)));
const line = (over: Record<string, unknown>): unknown => ({ sku: 'x', price: '1.50', qty: 1, ...over });
const cases: readonly (readonly [string, string, string])[] = [
  ['a body that fits', body({}), '200 ok, no at, no note'],
  [
    'an Option that is null is None',
    body({ at: null, note: null, rate: null, weight: null }),
    '200 ok, no at, no note',
  ],
  ['empty', '', '400 empty'],
  ['not JSON', '{', '400 not JSON'],
  ['a body that is not an object', '[]', '400 expected an object'],
  ['missing', without('key'), '400 key: missing'],
  ['null', body({ key: null }), '400 key: null'],
  ['null, of a Bool', body({ paid: null }), '400 paid: null'],
  ['expected text', body({ key: 5 }), '400 key: expected text'],
  ['expected true or false', body({ paid: 'yes' }), '400 paid: expected true or false'],
  ['expected an integer', body({ at: 1.5 }), '400 at: expected an integer'],
  ['expected a number', body({ weight: 'heavy' }), '400 weight: expected a number'],
  ['expected an array', body({ items: {} }), '400 items: expected an array'],
  ['a refinement of a length', body({ key: '' }), '400 key: expected 1 to 64 bytes'],
  ['a refinement of a Dec, lower bound open', body({ rate: '0.00' }), '400 rate: expected more than 0.00'],
  [
    'a condition that is not bounds',
    body({ slug: 'AB' }),
    '400 slug: expected a Slug: every_byte(v: self, keep: is_lower)',
  ],
  ['an element: missing', body({ items: [line({}), { sku: 'y', price: '1.00' }] }), '400 items[1].qty: missing'],
  [
    'an element: a Dec',
    body({ items: [line({ price: '1.505' })] }),
    '400 items[0].price: expected a number with at most 2 decimals',
  ],
  ['an element: a refinement', body({ items: [line({ qty: 0 })] }), '400 items[0].qty: expected 1 to 9'],
  ['an element: null', body({ items: [null] }), '400 items[0]: null'],
  ['an element: not an object', body({ items: [5] }), '400 items[0]: expected an object'],
  ['a list inside a list', body({ grid: [[1], [2, 'x']] }), '400 grid[1][1]: expected an integer'],
  ['kinds before refinements', body({ key: '', paid: 'yes' }), '400 paid: expected true or false'],
];
const r = compile([...std, { name: 'order.tape', text: PROGRAM }]);
same(
  'the program compiles',
  r.errors.map(e => `${e.code} ${e.line}: ${e.message}`),
  [],
);
const app = r.wasm ? instantiate(new WebAssembly.Module(r.wasm), { sql: nodeSql(), log: false }) : null;
const it = interpret([...std, { name: 'order.tape', text: PROGRAM }]);
const enc = new TextEncoder(),
  dec = new TextDecoder();
for (const [what, json, want] of cases) {
  const req = enc.encode(`POST /\n${json}`);
  const got = app ? responseOf(app.handle(req)) : null;
  const theirs = dec.decode(it.handle(req));
  same(
    `${what}: ${want}`,
    [got ? `${got.status} ${dec.decode(got.body)}` : 'does not compile', theirs.replace('\n', ' ')],
    [want, want],
  );
}

finish();
