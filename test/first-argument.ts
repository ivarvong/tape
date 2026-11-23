// A call's first argument may be written without its name, and passes the first parameter: `every_byte(self, keep:
// is_lower)` is `every_byte(v: self, keep: is_lower)`. `every_byte(self, …)` was refused 13 times in 4 bench rounds
// and outlived every doc fix. The one rule beside it, as before: a bare name that is one of the callee's parameters
// passes that parameter (`sub(b, a: 10)` is `sub(b: b, a: 10)`). Every argument after the first is named or such a
// name. Compiled and interpreted, each answer written from the rule.
import '../node25.ts';
import { compile } from '../compiler.ts';
import { instantiate, responseOf } from '../host.ts';
import { interpret } from '../interp.ts';
import { nodeSql } from '../nodesql.ts';
import { std } from '../std.ts';
import { finish, same } from './harness.ts';

const PROGRAM = `type Slug = View where len(self) >= 1 and every_byte(self, keep: is_lower)

fn sub(a: Int, b: Int) -> Int {
  a - b
}

fn joined(url: View, slug: View) -> View {
  url ++ "/" ++ slug
}

fn handle(raw: View) -> Buf {
  let b = 3
  let s = "ab"
  match request(raw).path {
    "/sub" -> respond(status: 200) |> write_int(value: sub(10, b: 4))
    "/expr" -> respond(status: 200) |> write_int(value: sub(2 * 5, b))
    "/name" -> respond(status: 200) |> write_int(value: sub(b, a: 10))
    "/join" -> respond(status: 200) |> append(view: joined("u", slug: s))
    "/slug/" ++ Slug(v) -> respond(status: 200) |> append(view: v)
    _ -> respond(status: 404)
  }
}
`;
const cases: readonly (readonly [string, string])[] = [
  ['GET /sub', '200 6'], // sub(a: 10, b: 4)
  ['GET /expr', '200 7'], // sub(a: 2 * 5, b: b)
  ['GET /name', '200 7'], // b is a parameter's name: sub(b: 3, a: 10)
  ['GET /join', '200 u/ab'],
  ['GET /slug/abc', '200 abc'],
  ['GET /slug/aBc', '404 '],
];
const r = compile([...std, { name: 'calls.tape', text: PROGRAM }]);
same(
  'a first argument without its name compiles',
  r.errors.map(e => `${e.code} ${e.line}: ${e.message}`),
  [],
);
const app = r.wasm ? instantiate(new WebAssembly.Module(r.wasm), { sql: nodeSql(), log: false }) : null;
const it = interpret([...std, { name: 'calls.tape', text: PROGRAM }]);
const enc = new TextEncoder(),
  dec = new TextDecoder();
for (const [request, want] of cases) {
  const req = enc.encode(request);
  const got = app ? responseOf(app.handle(req)) : null;
  same(
    `${request}: ${want}`,
    [got ? `${got.status} ${dec.decode(got.body)}` : 'does not compile', dec.decode(it.handle(req)).replace('\n', ' ')],
    [want, want],
  );
}

// what stays refused: an argument after the first with no name, and a bare name that is no parameter after the first
const said = (body: string): string => {
  const [e] = compile([
    ...std,
    {
      name: 't.tape',
      text: `fn sub(a: Int, b: Int) -> Int {\n  a - b\n}\n\n${body}\n\nfn handle(raw: View) -> Buf {\n  respond(status: 200)\n}\n`,
    },
  ]).errors;
  return e ? e.code : 'compiled';
};
same('a second argument without its name: C10', said('fn f(x: Int) -> Int {\n  sub(a: x, 2)\n}'), 'C10');
same('a bare name after the first that is no parameter: C11', said('fn f(x: Int) -> Int {\n  sub(a: 1, x)\n}'), 'C11');
same('the first and a name given twice: C12', said('fn f(x: Int) -> Int {\n  sub(x, a: 1)\n}'), 'C12');

finish();
