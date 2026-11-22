// The service, end to end, as a customer meets it: three walkthroughs that return what they saw as text.
//   A. upload a program, call it, read its log and its trace
//   B. a durable workflow: a step that times out resumes without repeating; a declined card compensates
//   C. tools for agents: capabilities granted by policy, a manifest with JSON Schemas, MCP
// `fetch` is anything shaped like fetch: the Worker itself in test/demo.test.ts, the network in demo/run.ts.
// Every claim printed is also checked: a line that would be false throws instead.
import { at, list, num, text } from '../jepsen/json.ts';

export type Sources = Readonly<
  Record<'hello' | 'payments' | 'inventory' | 'shipping' | 'fulfillment' | 'price' | 'notes' | 'fx', string>
>;
export type Demo = {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  base: string;
  token: string;
  sources: Sources;
  account?: string;
};
/** What a request came to: its body as JSON when it is JSON, and as the text it was. */
type Answer = { status: number; body: unknown; text: string; headers: Headers };
type Ask = (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<Answer>;
const parsed = (body: string): unknown => {
  try {
    const value: unknown = JSON.parse(body);
    return value;
  } catch {
    return body;
  }
};
const sent = (body: unknown): { body?: string } => {
  if (body === undefined) return {};
  return { body: typeof body === 'string' ? body : JSON.stringify(body) };
};
const short = (s: unknown, n = 8): string => `${String(s).slice(0, n)}…`;
const local = (url: string): string =>
  url.replace(/^https?:\/\/[^/]+/, '').replace(/exp=\d+&sig=[0-9a-f]+/, 'exp=…&sig=…');
/** What is in stock, on the cards and printed, and the same as one line. */
type State = { stock: Record<string, number>; cards: Record<string, number>; labels: number; line: string };

export async function demo({ fetch, base, token, sources, account = 'demo' }: Demo): Promise<string> {
  const out: string[] = [],
    say = (...lines: string[]): void => {
      out.push(...lines);
    };
  const must = (ok: boolean, what: string): void => {
    if (!ok) throw new Error(`demo: ${what}\n${out.join('\n')}`);
  };
  const as =
    (t: string | null): Ask =>
    async (method, path, body, headers) => {
      const res = await fetch(/^https?:/.test(path) ? path : `${base}${path}`, {
        method,
        headers: { ...(t === null ? {} : { authorization: `Bearer ${t}` }), ...headers },
        ...sent(body),
      });
      const answer = await res.text();
      return { status: res.status, body: parsed(answer), text: answer, headers: res.headers };
    };
  const operator = as(token),
    anyone = as(null);

  // A
  const A = account;
  say('A. Upload a program, call it, read its log and trace', '');
  const up = await operator('POST', `/${A}/hello`, sources.hello);
  const v = num(at(up.body, 'version')),
    hash = text(at(up.body, 'hash'));
  must(v >= 1 && hash !== '', `upload: ${up.text}`);
  say(`POST /${A}/hello                     -> ${up.status} version ${v}, hash ${short(hash)}`);
  const hi = await operator('GET', `/${A}/hello/v/${v}/hello/ada`);
  must(hi.status === 200 && hi.text.startsWith('Hello'), `call: ${hi.status} ${hi.text}`);
  const id = hi.headers.get('tape-request-id') ?? '',
    link = hi.headers.get('tape-trace-url') ?? '';
  say(
    `GET  /${A}/hello/v/${v}/hello/ada        -> ${hi.status} ${hi.text}`,
    `  tape-request-id: ${short(id, 13)}`,
    `  tape-trace-url:  ${local(link).replace(/\/r\/[0-9a-f]{4}([0-9a-f]+)/, (m: string, r: string) => m.replace(r, '…'))}`,
  );
  const log = await operator('GET', `/${A}/hello/log/${v}/${id}`);
  const effects = list(at(log.body, 'effects')),
    build = text(at(effects[0], 'build'));
  must(log.status === 200 && build !== '', `log: ${log.status}`);
  say(`GET  /${A}/hello/log/${v}/<id>           -> ${log.status} ${effects.length} effects, build ${short(build)}`);
  const page = await anyone('GET', `${link}&format=text`);
  must(page.status === 200 && page.text.includes('✓'), `trace page: ${page.status}`);
  say(
    '',
    'the trace link, opened with no token:',
    ...page.text
      .trimEnd()
      .split('\n')
      .map(l => `  ${l}`),
    '',
  );
  const noToken = await anyone('GET', `/${A}/hello`),
    forged = await anyone(
      'GET',
      link.replace(/sig=(.)/, (_m: string, c: string) => `sig=${c === '0' ? '1' : '0'}`),
    );
  must(noToken.status === 401 && forged.status === 401, `refusals: ${noToken.status} ${forged.status}`);
  say(
    `GET  /${A}/hello with no token       -> ${noToken.status}`,
    `the trace link with one digit changed -> ${forged.status}`,
    '',
  );

  // B
  const W = `${account}-wf`;
  say('B. A durable workflow: reserve stock, charge a card, print a label', '');
  /** Upload a program of the workflow; its version. */
  const uploaded = async (name: string, source: string): Promise<number> => {
    const r = await operator('POST', `/${W}/${name}`, source),
      version = num(at(r.body, 'version'));
    must(version >= 1, `upload ${name}: ${r.text}`);
    return version;
  };
  const ver = {
    inventory: await uploaded('inventory', sources.inventory),
    payments: await uploaded('payments', sources.payments),
    shipping: await uploaded('shipping', sources.shipping),
    fulfill: await uploaded('fulfill', sources.fulfillment),
  };
  /** One column of a route's rows by another. */
  const table = async (path: string, key: string, value: string): Promise<Record<string, number>> =>
    Object.fromEntries(list((await operator('GET', path)).body).map(r => [text(at(r, key)), num(at(r, value))]));
  const state = async (): Promise<State> => {
    const stock = await table(`/${W}/inventory/v/${ver.inventory}/stock`, 'sku', 'remaining');
    const cards = await table(`/${W}/payments/v/${ver.payments}/cards`, 'card', 'balance');
    const labels = list((await operator('GET', `/${W}/shipping/v/${ver.shipping}/labels`)).body).length;
    return {
      stock,
      cards,
      labels,
      line: `lamp ${stock['lamp']}  desk ${stock['desk']}  ann ${cards['ann-4242']}  labels ${labels}`,
    };
  };
  const order = (body: Record<string, unknown>, wait = ''): Promise<Answer> =>
    operator('POST', `/${W}/fulfill/v/${ver.fulfill}/orders${wait}`, body);
  /** Numbers of a state, 0 when it has none. */
  const lamps = (st: State): number => st.stock['lamp'] ?? 0,
    desks = (st: State): number => st.stock['desk'] ?? 0,
    ann = (st: State): number => st.cards['ann-4242'] ?? 0;
  /** A field of an order's answer. */
  const of = (a: Answer, field: string): unknown => at(a.body, field);
  const s0 = await state();
  say(`start                                 ${s0.line}`);
  const happy = await order({ key: `${W}-1`, sku: 'lamp', qty: 1, card: 'ann-4242', address: '1 Main St' });
  must(happy.status === 201 && of(happy, 'state') === 'done' && of(happy, 'steps') === 3, `happy: ${happy.text}`);
  const s1 = await state();
  must(
    lamps(s1) === lamps(s0) - 1 && ann(s1) === ann(s0) - num(of(happy, 'amount')) && s1.labels === s0.labels + 1,
    `after happy: ${s1.line}`,
  );
  say(
    `order ${num(of(happy, 'id'))}: 1 lamp               -> ${happy.status} ${text(of(happy, 'state'))}, ${num(of(happy, 'steps'))} steps   ${s1.line}`,
  );
  const slow = await order({ key: `${W}-2`, sku: 'lamp', qty: 2, card: 'ann-4242', address: '2 Main St' }, '/wait/1');
  must(slow.status === 202 && of(slow, 'state') === 'reserving', `slow: ${slow.status} ${slow.text}`);
  const s2 = await state(),
    slowId = num(of(slow, 'id'));
  must(lamps(s2) === lamps(s1) - 2 && ann(s2) === ann(s1), `after slow: ${s2.line}`);
  say(
    `order ${slowId}: 2 lamps, 1 ms per step -> ${slow.status} ${text(of(slow, 'state'))}        ${s2.line}`,
    `  "${text(of(slow, 'stall'))}"`,
    '  the reservation happened anyway: the lamps are taken, the card is not yet charged',
  );
  const resumed = await operator('POST', `/${W}/fulfill/v/${ver.fulfill}/advance/${slowId}`);
  must(resumed.status === 201 && of(resumed, 'state') === 'done', `resume: ${resumed.status} ${resumed.text}`);
  const s3 = await state();
  must(
    lamps(s3) === lamps(s2) && ann(s3) === ann(s2) - num(of(resumed, 'amount')) && s3.labels === s2.labels + 1,
    `after resume: ${s3.line}`,
  );
  say(
    `POST /advance/${slowId}                   -> ${resumed.status} ${text(of(resumed, 'state'))}, ${num(of(resumed, 'steps'))} steps   ${s3.line}`,
  );
  const calls = (await anyone('GET', `${resumed.headers.get('tape-trace-url') ?? ''}&format=text`)).text
    .split('\n')
    .filter(l => /call \w+\.\w+ once/.test(l))
    .map(l => l.trim());
  must(
    calls.some(l => /inventory\.reserve.*did not run again/.test(l)) &&
      calls.some(l => /payments\.charge.*ran charge/.test(l)),
    `resume trace:\n${calls.join('\n')}`,
  );
  say('', 'the trace of the resume:', ...calls.map(l => `  ${l}`), '');
  const refused = await order({ key: `${W}-3`, sku: 'desk', qty: 1, card: 'bob-0001', address: '3 Main St' }); // bob has 50; a desk is 150
  const s4 = await state();
  must(
    of(refused, 'state') === 'failed' &&
      text(of(refused, 'note')).includes('declined') &&
      desks(s4) === desks(s3) &&
      s4.labels === s3.labels,
    `declined: ${refused.text} ${s4.line}`,
  );
  say(
    `order ${num(of(refused, 'id'))}: a desk, a card that cannot pay -> ${refused.status} ${text(of(refused, 'state'))}, "${text(of(refused, 'note'))}"`,
    `  the stock went back                 ${s4.line}`,
    '',
  );

  // C
  const T = `${account}-agents`;
  say('C. Tools for agents', '');
  const minted = await operator('GET', `/_agent/${T}`);
  const agentToken = text(at(minted.body, 'token'));
  must(minted.status === 200 && agentToken !== '', `agent token: ${minted.status}`);
  const agent = as(agentToken);
  const denied = await agent('POST', `/tools/${T}/notes`, sources.notes);
  const problems = list(at(denied.body, 'problems'));
  must(denied.status === 403 && problems.length > 0, `notes without policy: ${denied.status} ${denied.text}`);
  say(`agent uploads a tool that takes a database, with no policy`, `  -> ${denied.status} "${text(problems[0])}"`);
  const priced = await agent('POST', `/tools/${T}/price`, sources.price);
  const tool = at(priced.body, 'tools', 0),
    pure = at(tool, 'capabilities', 'pure') === true;
  must(priced.status === 201 && pure, `price: ${priced.status} ${priced.text}`);
  say(
    `agent uploads a pure tool`,
    `  -> ${priced.status} ${text(at(tool, 'name'))}, pure: ${pure}, imports: ${JSON.stringify(at(tool, 'capabilities', 'imports'))}`,
    `  qty in its JSON Schema: ${JSON.stringify(at(tool, 'inputSchema', 'properties', 'qty'))}`,
  );
  const quote = await agent('POST', `/tools/${T}/price/quote`, {
    unit_cents: 1999,
    qty: 3,
    discount_percent: 10,
    tax_percent: 8,
  });
  const total = at(quote.body, 'output', 'total_cents');
  must(
    at(quote.body, 'ok') === true && total === 5829 && text(at(quote.body, 'trace_url')) !== '',
    `quote: ${quote.text}`,
  );
  say(`agent calls it: 3 at 19.99, 10% off, 8% tax`, `  -> total_cents ${num(total)}, with a trace link`);
  const bad = await agent('POST', `/tools/${T}/price/quote`, { unit_cents: 1999, qty: 0, tax_percent: 8 });
  must(bad.status === 422 && at(bad.body, 'ok') === false, `bad quote: ${bad.status} ${bad.text}`);
  say(`a message outside the schema (qty 0)`, `  -> ${bad.status} "${text(at(bad.body, 'error'))}"`);
  const program = await agent('POST', `/${T}/fx`, sources.fx),
    policy = await agent('PUT', `/_policy/${T}`, { sql: true });
  must(program.status === 401 && policy.status === 401, `agent reach: ${program.status} ${policy.status}`);
  say(`the agent's token on a program route -> ${program.status}; on the policy route -> ${policy.status}`);
  const granted = await operator('PUT', `/_policy/${T}`, { sql: true }),
    stored = await agent('POST', `/tools/${T}/notes`, sources.notes);
  must(granted.status === 200 && stored.status === 201, `grant: ${granted.status} ${stored.status} ${stored.text}`);
  const put = await agent('POST', `/tools/${T}/notes/put`, { key: 'a', text: 'one' });
  must(at(put.body, 'ok') === true && num(at(put.body, 'output', 'revision')) >= 1, `notes put: ${put.text}`);
  say(
    `the operator grants {"sql": true}; the same upload -> ${stored.status}; put -> ${JSON.stringify(at(put.body, 'output'))}`,
  );
  const mcp = await agent(
    'POST',
    `/mcp/${T}`,
    { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  );
  const names = list(at(mcp.body, 'result', 'tools')).map(t => text(at(t, 'name')));
  must(mcp.status === 200 && names.includes('price_quote'), `mcp: ${mcp.status} ${mcp.text}`);
  say(`MCP tools/list                       -> ${mcp.status} ${names.join(', ')}`);
  return out.join('\n');
}
