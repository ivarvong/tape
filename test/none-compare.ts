// `x == None` and `x != None` on an Option compare its constructor: True when it is None (or, for !=, when it holds a
// value). Five bench runs in two rounds and two reports wrote `title != None` in a guard (`let True = title != None
// or done != None else …`) and were refused with C19. Any other comparison with None stays C19 (`x < None`), as does
// `==` of two Options, whose values the comparison would have to look into. Compiled and interpreted, each answer
// written here from that rule.
import '../node25.ts';
import { compile } from '../compiler.ts';
import { instantiate, responseOf } from '../host.ts';
import { interpret } from '../interp.ts';
import { nodeSql } from '../nodesql.ts';
import { std } from '../std.ts';
import { finish, same, answered } from './harness.ts';

const PROGRAM = `type Patch { Patch(title: Option[View], done: Option[Bool], at: Option[Int]) }

fn handle(raw: View) -> Response {
  let Ok(value: Patch(title, done, at)) = decode(json: request(raw).body, as: Patch) else -> empty(status: 400)
  let True = title != None or done != None else -> buf() |> append(view: "nothing to change") |> respond(status: 400)
  buf()
    |> append(view: said(b: title == None))
    |> append(view: said(b: None == done))
    |> append(view: said(b: None != at))
    |> append(view: said(b: missing(x: at))) |> respond(status: 200)
}

fn said(b: Bool) -> View {
  match b {
    True -> "T"
    False -> "F"
  }
}

// a Bool from a comparison, passed on
fn missing(x: Option[Int]) -> Bool {
  x == None
}
`;
const cases: readonly (readonly [string, string])[] = [
  ['{}', '400 nothing to change'],
  ['{"title":null,"done":null}', '400 nothing to change'],
  ['{"title":"a"}', '200 FTFT'],
  ['{"done":false}', '200 TFFT'],
  ['{"title":"a","done":true,"at":3}', '200 FFTF'],
  ['{"done":true,"at":0}', '200 TFTF'],
];
const r = compile([...std, { name: 'patch.tape', text: PROGRAM }]);
same(
  'Option == None and != None compile',
  r.errors.map(e => `${e.code} ${e.line}: ${e.message}`),
  [],
);
const app = r.wasm ? instantiate(new WebAssembly.Module(r.wasm), { sql: nodeSql(), log: false }) : null;
const it = interpret([...std, { name: 'patch.tape', text: PROGRAM }]);
const enc = new TextEncoder(),
  dec = new TextDecoder();
for (const [json, want] of cases) {
  const req = enc.encode(`PATCH /\n${json}`);
  const got = app ? responseOf(app.handle(req)) : null;
  same(
    `${json}: ${want}`,
    [got ? `${got.status} ${dec.decode(got.body)}` : 'does not compile', answered(it.handle(req)).replace('\n', ' ')],
    [want, want],
  );
}

// what stays refused: another comparison with None, == of two Options, None against what is not an Option
const said = (body: string): string => {
  const [e] = compile([
    ...std,
    { name: 't.tape', text: `${body}\n\nfn handle(raw: View) -> Response {\n  empty(status: 200)\n}\n` },
  ]).errors;
  return e ? `${e.code}: ${e.message}` : 'compiled';
};
same('x < None: C19', said('fn f(x: Option[Int]) -> Bool {\n  x < None\n}').slice(0, 4), 'C19:');
same(
  'two Options compared: C19',
  said('fn f(x: Option[Int], y: Option[Int]) -> Bool {\n  x == y\n}').slice(0, 4),
  'C19:',
);
same('an Int against None: C19', said('fn f(x: Int) -> Bool {\n  x == None\n}').slice(0, 4), 'C19:');

finish();
