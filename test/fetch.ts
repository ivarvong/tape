// test/fetch.ts: Http, std/http.tape's `fetch` (issue #13 part 3). A fetch is an effect like a call: logged, a
// commit point, answered from the log on a replay, and budgeted by `within`. Its log entry holds the request with
// each secret the run read written `[secret <name>]`, and its reply with each such value held out of the log and put
// back on a replay. A request the host refuses (not https, a header it owns, a body over 64 KB, a write with no key)
// reaches no client. C100 refuses a fetch that is not a GET or a HEAD and writes no `key: Some(…)`. The simulator
// holds a fetch as it holds a call, so it can drop one or answer it late.
import '../node25.ts';
import { HTTP_LIMITS, fixedSecrets, instantiate, isEffect, replay, stubHttp, traceOf } from '../host.ts';
import type { Effect, HttpAnswer, HttpClient, HttpRequest } from '../host.ts';
import { interpret } from '../interp.ts';
import { nodeSql } from '../nodesql.ts';
import { replay as simReplay } from '../sim.ts';
import type { Outcome } from '../sim/engine.ts';
import { answered, built, codes, finish, moduleOf, ok, same, std } from './harness.ts';

const enc = new TextEncoder(),
  dec = new TextDecoder();
const KEY = 'tape-test-stripe-key-not-a-secret-7Qx';
// a refund: the key in a header, in the URL's query and in the body; the reply answered as the body
const PROGRAM = `migration 1 "asked" {
  CREATE TABLE asked(id INTEGER PRIMARY KEY, what TEXT NOT NULL)
}

fn handle(raw: View, db: Sql, secrets: Secrets, http: Http) -> Response {
  let key = value_or(given: secret(name: "stripe"), otherwise: "")
  let r = request(raw)
  let _ = sql_exec(query: "INSERT INTO asked(what) VALUES (:what)", what: r.path, repeat: True)
  let auth = Cons(head: Header(name: "authorization", value: "Bearer " ++ key), tail: Nil)
  match fetch(to: http, method: Post, url: "https://api.stripe.com" ++ r.path ++ "?k=" ++ key, headers: auth, body: "key=" ++ key, within: 2000, key: Some(value: "refund-1")) {
    Ok(value: HttpReply(status, headers, body)) -> buf() |> write_int(value: status) |> append(view: " ") |> append(view: body) |> respond(status: 200)
    Err(error: Rejected(reason)) -> buf() |> append(view: reason) |> respond(status: 502)
    Err(error: Timeout) -> empty(status: 504)
    Err(_) -> empty(status: 503)
  }
}
`;
const module = moduleOf(built(PROGRAM));
const traced = moduleOf(built(PROGRAM, { trace: true }));
const secrets = fixedSecrets({ stripe: KEY });

/** A client that answers `answer` and keeps what it was sent. */
function spy(answer: (r: HttpRequest) => HttpAnswer | Promise<HttpAnswer>): HttpClient & { sent: HttpRequest[] } {
  const sent: HttpRequest[] = [];
  return Object.assign(
    (r: HttpRequest) => {
      sent.push(r);
      return answer(r);
    },
    { sent },
  );
}
const appWith = (http: HttpClient | null) =>
  instantiate(module, { sql: nodeSql(), name: 't', secrets, http, timers: undefined });

// ---- the request is sent as written; the log holds no secret, the replay gives the same answer
{
  // the reply echoes the key, and holds the bytes of a mark too, which must come back as they were
  const echoed = `refunded ${KEY} \u0000tape-secret:0; done`;
  const client = spy(() => ({ status: 201, headers: [['content-type', 'text/plain']], body: enc.encode(echoed) }));
  const app = appWith(client);
  const req = enc.encode('POST /v1/refunds\n');
  const ran = await app.runLogged(req);
  same('the program gets the reply', answered(ran.out), `200\n201 ${echoed}`);
  const [sent] = client.sent;
  same(
    'the client is sent the request as the program wrote it',
    sent && [sent.method, sent.url, sent.headers, dec.decode(sent.body), sent.key],
    [
      'POST',
      `https://api.stripe.com/v1/refunds?k=${KEY}`,
      [['authorization', `Bearer ${KEY}`]],
      `key=${KEY}`,
      'refund-1',
    ],
  );
  const log = JSON.stringify(ran.effects);
  ok('the log holds no byte of the secret', !log.includes(KEY));
  const f = ran.effects.find(e => 'fetch' in e);
  same(
    'the request is logged with the secret written out',
    f && 'fetch' in f ? [f.fetch, f.headers, f.body, f.key] : null,
    [
      'https://api.stripe.com/v1/refunds?k=[secret stripe]',
      [{ name: 'authorization', value: 'Bearer [secret stripe]' }],
      'key=[secret stripe]',
      'refund-1',
    ],
  );
  same(
    'a replay from the log alone gives the same bytes',
    answered(replay(module, req, ran.effects, { secrets })),
    answered(ran.out),
  );
  ok('the replay asked the client nothing', client.sent.length === 1);
  const t = traceOf(traced, req, ran.effects, undefined, { secrets });
  ok(
    'the trace replays, with no secret in its events',
    t.error === null && !JSON.stringify(t.events).includes(KEY),
    String(t.error),
  );
  ok(
    'the trace shows the fetch',
    t.events.some(e => 'fetch' in e && e.fetch.endsWith('k=[secret stripe]') && e.status === 'ok'),
  );
  let tampered = '';
  try {
    const parsed: unknown = JSON.parse(log.replace('Bearer [secret stripe]', 'Bearer other'));
    const edited: Effect[] = (Array.isArray(parsed) ? parsed : []).filter(isEffect);
    replay(module, req, edited, { secrets });
  } catch (e) {
    tampered = e instanceof Error ? e.message : String(e);
  }
  ok('a log whose request differs does not replay', tampered.includes('replay diverged'), tampered);
}

// ---- a fetch is a commit point: what the run wrote before it is committed when it goes out
{
  const commits: string[] = [];
  const db = nodeSql();
  const app = instantiate(module, {
    sql: db,
    name: 't',
    secrets,
    http: () => {
      commits.push(`fetch sees ${JSON.stringify(db.exec('SELECT count(*) AS n FROM asked').toArray()[0]?.['n'])} rows`);
      return { status: 200, headers: [], body: enc.encode('ok') };
    },
  });
  await app.runLogged(enc.encode('POST /a\n'), {
    transaction: f => {
      const r = db.transaction(f);
      commits.push('commit');
      return r;
    },
  });
  same('the write is committed before the request goes out', commits, ['commit', 'fetch sees 1 rows', 'commit']);
}

// ---- what is refused before any client sees it, and the outcomes with none
{
  const fetchOf = (method: string, url: string, headers: string, body: string, key: string): string =>
    `fn handle(raw: View, http: Http) -> Response {\n  match fetch(to: http, method: ${method}, url: ${url}, headers: ${headers}, body: ${body}, within: 500, key: ${key}) {\n    Ok(value: HttpReply(status)) -> buf() |> write_int(value: status) |> respond(status: 200)\n    Err(error: Rejected(reason)) -> buf() |> append(view: reason) |> respond(status: 502)\n    Err(error: Timeout) -> empty(status: 504)\n    Err(error: Unreachable) -> empty(status: 503)\n    Err(_) -> empty(status: 500)\n  }\n}\n`;
  const nil = 'Nil';
  // built with the rules off: C100 refuses the keyless write below, and the host refuses it again at run time
  const run = async (text: string, http: HttpClient | null, body = ''): Promise<string> => {
    const app = instantiate(moduleOf(built(text, { rules: false })), { sql: nodeSql(), name: 't', http });
    return answered((await app.runLogged(enc.encode(`POST /\n${body}`))).out);
  };
  const client = spy(() => ({ status: 200, headers: [], body: new Uint8Array() }));
  const refused: [string, string, string][] = [
    ['http', fetchOf('Get', '"http://api.example.com/"', nil, '""', 'None'), 'only https URLs are fetched'],
    ['a user in the URL', fetchOf('Get', '"https://u:p@api.example.com/"', nil, '""', 'None'), 'a user or a password'],
    ['not a URL', fetchOf('Get', '"api.example.com"', nil, '""', 'None'), 'does not parse'],
    ['a GET with a body', fetchOf('Get', '"https://api.example.com/"', nil, '"x"', 'None'), 'a GET has no body'],
    [
      'a header the host sets',
      fetchOf(
        'Get',
        '"https://api.example.com/"',
        'Cons(head: Header(name: "Host", value: "evil.example"), tail: Nil)',
        '""',
        'None',
      ),
      'host is the host',
    ],
    [
      'the key header itself',
      fetchOf(
        'Get',
        '"https://api.example.com/"',
        'Cons(head: Header(name: "idempotency-key", value: "x"), tail: Nil)',
        '""',
        'None',
      ),
      "idempotency-key is the host's",
    ],
    [
      'a line feed in a value',
      fetchOf(
        'Get',
        '"https://api.example.com/"',
        'Cons(head: Header(name: "x-a", value: "1\\r\\nx-b: 2"), tail: Nil)',
        '""',
        'None',
      ),
      'invalid header value',
    ],
    [
      'a body over 64 KB',
      fetchOf('Post', '"https://api.example.com/"', nil, 'request(raw).body', 'Some(value: "k")'),
      `at most ${HTTP_LIMITS.body} bytes`,
    ],
    [
      'a method that is a value, with no key',
      fetchOf(
        'Other(name: "PURGE")',
        '"https://api.example.com/"',
        nil,
        '""',
        'value_or(given: None, otherwise: None)',
      ),
      'carries key: Some',
    ],
  ];
  for (const [what, text, why] of refused) {
    const got = await run(text, client, what === 'a body over 64 KB' ? 'x'.repeat(HTTP_LIMITS.body + 1) : '');
    ok(
      `${what}: Rejected, and no client is asked`,
      got.startsWith('502\n') && got.includes(why) && client.sent.length === 0,
      got,
    );
  }
  const get = fetchOf('Get', '"https://api.example.com/"', nil, '""', 'None');
  same('no Http client: Unreachable', await run(get, null), '503\n');
  same(
    'a client that throws: Timeout (the request may have arrived)',
    await run(get, () => {
      throw new Error('connection reset');
    }),
    '504\n',
  );
  same(
    'a client slower than within: Timeout',
    await run(
      get,
      () =>
        new Promise(done => {
          setTimeout(() => {
            done({ status: 200, headers: [], body: new Uint8Array() });
          }, 900);
        }),
    ),
    '504\n',
  );
  same(
    'a 3xx is the reply, not followed',
    await run(get, () => ({ status: 302, headers: [['location', 'https://evil.example/']], body: new Uint8Array() })),
    '200\n302',
  );
  same(
    'a reply over 1 MB is refused',
    await run(get, () => ({ status: 200, headers: [], body: new Uint8Array(HTTP_LIMITS.reply + 1) })),
    `502\na reply's body is at most ${HTTP_LIMITS.reply} bytes`,
  );
  same(
    'a stub answers from its table and refuses the rest',
    [
      await run(get, stubHttp({ 'GET https://api.example.com/': { status: 204 } })),
      await run(get, stubHttp({ 'https://other.example/': { status: 200 } })),
    ],
    ['200\n204', '502\nhost not allowed: no stub answer for GET https://api.example.com/'],
  );
  const headers = `fn handle(raw: View, http: Http) -> Response {\n  match fetch(to: http, method: Get, url: "https://api.example.com/", headers: Nil, body: "", within: 500, key: None) {\n    Ok(value: HttpReply(headers)) -> fold(headers, from: buf(), by: fn(o: Buf, h: Header) -> Buf { o |> append(view: h.name) |> append(view: "=") |> append(view: h.value) |> append(view: ";") }) |> respond(status: 200)\n    Err(_) -> empty(status: 500)\n  }\n}\n`;
  same(
    "the reply's headers in their order, names in lower case",
    await run(headers, () => ({
      status: 200,
      headers: [
        ['X-B', '2'],
        ['x-a', 'one:two'],
      ],
      body: new Uint8Array(),
    })),
    '200\nx-b=2;x-a=one:two;',
  );
}

// ---- the compiler: C100 for a write without a key, C72 without Http, C22 for the host's own call
{
  const prog = (method: string, key: string): string =>
    `fn handle(raw: View, http: Http) -> Response {\n  match fetch(to: http, method: ${method}, url: "https://api.example.com/", headers: Nil, body: "", within: 500, key: ${key}) {\n    Ok -> empty(status: 200)\n    Err -> empty(status: 502)\n  }\n}\n`;
  same('a POST with key: None is C100', codes(prog('Post', 'None')), ['C100:2']);
  same('a DELETE with a key that is a value is C100', codes(prog('Delete', 'value_or(given: None, otherwise: None)')), [
    'C100:2',
  ]);
  same('a method that is a value, key None, is C100', codes(prog('request(raw).method', 'None')), ['C100:2']);
  same('a POST with key: Some(…) compiles', codes(prog('Post', 'Some(value: "k")')), []);
  same('a GET and a HEAD need no key', [codes(prog('Get', 'None')), codes(prog('Head', 'None'))], [[], []]);
  same('C100 is a rule: off, it builds', codes(prog('Post', 'None'), { rules: false }), []);
  same(
    'fetch with no Http declared is C72',
    codes(
      'fn go() -> Int {\n  match fetch(to: http, method: Get, url: "https://a.example/", headers: Nil, body: "", within: 5, key: None) {\n    Ok -> 1\n    Err -> 0\n  }\n}\n\nfn handle(raw: View) -> Response {\n  buf() |> write_int(value: go()) |> respond(status: 200)\n}\n\nexport fn other(http: Http, message: Wake) -> Result[Wake, View] {\n  Ok(value: message)\n}\n',
    ).map(c => c.slice(0, 3)),
    ['C72'],
  );
  same(
    "http_send is std/http's own: C22 anywhere else",
    codes(
      'fn handle(raw: View, http: Http) -> Response {\n  match http_send(to: http, request: "{}", body: "", within: 5) {\n    Ok -> empty(status: 200)\n    Err -> empty(status: 500)\n  }\n}\n',
    ).map(c => c.slice(0, 3)),
    ['C22'],
  );
  const imports = (m: WebAssembly.Module): string[] => WebAssembly.Module.imports(m).map(i => i.name);
  ok('a module that fetches imports env.http', imports(module).includes('http'));
  ok(
    'one that does not, does not',
    !imports(moduleOf(built('fn handle(raw: View) -> Response {\n  empty(status: 200)\n}\n'))).includes('http'),
  );
}

// ---- the reference interpreter answers as the build does, from the same reply
{
  const app = appWith(() => ({ status: 201, headers: [['x-a', '1']], body: enc.encode('ok') }));
  const req = enc.encode('POST /v1/refunds\n');
  const ran = await app.runLogged(req);
  const f = ran.effects.find(e => 'fetch' in e);
  const it = interpret([...std, { name: 'program.tape', text: PROGRAM }], {
    secret: name => (name === 'stripe' ? enc.encode(KEY) : null),
    exec: () => 1,
    rows: () => [],
    http: () => ({ status: 'ok', reply: enc.encode(f && 'fetch' in f && typeof f.reply === 'string' ? f.reply : '') }),
  });
  same('interpreter and build agree', answered(it.handle(req)), answered(ran.out));
}

// ---- the simulator holds a fetch as it holds a call: delivered, or dropped (the program sees a Timeout)
{
  const text = `fn handle(raw: View, http: Http) -> Response {\n  match fetch(to: http, method: Get, url: "https://rates.example/eur", headers: Nil, body: "", within: 500, key: None) {\n    Ok(value: HttpReply(body)) -> buf() |> append(view: body) |> respond(status: 200)\n    Err(error: Timeout) -> empty(status: 504)\n    Err(error: Rejected(reason)) -> buf() |> append(view: reason) |> respond(status: 502)\n    Err(_) -> empty(status: 503)\n  }\n}\n`;
  const sim = {
    modules: { rates: moduleOf(built(text)) },
    entry: 'rates',
    http: { 'GET https://rates.example/eur': { body: '1.08' } },
    clients: () => [[{ name: 'rate', make: () => ({ line: 'GET /' }) }]],
  };
  const said = (r: Outcome): string =>
    r.log
      .filter(e => /answered|~http/.test(e.what + e.detail))
      .map(e => `${e.what} ${e.detail}`.trim())
      .join(' | ');
  const delivered = await simReplay(sim, ['start c0', 'deliver c0.0:1']);
  ok('delivered: the table answers', said(delivered).includes('answered 200 1.08'), said(delivered));
  const dropped = await simReplay(sim, ['start c0', 'drop c0.0:1']);
  ok('dropped: the program sees a Timeout', said(dropped).includes('answered 504'), said(dropped));
  const other = await simReplay({ ...sim, http: {} }, ['start c0', 'deliver c0.0:1']);
  ok(
    'a request the table has no answer for is refused',
    said(other).includes('answered 502 host not allowed'),
    said(other),
  );
}

finish();
