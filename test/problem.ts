// An error is application/problem+json (RFC 9457, issue #17): std/http.tape's problem and problem_with write the
// same body host/problem.ts writes for the host's and the service's own errors, title by title, compiled and
// interpreted alike; a problem's status written as a literal that is not an error is C96.
import '../node25.ts';
import { interpret } from '../interp.ts';
import { TITLES, instantiate, isProblem, problemOf, responseOf } from '../host.ts';
import { built, codes, finish, ok, same, std } from './harness.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();
const program = `type Taken { Taken(key: View, version: Int, note: Option[View]) }
fn handle(raw: View) -> Response {
  let r = request(raw)
  let Some(value: n) = parse_int(text: r.body) else -> problem(status: 400, detail: "the body is a status")
  match r.path {
    "/with" -> problem_with(status: n, detail: "taken", members: Taken(key: "a\\"b", version: 3, note: None))
    _ -> problem(status: n, detail: "why: \\"quoted\\"")
  }
}
`;
const app = instantiate(new WebAssembly.Module(built(program).wasm), {});
const it = interpret([...std, { name: 'program.tape', text: program }]);
const ask = (path: string, status: number): { type: string | undefined; body: unknown } => {
  const req = enc.encode(`POST ${path}\n${status}`);
  const a = app.handle(req),
    b = it.handle(req);
  ok(`compiled and interpreted answer ${path} ${status} with the same bytes`, a.join() === b.join());
  const r = responseOf(a);
  same(`${path} ${status} is answered with its status`, r.status, status);
  const body: unknown = JSON.parse(dec.decode(r.body));
  return { type: r.type, body };
};

// ---- every 4xx and 5xx: std's title is host/problem.ts's, so a program's problem and the service's read alike
let titled = 0;
for (let s = 400; s <= 599; s++) {
  const got = ask('/', s);
  const want = problemOf(s, 'why: "quoted"');
  if (JSON.stringify(got.body) !== JSON.stringify(want) || got.type !== 'application/problem+json')
    same(`problem(status: ${s}) is the host's problem`, [got.type, got.body], ['application/problem+json', want]);
  else titled++;
}
same('problem(status:, detail:) is the host problem for each of the 200 statuses 400 to 599', titled, 200);
same('the host names the registered phrases (38), and std the same', Object.keys(TITLES).length, 38);
same('a 404, as the client reads it', ask('/', 404).body, {
  type: 'about:blank',
  title: 'Not Found',
  status: 404,
  detail: 'why: "quoted"',
});
ok('a problem is a problem to isProblem', isProblem(ask('/', 500).body));

// ---- problem_with: the members after detail, as write_json writes them (None has no key)
same('problem_with writes the members of its record after the detail', ask('/with', 409).body, {
  type: 'about:blank',
  title: 'Conflict',
  status: 409,
  detail: 'taken',
  key: 'a"b',
  version: 3,
});
same(
  'and the host builds the same body, member for member',
  JSON.stringify(ask('/with', 409).body),
  JSON.stringify(problemOf(409, 'taken', { key: 'a"b', version: 3 })),
);
same(
  "a member named like the problem's own is dropped by the host: an extension cannot change what the problem is",
  problemOf(404, 'x', { status: 200, detail: 'y', code: 'gone' }),
  { type: 'about:blank', title: 'Not Found', status: 404, detail: 'x', code: 'gone' },
);

// ---- C96: a problem whose status, written as a literal, is not an error
same(
  'problem(status: 200) and problem_with(status: 303) are C96; 400 and 599 are not',
  codes(
    'type M { M(n: Int) }\nfn handle(raw: View) -> Response {\n  match raw {\n    "a" -> problem(status: 200, detail: "x")\n    "b" -> problem_with(status: 303, detail: "x", members: M(n: 1))\n    "c" -> problem(status: 400, detail: "x")\n    _ -> problem(status: 599, detail: "x")\n  }\n}\n',
  ),
  ['C96:4', 'C96:5'],
);
same(
  'a problem status outside 200 to 599 is C96 once, for that',
  codes('fn handle(raw: View) -> Response {\n  problem(status: 600, detail: "x")\n}\n'),
  ['C96:2'],
);

finish();
