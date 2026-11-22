// apps/trace/fixtures/make.ts: OTLP/JSON fixtures for trace.tape, made by the repository's own code.
//   node apps/trace/fixtures/make.ts            rewrite every fixture in this directory
//
// The call chain is the service's, minus Durable Objects. Each program is compiled with std (compiler.ts) and run
// on its own in-memory SQLite (nodesql.ts) by the host (host.ts: instantiate, runLogged, serve, wake), with real
// clocks and real calls between programs. Each run's effect log is then joined with what its callees ran, into
// the `Joined` shape service/src/name.ts builds (joined/joinCalls), and turned into OTLP by service/src/view.ts
// `otlp()` itself. The parts of the service this replaces, and how:
// - Name.joinCalls asks each callee for its rows under the caller's span: here each served call is remembered
//   as it happens, and matched to the caller's call entries in order, by callee and method.
// - Program.serve records a callee run that trapped with `failed` on its head and answers `rejected`
//   (program.ts, the catch in serve): the same is done here.
// - Program.#failed records a request that trapped with `failed` on its head: the same is done here.
// - A call to a program that is not there is answered `unreachable` by the host, and joinCalls finds no row for
//   it (served: null), which otlp() turns into a `tape.span.missing` event.
// Synthetic fixtures (big.json, deep.json) are made at the end from a seeded generator.
import '../../../node25.ts';
import { readFileSync, writeFileSync } from 'node:fs';
import { compile } from '../../../compiler.ts';
import { instantiate, isCall, isHead } from '../../../host.ts';
import type { App, Effect, Head, Service } from '../../../host.ts';
import { clockUs } from '../../../host/log.ts';
import type { CallEffect } from '../../../host/log.ts';
import { nodeSql } from '../../../nodesql.ts';
import { std } from '../../../std.ts';

// The service's own types (service/src/records.ts) are written again here, as far as this file builds them: the
// root tsconfig leaves service/ out (it is typed against the Workers runtime), and a static import of view.ts or
// records.ts would bring service/src/spans.ts, and its Workers globals, into the root type check. view.ts is
// loaded by a computed path for the same reason, and what its otlp() gives is checked below.
type Run = {
  id: string;
  version: number;
  at: number;
  effects: Effect[];
  source: string;
  queries: string[];
  request: string;
  status: number | string;
  response: string;
  trace: string[][];
  error: string | null;
  calls?: JoinedCall[];
};
type ServedRow = {
  version: number;
  key: string | null;
  method: string | undefined;
  status: string;
  at: number;
  began: number | null;
  took: number | null;
  began_us?: number | null;
  took_us?: number | null;
  log_id: string | null;
  view: Run | null;
};
type JoinedCall = { e: CallEffect; served: ServedRow | null; why?: string };
type Joined = Run & { account: string; name: string; calls: JoinedCall[] };
type Doc = { resourceSpans: { resource?: unknown; scopeSpans: { spans: unknown[] }[] }[] };

const VIEW = new URL('../../../service/src/view.ts', import.meta.url).href;
const viewModule: unknown = await import(VIEW);
const otlpFn = typeof viewModule === 'object' && viewModule !== null && 'otlp' in viewModule ? viewModule.otlp : null;
const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;
/** view.ts otlp(j), checked to be OTLP/JSON's outline. */
function otlp(j: Joined): Doc {
  if (typeof otlpFn !== 'function') return fail('service/src/view.ts has no otlp()');
  const doc: unknown = Reflect.apply(otlpFn, undefined, [j]);
  const list = isRecord(doc) ? doc['resourceSpans'] : null;
  if (!Array.isArray(list)) return fail('otlp() gave no resourceSpans');
  return {
    resourceSpans: list.map((r: unknown) => {
      const scopes = isRecord(r) ? r['scopeSpans'] : null;
      if (!isRecord(r) || !Array.isArray(scopes)) return fail('a resource with no scopeSpans');
      return {
        resource: r['resource'],
        scopeSpans: scopes.map((sc: unknown) => {
          const spans = isRecord(sc) ? sc['spans'] : null;
          return Array.isArray(spans) ? { ...(isRecord(sc) ? sc : {}), spans } : fail('a scope with no spans');
        }),
      };
    }),
  };
}

const ROOT = new URL('../../../', import.meta.url).pathname;
const HERE = new URL('./', import.meta.url).pathname;
const ACCOUNT = 'demo';
const enc = new TextEncoder();
const dec = new TextDecoder();
const sleep = (ms: number): Promise<void> =>
  new Promise(r => {
    setTimeout(r, ms);
  });

type Program = { name: string; app: App; source: string; queries: string[] };
/** What a callee did for one call: under which caller span, and its log (null: answered from a stored reply). */
type ServedCall = {
  caller: string | undefined;
  callee: string;
  method: string;
  key: string | null;
  status: string;
  at: number;
  took: number;
  atUs: number;
  tookUs: number;
  effects: Effect[] | null;
  failed: boolean;
  used: boolean;
};

class World {
  programs = new Map<string, Program>();
  served: ServedCall[] = [];
  /** compile and instantiate; `remotes` names the programs each Remote parameter reaches (absent: unreachable) */
  add(name: string, source: string, remotes: Record<string, string> = {}): Program {
    const r = compile([...std, { name: `${name}.tape`, text: source }]);
    if (!r.wasm) throw new Error(`${name}: ${r.errors.map(e => `${e.code} ${e.message}`).join('; ')}`);
    const services: Record<string, Service> = {};
    for (const [param, target] of Object.entries(remotes)) services[param] = this.service(target);
    const app = instantiate(new WebAssembly.Module(r.wasm), { sql: nodeSql(), services, name: `${ACCOUNT}/${name}` });
    const p = { name, app, source, queries: r.queries.map(q => q.sql) };
    this.programs.set(name, p);
    return p;
  }
  /** A Remote that reaches `target`'s exported methods, as the service's Name does. */
  service(target: string): Service {
    return async (bytes, o) => {
      const callee = this.programs.get(target);
      if (!callee) throw new Error(`no program ${target}`);
      const at = Date.now(),
        atUs = clockUs();
      const row: ServedCall = {
        caller: o.trace?.parent,
        callee: target,
        method: o.method,
        key: o.key,
        status: 'ok',
        at,
        took: 0,
        atUs,
        tookUs: 0,
        effects: null,
        failed: false,
        used: false,
      };
      this.served.push(row);
      try {
        const s = await callee.app.serve(
          { method: o.method, fingerprint: o.fingerprint, key: o.key, withinMs: o.withinMs, trace: o.trace },
          bytes,
        );
        Object.assign(row, {
          status: s.status,
          took: Date.now() - at,
          tookUs: clockUs() - atUs,
          effects: s.effects ?? null,
        });
        return { status: s.status, body: s.body };
      } catch (e) {
        // program.ts serve: a callee run that failed is recorded with `failed` and answered `rejected`
        const effects = effectsOf(e);
        const message = e instanceof Error ? e.message : String(e);
        const head = effects?.[0];
        if (head && isHead(head))
          Object.assign(head, { failed: { status: 'rejected', error: message, rolled_back: true } });
        Object.assign(row, {
          status: 'rejected',
          took: Date.now() - at,
          tookUs: clockUs() - atUs,
          effects,
          failed: true,
        });
        return { status: 'rejected', body: enc.encode(`${o.method} failed: ${message}`) };
      }
    };
  }
  /** A request to a program: the run as the service stores it, its calls joined. */
  async request(name: string, line: string, body = ''): Promise<Joined> {
    const p = this.programs.get(name) ?? fail(`no ${name}`);
    const bytes = enc.encode(body === '' ? line : `${line}\n\n${body}`);
    try {
      const ran = await p.app.runLogged(bytes);
      return this.joined(p, ran.effects, dec.decode(bytes), ran.out);
    } catch (e) {
      // program.ts #failed: the run trapped; its log so far is kept with `failed` on its head
      const effects = effectsOf(e) ?? fail(String(e));
      const message = e instanceof Error ? e.message : String(e);
      const head = effects[0];
      if (head && isHead(head)) Object.assign(head, { failed: { status: 500, error: message, rolled_back: true } });
      return this.joined(p, effects, dec.decode(bytes), null, message);
    }
  }
  /** A timer that is due: `woken` runs, a child span of the run that set it. */
  async wake(name: string, key: number): Promise<Joined> {
    const p = this.programs.get(name) ?? fail(`no ${name}`);
    const w = (await p.app.wake(key, { now: Date.now() + 3600_000 })) ?? fail(`timer ${key} is not set`);
    return this.joined(p, w.effects, `woken ${JSON.stringify({ key })}`, w.body);
  }
  joined(p: Program, effects: Effect[], request: string, out: Uint8Array | null, error: string | null = null): Joined {
    const view = this.view(p, effects, request, out, error);
    return { ...view, account: ACCOUNT, name: p.name, calls: view.calls ?? [] };
  }
  view(p: Program, effects: Effect[], request: string, out: Uint8Array | null, error: string | null): Run {
    const head = headOf(effects);
    const text = out === null ? '' : dec.decode(out);
    const status = error !== null ? 500 : Number(/^(\d{3})/.exec(text)?.[1] ?? 'NaN') || 'ok';
    return {
      id: crypto.randomUUID(),
      version: 1,
      at: head.at ?? 0,
      effects,
      source: p.source,
      queries: p.queries,
      request,
      status,
      response: text,
      trace: [],
      error,
      calls: this.calls(head, effects),
    };
  }
  /** Name.joinCalls: each call of this run with what its callee recorded under this run's span. */
  calls(head: Head, effects: Effect[]): JoinedCall[] {
    return effects.filter(isCall).map((e: CallEffect): JoinedCall => {
      const row = this.served.find(
        s => !s.used && s.caller === head.span && s.callee === e.call && s.method === e.method,
      );
      if (!row) return { e, served: null };
      row.used = true;
      const callee = this.programs.get(row.callee) ?? fail(row.callee);
      const view =
        row.effects === null
          ? null
          : this.view(callee, row.effects, `${row.method} ${messageText(headOf(row.effects).message)}`, null, null);
      if (view && !row.failed) view.status = row.status;
      const served: ServedRow = {
        version: 1,
        key: row.key,
        method: row.method,
        status: row.status,
        at: row.at,
        began: row.at,
        took: row.took,
        began_us: row.atUs,
        took_us: row.tookUs,
        log_id: view?.id ?? null,
        view,
      };
      return { e, served };
    });
  }
}

function fail(why: string): never {
  throw new Error(why);
}
/** The log a failed run carried on its error (host/run.ts stretch), if any. */
const effectsOf = (e: unknown): Effect[] | null =>
  typeof e === 'object' && e !== null && 'effects' in e && Array.isArray(e.effects) ? e.effects : null;
function headOf(effects: readonly Effect[]): Head {
  const [head] = effects;
  return head && isHead(head) ? head : fail('a log with no head');
}
const messageText = (m: Head['message']): string => (typeof m === 'string' ? m : m ? JSON.stringify(m) : '');
const example = (path: string): string => readFileSync(`${ROOT}${path}`, 'utf8');
const otlpOf = (...runs: Joined[]): Doc => ({ resourceSpans: runs.flatMap(j => otlp(j).resourceSpans) });
function save(name: string, doc: Doc): void {
  writeFileSync(`${HERE}${name}`, `${JSON.stringify(doc, null, 1)}\n`);
  console.log(`${name}: ${spanCount(doc)} spans`);
}
const spanCount = (doc: Doc): number =>
  doc.resourceSpans.flatMap(r => r.scopeSpans).reduce((n, s) => n + s.spans.length, 0);

// ---- hello: one request, one span, its SQL as an event
{
  const w = new World();
  w.add('hello', example('examples/hello.tape'));
  await w.request('hello', 'GET /hello/ada');
  save('hello.json', otlpOf(await w.request('hello', 'GET /hello/ada')));
}

// ---- a clock: a program that reads now() (examples/ratelimit.tape), three requests. Its events are timed by the
// reading, which is Date.now(), to the ms, while the run's span is placed to the µs: the reading must not put an
// event before the span it belongs to (the event-in-span gate in test.ts)
{
  const w = new World();
  w.add('ratelimit', example('examples/ratelimit.tape'));
  const runs: Joined[] = [];
  for (const who of ['ann', 'bob', 'ann']) runs.push(await w.request('ratelimit', `POST /check/${who}`));
  save('clock.json', otlpOf(...runs));
}

// ---- orders and stock: a call between two programs, the callee's run under the caller's client span
{
  const w = new World();
  w.add('stock', example('examples/stock.tape'));
  w.add('orders', example('examples/orders.tape'), { stock: 'stock' });
  save('orders.json', otlpOf(await w.request('orders', 'POST /orders', '{"key":"o-1","item":"lamp"}')));
}

// ---- fulfillment: three callees; shipping is not there at first (a missing span, a timer), then it is, and the
// timer's run (a consumer span under the request's) ships the order
{
  const w = new World();
  w.add('inventory', example('examples/inventory.tape'));
  w.add('payments', example('examples/payments.tape'));
  w.add('fulfillment', example('examples/fulfillment.tape'), {
    inventory: 'inventory',
    payments: 'payments',
    shipping: 'shipping',
  });
  const first = await w.request(
    'fulfillment',
    'POST /orders/wait/500',
    '{"key":"c-1","sku":"lamp","qty":2,"card":"ann-4242","address":"1 Main St"}',
  );
  w.add('shipping', example('examples/shipping.tape'));
  await sleep(1100);
  const woken = await w.wake('fulfillment', 1);
  save('fulfillment.json', otlpOf(first, woken));
}

// ---- the shop of LANGUAGE.md section 8, with a payments program that answers its `charge`; it sets a timer before
// it calls, and the timer's run finds the order paid
{
  const language = example('LANGUAGE.md');
  const shop =
    /## 8\. A whole program[\s\S]*?```tape\n([\s\S]*?)```/.exec(language)?.[1] ?? fail('no shop in LANGUAGE.md');
  const w = new World();
  w.add('payments', readFileSync(`${HERE}shop-payments.tape`, 'utf8'));
  w.add('shop', shop, { payments: 'payments' });
  const placed = await w.request('shop', 'POST /orders', '{"key":"k-7","amount":1200}');
  const refused = await w.request('shop', 'POST /orders', '{"key":"k-8","amount":999999}');
  await sleep(20);
  const woken = await w.wake('shop', 1);
  save('shop.json', otlpOf(placed, refused, woken));
}

// ---- failures: a callee that traps (its run is rolled back and the call refused), a request that traps, and a
// call to a program that is not there (its span is missing)
{
  const w = new World();
  w.add('stock', readFileSync(`${HERE}broken-stock.tape`, 'utf8'));
  w.add('orders', example('examples/orders.tape'), { stock: 'stock' });
  w.add('lonely', example('examples/orders.tape'), { stock: 'nowhere' });
  w.add('trap', example('examples/trap.tape'));
  const refused = await w.request('orders', 'POST /orders', '{"key":"o-1","item":"lamp"}');
  const trapped = await w.request('trap', 'POST /todos');
  const lost = await w.request('lonely', 'POST /orders', '{"key":"o-2","item":"desk"}');
  save('failure.json', otlpOf(refused, trapped, lost));
}

// ---- synthetic: seeded, so the same files every time
{
  let seed = 0x7ace;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const hex = (n: number): string =>
    Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(rand() * 16)]).join('');
  const T0 = 1763800000000000000n;
  const services = ['edge/router', 'api/orders', 'api/payments', 'db/postgres', 'cache/redis', 'api/search'];
  const attr = (key: string, v: string | number | boolean): unknown => ({
    key,
    value:
      typeof v === 'string' ? { stringValue: v } : typeof v === 'boolean' ? { boolValue: v } : { intValue: String(v) },
  });
  // 2,000 spans: a tree of fan-outs, children inside their parents, a few errors and events
  type S = { id: string; parent: string; start: bigint; end: bigint; depth: number; svc: number };
  const trace = hex(32);
  const all: S[] = [{ id: hex(16), parent: '', start: T0, end: T0 + 1_800_000_000n, depth: 0, svc: 0 }];
  for (let i = 1; i < 2000; i++) {
    const p = all[Math.floor(rand() * Math.min(all.length, 400))] ?? fail('no parent');
    const len = p.end - p.start;
    const a = p.start + (len * BigInt(Math.floor(rand() * 900))) / 1000n;
    const b = a + ((p.end - a) * BigInt(Math.floor(rand() * 1000))) / 1000n;
    all.push({
      id: hex(16),
      parent: p.id,
      start: a,
      end: b,
      depth: p.depth + 1,
      svc: (p.svc + 1 + Math.floor(rand() * 2)) % services.length,
    });
  }
  const spanOf = (s: S, i: number): unknown => ({
    traceId: trace,
    spanId: s.id,
    ...(s.parent === '' ? {} : { parentSpanId: s.parent }),
    name: s.depth === 0 ? 'GET /checkout' : `${['SELECT', 'GET', 'POST', 'call', 'render'][i % 5]} step ${i}`,
    kind: 1 + (i % 3),
    startTimeUnixNano: String(s.start),
    endTimeUnixNano: String(s.end),
    attributes: [attr('i', i), attr('ok', i % 7 !== 0)],
    events:
      i % 11 === 0
        ? [
            {
              timeUnixNano: String((s.start + s.end) / 2n),
              name: 'db.query',
              attributes: [attr('db.query.text', 'SELECT 1')],
            },
          ]
        : [],
    status: i % 97 === 0 ? { code: 2, message: `failure ${i}` } : { code: 0 },
  });
  const byService = services.map((name, k) => ({
    resource: { attributes: [attr('service.name', name)] },
    scopeSpans: [{ scope: { name: 'synthetic' }, spans: all.flatMap((s, i) => (s.svc === k ? [spanOf(s, i)] : [])) }],
  }));
  save('big.json', { resourceSpans: byService });
  // 300 levels deep, each a child of the one before
  const deep: unknown[] = [];
  let parent = '';
  for (let d = 0; d < 300; d++) {
    const id = hex(16);
    deep.push({
      traceId: trace,
      spanId: id,
      ...(parent === '' ? {} : { parentSpanId: parent }),
      name: `level ${d}`,
      startTimeUnixNano: String(T0 + BigInt(d) * 1000n),
      endTimeUnixNano: String(T0 + 1_000_000n - BigInt(d) * 1000n),
    });
    parent = id;
  }
  save('deep.json', {
    resourceSpans: [{ resource: { attributes: [attr('service.name', 'recursion')] }, scopeSpans: [{ spans: deep }] }],
  });
}
