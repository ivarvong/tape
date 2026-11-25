// An exported method's error is a type of the program's own (issue #17, part 2): the callee answers Err with a value
// of it, written as JSON, and the caller names it (`error: QuoteError`) and matches Rejected(reason: …) on its
// constructors, a match the compiler holds to every one of them. A View error is C98. A caller built against another
// error type is told Skew by the fingerprint and runs nothing; a refusal it cannot decode is Skew too, never Rejected.
import '../node25.ts';
import { instantiate } from '../host.ts';
import type { ServeRequest } from '../host/run.ts';
import { interpret } from '../interp.ts';
import { nodeSql } from '../nodesql.ts';
import { answered, built, codes, finish, ok, problems, same, std } from './harness.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();
const callee = (error: string): string => `type Ask { Ask(item: View) }
type Quote { Quote(cents: Int) }
type QuoteError {
${error}
}

export fn quote(message: Ask) -> Result[Quote, QuoteError] {
  match message.item {
    "lamp" -> Ok(value: Quote(cents: 30))
    "busy" -> Err(error: Busy)
    _ -> Err(error: NoSuchItem(item: message.item))
  }
}
`;
const ERROR = '  Busy\n  NoSuchItem(item: View)';
// asks again only when the callee says Busy, twice at most; another refusal is answered at once
const caller = (error: string, arms: string): string => `type Ask { Ask(item: View) }
type Quote { Quote(cents: Int) }
type QuoteError {
${error}
}

fn handle(raw: View, prices: Remote) -> Response {
  asked(item: request(raw).body, tries: 0)
}

fn asked(item: View, tries: Int) -> Response uses prices {
  match ask(to: prices, method: "quote", send: Ask(item), reply: Quote, error: QuoteError, within: 1000) {
    Ok(value: Quote(cents)) -> buf() |> append(view: "\\(cents) after \\(tries)") |> respond(status: 200)
${arms}
    Err(error: Skew(reason)) -> problem(status: 502, detail: reason)
    Err(error: Timeout) -> problem(status: 504, detail: "no answer in time")
    Err(error: Unreachable) -> problem(status: 503, detail: "no answer")
  }
}
`;
const RETRY = `    Err(error: Rejected(reason: Busy)) if tries < 2 -> asked(item, tries: tries + 1)
    Err(error: Rejected(reason: Busy)) -> problem(status: 503, detail: "busy after \\(tries + 1)")
    Err(error: Rejected(reason: NoSuchItem(item: named))) -> problem(status: 404, detail: "no \\(named)")`;

// ---- a caller that retries on Busy alone, against a callee that says Busy as often as it is told to
{
  let busy = 0;
  const asks: string[] = [];
  const service = (b: ReturnType<typeof built>, wrap?: (r: string) => string) => {
    const app = instantiate(new WebAssembly.Module(b.wasm), { sql: nodeSql() });
    return async (bytes: Uint8Array, m: ServeRequest) => {
      asks.push(/"item":"([^"]*)"/.exec(dec.decode(bytes))?.[1] ?? '');
      const r = await app.serve(m, busy-- > 0 ? enc.encode('{"item":"busy"}') : bytes);
      return wrap ? { status: r.status, body: enc.encode(wrap(dec.decode(r.body))) } : r;
    };
  };
  const quote = built(callee(ERROR));
  const ask = async (item: string, times: number, prices = service(quote)): Promise<[string, number]> => {
    busy = times;
    asks.length = 0;
    const app = instantiate(new WebAssembly.Module(built(caller(ERROR, RETRY)).wasm), { services: { prices } });
    return [answered(await app.run(enc.encode(`POST /\n${item}`))), asks.length];
  };
  same('an answer the first time: one ask', await ask('lamp', 0), ['200\n30 after 0', 1]);
  same('Busy once: asked again, and answered', await ask('lamp', 1), ['200\n30 after 1', 2]);
  same('Busy three times: asked three times, then a 503', await ask('lamp', 3), [
    '503 application/problem+json\n{"type":"about:blank","title":"Service Unavailable","status":503,"detail":"busy after 3"}',
    3,
  ]);
  same('NoSuchItem: not asked again, and its field is read', await ask('desk', 0), [
    '404 application/problem+json\n{"type":"about:blank","title":"Not Found","status":404,"detail":"no desk"}',
    1,
  ]);
  // the refusal on the wire is the callee's error as JSON: a constructor with no fields is its text
  const app = instantiate(new WebAssembly.Module(quote.wasm), { sql: nodeSql() });
  const wire = async (item: string): Promise<[string, string]> => {
    const r = await app.serve(
      { method: 'quote', fingerprint: quote.methods[0]?.fingerprint ?? '' },
      enc.encode(`{"item":"${item}"}`),
    );
    return [r.status, dec.decode(r.body)];
  };
  same('Busy on the wire', await wire('busy'), ['rejected', '{"Busy":{}}']);
  same('NoSuchItem on the wire', await wire('desk'), ['rejected', '{"NoSuchItem":{"item":"desk"}}']);
  same(
    'a message that does not decode is skew, not a refusal',
    dec.decode(
      (await app.serve({ method: 'quote', fingerprint: quote.methods[0]?.fingerprint ?? '' }, enc.encode('{}'))).body,
    ),
    'item: missing',
  );
  same(
    'and its status is skew',
    (await app.serve({ method: 'quote', fingerprint: quote.methods[0]?.fingerprint ?? '' }, enc.encode('{}'))).status,
    'skew',
  );
  // a refusal the caller cannot decode (a callee that answers some other JSON) is Skew, with why
  const [garbled] = await ask(
    'desk',
    0,
    service(quote, () => '[1]'),
  );
  ok('a refusal that is not a QuoteError is Skew, a 502 here, never Rejected', garbled.startsWith('502 '), garbled);

  // the interpreter answers as the build does
  const it = interpret([...std, { name: 'callee.tape', text: callee(ERROR) }]);
  same(
    'the interpreter writes the same refusal',
    [
      dec.decode(it.serve('quote', enc.encode('{"item":"busy"}'))),
      dec.decode(it.serve('quote', enc.encode('{"item":"x"}'))),
    ],
    ['1{"Busy":{}}', '1{"NoSuchItem":{"item":"x"}}'],
  );
  same(
    'and the same skew for a message it cannot read',
    dec.decode(it.serve('quote', enc.encode('{}'))),
    '2item: missing',
  );

  // ---- a callee whose error has one constructor more: its fingerprint differs, so the call is Skew, and it ran
  // nothing (no ask reached it)
  const grown = built(
    callee(`${ERROR}\n  Closed`).replace(
      '    "busy" -> Err(error: Busy)',
      '    "busy" -> Err(error: Busy)\n    "shut" -> Err(error: Closed)',
    ),
  );
  const [answer, reached] = await ask('lamp', 0, service(grown));
  ok(
    'a caller built against the old error, calling the new callee, gets Skew (502 here) before anything runs',
    answer.startsWith('502 application/problem+json') &&
      answer.includes('quote is defined differently on the two sides'),
    answer,
  );
  same('the callee ran nothing (the host refused it on the fingerprint)', reached, 1);
}

// ---- the compiler holds a caller to every constructor, and to the callee's error type
same(
  'a match that leaves a constructor of the error out is refused (C24)',
  codes(caller(ERROR, '    Err(error: Rejected(reason: Busy)) -> problem(status: 503, detail: "busy")')),
  ['C24:13'],
);
same('and one that names every constructor compiles', codes(caller(ERROR, RETRY)), []);
same(
  'a constructor added to the error is refused in a caller whose match named each one (C24): adding one breaks callers',
  codes(caller(`${ERROR}\n  Closed`, RETRY)),
  ['C24:14'],
);
const [view] = problems(callee(ERROR).replace('-> Result[Quote, QuoteError]', '-> Result[Quote, View]'));
same(
  'an exported method whose error is View is C98, with a fix that declares one',
  [view?.code, view?.message],
  [
    'C98',
    "the error of exported function quote is View; it is a type of the program's own whose constructors are the reasons it refuses",
  ],
);
ok(
  'the fix shows the declaration',
  (view?.hint ?? '').includes('type QuoteError { OutOfStock(left: Int)  NoSuchItem }'),
  view?.hint,
);
same(
  'a caller that names View as the error is C98 too',
  codes(caller(ERROR, RETRY).replace('error: QuoteError,', 'error: View,')),
  ['C98:13'],
);
same('a caller that names no error is C13', codes(caller(ERROR, RETRY).replace(' error: QuoteError,', '')), ['C13:13']);
// C87: an arm on one of the callee's reasons takes only that one; the rest are still the catch-all's, with no answer
const timed = (arms: string): string => `type Ask { Ask(item: View) }
type Quote { Quote(cents: Int) }
type QuoteError {
${ERROR}
}

fn handle(raw: View, prices: Remote, timer: Timer) -> Response {
  match call(to: prices, method: "quote", send: Ask(item: raw), reply: Quote, error: QuoteError, within: 1000, once: raw) {
    Ok(value) -> empty(status: 200)
${arms}
    Err(error) -> {
      do wake(after: 1000, key: 1)
      empty(status: 202)
    }
  }
}

export fn woken(message: Wake) -> Result[Wake, View] {
  Ok(value: message)
}
`;
same(
  'one reason in its own arm leaves the others to the catch-all that sets a timer: C87',
  codes(timed('    Err(error: Rejected(reason: Busy)) -> empty(status: 503)')).filter(c => c.startsWith('C87')),
  ['C87:12'],
);
same(
  'every reason in its own arm, or the refusal bound whole, and the catch-all takes only no answer',
  [
    codes(
      timed(
        '    Err(error: Rejected(reason: Busy)) -> empty(status: 503)\n    Err(error: Rejected(reason: NoSuchItem)) -> empty(status: 404)',
      ),
    ).filter(c => c.startsWith('C87')),
    codes(timed('    Err(error: Rejected(reason)) -> empty(status: 409)')).filter(c => c.startsWith('C87')),
  ],
  [[], []],
);
same(
  "woken's error may stay text: the host logs it",
  codes('export fn woken(message: Wake) -> Result[Wake, View] {\n  Ok(value: message)\n}\n', { exports: ['woken'] }),
  [],
);

finish();
