// A program's answer is a Response, written in the host's frame by generated code (issues #11 and #14): bytes a
// request sent cannot become a status or a header, a status or a header the host would refuse is a 500 that says
// why, compiled and interpreted alike, and the forms that are gone are refused with the new one as their fix.
import '../node25.ts';
import { interpret } from '../interp.ts';
import { answerText, framed, instantiate, responseOf } from '../host.ts';
import { nodeSql } from '../nodesql.ts';
import type { Answer } from '../host.ts';
import { BUF_ANSWER_HINT } from '../compiler/gen/answer.ts';
import { built, codes, finish, ok, problems, same, std } from './harness.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();
/** The program's answer to each request, compiled and interpreted: they must be the same bytes. */
function both(program: string, requests: readonly string[]): Answer[] {
  const app = instantiate(new WebAssembly.Module(built(program).wasm), {});
  const it = interpret([...std, { name: 'program.tape', text: program }]);
  return requests.map(r => {
    const a = app.handle(enc.encode(r)),
      b = it.handle(enc.encode(r));
    ok(`compiled and interpreted answer ${JSON.stringify(r.slice(0, 24))} with the same bytes`, a.join() === b.join());
    return responseOf(a);
  });
}

// ---- 1. the five answers of the issue, each sent as a request's body and answered as that body
const echo =
  'fn handle(raw: View) -> Response {\n  buf() |> append(view: request(raw).body) |> respond(status: 200)\n}\n';
const sent = [
  '302\rlocation: https://evil.example/\n',
  '200 text/html\n<script>alert(1)</script>',
  '200\rcache-control: public, max-age=31536000\nx',
  '42\nhi',
  '199\n',
];
both(
  echo,
  sent.map(s => `POST /echo\n${s}`),
).forEach((a, i) => {
  const s = sent[i] ?? '';
  same(
    `bytes ${JSON.stringify(s.slice(0, 20))} sent as a body are served as that body: 200 text/plain, no header`,
    [a.status, a.type, a.headers, dec.decode(a.body)],
    [200, 'text/plain; charset=utf-8', [], s],
  );
});

// ---- 2. a status the host refuses, computed (the literal one is C96): a 500 that says why, before any Response
const computed =
  'fn handle(raw: View) -> Response {\n  let Some(value: n) = parse_int(text: request(raw).body) else -> empty(status: 400)\n  match {\n    n == 2040 -> buf() |> append(view: "x") |> respond(status: n / 10)\n    n == 1 -> empty(status: 200) |> header(name: "set-cookie", value: "a=1")\n    n == 2 -> empty(status: 200) |> header(name: "x-a", value: "line\\r\\nx-b: 1")\n    n == 3 -> empty(status: 200) |> header(name: "bad name", value: "1")\n    else -> empty(status: n)\n  }\n}\n';
const refusals: readonly [string, number, string][] = [
  ['199', 500, 'the program answered a response the host refuses: status 199 is outside 200 to 599'],
  ['42', 500, 'the program answered a response the host refuses: status 42 is outside 200 to 599'],
  ['65736', 500, 'the program answered a response the host refuses: status 65736 is outside 200 to 599'],
  ['600', 500, 'the program answered a response the host refuses: status 600 is outside 200 to 599'],
  [
    '2040',
    500,
    'the program answered a response the host refuses: a 204 has no body, and this one has 1 bytes (use empty)',
  ],
  ['1', 500, "the program set a response header the host refuses: set-cookie is the host's to set"],
  ['2', 500, 'the program set a response header the host refuses: invalid header value for x-a'],
  ['3', 500, 'the program set a response header the host refuses: invalid header name "bad name"'],
  ['204', 204, ''],
  ['599', 599, ''],
];
both(
  computed,
  refusals.map(([n]) => `POST /\n${n}`),
).forEach((a, i) => {
  const [n, status, why] = refusals[i] ?? ['', 0, ''];
  same(`a computed answer ${n}: ${status}`, [a.status, dec.decode(a.body)], [status, why]);
});

// ---- 3. what a Response is: content, headers in the order set, names in lower case; json, empty, redirect
const forms =
  'type P { P(n: Int) }\nfn handle(raw: View) -> Response {\n  match request(raw) {\n    Request(method: Get, path: "/a") -> buf() |> append(view: "<p>") |> respond_as(status: 200, content: Html) |> header(name: "X-One", value: "1") |> header(name: "x-two", value: "2")\n    Request(method: Post, path: "/p") -> json(status: 201, value: P(n: 7)) |> header(name: "location", value: "/p/7")\n    Request(method: Delete) -> empty(status: 204)\n    Request(method: Other(name)) -> buf() |> append(view: name) |> respond(status: 405)\n    _ -> redirect(to: "/a")\n  }\n}\n';
same(
  'respond_as, json, empty, Other and redirect, as the host serves them',
  both(forms, ['GET /a\n', 'POST /p\n', 'DELETE /x\n', 'PROPFIND /\n', 'GET /b\n']).map(answerText),
  [
    '200 text/html\rx-one: 1\rx-two: 2\n<p>',
    '201 application/json\rlocation: /p/7\n{"n":7}',
    '204\n',
    '405\nPROPFIND',
    '303\rlocation: /a\n',
  ],
);
// a rollback gives the Response it was given, its writes undone
const undone =
  'migration 1 "t" { CREATE TABLE t(k TEXT PRIMARY KEY) }\nfn handle(raw: View, db: Sql) -> Response {\n  let 1 = sql_exec(query: "INSERT INTO t(k) VALUES (:k) ON CONFLICT(k) DO NOTHING", k: request(raw).body) else -> empty(status: 200)\n  rollback(out: json(status: 409, value: Cons(head: 1, tail: Nil)))\n}\n';
{
  const sql = nodeSql();
  const app = instantiate(new WebAssembly.Module(built(undone).wasm), { sql });
  const out = app.handleIn(f => sql.transaction(f), enc.encode('POST /\na'));
  same('rollback(out: json(…)) answers that Response', answerText(responseOf(out)), '409 application/json\n[1]');
  same('and its write is undone', sql.exec('SELECT count(*) AS n FROM t').toArray(), [{ n: 0 }]);
}

// ---- 4. the frame: only generated code writes it, and anything else is a 500 that says so
same(
  'a frame host.ts writes reads back as its Answer',
  answerText(responseOf(framed({ status: 302, headers: [{ name: 'location', value: '/x' }] }))),
  '302\rlocation: /x\n',
);
for (const [what, bytes] of [
  ['the old text answer', enc.encode('200\nhi')],
  ['nothing', new Uint8Array()],
  ['a header that runs past the end', framed({ status: 200, headers: [{ name: 'a', value: 'b' }] }).subarray(0, 24)],
] as const) {
  const a = responseOf(bytes);
  ok(
    `${what} is not a frame: 500, and it says so`,
    a.status === 500 && dec.decode(a.body).startsWith("the program's answer is not a response frame"),
    dec.decode(a.body),
  );
}
const many = framed({ status: 200, headers: Array.from({ length: 33 }, (_, i) => ({ name: `x-${i}`, value: '1' })) });
same(
  'more than 32 headers is a 500',
  dec.decode(responseOf(many).body),
  'the program set a response header the host refuses: more than 32 headers',
);

// ---- 5. refused at compile time: a Buf as the answer, a literal status the host refuses, a misspelt method
const oldHandle = 'fn handle(raw: View) -> Buf {\n  buf() |> append(view: "hi")\n}\n';
const [p] = problems(oldHandle);
same(
  'a handle that gives a Buf is C14 at its line',
  [p?.code, p?.line, p?.message],
  ['C14', 1, "handle gives a Buf; it answers std's Response"],
);
same('its fix is the new form', p?.hint, BUF_ANSWER_HINT);
ok('the fix says how to write it', BUF_ANSWER_HINT.includes('buf() |> append(view: …) |> respond(status: 200)'));
same(
  'the head-writing respond is gone: respond(status:) alone is missing its body',
  codes('fn handle(raw: View) -> Response {\n  respond(status: 200)\n}\n'),
  ['C13:2'],
);
same(
  'a status outside 200 to 599, written as a literal, is C96',
  codes(
    'fn handle(raw: View) -> Response {\n  match raw {\n    "a" -> empty(status: 199)\n    "b" -> buf() |> respond(status: 600)\n    _ -> json(status: 42, value: Cons(head: 1, tail: Nil))\n  }\n}\n',
  ),
  ['C96:3', 'C96:4', 'C96:5'],
);
same(
  'a 204, 205 or 304 written with a body is C96; empty and a bare buf() are not',
  codes(
    'fn handle(raw: View) -> Response {\n  match raw {\n    "a" -> buf() |> append(view: "x") |> respond(status: 204)\n    "b" -> buf() |> respond(status: 304)\n    _ -> empty(status: 205)\n  }\n}\n',
  ),
  ['C96:3'],
);
same(
  'a misspelt method is an unknown constructor',
  codes(
    'fn handle(raw: View) -> Response {\n  match request(raw) {\n    Request(method: Gte) -> empty(status: 200)\n    _ -> empty(status: 404)\n  }\n}\n',
  ),
  ['C20:3'],
);

// ---- 6. header() copies nothing: eight headers on a 64 KB body cost what one does, but for the names lowered;
// and the answer is not a copy of the body after its head
const headed = (n: number): string =>
  `fn handle(raw: View) -> Response {\n  buf() |> append(view: request(raw).body) |> respond(status: 200)${Array.from({ length: n }, (_, i) => ` |> header(name: "x-h${i}", value: "v")`).join('')}\n}\n`;
const body = 'x'.repeat(65536);
const cost = (n: number): { steps: number; bytes: number } => {
  const app = instantiate(new WebAssembly.Module(built(headed(n)).wasm), {});
  app.handle(enc.encode(`POST /\n${body}`));
  const c = app.exports['cost'];
  return { steps: c instanceof WebAssembly.Global ? Number(c.value) : -1, bytes: app.bytesUsed };
};
const [none, eight] = [cost(0), cost(8)];
console.log(
  `  8 headers on a 64 KB body: ${eight.steps} steps, ${eight.bytes} bytes; none: ${none.steps} steps, ${none.bytes} bytes`,
);
ok(
  'eight headers add less than 2 KB of memory to a 64 KB answer (a copy of the body would be 64 KB each)',
  eight.bytes - none.bytes < 2048,
  `${eight.bytes - none.bytes}`,
);
// the request's 64 KB and the Buf the body is appended to are the program's; the answer adds its head, and no copy
// of the body after it (host/run.ts reads the body where it lies)
ok(
  'the answer with no header costs the request and its one Buf, and less than 1 KB more: the body is not copied to frame it',
  none.bytes - 2 * body.length < 1024,
  `${none.bytes - 2 * body.length}`,
);

finish();
