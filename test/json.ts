// Records inside records, and lists, in JSON: decode, write_json, messages between programs, fingerprints and
// JSON Schema. The decoder is checked against JSON.parse on generated values.
import '../node25.ts';
import { compile } from '../compiler.ts';
import type { Built } from '../compiler.ts';
import { instantiate, responseOf } from '../host.ts';
import { rng } from '../sim.ts';
import { nodeSql } from '../nodesql.ts';
import { finish, ok, read, std } from './harness.ts';

type Compiled = ReturnType<typeof compile>;
const build = (text: string, sources = std): Compiled => compile([...sources, { name: 'program.tape', text }]);
const codes = (b: Compiled): string => b.errors.map(e => e.code).join(',');
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** A list of objects out of an answer. */
const list = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v)
    ? v.map((x: unknown) => (typeof x === 'object' && x !== null ? Object.fromEntries(Object.entries(x)) : {}))
    : [];
/** An answer's JSON object; {} when it is not one. */
const objectIn = (text: string): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(text);
  return typeof parsed === 'object' && parsed !== null ? Object.fromEntries(Object.entries(parsed)) : {};
};
const dec = new TextDecoder(),
  enc = new TextEncoder();

const TYPES = `type Qty = Int where self >= 1 and self <= 9

type Tier { Tier(name: View, price: Int, qty: Qty) }

type Venue { Venue(city: View, indoor: Bool) }

type NewEvent { NewEvent(key: View, venue: Venue, tiers: List[Tier], tags: List[View], sizes: List[Int], grid: List[List[Int]], note: Option[View], backup: Option[Venue], extra: Option[List[Tier]]) }

type Made { Made(key: View, venue: Venue, tiers: List[Tier], tags: List[View], sizes: List[Int], grid: List[List[Int]], seats: Int) }
`;
const program = `${TYPES}
fn handle(raw: View) -> Response {
  match request(raw) {
    Request(method: Post, path: "/events", body) -> made(decoded: decode(json: body, as: NewEvent))
    _ -> empty(status: 404)
  }
}

fn made(decoded: Result[NewEvent, View]) -> Response {
  match decoded {
    Ok(value: NewEvent(key, venue, tiers, tags, sizes, grid, note, backup, extra)) -> buf() |> write_json(value: Made(key, venue, tiers, tags, sizes, grid, seats: seats(list: tiers, sum: 0) + had(note) + 10 * there(backup) + 100 * more(extra))) |> respond_as(status: 201, content: Json)
    Err(error) -> buf() |> append(view: error) |> respond(status: 400)
  }
}

fn seats(list: List[Tier], sum: Int) -> Int {
  match list {
    Cons(head: Tier(qty), tail) -> seats(list: tail, sum: sum + qty)
    Nil -> sum
  }
}

fn had(note: Option[View]) -> Int {
  match note {
    Some(value) -> len(value)
    None -> 0
  }
}

fn there(backup: Option[Venue]) -> Int {
  match backup {
    Some(value: Venue(indoor: True)) -> 2
    Some(value) -> 1
    None -> 0
  }
}

fn more(extra: Option[List[Tier]]) -> Int {
  match extra {
    Some(value) -> 1 + length(list: value)
    None -> 0
  }
}
`;
const b = build(program);
ok(
  'a record of records, lists, lists of lists and optional ones builds',
  !b.errors?.length,
  b.errors
    ?.map(e => `${e.code} ${e.file}:${e.line} ${e.message}`)
    .join(' | ')
    .slice(0, 300),
);
const good = {
  key: 'k1',
  venue: { city: 'NYC\nNY "5"', indoor: true },
  tiers: [
    { name: 'floor', price: 8500, qty: 2 },
    { name: 'b}al,c[ony\n', price: -4, qty: 9 },
  ],
  tags: ['a', 'b\n"c"\\', ''],
  sizes: [1, -2, 3],
  grid: [[1, 2], [], [3]],
};
if (b.wasm !== null) {
  const app = instantiate(new WebAssembly.Module(b.wasm), {});
  const post = (body: unknown): [number, string] => {
    try {
      const r = responseOf(
        app.handle(enc.encode(`POST /events\n${typeof body === 'string' ? body : JSON.stringify(body)}`)),
      );
      return [r.status, dec.decode(r.body)];
    } catch (e) {
      return [0, `threw ${messageOf(e)}`];
    }
  };
  const [s1, t1] = post(good);
  ok(
    "decoded and written back: the same JSON, in the type's field order",
    s1 === 201 && t1 === JSON.stringify({ ...good, seats: 11 }),
    t1.slice(0, 200),
  );
  const [s2, t2] = post({
    ...good,
    tiers: [],
    tags: [],
    sizes: [],
    grid: [],
    note: 'hey',
    backup: { city: 'LA', indoor: true },
    extra: [good.tiers[0]],
  });
  ok(
    'empty lists and optional keys: None when absent, decoded when there',
    s2 === 201 && objectIn(t2).seats === 3 + 20 + 200,
    t2.slice(-40),
  );
  const BAD: readonly (readonly [string, unknown, string])[] = [
    [
      'a refined field two levels down',
      { ...good, tiers: [good.tiers[0], { name: 'x', price: 1, qty: 0 }] },
      'tiers[1].qty: expected Qty, 1 to 9',
    ],
    ['a key missing in an element', { ...good, tiers: [{ name: 'x', qty: 1 }] }, 'tiers[0].price: missing'],
    ['a record that is not an object', { ...good, venue: 'NYC' }, 'venue: expected an object'],
    [
      'a lone surrogate inside a record',
      { ...good, venue: { city: '\uD800', indoor: true } },
      'venue.city: expected text without lone surrogates',
    ],
    ['a wrong value in a list of text', { ...good, tags: ['a', 5] }, 'tags[1]: expected text'],
    ['a list that is not an array', { ...good, tiers: {} }, 'tiers: expected an array'],
    ['an element that is not an object', { ...good, tiers: [7] }, 'tiers[0]: expected an object'],
    ['a list inside a list', { ...good, grid: [[1], [2, 'x']] }, 'grid[1][1]: expected an integer'],
    ['an optional record that is wrong', { ...good, backup: { city: 1, indoor: true } }, 'backup.city: expected text'],
    [
      'an optional list that is wrong',
      { ...good, extra: [{ name: 'x', price: 1, qty: 99 }] },
      'extra[0].qty: expected Qty, 1 to 9',
    ],
    [
      'a nested record missing',
      Object.fromEntries(Object.entries(good).filter(([k]) => k !== 'venue')),
      'venue: missing',
    ],
    ['null where a record goes', { ...good, venue: null }, 'venue: null'],
  ];
  const [s3, t3] = post({ ...good, sent_at: 1, venue: { ...good.venue, roof: 1 } });
  ok(
    'keys the types do not name, at the top and inside a record, are left unread',
    s3 === 201 && t3 === JSON.stringify({ ...good, seats: 11 }),
    t3.slice(0, 200),
  );
  for (const [what, bad, want] of BAD) {
    const [s, t] = post(bad);
    ok(`400: ${what}`, s === 400 && t === want, t);
  }

  // against JSON.parse: generated values round-trip exactly; generated damage is refused
  const r = rng(7),
    pick = <T>(xs: readonly [T, ...T[]]): T => xs[Math.floor(r() * xs.length)] ?? xs[0],
    int = (): number => Math.floor(r() * 2000001) - 1000000;
  const text = (): string =>
    Array.from({ length: Math.floor(r() * 6) }, () =>
      pick(['a', 'é', '✓', '"', '\\', '\n', '\t', '{', ']', ',', ' ', '\u0001', '😀', ':']),
    ).join('');
  const many = <T>(make: () => T): T[] => Array.from({ length: Math.floor(r() * 4) }, make);
  const tier = () => ({ name: text(), price: int(), qty: 1 + Math.floor(r() * 9) }),
    venue = () => ({ city: text(), indoor: r() < 0.5 });
  const event = () => ({
    key: text(),
    venue: venue(),
    tiers: many(tier),
    tags: many(text),
    sizes: many(int),
    grid: many(() => many(int)),
    ...(r() < 0.5 ? { note: text() } : {}),
    ...(r() < 0.5 ? { backup: venue() } : {}),
    ...(r() < 0.5 ? { extra: many(tier) } : {}),
  });
  let same = 0,
    refused = 0,
    N = 300;
  for (let i = 0; i < N; i++) {
    const e = event(),
      [s, t] = post(e),
      { note, backup, extra, ...rest } = e;
    const seats =
      e.tiers.reduce((n, x) => n + x.qty, 0) +
      (note === undefined ? 0 : enc.encode(note).length) +
      (backup ? (backup.indoor ? 20 : 10) : 0) +
      (extra ? 100 * (1 + extra.length) : 0);
    if (s === 201 && t === JSON.stringify({ ...rest, seats })) same++;
    else if (same + refused === i)
      console.log('   differs:', JSON.stringify(e).slice(0, 200), '->', s, t.slice(0, 200));
    // damage one thing somewhere inside; it must be refused
    const spot = pick(['tier', 'venue', 'tag', 'size', 'grid']);
    const damaged = (): Record<string, unknown> => {
      if (spot === 'tier') return { ...e, tiers: [...e.tiers, { ...tier(), qty: pick<unknown>([0, 10, 'x', 1.5]) }] };
      if (spot === 'venue') return { ...e, venue: { ...e.venue, indoor: pick<unknown>([0, 'yes', null]) } };
      if (spot === 'tag') return { ...e, tags: [...e.tags, pick<unknown>([1, null, {}, []])] };
      if (spot === 'size') return { ...e, sizes: [...e.sizes, pick<unknown>(['1', 1.5, null, 2 ** 60])] };
      return { ...e, grid: [...e.grid, [pick<unknown>(['x', null, 0.5])]] };
    };
    const d = damaged();
    if (post(d)[0] === 400) refused++;
  }
  ok(`${N} generated values come back as JSON.stringify writes them`, same === N, `${same} of ${N}`);
  ok(`${N} values with one thing wrong somewhere inside are refused`, refused === N, `${refused} of ${N}`);
}

// what cannot be JSON says so
ok(
  'C09: a list of optional values',
  codes(
    build(
      `type T { T(xs: List[Option[Int]]) }\nfn handle(raw: View) -> Response {\n  shown(d: decode(json: raw, as: T))\n}\nfn shown(d: Result[T, View]) -> Response {\n  match d {\n    Ok(value) -> empty(status: 200)\n    Err(error) -> empty(status: 400)\n  }\n}\n`,
    ),
  ) === 'C09',
);
ok(
  'C09: a list on its own of something that cannot be JSON',
  codes(
    build(
      `type T { T(n: Int) }\nfn handle(raw: View) -> Response {\n  buf() |> write_json(value: Cons(head: Some(value: 1), tail: Nil)) |> respond(status: 200)\n}\n`,
    ),
  ) === 'C09',
);
ok(
  'without std/json there is no nested JSON (C09), and nothing else changes',
  codes(
    compile([
      ...std.filter(s => s.name !== 'std/json.tape'),
      {
        name: 'program.tape',
        text: `type V { V(a: Int) }\ntype T { T(v: V) }\nfn handle(raw: View) -> Response {\n  shown(d: decode(json: raw, as: T))\n}\nfn shown(d: Result[T, View]) -> Response {\n  match d {\n    Ok(value) -> empty(status: 200)\n    Err(error) -> empty(status: 400)\n  }\n}\n`,
      },
    ]),
  ) === 'C09',
);
const flat = build(
  `type T { T(a: Int, b: View) }\nfn handle(raw: View) -> Response {\n  shown(d: decode(json: raw, as: T))\n}\nfn shown(d: Result[T, View]) -> Response {\n  match d {\n    Ok(value) -> buf() |> write_json(value) |> respond(status: 200)\n    Err(error) -> empty(status: 400)\n  }\n}\n`,
);
ok(
  'a flat record is decoded in the module, by the decoder written for it, with no import for JSON',
  flat.wasm !== null &&
    flat.functions.includes('json_decode_T') &&
    !WebAssembly.Module.imports(new WebAssembly.Module(flat.wasm)).some(i => i.name === 'json'),
  flat.wasm === null ? codes(flat) : flat.functions.filter(n => n.startsWith('json_')).join(','),
);

// between programs: a nested message and a nested reply, and a disagreement three levels down
const msg = `type Item { Item(sku: View, qty: Int) }\n\ntype Buyer { Buyer(name: View, tags: List[View]) }\n\ntype Basket { Basket(buyer: Buyer, items: List[Item]) }\n\ntype Line { Line(sku: View, cents: Int) }\n\ntype Quote { Quote(lines: List[Line], total: Int, to: Buyer) }\n\ntype Refusal { Refused(reason: View) }\n`;
const shop = (cents: string) => `${msg.replace('Item(sku: View, qty: Int)', cents)}
export fn price(message: Basket) -> Result[Quote, Refusal] {
  let Basket(buyer, items) = message
  match items {
    Nil -> Err(error: Refused(reason: "an empty basket"))
    _ -> Ok(value: Quote(lines: priced(items, acc: Nil), total: total(items, sum: 0), to: buyer))
  }
}

fn priced(items: List[Item], acc: List[Line]) -> List[Line] {
  match items {
    Cons(head: Item(sku, qty), tail) -> priced(items: tail, acc: Cons(head: Line(sku, cents: 250 * qty), tail: acc))
    Nil -> reverse(list: acc)
  }
}

fn total(items: List[Item], sum: Int) -> Int {
  match items {
    Cons(head: Item(qty), tail) -> total(items: tail, sum: sum + 250 * qty)
    Nil -> sum
  }
}
`;
const front = `${msg}
fn handle(raw: View, shop: Remote) -> Response {
  match request(raw) {
    Request(method: Post, path: "/quote", body) -> asked(basket: decode(json: body, as: Basket))
    _ -> empty(status: 404)
  }
}

fn asked(basket: Result[Basket, View]) -> Response {
  match basket {
    Ok(value) -> quoted(reply: ask(to: shop, method: "price", send: value, reply: Quote, error: Refusal, within: 1000))
    Err(error) -> buf() |> append(view: error) |> respond(status: 400)
  }
}

fn quoted(reply: Result[Quote, CallError[Refusal]]) -> Response {
  match reply {
    Ok(value) -> buf() |> write_json(value) |> respond_as(status: 200, content: Json)
    Err(error: Rejected(reason: Refused(reason))) -> buf() |> append(view: reason) |> respond(status: 422)
    Err(error: Skew(reason)) -> buf() |> append(view: reason) |> respond(status: 502)
    Err(error) -> empty(status: 504)
  }
}
`;
const fb = build(front),
  sb = build(shop('Item(sku: View, qty: Int)')),
  other = build(
    shop('Item(sku: View, qty: Int, gift: Bool)').replace(
      'Cons(head: Item(sku, qty), tail) -> priced',
      'Cons(head: Item(sku, qty), tail) -> priced',
    ),
  );
ok(
  'caller and callee with nested messages build',
  !fb.errors?.length && !sb.errors?.length && !other.errors?.length,
  [fb, sb, other]
    .map(x => x.errors?.map(e => `${e.code} ${e.file}:${e.line} ${e.message}`).join('|'))
    .join(' ; ')
    .slice(0, 400),
);
if (fb.wasm !== null && sb.wasm !== null && other.wasm !== null) {
  const frontModule = new WebAssembly.Module(fb.wasm);
  const wired = (callee: Built): ((body: unknown) => Promise<[number, string]>) => {
    const sql = nodeSql(),
      c = instantiate(new WebAssembly.Module(callee.wasm), { name: 't/shop', sql });
    const app = instantiate(frontModule, {
      name: 't/front',
      services: {
        shop: async (bytes, meta) => {
          const r = await c.serve({ method: meta.method, fingerprint: meta.fingerprint, key: meta.key }, bytes, {
            transaction: f => sql.transaction(f),
          });
          return { status: r.status, body: r.body };
        },
      },
    });
    return async (body: unknown): Promise<[number, string]> => {
      const r = responseOf(await app.run(enc.encode(`POST /quote\n${JSON.stringify(body)}`)));
      return [r.status, dec.decode(r.body)];
    };
  };
  const basket = {
    buyer: { name: 'ann', tags: ['vip', 'n"y'] },
    items: [
      { sku: 'lamp', qty: 2 },
      { sku: 'desk', qty: 1 },
    ],
  };
  const [s, t] = await wired(sb)(basket);
  ok(
    'a nested message goes out and a nested reply comes back',
    s === 200 &&
      t ===
        JSON.stringify({
          lines: [
            { sku: 'lamp', cents: 500 },
            { sku: 'desk', cents: 250 },
          ],
          total: 750,
          to: basket.buyer,
        }),
    `${s} ${t}`,
  );
  const [s3, t3] = await wired(sb)({ ...basket, items: [] });
  ok("the callee's refusal comes back as its reason", s3 === 422 && t3 === 'an empty basket', `${s3} ${t3}`);
  const [s4, t4] = await wired(other)(basket);
  ok(
    'a callee whose Item has one more field, two levels inside the message, answers skew and runs nothing',
    s4 === 502 && /defined differently/.test(t4),
    `${s4} ${t4.slice(0, 120)}`,
  );
  ok(
    "the two builds' fingerprints differ only because of that inner field",
    fb.calls[0]?.fingerprint === sb.methods[0]?.fingerprint &&
      sb.methods[0]?.fingerprint !== other.methods[0]?.fingerprint,
  );
  const [schema] = sb.schemas;
  const sent = schema?.input.properties;
  ok(
    'the JSON Schema of the message goes through its records and lists',
    sent?.items?.type === 'array' &&
      sent.items.items?.properties?.qty?.type === 'integer' &&
      sent.buyer?.properties?.tags?.items?.type === 'string' &&
      schema?.output.properties?.lines?.items?.required?.join(',') === 'sku,cents',
    JSON.stringify(schema?.input).slice(0, 200),
  );
}

// write_rows, and the box office taking an event with its tiers in one request
{
  const { build: withRules } = await import('../sim.ts');
  const tix = withRules(read('apps/tickets/tickets.tape'));
  ok(
    'apps/tickets builds with a nested request type',
    !tix.errors,
    tix.errors
      ?.map(e => `${e.code}:${e.line} ${e.message}`)
      .join(' | ')
      .slice(0, 300),
  );
  if (!tix.errors) {
    const sql = nodeSql(),
      app = instantiate(tix.module, { sql, name: 't/tickets', services: {} });
    const req = async (line: string, body: unknown = ''): Promise<[number, string]> => {
      const r = responseOf(
        (
          await app.runLogged(enc.encode(`${line}\n${typeof body === 'string' ? body : JSON.stringify(body)}`), {
            transaction: f => sql.transaction(f),
          })
        ).out,
      );
      return [r.status, dec.decode(r.body)];
    };
    const ev = {
      key: 'e3',
      name: 'Nested Night',
      starts: '2027-01-01T20:00',
      tiers: [
        { key: 'e3-a', name: 'floor', price: 5000, capacity: 10 },
        { key: 'e3-b', name: 'balcony', price: 2500, capacity: 30 },
      ],
    };
    const [s1] = await req('POST /events', ev),
      [, shown] = await req('GET /events/3');
    ok(
      'an event and its tiers are made by one request',
      s1 === 201 &&
        list(objectIn(shown).tiers)
          .map(x => [x.name, x.capacity, x.left])
          .join(';') === 'floor,10,10;balcony,30,30',
      shown.slice(0, 160),
    );
    const [s2] = await req('POST /events', ev),
      [, again] = await req('GET /events/3');
    ok('sent again with the same key: the same event, no tier twice', s2 === 200 && again === shown);
    const [s3, t3] = await req('POST /events', {
      ...ev,
      key: 'e4',
      tiers: [...ev.tiers.slice(0, 1), { key: 'e4-b', name: 'x', price: -1, capacity: 1 }],
    });
    ok(
      'a wrong tier refuses the whole request, and says where',
      s3 === 400 &&
        t3 ===
          '{"type":"about:blank","title":"Bad Request","status":400,"detail":"tiers[1].price: expected Money, 0 to 10000000"}' &&
        sql.exec("SELECT count(*) AS n FROM events WHERE client = 'e4'").toArray()[0]?.n === 0,
      t3,
    );
    const [, audit] = await req('GET /audit');
    ok(
      'write_rows writes every row of a query as write_json writes one',
      list(objectIn(audit).tiers).length === 6 && Array.isArray(objectIn(audit).holds),
      audit.slice(0, 100),
    );
  }
}

finish();
