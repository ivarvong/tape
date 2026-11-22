// test/calls.ts: recursive types, decode reasons, calls with time budgets, resumption and replay.
import '../node25.ts';
import { readFileSync } from 'node:fs';
import { compile } from '../compiler.ts';
import { instantiate, isCall, isHead, replay, spans, traceOf } from '../host.ts';
import type { Effect, Head, Service, ServiceOptions } from '../host.ts';
import { nodeSql } from '../nodesql.ts';
import { std } from '../std.ts';
import type { Built, Options } from '../compiler.ts';
import { bare, built, call, finish, messageOf, moduleOf, same as T, sleep } from './harness.ts';
const build = (program: string, options: Partial<Options> = {}): Built =>
  built([{ name: 't', text: program }], options);
const err = (program: string): string =>
  compile([...std, { name: 't', text: program }], { exports: ['f'] }).errors[0]?.code ?? 'compiled';
const pure = (program: string, fn: string, args: bigint[]): number => {
  const ex = bare(moduleOf(build(program, { exports: [fn] })));
  call(ex.fns, 'reset');
  return Number(call(ex.fns, fn, ...args));
};
const text = (b: Uint8Array | undefined): string => new TextDecoder().decode(b),
  bytes = (s: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(s);

const callAt = (effects: readonly Effect[], i: number) => {
  const e = effects[i];
  return e && isCall(e) ? e : undefined;
};
const headOf = (effects: readonly Effect[] | undefined): Head | undefined => {
  const [h] = effects ?? [];
  return h && isHead(h) ? h : undefined;
};

// ---- recursive types
const LIST = `type List[T] {
  Cons(head: T, tail: List[T])
  Nil
}
fn range(n: Int, acc: List[Int]) -> List[Int] {
  match {
    n == 0 -> acc
    else -> range(n: n - 1, acc: Cons(head: n, tail: acc))
  }
}
fn sum(list: List[Int], acc: Int) -> Int {
  match list {
    Cons(head, tail) -> sum(list: tail, acc: acc + head)
    Nil -> acc
  }
}
fn reverse(list: List[Int], acc: List[Int]) -> List[Int] {
  match list {
    Cons(head, tail) -> reverse(list: tail, acc: Cons(head, tail: acc))
    Nil -> acc
  }
}
fn first(list: List[Int]) -> Int {
  match list {
    Cons(head) -> head
    Nil -> 0 - 1
  }
}
fn f(n: Int) -> Int {
  sum(list: range(n, acc: Nil), acc: 0) * 1000 + first(list: reverse(list: range(n, acc: Nil), acc: Nil))
}`;
T('list: build, fold, reverse', pure(LIST, 'f', [100n]), 5050 * 1000 + 100);
T('list of 200,000', pure(LIST, 'f', [200000n]), 20000100000 * 1000 + 200000);
T(
  'tree',
  pure(
    `type Tree {
  Node(left: Tree, value: Int, right: Tree)
  Leaf
}
fn insert(tree: Tree, n: Int) -> Tree {
  match tree {
    Leaf -> Node(left: Leaf, value: n, right: Leaf)
    Node(left, value, right) if n < value -> Node(left: insert(tree: left, n), value, right)
    Node(left, value, right) -> Node(left, value, right: insert(tree: right, n))
  }
}
fn fill(tree: Tree, n: Int, seed: Int) -> Tree {
  match {
    n == 0 -> tree
    else -> fill(tree: insert(tree, n: seed % 1000), n: n - 1, seed: (seed * 7919 + 13) % 100003)
  }
}
fn depth(tree: Tree) -> Int {
  match tree {
    Leaf -> 0
    Node(left, right) -> 1 + larger(a: depth(tree: left), b: depth(tree: right))
  }
}
fn larger(a: Int, b: Int) -> Int {
  match {
    a > b -> a
    else -> b
  }
}
fn total(tree: Tree) -> Int {
  match tree {
    Leaf -> 0
    Node(left, value, right) -> total(tree: left) + value + total(tree: right)
  }
}
fn smallest(tree: Tree) -> Int {
  match tree {
    Node(left: Leaf, value) -> value
    Node(left) -> smallest(tree: left)
    Leaf -> 0 - 1
  }
}
fn f(n: Int) -> Int {
  total(tree: fill(tree: Leaf, n, seed: 1)) * 100 + depth(tree: fill(tree: Leaf, n, seed: 1))
}`,
    'f',
    [500n],
  ),
  (() => {
    let s = 1,
      t = 0;
    type Node = { v: number; l?: Node; r?: Node };
    const ins = (n: Node | undefined, v: number): Node => {
      if (!n) return { v };
      if (v < n.v) n.l = ins(n.l, v);
      else n.r = ins(n.r, v);
      return n;
    };
    let root: Node | undefined;
    for (let i = 0; i < 500; i++) {
      root = ins(root, s % 1000);
      t += s % 1000;
      s = (s * 7919 + 13) % 100003;
    }
    const d = (n: Node | undefined): number => (n ? 1 + Math.max(d(n.l), d(n.r)) : 0);
    return t * 100 + d(root);
  })(),
);
T(
  'mutually recursive types',
  pure(
    `type Expr {
  Num(value: Int)
  Add(terms: Terms)
}
type Terms {
  More(first: Expr, rest: Terms)
  Done
}
fn eval(e: Expr) -> Int {
  match e {
    Num(value) -> value
    Add(terms) -> all(terms, acc: 0)
  }
}
fn all(terms: Terms, acc: Int) -> Int {
  match terms {
    More(first, rest) -> all(terms: rest, acc: acc + eval(e: first))
    Done -> acc
  }
}
fn f(n: Int) -> Int {
  eval(e: Add(terms: More(first: Num(value: n), rest: More(first: Add(terms: More(first: Num(value: 2), rest: Done)), rest: Done))))
}`,
    'f',
    [40n],
  ),
  42,
);
T(
  'Buf in a recursive type is rejected',
  err('type L {\n  C(b: Buf, t: L)\n  N\n}\nfn f(n: Int) -> Int {\n  n\n}\nfn g(l: L) -> Int {\n  1\n}'),
  'C08',
);

// ---- decode reasons
const DEC = `type Title = View where len(self) >= 1 and len(self) <= 5
type New { New(title: Title, done: Option[Bool]) }
fn handle(raw: View) -> Buf {
  match decode(json: raw, as: New) {
    Ok(value: New(title)) -> append(buf: buf(), view: title)
    Err(error) -> append(buf: append(buf: buf(), view: "no: "), view: error)
  }
}`;
{
  const app = instantiate(new WebAssembly.Module(build(DEC).wasm), {});
  const go = (s: string) => text(app.handle(bytes(s)));
  T('decode ok', go('{"title":"milk"}'), 'milk');
  T('decode: not JSON', go('{"title":'), 'no: not JSON');
  T('decode: missing key', go('{"done":true}'), 'no: missing key "title"');
  T('decode: wrong kind', go('{"title":5}'), 'no: title: expected text');
  T('decode: unknown key', go('{"title":"a","x":1}'), 'no: unknown key "x"');
  T('decode: refinement', go('{"title":"too long"}'), 'no: title: not a valid Title');
  T('decode: empty', go(''), 'no: empty');
}

// ---- calls: orders.tape (caller) and stock.tape (callee), both in the language
T(
  'call without a time budget is rejected',
  err(
    'type M { M(n: Int) }\nfn f(r: Remote) -> Int {\n  ignore(reply: call(to: r, method: "m", send: M(n: 1), reply: M, once: 1))\n}\nfn ignore(reply: Result[M, CallError]) -> Int {\n  match reply {\n    Ok(value) -> 1\n    Err(error) -> 0\n  }\n}',
  ),
  'C39',
);
T(
  'a command without a key is rejected',
  err(
    'type M { M(n: Int) }\nfn f(r: Remote) -> Int {\n  ignore(reply: call(to: r, method: "m", send: M(n: 1), reply: M, within: 5))\n}\nfn ignore(reply: Result[M, CallError]) -> Int {\n  match reply {\n    Ok(value) -> 1\n    Err(error) -> 0\n  }\n}',
  ),
  'C41',
);
T(
  'a read takes no key',
  err(
    'type M { M(n: Int) }\nfn f(r: Remote) -> Int {\n  ignore(reply: ask(to: r, method: "m", send: M(n: 1), reply: M, within: 5, once: 1))\n}\nfn ignore(reply: Result[M, CallError]) -> Int {\n  match reply {\n    Ok(value) -> 1\n    Err(error) -> 0\n  }\n}',
  ),
  'C11',
);
T(
  'an exported function has one message and returns Result[_, View]',
  err(
    'type M { M(n: Int) }\nexport fn m(a: M, b: M) -> Result[M, View] {\n  Ok(value: a)\n}\nfn f(n: Int) -> Int {\n  n\n}',
  ),
  'C42',
);
const read = (n: string) => readFileSync(new URL(`../examples/${n}`, import.meta.url), 'utf8');
const orders = build(read('orders.tape')),
  module = new WebAssembly.Module(orders.wasm),
  traced = new WebAssembly.Module(build(read('orders.tape'), { trace: true }).wasm);
const stockBuild = build(read('stock.tape')),
  stockModule = new WebAssembly.Module(stockBuild.wasm);
const post = (item: string, key: string) =>
    bytes(`POST /orders\n{"key":${JSON.stringify(key)},"item":${JSON.stringify(item)}}`),
  list = bytes('GET /orders\n'),
  retry = (id: number) => bytes(`POST /retry/${id}\n`);
{
  const stockSql = nodeSql(),
    stockApp = instantiate(stockModule, { sql: stockSql });
  const left = (item: string) =>
    stockSql.exec('SELECT remaining FROM stock WHERE item = ?1', item).raw().toArray()[0]?.[0];
  let delay = 0,
    seen: ServiceOptions[] = [];
  const stock: Service = async (b, meta) => {
    seen.push(meta);
    if (delay > 0) await sleep(delay);
    return stockApp.serve(meta, b);
  };
  const app = instantiate(module, { sql: nodeSql(), services: { stock }, name: 'orders-1' });
  app.setFlags({ stock_budget_ms: 50 }); // the default is 2000; these tests want to see the budget run out
  T(
    'the two modules agree on the fingerprint',
    [orders.calls[0]?.fingerprint, orders.calls[0]?.keyed],
    [stockBuild.methods[0]?.fingerprint, true],
  );
  T(
    'entry',
    orders.entry.map(p => p.type),
    ['View', 'Sql', 'Remote'],
  );
  const ok = await app.runLogged(post('lamp', 'a'));
  T('call ok', text(ok.out), '201\n{"id":1,"item":"lamp","state":"confirmed"}');
  T(
    'log: build, insert, call, update',
    ok.effects.map(e => Object.keys(e)[0]),
    ['build', 'q', 'call', 'q'],
  );
  T(
    'log: the call',
    { ...ok.effects[2], took: 0, sent: typeof callAt(ok.effects, 2)?.sent },
    {
      call: 'stock',
      method: 'reserve',
      send: '{"item":"lamp"}',
      within: 50,
      once: '{"order":1}',
      status: 'ok',
      reply: '{"item":"lamp","remaining":1}',
      sent: 'number',
      took: 0,
    },
  );
  T(
    'the key names the caller, the method and the program key (a record key, as its JSON)',
    seen[0]?.key,
    'orders-1/reserve/{"order":1}',
  );
  T('replay ok', text(replay(module, post('lamp', 'a'), ok.effects)), text(ok.out));
  T(
    'trace has the call',
    traceOf(traced, post('lamp', 'a'), ok.effects).events.flatMap(e => ('call' in e ? [e.status] : [])),
    ['ok'],
  );
  T("call rejected with the callee's reason", text(await app.run(post('unicorn', 'b'))), '409\n{"error":"none left"}');

  // a timeout on a command: the outcome is unknown, and sending it again with the same key is safe
  delay = 120;
  const t0 = Date.now(),
    slow = await app.runLogged(post('lamp', 'c')),
    took = Date.now() - t0;
  T('call timeout', text(slow.out), '504\n{"error":"stock did not answer in time; the order stays pending"}');
  T('timeout returned at the budget, not at the reply', took >= 45 && took < 110, true);
  T(
    'replay timeout takes no time',
    (() => {
      const t = Date.now();
      const out = text(replay(module, post('lamp', 'c'), slow.effects));
      return [out.slice(0, 3), Date.now() - t < 20];
    })(),
    ['504', true],
  );
  await sleep(150);
  delay = 0;
  T('the callee did reserve it', left('lamp'), 0);
  T(
    'retry with the same key is answered from the stored reply',
    text(await app.run(retry(3))),
    '201\n{"id":3,"item":"lamp","state":"confirmed"}',
  );
  T(
    'and reserved nothing more',
    [left('lamp'), stockSql.exec('SELECT count(*) FROM _calls').raw().toArray()[0]?.[0]],
    [0, 3],
  );
  T('a second retry finds no pending order', text(await app.run(retry(3))).slice(0, 3), '404');
  T(
    'states',
    text(await app.run(list)),
    '200\n[{"id":1,"item":"lamp","state":"confirmed"},{"id":2,"item":"unicorn","state":"refused"},{"id":3,"item":"lamp","state":"confirmed"}]',
  );

  // a served request has its own log and replays without a database
  const served = await stockApp.serve(
    { method: 'reserve', fingerprint: stockBuild.methods[0]?.fingerprint ?? '', key: 'test/reserve/9' },
    bytes('{"item":"desk"}'),
  );
  T(
    'serve',
    [served.status, text(served.body), headOf(served.effects)?.method],
    ['ok', '{"item":"desk","remaining":4}', 'reserve'],
  );
  T(
    'replay of a served method',
    text(replay(stockModule, bytes('{"item":"desk"}'), served.effects ?? [])).slice(1),
    '{"item":"desk","remaining":4}',
  );
  T('a served log holds its message', headOf(served.effects)?.message, '{"item":"desk"}');
  T(
    'so it replays from the log alone',
    text(replay(stockModule, null, served.effects ?? [])).slice(1),
    '{"item":"desk","remaining":4}',
  );
  const read1 = await stockApp.serve(
    { method: 'remaining', fingerprint: stockBuild.methods[1]?.fingerprint ?? '' },
    bytes('{"item":"desk"}'),
  );
  T(
    'a read stores nothing',
    [text(read1.body), stockSql.exec('SELECT count(*) FROM _calls').raw().toArray()[0]?.[0]],
    ['{"remaining":4}', 4],
  );
  T(
    'a bad message is rejected with the reason',
    await stockApp
      .serve({ method: 'reserve', fingerprint: stockBuild.methods[0]?.fingerprint ?? '' }, bytes('{"item":7}'))
      .then(r => [r.status, text(r.body)]),
    ['rejected', 'item: expected text'],
  );

  // version skew: the callee was built from another definition of the method, so nothing runs
  const newer = new WebAssembly.Module(
    build(
      read('stock.tape').replace(
        'type Reserve { Reserve(item: View) }',
        'type Reserve { Reserve(item: View, count: Int) }',
      ),
    ).wasm,
  );
  const newSql = nodeSql(),
    newStock = instantiate(newer, { sql: newSql });
  const skewed = instantiate(module, {
    sql: nodeSql(),
    services: { stock: (b, meta) => newStock.serve(meta, b) },
    name: 'orders-2',
  });
  const sk = text(await skewed.run(post('lamp', 'd')));
  T('skew is a value', [sk.slice(0, 3), sk.includes('reserve is defined differently on the two sides')], ['502', true]);
  T(
    'and nothing ran on the callee',
    newSql.exec("SELECT remaining FROM stock WHERE item = 'lamp'").raw().toArray()[0]?.[0],
    2,
  );
  const gone = instantiate(module, {
    sql: nodeSql(),
    services: { stock: (b, meta) => newStock.serve({ ...meta, method: 'hold' }, b) },
    name: 'orders-3',
  });
  T(
    'an unknown method is skew too',
    text(await gone.run(post('lamp', 'e'))).includes('no method hold here; this build serves: reserve, remaining'),
    true,
  );

  // budgets, deadlines, transactions
  seen = [];
  await app.run(post('desk', 'f'), { deadlineMs: 20 });
  T('the request deadline caps the call budget', (seen[0]?.withinMs ?? Infinity) <= 20, true);
  T(
    'no time left: no call is made',
    [text(await app.run(post('desk', 'g'), { deadlineMs: 0 })).slice(0, 3), seen.length],
    ['504', 1],
  );
  T(
    'unreachable',
    text(await instantiate(module, { sql: nodeSql(), name: 'x' }).run(post('lamp', 'h'))),
    '503\n{"error":"stock is unreachable; the order stays pending"}',
  );
  T(
    'bad body gives the reason',
    text(await app.run(bytes('POST /orders\n{"key":"z","item":7}'))),
    '400\n{"error":"item: expected text"}',
  );
  T(
    'sync handle refuses a handler that calls',
    (() => {
      try {
        app.handle(post('x', 'i'));
        return 'ran';
      } catch (e) {
        return messageOf(e);
      }
    })(),
    'this handler calls stock: use await app.run(bytes)',
  );
  const tx = { begun: 0, done: 0 };
  await app.run(post('desk', 'j'), {
    transaction: f => {
      tx.begun++;
      const r = f();
      tx.done++;
      return r;
    },
  });
  T('one transaction per stretch between calls', tx, { begun: 2, done: 2 });
  const other = new WebAssembly.Module(build(read('orders.tape').replace('Int = 2000', 'Int = 2500')).wasm);
  T(
    'another build refuses the log',
    (() => {
      try {
        replay(other, post('lamp', 'a'), ok.effects);
        return 'ran';
      } catch (e) {
        return messageOf(e).slice(0, 31);
      }
    })(),
    'this log was recorded by build ',
  );
  T('the traced build has the same name', build(read('orders.tape'), { trace: true }).build, orders.build);
  T(
    'a command needs a named caller',
    await instantiate(module, { sql: nodeSql(), services: { stock } })
      .run(post('desk', 'k'))
      .then(
        () => 'ran',
        (e: unknown) => messageOf(e).slice(0, 27),
      ),
    'this program sends commands',
  );
}
console.log(`orders.tape: ${orders.wasm.length} bytes, stock.tape: ${stockBuild.wasm.length} bytes`);

// ---- distributed tracing: one trace across two objects, assembled from their logs
{
  const logs: Effect[][] = [],
    sink = (log: Effect[]): void => {
      logs.push(log);
    };
  const stockApp = instantiate(stockModule, { sql: nodeSql(), name: 'stock', sink });
  let delay = 0;
  const app = instantiate(module, {
    sql: nodeSql(),
    name: 'orders',
    sink,
    services: {
      stock: async (b, meta) => {
        if (delay > 0) await sleep(delay);
        return stockApp.serve(meta, b);
      },
    },
  });
  app.setFlags({ stock_budget_ms: 50 });
  await app.run(post('lamp', 't1'));
  const [root] = spans(logs),
    child = root?.children[0];
  T(
    'one trace, two spans',
    [logs.length, spans(logs).length, root?.name, root?.children.length, child?.name, child?.method],
    [2, 1, 'orders', 1, 'stock', 'reserve'],
  );
  T(
    'ids',
    [root?.trace?.length, root?.span?.length, child?.trace === root?.trace, child?.parent === root?.span, root?.parent],
    [32, 16, true, true, null],
  );
  T(
    'the caller span lists its call',
    root?.calls.map(c => [c.to, c.method, c.status]),
    [['stock', 'reserve', 'ok']],
  );
  T(
    'any span expands to every arm by replay',
    traceOf(
      new WebAssembly.Module(build(read('stock.tape'), { trace: true }).wasm),
      bytes('{"item":"lamp"}'),
      child?.log ?? [],
    ).events.some(e => 'what' in e && e.what === 1),
    true,
  );
  T(
    'and traces from its own log, with no bytes from the caller',
    (() => {
      const t = traceOf(
        new WebAssembly.Module(build(read('stock.tape'), { trace: true }).wasm),
        null,
        child?.log ?? [],
      );
      return [t.error, t.events.flatMap(e => ('json' in e ? [e.json] : []))];
    })(),
    [null, ['decoded']],
  );
  // a timeout: the caller's span ends with the call timed out; the callee's span arrives later, same trace
  logs.length = 0;
  delay = 100;
  await app.run(post('lamp', 't2'));
  T(
    'timeout: the caller span is done before the callee span exists',
    [logs.length, headOf(logs[0])?.name, callAt(logs[0] ?? [], (logs[0]?.length ?? 0) - 1)?.status],
    [1, 'orders', 'timeout'],
  );
  await sleep(130);
  const [late] = spans(logs);
  T(
    'the late callee span joins the same trace',
    [logs.length, late?.children[0]?.name, (late?.children[0]?.at ?? 0) >= (late?.at ?? 0) + (late?.took ?? 0)],
    [2, 'stock', true],
  );
  T('replay ignores trace fields', text(replay(module, post('lamp', 't2'), late?.log ?? [])).slice(0, 3), '504');
}

// ---- time and randomness are capabilities, and logged
{
  const SRC = `fn handle(raw: View, clock: Clock, dice: Entropy) -> Buf {
  stamp(out: write_int(out: buf(), value: now(clock)), roll: random(from: dice) % 6 + 1)
}
fn stamp(out: Buf, roll: Int) -> Buf {
  write_int(out: push(buf: out, byte: 32), value: roll)
}`;
  const m = new WebAssembly.Module(build(SRC).wasm),
    app = instantiate(m, {});
  const out = text(app.handle(bytes(''))),
    [t = 0, roll = 0] = out.split(' ').map(Number);
  T('now and random', [Math.abs(t - Date.now()) < 1000, roll >= 1 && roll <= 6], [true, true]);
  T(
    'log has both',
    app.effects.slice(1).map(e => Object.keys(e)[0]),
    ['now', 'random'],
  );
  T('replay gives the same time and roll', text(replay(m, bytes(''), app.effects)), out);
  T('now without the capability is rejected', err('fn f(n: Int) -> Int {\n  now(n)\n}'), 'C14');
  // ---- command keys (C64, C65) and the callee's check that a key names one message
  const prog = (key: string) =>
    `type M { M(n: Int, text: View) }\ntype ForRow { ForRow(row: Int) }\nfn f(r: Remote, id: Int, raw: View) -> Int {\n  ignore(reply: call(to: r, method: "m", send: M(n: id, text: raw), reply: M, within: 5, once: ${key}))\n}\nfn ignore(reply: Result[M, CallError]) -> Int {\n  match reply {\n    Ok(value) -> 1\n    Err(error) -> 0\n  }\n}`;
  T(
    'C64: a key that is an Int, a Bool or an Option is refused (text and records pass C64, then C65 judges them)',
    ['id', 'id == 1', 'Some(value: id)', 'raw', 'ForRow(row: id)', '"row-" ++ raw'].map(k => err(prog(k))),
    ['C64', 'C64', 'C64', 'C65', 'C65', 'C65'],
  );
  const prog2 = (key: string) => prog(key).replace('send: M(n: id, text: raw)', 'send: M(n: 1, text: "x")');
  T(
    'C65: a key that is the same every time is refused; one the message does not carry is taken',
    [err(prog2('"always"')), err(prog2('ForRow(row: 7)')), err(prog2('ForRow(row: id)')), err(prog2('raw'))],
    ['C65', 'C65', 'compiled', 'compiled'],
  );
  T(
    'C65: a key made only of what the message carries is refused, unless it is the message itself',
    [err(prog('ForRow(row: id)')), err(prog('M(n: id, text: raw)'))],
    ['C65', 'compiled'],
  );
  const c65 = compile([...std, { name: 't', text: prog('ForRow(row: id)') }], { exports: ['f'] }).errors[0];
  T(
    'the C65 error names what the key is made of and the two ways out',
    [c65?.message.includes('(id)'), c65?.hint?.includes('the same record as `send:`')],
    [true, true],
  );
  {
    const sql = nodeSql(),
      callee = instantiate(stockModule, { sql });
    const meta = {
      method: 'reserve',
      fingerprint: stockBuild.methods[0]?.fingerprint ?? '',
      key: 'orders-9/reserve/{"order":1}',
    };
    const left = (item: string) =>
      sql.exec('SELECT remaining FROM stock WHERE item = ?1', item).raw().toArray()[0]?.[0];
    const a = await callee.serve(meta, bytes('{"item":"desk"}')),
      b = await callee.serve(meta, bytes('{"item":"desk"}'));
    T(
      'a key sent again with the same message is answered from the stored reply, and runs once',
      [a.status, b.status, text(b.body), left('desk')],
      ['ok', 'ok', text(a.body), 4],
    );
    const c = await callee.serve(meta, bytes('{"item":"lamp"}'));
    T(
      'the same key with another message answers skew (not rejected: the first message ran), and nothing runs',
      [c.status, /was used before for another reserve message/.test(text(c.body)), left('lamp')],
      ['skew', true, 2],
    );
    sql.exec(`INSERT INTO _calls(key, status, body) VALUES ('old/reserve/7', 'ok', '{"item":"desk","remaining":9}')`);
    const d = await callee.serve({ ...meta, key: 'old/reserve/7' }, bytes('{"item":"lamp"}'));
    T(
      'a row stored before messages were kept (message NULL) is replayed as before',
      [d.status, text(d.body), left('lamp')],
      ['ok', '{"item":"desk","remaining":9}', 2],
    );
  }
  {
    // an object made before messages were kept: instantiate adds the column, and keeps the rows
    const sql = nodeSql();
    sql.exec('CREATE TABLE _calls(key TEXT PRIMARY KEY, status TEXT NOT NULL, body TEXT NOT NULL)');
    sql.exec(`INSERT INTO _calls VALUES ('k', 'ok', 'x')`);
    instantiate(stockModule, { sql });
    T(
      'the _calls table of an older object gains its message column; its rows stay',
      [
        sql
          .exec("SELECT name FROM pragma_table_info('_calls')")
          .toArray()
          .map(r => r.name),
        sql
          .exec('SELECT key, message FROM _calls')
          .toArray()
          .map(r => [r.key, r.message]),
      ],
      [['key', 'status', 'body', 'message'], [['k', null]]],
    );
  }
  // ---- a family of Remotes: remote(of, index) names member <family>-<index>, chosen at run time
  {
    const fam =
      'type P { P(n: Int) }\ntype Q { Q(n: Int) }\nfn handle(raw: View, shards: Remotes) -> Buf {\n  answer(reply: call(to: remote(of: shards, index: len(raw) % 3), method: "p", send: P(n: len(raw)), reply: Q, within: 500, once: raw))\n}\nfn answer(reply: Result[Q, CallError]) -> Buf {\n  match reply {\n    Ok(value: Q(n)) -> write_int(out: respond(status: 200), value: n)\n    _ -> respond(status: 502)\n  }\n}\n';
    const r = build(fam),
      hits: [number, string | null][] = [];
    const shard =
      (i: number): Service =>
      (_b, meta) => {
        hits.push([i, meta.key]);
        return bytes(JSON.stringify({ n: i }));
      };
    const services = Object.fromEntries([0, 1, 2].map(i => [`shards-${i}`, shard(i)]));
    const router = instantiate(new WebAssembly.Module(r.wasm), { sql: nodeSql(), services, name: 'router' });
    const outs = [];
    for (const req of ['a', 'bb', 'ccc', 'dddd']) outs.push(text(await router.run(bytes(req))));
    T(
      'a family of Remotes: the member is chosen at run time, and named <family>-<index>',
      [outs, hits.map(h => h[0])],
      [
        ['200\n1', '200\n2', '200\n0', '200\n1'],
        [1, 2, 0, 1],
      ],
    );
    T(
      'remote needs a family; a Remote is not one',
      err(
        'type P { P(n: Int) }\nfn f(s: Remote) -> Int {\n  ignore(reply: call(to: remote(of: s, index: 1), method: "p", send: P(n: 1), reply: P, within: 5, once: "k"))\n}\nfn ignore(reply: Result[P, CallError]) -> Int {\n  1\n}',
      ),
      'C14',
    );
    const neg = build(fam.replace('index: len(raw) % 3', 'index: 0 - len(raw)'));
    let msg = '';
    try {
      await instantiate(new WebAssembly.Module(neg.wasm), { sql: nodeSql(), services, name: 'router' }).run(bytes('x'));
    } catch (e) {
      msg = messageOf(e);
    }
    T('a negative index is refused by the host', /index -1 is not a whole number from 0/.test(msg), true);
  }
  finish();
}
