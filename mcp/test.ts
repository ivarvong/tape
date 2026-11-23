// node mcp/test.ts: tape-mcp's tools and HTTP face, in Node, with the program run by runner.ts as the Dynamic
// Worker runs it (Node can compile Wasm, so no Loader is needed here; mcp/test/worker.test.ts runs the Worker in
// workerd). Each test returns what it found wrong; the run passes when every list is empty.
//   node mcp/test.ts            the tests
//   node mcp/test.ts --plants   each bug in PLANTS planted in a copy of src/, and the test meant for it seen to fail
//
// The expected values do not come from the code under test: the bodies, the C54 line and the rows are the ones
// README.md shows for examples/hello.tape (checked to be there), and each trace is compared with the one the
// playground's Workbench makes for the same requests (apps/playground/src/workbench.ts, its own runner).
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { std } from '../std.ts';
import { INTRINSICS } from '../compiler/types.ts';
import { Workbench } from '../apps/playground/src/workbench.ts';
import { nodeSql } from '../apps/playground/src/sqlite.ts';
import type * as RunnerM from './src/runner.ts';
import type * as ToolsM from './src/tools.ts';
import type * as ServeM from './src/serve.ts';
import type { SqlJsInit } from './src/runner.ts';

const HERE = new URL('./', import.meta.url).pathname;
const ROOT = new URL('../', import.meta.url).pathname;
const HELLO = readFileSync(`${ROOT}examples/hello.tape`, 'utf8');
const LIMITS_TAPE = readFileSync(`${HERE}test/limits.tape`, 'utf8');
const UNDONE_TAPE = readFileSync(`${HERE}test/undone.tape`, 'utf8');
const CLOCK_TAPE = readFileSync(`${HERE}test/clock.tape`, 'utf8');
const README = readFileSync(`${ROOT}README.md`, 'utf8');

type Mods = { runner: typeof RunnerM; tools: typeof ToolsM; serve: typeof ServeM };
type Plant = { test: string; what: string; file: string; from: string; to: string };
const SRC = ['runner.ts', 'tools.ts', 'feedback.ts', 'serve.ts', 'host.ts', 'sqlite.ts'];

const isMods = (m: Record<string, unknown>): m is Mods =>
  typeof m['runner'] === 'object' && typeof m['tools'] === 'object' && typeof m['serve'] === 'object';
/** src/, or a copy of it with one plant in it: its imports of the repository made absolute, its own left relative. */
async function modules(plant: Plant | null): Promise<Mods> {
  let dir = `${HERE}src/`;
  if (plant) {
    dir = `${mkdtempSync(join(tmpdir(), 'mcp-plant-'))}/`;
    for (const f of SRC) {
      let text = readFileSync(`${HERE}src/${f}`, 'utf8');
      if (f === plant.file) {
        if (!text.includes(plant.from)) throw new Error(`plant "${plant.what}": its text is not in src/${f}`);
        text = text.replace(plant.from, plant.to);
      }
      text = text.replaceAll(/(from\s+)'(\.\.\/\.\.\/[^']+)'/g, (_m, lead: string, spec: string) => {
        return `${lead}'${new URL(spec, pathToFileURL(`${HERE}src/`)).href}'`;
      });
      writeFileSync(dir + f, text);
    }
  }
  const at = (f: string): Promise<unknown> => import(pathToFileURL(dir + f).href);
  const m = { runner: await at('runner.ts'), tools: await at('tools.ts'), serve: await at('serve.ts') };
  if (!isMods(m)) throw new Error('src/ does not export what this test uses');
  return m;
}

// sql.js is CommonJS (or a script); under "type": "module" it is loaded from a .cjs copy (as the playground's test)
const require = createRequire(import.meta.url);
const VENDOR = `${ROOT}apps/playground/vendor/sql.js-1.10.3/`;
const cjs = join(mkdtempSync(join(tmpdir(), 'sqljs-')), 'sql-wasm.cjs');
writeFileSync(cjs, readFileSync(`${VENDOR}sql-wasm.js`));
const isInit = (f: unknown): f is SqlJsInit => typeof f === 'function';
const init: unknown = require(cjs);
if (!isInit(init)) throw new Error("sql-wasm.js's export is not sql.js's init function");
const sqlite3 = new WebAssembly.Module(readFileSync(`${VENDOR}sql-wasm.wasm`));

type Fields = Record<string, unknown>;
const isFields = (v: unknown): v is Fields => typeof v === 'object' && v !== null && !Array.isArray(v);
const F = (v: unknown): Fields => (isFields(v) ? v : {});
const L = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

type Gate = ServeM.Gate;
type Deps = ToolsM.Deps;
const depsOf = (m: Mods, over: Partial<Deps> = {}): Deps => ({
  std,
  hello: { name: 'hello.tape', text: HELLO },
  run: async (program, requests) => {
    await m.runner.startSqlite(init, sqlite3);
    return m.runner.runAll(
      new WebAssembly.Module(program.wasm),
      requests,
      program.traced ? new WebAssembly.Module(program.traced) : null,
    );
  },
  ...over,
});
type Answer = { status: number; headers: Headers; body: unknown; text: string; logs: Fields[] };
async function post(
  m: Mods,
  path: string,
  body: string,
  {
    headers = {},
    gate = {},
    deps = {},
    method = 'POST',
  }: { headers?: Record<string, string>; gate?: Partial<Gate>; deps?: Partial<Deps>; method?: string } = {},
): Promise<Answer> {
  const logs: Fields[] = [];
  const res = await m.serve.serve(
    new Request(`https://tape.example${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'cf-connecting-ip': '203.0.113.7',
        'user-agent': 'mcp-test/1',
        ...headers,
      },
      ...(method === 'GET' ? {} : { body }),
    }),
    depsOf(m, deps),
    {
      killSwitch: 'off',
      salt: 'test-salt',
      limiter: null,
      log: l => {
        logs.push({ ...l });
      },
      ...gate,
    },
  );
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: res.status, headers: res.headers, body: parsed, text, logs };
}
const rpc = (m: Mods, method: string, params: unknown, id: number | null = 1, opts = {}): Promise<Answer> =>
  post(m, '/mcp', JSON.stringify({ jsonrpc: '2.0', ...(id === null ? {} : { id }), method, params }), opts);
/** A tool called over MCP: its structuredContent, and whether it was an error. */
async function tool(m: Mods, name: string, args: unknown): Promise<{ out: Fields; isError: boolean; answer: Answer }> {
  const answer = await rpc(m, 'tools/call', { name, arguments: args });
  const result = F(F(answer.body)['result']);
  return { out: F(result['structuredContent']), isError: result['isError'] === true, answer };
}

const WITHOUT_REPEAT = HELLO.replace('        repeat: True,\n', '');
const RESULTS = (out: Fields): Fields[] => L(out['results']).map(F);
/** The tool a limits case is for: run, unless it says compile. */
const toolOf = (args: Fields): string => (args['$tool'] === 'compile' ? 'compile' : 'run');

// ---- OTLP: its shape, and the same with what differs between two runs (ids and times) taken out

function otlpProblems(trace: unknown): string[] {
  const out: string[] = [];
  const rs = L(F(trace)['resourceSpans']);
  if (rs.length === 0) return ['no resourceSpans'];
  for (const r of rs.map(F)) {
    if (!Array.isArray(F(r['resource'])['attributes'])) out.push('a resource has no attributes list');
    const ss = L(r['scopeSpans']).map(F);
    if (ss.length === 0) out.push('a resource has no scopeSpans');
    for (const s of ss) {
      const spans = L(s['spans']).map(F);
      if (spans.length === 0) out.push('a scope has no spans');
      for (const sp of spans) {
        if (!/^[0-9a-f]{32}$/.test(String(sp['traceId']))) out.push(`traceId ${String(sp['traceId'])} is not 32 hex`);
        if (!/^[0-9a-f]{16}$/.test(String(sp['spanId']))) out.push(`spanId ${String(sp['spanId'])} is not 16 hex`);
        if ('parentSpanId' in sp && !/^[0-9a-f]{16}$/.test(String(sp['parentSpanId'])))
          out.push('parentSpanId is not 16 hex');
        for (const k of ['startTimeUnixNano', 'endTimeUnixNano']) {
          const t = sp[k];
          if (typeof t !== 'string' || !/^\d+$/.test(t)) out.push(`${k} is not a decimal string`);
        }
        if (typeof sp['name'] !== 'string' || typeof sp['kind'] !== 'number') out.push('a span has no name or kind');
        for (const a of L(sp['attributes']).map(F))
          if (typeof a['key'] !== 'string' || !isFields(a['value'])) out.push('an attribute is not {key, value}');
        for (const e of L(sp['events']).map(F)) {
          const t = e['timeUnixNano'];
          if (typeof t !== 'string' || !/^\d+$/.test(t)) out.push('an event time is not a decimal string');
        }
      }
    }
  }
  return out;
}
const VARIES = new Set([
  'traceId',
  'spanId',
  'parentSpanId',
  'startTimeUnixNano',
  'endTimeUnixNano',
  'timeUnixNano',
  'trace_id',
  'duration_us',
]);
/** A value with what differs between two runs of the same input replaced: ids, times, and attributes holding them. */
function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (!isFields(v)) return v;
  if (v['key'] === 'tape.request_id') return { key: v['key'], value: 'id' };
  return Object.fromEntries(
    Object.entries(v).map(([k, x]) => [k, VARIES.has(k) ? 'varies' : k.endsWith('_ms') ? 'ms' : stable(x)]),
  );
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(stable(a)) === JSON.stringify(stable(b));

/** The playground's own run of the same requests: its OTLP for each. */
async function workbenchOtlp(name: string, text: string, requests: readonly string[]): Promise<unknown[]> {
  const w = new Workbench(std, () => nodeSql(), { account: 'tape-mcp' });
  const problems = w.load([{ name, text }]);
  if (problems.length > 0) throw new Error(`the workbench did not take ${name}.tape: ${problems[0]?.message}`);
  const out: unknown[] = [];
  for (const r of requests) out.push((await w.send(name, r)).otlp);
  return out;
}

type Test = { name: string; run: (m: Mods) => Promise<string[]> };
const tests: Test[] = [
  {
    name: 'oracle',
    // the values the other tests expect are the ones README.md shows, so they are not the code's own
    run: () =>
      Promise.resolve(
        ['Hello again, ada #2!', 'hello.tape:11: C54', 'sql ["ada"] -> [[2]]', '        repeat: True,'].flatMap(s =>
          README.includes(s) || HELLO.includes(s) ? [] : [`README.md and hello.tape do not show ${JSON.stringify(s)}`],
        ),
      ),
  },
  {
    name: 'handshake',
    run: async m => {
      const out: string[] = [];
      const opened = await rpc(m, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 't', version: '1' },
      });
      const r = F(F(opened.body)['result']);
      if (opened.status !== 200) out.push(`initialize: ${opened.status}`);
      if (r['protocolVersion'] !== '2025-06-18') out.push(`protocolVersion ${String(r['protocolVersion'])}`);
      if (F(r['serverInfo'])['name'] !== 'tape') out.push(`serverInfo ${JSON.stringify(r['serverInfo'])}`);
      if (!isFields(F(r['capabilities'])['tools'])) out.push('no tools capability');
      const said = r['instructions'];
      if (typeof said !== 'string' || !said.includes('TERMS.md')) out.push('instructions do not mention TERMS.md');
      if (typeof said !== 'string' || !said.includes('a small language for durable services, compiled to WebAssembly'))
        out.push('instructions do not say what Tape is');
      const note = await rpc(m, 'notifications/initialized', {}, null);
      if (note.status !== 202) out.push(`a notification: ${note.status}, not 202`);
      const ping = await rpc(m, 'ping', {}, 2);
      if (JSON.stringify(F(ping.body)['result']) !== '{}' || F(ping.body)['id'] !== 2) out.push(`ping: ${ping.text}`);
      const nope = await rpc(m, 'resources/list', {});
      if (F(F(nope.body)['error'])['code'] !== -32601) out.push(`an unknown method: ${nope.text}`);
      const bad = await rpc(m, 'tools/call', { name: 'fmt', arguments: {} });
      if (F(F(bad.body)['error'])['code'] !== -32602) out.push(`an unknown tool: ${bad.text}`);
      return out;
    },
  },
  {
    name: 'feedback',
    run: async m => {
      const out: string[] = [];
      const stored: { key: string; body: string }[] = [];
      let allow = true,
        broken = false;
      const feedback = {
        put: async (key: string, body: string): Promise<void> => {
          await Promise.resolve();
          if (broken) throw new Error('R2 is down');
          stored.push({ key, body });
        },
        limiter: { limit: (): Promise<{ success: boolean }> => Promise.resolve({ success: allow }) },
      };
      const gate: Partial<Gate> = { version: 'v-test', feedback };
      const call = async (
        args: unknown,
        headers: Record<string, string> = {},
        over: Partial<Gate> = gate,
      ): Promise<{ out: Fields; isError: boolean; answer: Answer }> => {
        const answer = await rpc(m, 'tools/call', { name: 'feedback', arguments: args }, 1, { gate: over, headers });
        const r = F(F(answer.body)['result']);
        return { out: F(r['structuredContent']), isError: r['isError'] === true, answer };
      };
      const report = {
        text: '21! is negative',
        kind: 'bug',
        files: [{ name: 'hello.tape', text: WITHOUT_REPEAT }],
        requests: ['GET /hello/ada'],
        expected: 'a trap',
        actual: 'status 200',
      };
      const ok = await call(report, { 'mcp-protocol-version': '2025-06-18' });
      const id = ok.out['id'];
      if (ok.isError || ok.out['ok'] !== true || typeof id !== 'string') out.push(`a report: ${ok.answer.text}`);
      const day = new Date().toISOString().slice(0, 10);
      const [first] = stored;
      if (stored.length !== 1 || !first) return [...out, `${stored.length} objects stored, not 1`];
      if (!/^\d{4}\/\d{2}\/\d{2}\/\d{8}T\d{6}\.\d{3}Z-[0-9a-f]{12}\.json$/.test(first.key))
        out.push(`key ${first.key}`);
      if (first.key !== `${day.replaceAll('-', '/')}/${String(id)}.json`)
        out.push(`key ${first.key} is not of ${String(id)}`);
      const body = F(JSON.parse(first.body));
      for (const k of ['text', 'kind', 'files', 'requests', 'expected', 'actual'] as const)
        if (JSON.stringify(body[k]) !== JSON.stringify(report[k])) out.push(`stored ${k}: ${JSON.stringify(body[k])}`);
      if (body['id'] !== id) out.push(`stored id ${String(body['id'])}`);
      // the program as it compiled when it was reported: hello.tape without repeat is C54 (README.md)
      const rep = F(body['reproduced']);
      if (rep['ok'] !== false || JSON.stringify(rep['diagnostic_codes']) !== '["C54"]')
        out.push(`reproduced ${JSON.stringify(rep)}`);
      const server = F(body['server']);
      if (server['ip_hash'] !== (await m.serve.ipHash('203.0.113.7', 'test-salt', day)))
        out.push(`ip_hash ${String(server['ip_hash'])}`);
      if (server['user_agent'] !== 'mcp-test/1') out.push(`user_agent ${String(server['user_agent'])}`);
      if (server['mcp_protocol_version'] !== '2025-06-18')
        out.push(`mcp_protocol_version ${String(server['mcp_protocol_version'])}`);
      if (server['tape_mcp_version'] !== 'v-test') out.push(`tape_mcp_version ${String(server['tape_mcp_version'])}`);
      if (typeof body['received_at'] !== 'string' || !body['received_at'].startsWith(day))
        out.push(`received_at ${String(body['received_at'])}`);
      if (first.body.includes('203.0.113.7')) out.push('the raw address is stored');
      const line = ok.answer.logs[0];
      if (line?.['tool'] !== 'feedback' || JSON.stringify(line).includes('21!'))
        out.push(`log ${JSON.stringify(line)}`);
      // as plain JSON, with only text; a deploy's smoke under smoke/
      const http = await post(m, '/v1/feedback', JSON.stringify({ text: 'only text' }), { gate });
      const hj = F(http.body);
      if (http.status !== 200 || hj['ok'] !== true || typeof hj['id'] !== 'string')
        out.push(`/v1/feedback: ${http.text}`);
      if (F(JSON.parse(stored[1]?.body ?? '{}'))['reproduced'] !== null)
        out.push('reproduced without files is not null');
      await call({ text: 'smoke' }, { 'x-tape-synthetic': 'deploy-smoke' });
      if (!stored[2]?.key.startsWith('smoke/')) out.push(`a smoke report's key ${String(stored[2]?.key)}`);
      // refusals: nothing stored
      const n = stored.length;
      const refusals: [unknown, string][] = [
        [{}, 'bad_text'],
        [{ text: '  ' }, 'bad_text'],
        [{ text: 'x'.repeat(8 * 1024 + 1) }, 'text_too_large'],
        [{ text: 'x', kind: 'rant' }, 'bad_kind'],
        [{ text: 'x', mood: 'sad' }, 'unknown_argument'],
        [{ text: 'x', files: [{ name: 'a.tape', text: 'x'.repeat(64 * 1024 + 1) }] }, 'source_too_large'],
        [{ text: 'x', requests: Array.from({ length: 51 }, () => 'GET /') }, 'too_many_requests'],
        [{ text: 'x', expected: 'x'.repeat(8 * 1024 + 1) }, 'field_too_large'],
        [{ text: 'x', actual: 7 }, 'bad_field'],
      ];
      for (const [args, code] of refusals) {
        const r = await call(args);
        if (!r.isError || r.out['error'] !== code)
          out.push(`${JSON.stringify(args).slice(0, 60)}: ${r.answer.text.slice(0, 160)}`);
      }
      const none = await call({ text: 'x' }, {}, { version: 'v-test' });
      if (none.out['error'] !== 'feedback_unavailable') out.push(`no bucket: ${none.answer.text}`);
      allow = false;
      const limited = await call({ text: 'x' });
      if (limited.out['error'] !== 'feedback_rate_limited') out.push(`rate limit: ${limited.answer.text}`);
      allow = true;
      const off = await call({ text: 'x' }, {}, { ...gate, killSwitch: 'on' });
      if (off.answer.status !== 503) out.push(`kill switch: ${off.answer.status}`);
      broken = true;
      const down = await call({ text: 'x' });
      if (down.out['error'] !== 'store_failed') out.push(`a failed write: ${down.answer.text}`);
      if (stored.length !== n) out.push(`${stored.length - n} refused reports stored`);
      return out;
    },
  },
  {
    name: 'undone',
    run: async m => {
      const out: string[] = [];
      const { out: r } = await tool(m, 'run', {
        files: [{ name: 'undone.tape', text: UNDONE_TAPE }],
        requests: ['GET /undo', 'GET /trap', 'GET /keep', 'GET /keep', 'GET /wake'],
        trace: 'full',
      });
      const rs = RESULTS(r);
      // the first INSERT is undone by rollback(out), the second by the trap: the third request writes the row
      // (1), and the fourth finds it there (0)
      const bodies = rs.map(x => `${String(x['status'])} ${String(x['body'])}`);
      if (
        JSON.stringify(bodies) !==
        JSON.stringify(['409 undone 1', '500 trap 4: division by zero', '200 kept 1', '200 kept 0', '409 no timer'])
      )
        out.push(`bodies ${JSON.stringify(bodies)}`);
      const marks = rs.map(x => L(x['effects']).map(e => F(e)['undone'] === true));
      if (JSON.stringify(marks) !== '[[true],[true],[false],[false],[true,true]]')
        out.push(`undone marks ${JSON.stringify(marks)}`);
      if (!rs.every(x => x['replayed'] === true)) out.push('a run with undone writes does not replay');
      // the trace says so: the write's event has tape.sql.undone, and the span's rows_written leaves it out
      const spanOf = (x: Fields): Fields =>
        F(L(F(L(F(L(F(x['trace'])['resourceSpans'])[0])['scopeSpans'])[0])['spans'])[0]);
      const attr = (list: unknown, key: string): unknown =>
        F(
          F(
            L(list)
              .map(F)
              .find(a => a['key'] === key),
          )['value'],
        );
      for (const [i, undone, written] of [
        [0, true, '0'],
        [1, true, '0'],
        [2, false, '1'],
      ] as const) {
        const span = spanOf(rs[i] ?? {}),
          ev = L(span['events'])
            .map(F)
            .find(e => e['name'] === 'db.query');
        const u = F(attr(ev?.['attributes'], 'tape.sql.undone'))['boolValue'];
        if ((u === true) !== undone) out.push(`request ${i}: tape.sql.undone ${String(u)}`);
        const w = F(attr(span['attributes'], 'tape.sql.rows_written'))['intValue'];
        if (String(w) !== written)
          out.push(`request ${i}: the span's tape.sql.rows_written ${String(w)}, not ${written}`);
      }
      // a timer set in the stretch a rollback undid is undone too: its row in _wakes was rolled back with the rest
      const wake = L(rs[4]?.['effects']).map(F);
      if (JSON.stringify(wake.map(e => [e['kind'], e['undone'] === true])) !== '[["sql",true],["wake",true]]')
        out.push(`/wake: ${JSON.stringify(wake)}`);
      const wakeEv = L(spanOf(rs[4] ?? {})['events'])
        .map(F)
        .find(e => e['name'] === 'tape.timer.set');
      if (F(attr(wakeEv?.['attributes'], 'tape.timer.undone'))['boolValue'] !== true)
        out.push(`/wake: the timer's event ${JSON.stringify(wakeEv)}`);
      return out;
    },
  },
  {
    name: 'list',
    run: async m => {
      const out: string[] = [];
      const tools = L(F(F((await rpc(m, 'tools/list', {})).body)['result'])['tools']).map(F);
      if (JSON.stringify(tools.map(t => t['name'])) !== '["compile","run","feedback"]')
        out.push(`tools: ${tools.map(t => String(t['name'])).join(', ')}`);
      const fb = tools[2];
      const fd = String(fb?.['description']);
      for (const said of ['surprising', 'minimal program', 'stored', 'read by the maintainers', 'secrets', 'TERMS.md'])
        if (!fd.includes(said)) out.push(`feedback: its description does not say ${said}`);
      const fs = F(fb?.['inputSchema']);
      if (JSON.stringify(fs['required']) !== '["text"]' || fs['additionalProperties'] !== false)
        out.push(`feedback: inputSchema ${JSON.stringify(fs)}`);
      if (F(F(fs['properties'])['text'])['maxLength'] !== 8192) out.push('feedback: text has no maxLength 8192');
      if (F(fb?.['annotations'])['readOnlyHint'] !== false) out.push('feedback: it is not read-only');
      for (const t of tools.slice(0, 2)) {
        const d = String(t['description']);
        if (!d.includes(HELLO.trimEnd())) out.push(`${String(t['name'])}: its description does not hold hello.tape`);
        if (!d.includes('TERMS.md')) out.push(`${String(t['name'])}: its description does not say calls are logged`);
        const s = F(t['inputSchema']);
        if (s['type'] !== 'object' || s['additionalProperties'] !== false)
          out.push(`${String(t['name'])}: inputSchema ${JSON.stringify(s)}`);
        if (F(F(s['properties'])['files'])['maxItems'] !== 8) out.push(`${String(t['name'])}: files.maxItems is not 8`);
        if (F(t['outputSchema'])['type'] !== 'object') out.push(`${String(t['name'])}: no outputSchema`);
      }
      const [compile, run] = tools;
      // the cheat sheet: in both, linking the std reference and the guide, naming what the usability benchmark's
      // agents could not find; every function it names is one std/ defines or a built-in; and short
      const stdFns = new Set(std.flatMap(f => [...f.text.matchAll(/^fn ([a-z_][a-z0-9_]*)/gm)].map(x => x[1] ?? '')));
      for (const t of [compile, run]) {
        const d = String(t?.['description']);
        for (const said of [
          'docs/std.md',
          'docs/guide.md#a-whole-rest-service-worked',
          'respond_as(status: 200, content: Json)',
          'query: Option[View]',
          'form_field(body: q, name: "limit")',
          'decode(json: body, as: NewItem)',
          ':name',
          // numbers, stated: an agent assumed floats and guessed (LANGUAGE.md section 2; the traps' own words)
          'Int is a 64-bit signed integer',
          '"trap 6: integer overflow"',
          '"trap 4: division by zero"',
          'no floats yet',
        ])
          if (!d.includes(said)) out.push(`${String(t?.['name'])}: its description does not say ${said}`);
        const sheet = d.slice(d.indexOf('Tape in brief'), d.indexOf('examples/hello.tape, the program'));
        const named = [...sheet.matchAll(/\b([a-z_][a-z0-9_]*)\(/g)].map(x => x[1] ?? '');
        const unknown = [...new Set(named)].filter(
          n => !stdFns.has(n) && !INTRINSICS.has(n) && n !== 'handle' && n !== 'f',
        );
        if (named.length < 10 || unknown.length > 0)
          out.push(
            `${String(t?.['name'])}: the cheat sheet names ${named.length} functions; not in std: ${unknown.join(', ')}`,
          );
        if (d.length > 6000) out.push(`${String(t?.['name'])}: its description is ${d.length} characters, over 6000`);
      }
      for (const said of ['at_ms', 'woken', '"lines"', '"compact"'])
        if (!String(run?.['description']).includes(said)) out.push(`run: its description does not say ${said}`);
      const props = F(F(run?.['inputSchema'])['properties']);
      if (JSON.stringify(F(props['trace'])['enum']) !== '["lines","full","none"]') out.push('run: no trace enum');
      if (JSON.stringify(F(props['effects'])['enum']) !== '["compact","full"]') out.push('run: no effects enum');
      if (!String(compile?.['description']).includes('C54')) out.push('compile: its description does not say C54');
      if (!String(run?.['description']).includes('Hello again, ada #2!'))
        out.push('run: its description does not give the second body');
      const req = F(F(run?.['inputSchema'])['properties'])['requests'];
      if (F(req)['maxItems'] !== 50 || JSON.stringify(F(run?.['inputSchema'])['required']) !== '["requests"]')
        out.push(`run: requests ${JSON.stringify(req)}`);
      return out;
    },
  },
  {
    name: 'compile',
    run: async m => {
      const out: string[] = [];
      const { out: ok, isError } = await tool(m, 'compile', {});
      if (isError || ok['ok'] !== true || L(ok['diagnostics']).length > 0) out.push(`hello: ${JSON.stringify(ok)}`);
      const size = ok['wasm_bytes'];
      if (typeof size !== 'number' || size < 1000) out.push(`wasm_bytes ${String(ok['wasm_bytes'])}`);
      // hello.tape has one statement, the INSERT (README.md's log)
      if (ok['statements'] !== 1) out.push(`statements ${String(ok['statements'])}, not 1`);
      const http = await post(m, '/v1/compile', JSON.stringify({ files: [{ name: 'hello.tape', text: HELLO }] }));
      if (http.status !== 200 || JSON.stringify(http.body) !== JSON.stringify(ok))
        out.push(`POST /v1/compile: ${http.status} ${http.text.slice(0, 200)}`);
      return out;
    },
  },
  {
    name: 'c54',
    run: async m => {
      const out: string[] = [];
      const { out: r, isError } = await tool(m, 'compile', { files: [{ name: 'hello.tape', text: WITHOUT_REPEAT }] });
      const d = L(r['diagnostics']).map(F);
      if (isError || r['ok'] !== false) out.push(`ok: ${String(r['ok'])}`);
      if (d.length !== 1) out.push(`${d.length} diagnostics`);
      const [c] = d;
      if (c?.['code'] !== 'C54' || c['file'] !== 'hello.tape' || c['line'] !== 11)
        out.push(`diagnostic ${JSON.stringify(c)}`);
      if (!String(c?.['message']).includes('n = n + 1')) out.push('its message does not name the write');
      const fix = c?.['fix'];
      if (typeof fix !== 'string' || !fix.includes('repeat'))
        out.push(`its fix ${JSON.stringify(c?.['fix'])} does not say what to write`);
      if (r['wasm_bytes'] !== null) out.push('a refused program has wasm_bytes');
      // run says the same, and runs nothing
      const { out: ran } = await tool(m, 'run', {
        files: [{ name: 'hello.tape', text: WITHOUT_REPEAT }],
        requests: ['GET /hello/ada'],
      });
      if (ran['ok'] !== false || L(ran['results']).length > 0 || F(L(ran['diagnostics'])[0])['code'] !== 'C54')
        out.push(`run: ${JSON.stringify(ran).slice(0, 200)}`);
      return out;
    },
  },
  {
    name: 'run',
    run: async m => {
      const out: string[] = [];
      const { out: r, isError } = await tool(m, 'run', { requests: ['GET /hello/ada', 'GET /hello/ada', 'GET /nope'] });
      const [a, b, c] = RESULTS(r);
      if (isError || r['ok'] !== true) out.push(`ok ${String(r['ok'])}`);
      if (a?.['status'] !== 200 || a['body'] !== 'Hello, ada')
        out.push(`first: ${String(a?.['status'])} ${JSON.stringify(a?.['body'])}`);
      if (b?.['status'] !== 200 || b['body'] !== 'Hello again, ada #2!')
        out.push(`second: ${String(b?.['status'])} ${JSON.stringify(b?.['body'])}`);
      if (c?.['status'] !== 404 || c['body'] !== 'no such route')
        out.push(`third: ${String(c?.['status'])} ${JSON.stringify(c?.['body'])}`);
      if (a?.['content_type'] !== 'text/plain; charset=utf-8' || a['truncated'] !== false)
        out.push(`first: ${JSON.stringify(a?.['content_type'])} truncated ${String(a?.['truncated'])}`);
      const http = await post(
        m,
        '/v1/run',
        JSON.stringify({ requests: ['GET /hello/ada', 'GET /hello/ada', 'GET /nope'] }),
      );
      if (http.status !== 200 || !same(http.body, r))
        out.push(`POST /v1/run is not what the tool gives: ${http.status}`);
      return out;
    },
  },
  {
    name: 'lenient arguments',
    run: async m => {
      const out: string[] = [];
      // 18 of about 120 trace arguments in the usability bench were the mode quoted twice ("\"none\""): taken as the
      // mode, not refused; a quoted word that is no mode still is
      const quoted = await tool(m, 'run', { requests: ['GET /hello/ada'], trace: '"none"', effects: '"full"' });
      if (quoted.isError || RESULTS(quoted.out)[0]?.['trace'] !== null)
        out.push(`trace quoted none: ${JSON.stringify(quoted.out).slice(0, 200)}`);
      const unknown = await tool(m, 'run', { requests: ['GET /hello/ada'], trace: '"otlp"' });
      if (unknown.out['error'] !== 'bad_arguments') out.push(`trace quoted otlp: ${JSON.stringify(unknown.out)}`);
      // 50 requests a call (one call of 50 hello requests took about 8 ms in Node)
      const { out: r, isError } = await tool(m, 'run', {
        requests: Array.from({ length: 50 }, (_, i) => `GET /hello/n${i}`),
      });
      if (isError || r['ok'] !== true || RESULTS(r).length !== 50)
        out.push(`50 requests: ${RESULTS(r).length} results, ${JSON.stringify(r).slice(0, 120)}`);
      return out;
    },
  },
  {
    name: 'response headers',
    run: async m => {
      const out: string[] = [];
      // a 302's Location is the redirect; written here as std/http.tape documents header(), not from tools.ts
      const text = `fn handle(raw: View) -> Buf {
  match request(raw).path {
    "/go/" ++ code -> respond(status: 302) |> header(name: "Location", value: "https://example.com/" ++ code)
    _ -> respond(status: 200) |> append(view: "plain")
  }
}
`;
      const args = { files: [{ name: 'go.tape', text }], requests: ['GET /go/ab', 'GET /x'] };
      const { out: r } = await tool(m, 'run', args);
      const [go, plain] = RESULTS(r);
      if (go?.['status'] !== 302) out.push(`redirect: status ${String(go?.['status'])}`);
      if (JSON.stringify(go?.['headers']) !== '[{"name":"location","value":"https://example.com/ab"}]')
        out.push(`redirect: headers ${JSON.stringify(go?.['headers'])}`);
      // compact: a response that set no header has no headers field at all
      if (plain === undefined || 'headers' in plain) out.push(`plain: headers ${JSON.stringify(plain?.['headers'])}`);
      const http = await post(m, '/v1/run', JSON.stringify(args));
      if (http.status !== 200 || !same(http.body, r))
        out.push(`POST /v1/run is not what the tool gives: ${http.status}`);
      return out;
    },
  },
  {
    name: 'effects',
    run: async m => {
      const out: string[] = [];
      const { out: r } = await tool(m, 'run', { requests: ['GET /hello/ada', 'GET /hello/ada'] });
      for (const [i, x] of RESULTS(r).entries()) {
        const fx = L(x['effects']).map(F);
        if (fx.length !== 1) out.push(`request ${i + 1}: ${fx.length} effects`);
        const [sql] = fx;
        if (sql?.['kind'] !== 'sql') out.push(`request ${i + 1}: ${JSON.stringify(sql)}`);
        // the program's words: the literal in hello.tape, its `\` line break taken out
        const literal =
          'INSERT INTO greeted(name, n) VALUES (:name, 1) ON CONFLICT(name) DO UPDATE SET n = n + 1 RETURNING n';
        if (sql?.['query'] !== literal) out.push(`request ${i + 1}: query ${JSON.stringify(sql?.['query'])}`);
        if (JSON.stringify(sql?.['params']) !== '{":name":"ada"}')
          out.push(`request ${i + 1}: params ${JSON.stringify(sql?.['params'])}`);
        if (JSON.stringify(sql?.['rows']) !== JSON.stringify([[i + 1]]))
          out.push(`request ${i + 1}: rows ${JSON.stringify(sql?.['rows'])}`);
        const steps = x['steps'];
        if (typeof steps !== 'number' || steps <= 0) out.push(`request ${i + 1}: steps ${String(x['steps'])}`);
      }
      return out;
    },
  },
  {
    name: 'replay',
    run: async m => {
      const out: string[] = [];
      const { out: r } = await tool(m, 'run', { requests: ['GET /hello/ada', 'GET /hello/bo'] });
      for (const x of RESULTS(r))
        if (x['replayed'] !== true)
          out.push(`${String(x['request'])}: replayed ${String(x['replayed'])} ${String(x['replay_error'])}`);
      // a log that does not match the program is caught: replay hello's log through another build
      const built = await import('../compiler.ts');
      const one = built.compile([...std, { name: 'hello.tape', text: HELLO }]),
        other = built.compile([...std, { name: 'hello.tape', text: HELLO.replace('Hello again', 'Hi again') }]);
      if (!one.wasm || !other.wasm) return ['hello.tape does not compile'];
      await m.runner.startSqlite(init, sqlite3);
      const ran = await m.runner.runAll(new WebAssembly.Module(one.wasm), ['GET /hello/ada', 'GET /hello/ada']);
      if (!ran.ok) return [ran.error];
      const host = await import('../host.ts');
      const [, second] = ran.runs;
      let diverged = false;
      try {
        const again = host.replay(
          new WebAssembly.Module(other.wasm),
          new TextEncoder().encode('GET /hello/ada'),
          second?.effects ?? [],
        );
        diverged = new TextDecoder().decode(again) !== new TextDecoder().decode(second?.out ?? new Uint8Array());
      } catch {
        diverged = true;
      }
      if (!diverged) out.push('a replay through another build gave the same answer');
      return out;
    },
  },
  {
    name: 'otlp',
    run: async m => {
      const out: string[] = [];
      const requests = ['GET /hello/ada', 'GET /hello/ada', 'GET /nope'];
      const { out: r } = await tool(m, 'run', { requests, trace: 'full' });
      const mine = RESULTS(r).map(x => x['trace']);
      for (const [i, t] of mine.entries()) out.push(...otlpProblems(t).map(p => `request ${i + 1}: ${p}`));
      // and a run that trapped, beside one that did not
      const trapped = ['GET /div/', 'GET /div/ab'];
      const { out: t2 } = await tool(m, 'run', {
        files: [{ name: 'limits.tape', text: LIMITS_TAPE }],
        requests: trapped,
        trace: 'full',
      });
      const mine2 = RESULTS(t2).map(x => x['trace']);
      for (const [i, t] of mine2.entries()) out.push(...otlpProblems(t).map(p => `limits request ${i + 1}: ${p}`));
      const pairs = [
        ...(await workbenchOtlp('hello', HELLO, requests)).map(
          (theirs, i) => [mine[i], theirs, `request ${i + 1}`] as const,
        ),
        ...(await workbenchOtlp('limits', LIMITS_TAPE, trapped)).map(
          (theirs, i) => [mine2[i], theirs, trapped[i]] as const,
        ),
      ];
      for (const [t, theirs, what] of pairs)
        if (!same(t, theirs)) {
          out.push(`${what}: the trace is not the playground's for the same request`);
          console.log(
            `  mine:   ${JSON.stringify(stable(t)).slice(0, 600)}\n  theirs: ${JSON.stringify(stable(theirs)).slice(0, 600)}`,
          );
        }
      const failedSpan = F(L(F(L(F(L(F(mine2[0])['resourceSpans'])[0])['scopeSpans'])[0])['spans'])[0]);
      if (
        F(failedSpan['status'])['code'] !== 2 ||
        !String(F(failedSpan['status'])['message']).includes('division by zero')
      )
        out.push(`the trapped run's span status ${JSON.stringify(failedSpan['status'])}`);
      const span = F(L(F(L(F(L(F(mine[1])['resourceSpans'])[0])['scopeSpans'])[0])['spans'])[0]);
      const attrs: Record<string, unknown> = Object.fromEntries(
        L(span['attributes'])
          .map(F)
          .map((a): [string, unknown] => [String(a['key']), a['value']]),
      );
      if (
        span['name'] !== 'GET /hello/ada' ||
        JSON.stringify(attrs['http.response.status_code']) !== '{"intValue":"200"}'
      )
        out.push(`span ${String(span['name'])} ${JSON.stringify(attrs['http.response.status_code'])}`);
      return out;
    },
  },
  {
    name: 'budget',
    run: async m => {
      const out: string[] = [];
      const files = [{ name: 'limits.tape', text: LIMITS_TAPE }];
      const { out: r } = await tool(m, 'run', { files, requests: ['GET /spin', 'GET /huge', 'GET /big', 'GET /dice'] });
      const [spin, huge, big, dice] = RESULTS(r);
      if (r['ok'] !== false) out.push('a run with traps is ok');
      if (spin?.['status'] !== 500 || !String(spin['error']).includes('reduction budget exceeded'))
        out.push(`spin: ${String(spin?.['status'])} ${String(spin?.['error'])}`);
      if (Number(spin?.['steps']) < 50_000_000) out.push(`spin: steps ${String(spin?.['steps'])}`);
      if (spin?.['replayed'] !== true)
        out.push(`spin: a trap replays as the same trap: ${String(spin?.['replay_error'])}`);
      if (huge?.['status'] !== 500 || !String(huge['error']).includes('out of memory'))
        out.push(`huge: ${String(huge?.['status'])} ${String(huge?.['error'])}`);
      if (
        big?.['status'] !== 200 ||
        big['truncated'] !== true ||
        big['body_bytes'] !== 70000 ||
        String(big['body']).length !== 65536
      )
        out.push(
          `big: truncated ${String(big?.['truncated'])} ${String(big?.['body_bytes'])} ${String(big?.['body']).length}`,
        );
      if (dice?.['status'] !== 200 || !/^\d+$/.test(String(dice['body'])))
        out.push(`dice: ${JSON.stringify(dice?.['body'])}`);
      return out;
    },
  },
  {
    name: 'limits',
    run: async m => {
      const out: string[] = [];
      const hello = { name: 'hello.tape', text: HELLO };
      const expect = async (
        what: string,
        args: Fields,
        status: number,
        error: string,
        via: 'mcp' | 'http' = 'mcp',
      ): Promise<void> => {
        if (via === 'mcp') {
          const { out: r, isError } = await tool(m, toolOf(args), { ...args, $tool: undefined });
          if (!isError || r['error'] !== error || typeof r['reason'] !== 'string')
            out.push(`${what} over MCP: ${JSON.stringify(r).slice(0, 200)}`);
        }
        const { $tool, ...rest } = args;
        const http = await post(m, `/v1/${toolOf({ $tool })}`, JSON.stringify(rest));
        const b = F(http.body);
        if (http.status !== status || b['error'] !== error || b['ok'] !== false || typeof b['reason'] !== 'string')
          out.push(`${what}: ${http.status} ${http.text.slice(0, 200)}`);
      };
      const ok = ['GET /hello/ada'];
      await expect(
        '9 files',
        { requests: ok, files: Array.from({ length: 9 }, (_, i) => ({ name: `f${i}.tape`, text: '' })) },
        413,
        'too_many_files',
      );
      await expect(
        '8 files of 8193 bytes',
        {
          requests: ok,
          files: Array.from({ length: 8 }, (_, i) => ({ name: `f${i}.tape`, text: `//${'x'.repeat(8191)}` })),
        },
        413,
        'source_too_large',
      );
      await expect(
        'a file name with a slash',
        { requests: ok, files: [{ name: '../hello.tape', text: HELLO }] },
        400,
        'bad_file_name',
      );
      await expect(
        'a file name without .tape',
        { requests: ok, files: [{ name: 'hello', text: HELLO }] },
        400,
        'bad_file_name',
      );
      await expect('two files of one name', { requests: ok, files: [hello, hello] }, 400, 'bad_files');
      await expect('a file with another field', { requests: ok, files: [{ ...hello, path: 'x' }] }, 400, 'bad_files');
      await expect('no files', { requests: ok, files: [] }, 400, 'bad_files');
      await expect(
        '51 requests',
        { requests: Array.from({ length: 51 }, () => 'GET /hello/ada') },
        413,
        'too_many_requests',
      );
      await expect('no requests', { requests: [] }, 400, 'bad_requests');
      await expect('a body of 16385 bytes', { requests: [`POST /x\n${'x'.repeat(16385)}`] }, 413, 'request_too_large');
      await expect('a request that is not METHOD SP TARGET', { requests: ['hello ada'] }, 400, 'bad_request_line');
      await expect('a request that is not text', { requests: [7] }, 400, 'bad_requests');
      await expect('an unknown argument', { requests: ok, file: 'x' }, 400, 'unknown_argument');
      await expect('trace: "otlp"', { requests: ok, trace: 'otlp' }, 400, 'bad_arguments');
      await expect('effects: "all"', { requests: ok, effects: 'all' }, 400, 'bad_arguments');
      await expect('at_ms -1', { requests: [{ request: 'GET /', at_ms: -1 }] }, 400, 'bad_at_ms');
      await expect('at_ms 1.5', { requests: [{ request: 'GET /', at_ms: 1.5 }] }, 400, 'bad_at_ms');
      await expect('at_ms past 30 days', { requests: [{ request: 'GET /', at_ms: 2_592_000_001 }] }, 400, 'bad_at_ms');
      await expect(
        'at_ms going back',
        {
          requests: [
            { request: 'GET /', at_ms: 2000 },
            { request: 'GET /', at_ms: 1999 },
          ],
        },
        400,
        'bad_at_ms',
      );
      await expect('a request with another field', { requests: [{ request: 'GET /', at: 1 }] }, 400, 'bad_requests');
      await expect('a request object without text', { requests: [{ at_ms: 1 }] }, 400, 'bad_requests');
      await expect('requests given to compile', { $tool: 'compile', requests: ok }, 400, 'unknown_argument');
      // and what is allowed is: 16384 bytes of body, 20 requests, 8 files, 65536 bytes of source
      const { out: edge } = await tool(m, 'run', {
        files: [
          hello,
          ...Array.from({ length: 7 }, (_, i) => ({
            name: `f${i}.tape`,
            text: `//${'x'.repeat(Math.floor((65536 - new TextEncoder().encode(HELLO).length) / 7) - 2)}`,
          })),
        ],
        requests: [...Array.from({ length: 19 }, () => 'GET /hello/ada'), `POST /x\n${'x'.repeat(16384)}`],
      });
      if (edge['ok'] !== true || RESULTS(edge).length !== 20)
        out.push(`the limits themselves are refused: ${JSON.stringify(edge).slice(0, 200)}`);
      // the HTTP gate: method, content type, origin, size, kill switch, rate limit, and the run's own guards
      const get = await post(m, '/mcp', '', { method: 'GET' });
      if (get.status !== 405 || F(get.body)['error'] !== 'method_not_allowed')
        out.push(`GET /mcp: ${get.status} ${get.text}`);
      const form = await post(m, '/v1/run', '{}', { headers: { 'content-type': 'text/plain' } });
      if (form.status !== 415 || F(form.body)['error'] !== 'unsupported_media_type')
        out.push(`text/plain: ${form.status}`);
      const page = await post(m, '/mcp', '{}', { headers: { origin: 'https://evil.example' } });
      if (page.status !== 403 || F(page.body)['error'] !== 'origin_refused') out.push(`an Origin: ${page.status}`);
      const big = await post(m, '/v1/run', JSON.stringify({ requests: ['GET /'], pad: 'x'.repeat(2_000_000) }));
      if (big.status !== 413 || F(big.body)['error'] !== 'body_too_large') out.push(`a 2 MB body: ${big.status}`);
      const unsalted = await rpc(m, 'tools/list', {}, 1, { gate: { salt: undefined } });
      if (unsalted.status !== 503 || F(unsalted.body)['error'] !== 'misconfigured')
        out.push(`no IP_SALT: ${unsalted.status}`);
      if (unsalted.logs[0]?.['ip_hash'] !== 'unsalted') out.push('without a salt the address is still hashed');
      // the hash: the same for one address, salt and day; another for another day or salt; the address not in it
      const h = (ip: string, salt: string, day: string): Promise<string> => m.serve.ipHash(ip, salt, day);
      const base = await h('203.0.113.7', 'a', '2026-11-22');
      if (base !== (await h('203.0.113.7', 'a', '2026-11-22'))) out.push('the hash is not stable within a day');
      if (base === (await h('203.0.113.7', 'a', '2026-11-23'))) out.push('the hash does not change with the day');
      if (base === (await h('203.0.113.7', 'b', '2026-11-22'))) out.push('the hash does not depend on the salt');
      if (base === (await h('203.0.113.8', 'a', '2026-11-22'))) out.push('two addresses hash the same');
      if (!/^[0-9a-f]{16}$/.test(base)) out.push(`the hash ${base} is not 16 hex`);
      if (
        m.serve.dayOf(Date.UTC(2026, 10, 22, 23, 59)) !== '2026-11-22' ||
        m.serve.dayOf(Date.UTC(2026, 10, 23)) !== '2026-11-23'
      )
        out.push('dayOf is not the UTC day');
      const off = await rpc(m, 'tools/list', {}, 1, { gate: { killSwitch: 'on' } });
      if (off.status !== 503 || F(off.body)['error'] !== 'disabled') out.push(`the kill switch: ${off.status}`);
      const keys: string[] = [];
      const limited = await rpc(m, 'tools/list', {}, 1, {
        gate: {
          limiter: {
            limit: ({ key }: { key: string }) => {
              keys.push(key);
              return Promise.resolve({ success: false });
            },
          },
        },
      });
      if (limited.status !== 429 || F(limited.body)['error'] !== 'rate_limited')
        out.push(`the rate limit: ${limited.status}`);
      if (
        keys[0] !== (await m.serve.ipHash('203.0.113.7', 'test-salt', m.serve.dayOf(Date.now()))) ||
        keys[0]?.includes('203')
      )
        out.push(`the rate limit's key ${String(keys[0])} is not the address's hash`);
      if (limited.logs[0]?.['rate_limited'] !== true) out.push('a rate-limited call is not logged as one');
      const slow = await tool(m, 'run', { requests: ok }).then(() =>
        post(m, '/v1/run', JSON.stringify({ requests: ok }), { deps: { wallMs: 5, run: () => new Promise(() => {}) } }),
      );
      if (slow.status !== 504 || F(slow.body)['error'] !== 'run_timeout')
        out.push(`a run past the wall guard: ${slow.status}`);
      const dead = await post(m, '/v1/run', JSON.stringify({ requests: ok }), {
        deps: { run: () => Promise.reject(new Error('Worker exceeded CPU time limit.')) },
      });
      if (
        dead.status !== 503 ||
        F(dead.body)['error'] !== 'run_failed' ||
        !String(F(dead.body)['reason']).includes('CPU')
      )
        out.push(`a runner that died: ${dead.status} ${dead.text}`);
      const nowhere = await post(m, '/v2/run', '{}');
      if (nowhere.status !== 404 || F(nowhere.body)['error'] !== 'not_found')
        out.push(`an unknown route: ${nowhere.status}`);
      return out;
    },
  },
  {
    name: 'malformed',
    run: async m => {
      const out: string[] = [];
      const mcp = await post(m, '/mcp', '{"jsonrpc": "2.0", "id": 1, "method": ');
      const e = F(F(mcp.body)['error']);
      if (mcp.status !== 400 || e['code'] !== -32700 || F(mcp.body)['id'] !== null)
        out.push(`/mcp: ${mcp.status} ${mcp.text}`);
      const http = await post(m, '/v1/compile', 'files: hello');
      if (http.status !== 400 || F(http.body)['error'] !== 'bad_json')
        out.push(`/v1/compile: ${http.status} ${http.text}`);
      const notObject = await post(m, '/v1/run', '["GET /"]');
      if (notObject.status !== 400 || F(notObject.body)['error'] !== 'bad_arguments')
        out.push(`an array: ${notObject.status} ${notObject.text}`);
      const args = await tool(m, 'compile', 'hello');
      if (!args.isError || args.out['error'] !== 'bad_arguments')
        out.push(`arguments that are text: ${JSON.stringify(args.out)}`);
      return out;
    },
  },
  {
    name: 'headers',
    run: async m => {
      const out: string[] = [];
      // a refusal before the body is read still finishes with the body: through the tape Worker's binding a body
      // left unread is logged as an error ("Can't read from request stream after response has been sent")
      for (const [path, headers] of [
        ['/v1/run', { origin: 'https://x.example' }],
        ['/v1/run', { 'content-type': 'text/plain' }],
        ['/nowhere', {}],
      ] as const) {
        const req = new Request(`https://tape.example${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7', ...headers },
          body: '{"requests":["GET /"]}',
        });
        await m.serve.serve(req, depsOf(m), {
          killSwitch: 'off',
          salt: 'test-salt',
          limiter: null,
          log: line => {
            void line;
          },
        });
        if (!req.bodyUsed) out.push(`${path} ${JSON.stringify(headers)}: the refusal left the body unread`);
      }
      const answers = [
        await rpc(m, 'tools/list', {}),
        await post(m, '/v1/run', JSON.stringify({ requests: ['GET /hello/<script>alert(1)</script>'] })),
        await post(m, '/v1/run', '{}', { headers: { origin: 'https://x.example' } }),
        await post(m, '/', '', { method: 'GET' }),
        await rpc(m, 'notifications/initialized', {}, null),
      ];
      for (const [i, a] of answers.entries()) {
        if (a.headers.get('content-type') !== 'application/json; charset=utf-8')
          out.push(`answer ${i}: content-type ${a.headers.get('content-type')}`);
        if (a.headers.get('x-content-type-options') !== 'nosniff') out.push(`answer ${i}: no nosniff`);
        if (a.headers.get('content-security-policy') !== "default-src 'none'; sandbox")
          out.push(`answer ${i}: CSP ${a.headers.get('content-security-policy')}`);
        if (a.headers.get('access-control-allow-origin') !== null) out.push(`answer ${i}: a CORS header`);
      }
      // a program's HTML is a JSON string, never a page: the body holds it as text
      if (answers[1]?.text.includes('<script>alert(1)</script>"') !== true && answers[1]?.status !== 200)
        out.push('the run did not answer');
      return out;
    },
  },
  {
    name: 'log',
    run: async m => {
      const out: string[] = [];
      const secret = 'a-secret-name-in-the-source';
      const text = HELLO.replace('no such route', secret);
      const a = await tool(m, 'run', {
        files: [{ name: 'hello.tape', text }],
        requests: [`GET /hello/${secret}`, 'POST /x\nbody-secret'],
      });
      const [line] = a.answer.logs;
      if (a.answer.logs.length !== 1 || !line) return [`${a.answer.logs.length} log lines for one call`];
      const want: Fields = {
        event: 'tape-mcp.call',
        via: 'mcp',
        mcp_method: 'tools/call',
        tool: 'run',
        ok: true,
        refused: null,
        status: 200,
        files: 1,
        requests: 2,
        rate_limited: false,
        user_agent: 'mcp-test/1',
      };
      for (const [k, v] of Object.entries(want))
        if (JSON.stringify(line[k]) !== JSON.stringify(v))
          out.push(`${k}: ${JSON.stringify(line[k])}, not ${JSON.stringify(v)}`);
      if (line['ip_hash'] !== (await m.serve.ipHash('203.0.113.7', 'test-salt', m.serve.dayOf(Date.now()))))
        out.push(`ip_hash ${String(line['ip_hash'])}`);
      if (JSON.stringify(line['statuses']) !== '[200,404]') out.push(`statuses ${JSON.stringify(line['statuses'])}`);
      if (line['source_bytes'] !== new TextEncoder().encode(text).length)
        out.push(`source_bytes ${String(line['source_bytes'])}`);
      const steps = line['steps'];
      if (typeof steps !== 'number' || steps <= 0) out.push(`steps ${String(steps)}`);
      for (const k of ['compile_ms', 'run_ms', 'total_ms']) if (typeof line[k] !== 'number') out.push(`no ${k}`);
      const all = JSON.stringify(line);
      for (const s of [secret, 'body-secret', '203.0.113.7', 'greeted'])
        if (all.includes(s)) out.push(`the log line holds ${s}`);
      const refusedLine = (await post(m, '/v1/compile', JSON.stringify({ files: [] }))).logs[0];
      if (refusedLine?.['refused'] !== 'bad_files' || refusedLine['ok'] !== false || refusedLine['via'] !== 'http')
        out.push(`a refusal's line: ${JSON.stringify(refusedLine)}`);
      const c54 = (
        await post(m, '/v1/compile', JSON.stringify({ files: [{ name: 'hello.tape', text: WITHOUT_REPEAT }] }))
      ).logs[0];
      if (JSON.stringify(c54?.['diagnostic_codes']) !== '["C54"]' || c54?.['ok'] !== false)
        out.push(`C54's line: ${JSON.stringify(c54)}`);
      return out;
    },
  },
  {
    name: 'trace',
    // trace: "lines" (the default) is the run's line trace, made from its log by the traced build as the CLI's (each
    // function, each arm tried with ✓ or ✗ and its line, each effect under the line that made it, a trap at its
    // line); "full" the OTLP, compared with the playground's OTLP for the same requests; "none" nothing. The lines
    // wanted are read off examples/hello.tape and test/limits.tape, not off this code
    run: async m => {
      const out: string[] = [];
      const { out: h } = await tool(m, 'run', { requests: ['GET /hello/ada', 'GET /hello/ada'] });
      const [first, second] = RESULTS(h).map(x => x['trace']);
      if (typeof first !== 'string' || typeof second !== 'string')
        out.push(`the default trace is text: ${JSON.stringify(first).slice(0, 120)}`);
      const a = String(first).split('\n'),
        b = String(second).split('\n');
      const at = (ls: string[], s: string): number => ls.findIndex(l => l.includes(s));
      // the first greeting takes line 25 (n == 1); the second tries 25, then takes 26
      if (at(a, '✓ hello.tape:25') < 0 || at(a, 'hello.tape:26') >= 0) out.push(`first: ${a.join(' | ')}`);
      if (
        at(b, '✗ hello.tape:25') < 0 ||
        at(b, '✓ hello.tape:26') < 0 ||
        at(b, '✗ hello.tape:25') > at(b, '✓ hello.tape:26')
      )
        out.push(`second: ${b.join(' | ')}`);
      // the INSERT, in the program's words with its :name, under the arm of line 9 that made it, before greet
      const sql = at(a, 'sql INSERT INTO greeted(name, n) VALUES (:name, 1)');
      if (!(at(a, '✓ hello.tape:9') < sql && sql < a.indexOf('greet')) || !String(a[sql]).includes(':name="ada"'))
        out.push(`the INSERT is not under line 9: ${a.join(' | ')}`);
      if (!String(a[sql]).includes('-> [[1]]') || !String(b[at(b, 'sql INSERT')]).includes('-> [[2]]'))
        out.push(`the INSERT's rows: ${a[sql]} / ${b[at(b, 'sql INSERT')]}`);
      // a trap ends the trace with its reason, at the arm it happened in: 100 / len("") in the arm of line 7
      const files = [{ name: 'limits.tape', text: LIMITS_TAPE }];
      const requests = ['GET /div/', 'GET /dice'];
      const { out: r } = await tool(m, 'run', { files, requests });
      const div = String(RESULTS(r)[0]?.['trace']).split('\n');
      const last = div.at(-1) ?? '';
      if (
        !/^ {2}✗ trap \d+: division by zero at limits\.tape:7 {2}Request\(method: "GET", path: "\/div\/" \+\+ by\)/.test(
          last,
        )
      )
        out.push(`the trap's last line: ${JSON.stringify(last)} of ${div.join(' | ')}`);
      if (at(div, '✓ limits.tape:7') < 0) out.push(`the arm before the trap: ${div.join(' | ')}`);
      const theirs = await workbenchOtlp('limits', LIMITS_TAPE, requests);
      const { out: full } = await tool(m, 'run', { files, requests, trace: 'full' });
      for (const [i, x] of RESULTS(full).entries()) {
        out.push(...otlpProblems(x['trace']).map(p => `full, request ${i + 1}: ${p}`));
        const names = (o: unknown): unknown[] =>
          L(F(L(F(L(F(o)['resourceSpans'])[0])['scopeSpans'])[0])['spans']).map(sp => F(sp)['name']);
        if (JSON.stringify(names(x['trace'])) !== JSON.stringify(names(theirs[i])))
          out.push(
            `full, request ${i + 1}: spans ${JSON.stringify(names(x['trace']))}, the playground's ${JSON.stringify(names(theirs[i]))}`,
          );
      }
      const { out: none } = await tool(m, 'run', { files, requests, trace: 'none' });
      if (!RESULTS(none).every(x => x['trace'] === null)) out.push('trace: "none" still gives a trace');
      const { out: gone } = await tool(m, 'run', { files, requests, trace: 'summary' });
      if (gone['error'] !== 'bad_arguments')
        out.push(`trace: "summary" is not refused: ${JSON.stringify(gone).slice(0, 120)}`);
      // and it is smaller than the OTLP
      const size = (x: Fields): number => JSON.stringify(x).length;
      if (!(size(none) < size(r) && size(r) * 2 < size(full)))
        out.push(`sizes: none ${size(none)}, lines ${size(r)}, full ${size(full)}`);
      // a long trace is cut: at most 200 lines, then how many were left out (300 calls of count: 601 lines and
      // more); a run of more steps than a line trace is made for says so
      const COUNT =
        'fn handle(raw: View) -> Buf {\n  respond(status: 200) |> append(view: "\\(count(n: 0))")\n}\n\nfn count(n: Int) -> Int {\n  match {\n    n >= 300 -> n\n    else -> count(n: n + 1)\n  }\n}\n';
      const { out: loop } = await tool(m, 'run', { files: [{ name: 'count.tape', text: COUNT }], requests: ['GET /'] });
      const long = String(RESULTS(loop)[0]?.['trace']).split('\n');
      if (long.length !== 201 || !/^… \d+ more lines$/.test(long.at(-1) ?? ''))
        out.push(`a long trace: ${long.length} lines, last ${JSON.stringify(long.at(-1))}`);
      const { out: spin } = await tool(m, 'run', { files, requests: ['GET /spin'] });
      if (!/^the run took \d+ steps; a line trace is made for at most 200000/.test(String(RESULTS(spin)[0]?.['trace'])))
        out.push(`a run too long to trace: ${String(RESULTS(spin)[0]?.['trace']).slice(0, 120)}`);
      return out;
    },
  },
  {
    name: 'compact',
    // effects: "compact" (the default) shows a query's rows only when it returned at most 20, and says how many;
    // "full" shows them all
    run: async m => {
      const out: string[] = [];
      const files = [{ name: 'clock.tape', text: CLOCK_TAPE }];
      const sqlOf = (x: Fields | undefined): Fields =>
        F(
          L(x?.['effects'])
            .map(F)
            .find(e => e['kind'] === 'sql'),
        );
      for (const [n, shown] of [
        [3, true],
        [20, true],
        [21, false],
      ] as const) {
        const { out: r } = await tool(m, 'run', { files, requests: [`POST /rows/${n}`, 'GET /rows'] });
        const read = sqlOf(RESULTS(r)[1]);
        if (read['rows_returned'] !== n) out.push(`${n} rows: rows_returned ${String(read['rows_returned'])}`);
        if (shown !== Array.isArray(read['rows']) || (shown && L(read['rows']).length !== n))
          out.push(`${n} rows: rows ${JSON.stringify(read['rows'])?.slice(0, 80)}`);
        const write = L(RESULTS(r)[0]?.['effects']).map(F);
        if (write.length !== n || write.some(e => e['rows_written'] !== 1 || 'rows' in e))
          out.push(`${n} inserts: ${JSON.stringify(write).slice(0, 120)}`);
      }
      const { out: full } = await tool(m, 'run', { files, requests: ['POST /rows/25', 'GET /rows'], effects: 'full' });
      const all = sqlOf(RESULTS(full)[1]);
      if (L(all['rows']).length !== 25 || 'rows_returned' in all)
        out.push(`full: ${L(all['rows']).length} rows, rows_returned ${String(all['rows_returned'])}`);
      return out;
    },
  },
  {
    name: 'clock',
    // at_ms: now() is the run's start plus at_ms, so a 60 s window can be stepped through; timers due by a
    // request's time run before it, oldest first
    run: async m => {
      const out: string[] = [];
      const files = [{ name: 'clock.tape', text: CLOCK_TAPE }];
      const at = (request: string, at_ms: number): Fields => ({ request, at_ms });
      const { out: r } = await tool(m, 'run', {
        files,
        requests: [
          at('POST /hit', 0),
          at('POST /hit', 1000),
          'GET /window',
          at('GET /window', 60_500),
          at('GET /window', 61_000),
        ],
      });
      const rs = RESULTS(r);
      const bodies = rs.map(x => x['body']);
      // hits at 0 and 1000; the window at t holds the hits after t - 60000
      if (JSON.stringify(bodies) !== JSON.stringify(['{"n":1}', '{"n":1}', '{"n":2}', '{"n":1}', '{"n":0}']))
        out.push(`window: ${JSON.stringify(bodies)}`);
      if (JSON.stringify(rs.map(x => x['at_ms'])) !== JSON.stringify([0, 1000, 1000, 60_500, 61_000]))
        out.push(`at_ms ${JSON.stringify(rs.map(x => x['at_ms']))}`);
      const nows = rs.map(x =>
        Number(
          F(
            L(x['effects'])
              .map(F)
              .find(e => e['kind'] === 'now'),
          )['now'],
        ),
      );
      const start = nows[0] ?? 0;
      if (JSON.stringify(nows.map(n => n - start)) !== JSON.stringify([0, 1000, 1000, 60_500, 61_000]))
        out.push(`now() - start: ${JSON.stringify(nows.map(n => n - start))}`);
      if (Math.abs(start - Date.now()) > 60_000) out.push(`the run's start ${start} is not about now`);
      if (r['ok'] !== true) out.push(`ok ${String(r['ok'])}`);
      // a timer set at 0 for 5000 ms: not run by 4999, run (as its own result, before the request) by 5000
      const { out: t } = await tool(m, 'run', {
        files,
        requests: [at('POST /later/7', 0), at('GET /fired', 4999), at('GET /fired', 5000), 'GET /fired'],
      });
      const ts = RESULTS(t);
      const shape = ts.map(x => `${String(x['request'])} ${String(x['status'])} ${String(x['body'])}`);
      const woken = ts[2];
      const fired = ts[3];
      const firedAt = Number(
        F(
          L(woken?.['effects'])
            .map(F)
            .find(e => e['kind'] === 'now'),
        )['now'],
      );
      const wake = F(
        L(ts[0]?.['effects'])
          .map(F)
          .find(e => e['kind'] === 'wake'),
      );
      if (ts.length !== 5 || ts[1]?.['body'] !== '[]' || String(woken?.['request']) !== 'woken {"key":7}')
        out.push(`timers: ${JSON.stringify(shape)}`);
      if (JSON.stringify(woken?.['woken']) !== '{"key":7,"due_ms":5000}' || woken?.['at_ms'] !== 5000)
        out.push(`the timer's run: woken ${JSON.stringify(woken?.['woken'])} at_ms ${String(woken?.['at_ms'])}`);
      if (woken?.['status'] !== 200 || woken['body'] !== '{"n":1}' || woken['replayed'] !== null)
        out.push(
          `the timer's run: ${String(woken?.['status'])} ${String(woken?.['body'])} ${String(woken?.['replayed'])}`,
        );
      if (fired?.['body'] !== `[{"key":7,"at":${firedAt}}]` || firedAt - start < 0 || wake['due'] !== firedAt)
        out.push(`fired: ${String(fired?.['body'])}, the timer's now ${firedAt}, due ${String(wake['due'])}`);
      if (JSON.stringify(t['timers']) !== '{"fired":1,"pending":0}') out.push(`timers ${JSON.stringify(t['timers'])}`);
      if (t['ok'] !== true) out.push(`timers: ok ${String(t['ok'])}`);
      if (String(ts[4]?.['request']) !== 'GET /fired' || ts[4]?.['at_ms'] !== 5000)
        out.push(`a request without at_ms after one with it: ${String(ts[4]?.['at_ms'])}`);
      // without at_ms: the real clock, no timer runs, no at_ms or timers in the answer
      const { out: real } = await tool(m, 'run', { files, requests: ['POST /later/7', 'GET /fired'] });
      if (RESULTS(real).length !== 2 || 'timers' in real || RESULTS(real).some(x => 'at_ms' in x))
        out.push(`the real clock: ${JSON.stringify(real).slice(0, 160)}`);
      // the clock is put back after a run
      if (Math.abs(Date.now() - (performance.timeOrigin + performance.now())) > 1000)
        out.push('Date.now is not the real clock after a run');
      return out;
    },
  },
  {
    name: 'determinism',
    run: async m => {
      const out: string[] = [];
      const cases: Fields[] = [
        { requests: ['GET /hello/ada', 'GET /hello/ada', 'GET /hello/bo', 'POST /hello/x\n{}'] },
        {
          files: [{ name: 'limits.tape', text: LIMITS_TAPE }],
          requests: ['GET /dice', 'GET /dice', 'GET /spin', 'GET /big'],
        },
        { files: [{ name: 'hello.tape', text: WITHOUT_REPEAT }], requests: ['GET /hello/ada'] },
      ];
      for (const args of cases) {
        const a = await post(m, '/v1/run', JSON.stringify(args)),
          b = await post(m, '/v1/run', JSON.stringify(args));
        if (a.status !== 200 || !same(a.body, b.body)) {
          out.push(`${JSON.stringify(args).slice(0, 80)}: two runs differ beyond ids and times`);
          console.log(
            `  a: ${JSON.stringify(stable(a.body)).slice(0, 400)}\n  b: ${JSON.stringify(stable(b.body)).slice(0, 400)}`,
          );
        }
        // and the ids that do differ are each run's own
        const ids = (x: Answer): string => JSON.stringify(x.body).match(/"traceId":"([0-9a-f]+)"/)?.[1] ?? '';
        if (ids(a) !== '' && ids(a) === ids(b)) out.push('two runs share a trace id');
      }
      return out;
    },
  },
];

const PLANTS: Plant[] = [
  {
    test: 'handshake',
    what: 'the server gives another name',
    file: 'serve.ts',
    from: "name: 'tape',",
    to: "name: 'tape-tools',",
  },
  {
    test: 'list',
    what: "run's description leaves out hello.tape",
    file: 'serve.ts',
    from: 'and no files. Both are status 200; the first body is "Hello, ada", the second "Hello again, ada #2!"; each has one sql effect, the INSERT with params {":name": "ada"} and rows [[1]] then [[2]]; both are replayed: true.\n\n${hello}',
    to: 'and no files. Both are status 200; the first body is "Hello, ada", the second "Hello again, ada #2!"; each has one sql effect, the INSERT with params {":name": "ada"} and rows [[1]] then [[2]]; both are replayed: true.',
  },
  {
    test: 'list',
    what: "run's description leaves out the cheat sheet",
    file: 'serve.ts',
    from: 'Calls to other programs answer Unreachable.\n\n${CHEAT_SHEET}',
    to: 'Calls to other programs answer Unreachable.',
  },
  {
    test: 'list',
    what: 'the cheat sheet names a function std does not have',
    file: 'serve.ts',
    from: 'decimal(v)',
    to: 'parse_number(v)',
  },
  {
    test: 'compile',
    what: 'the module size is left out',
    file: 'tools.ts',
    from: 'wasm_bytes: c.built?.wasm.length ?? null,',
    to: 'wasm_bytes: null,',
  },
  {
    test: 'c54',
    what: "a diagnostic's fix is its message again",
    file: 'tools.ts',
    from: 'fix: e.hint }',
    to: 'fix: e.message }',
  },
  {
    test: 'run',
    what: 'a response body keeps its status line',
    file: 'tools.ts',
    from: 'full = ran.failed ? ran.failed.error : dec.decode(res?.body ?? new Uint8Array()),',
    to: 'full = ran.failed ? ran.failed.error : dec.decode(ran.out ?? new Uint8Array()),',
  },
  {
    test: 'effects',
    what: 'a value is shown under its number, not its name',
    file: 'tools.ts',
    from: '[line?.binds[i]?.[0] ?? `?${i + 1}`, jsonCell(v)]',
    to: '[`?${i + 1}`, jsonCell(v)]',
  },
  {
    test: 'replay',
    what: 'the replay is compared with nothing',
    file: 'runner.ts',
    from: 'if (out !== null && same(again, out)) return',
    to: 'if (out !== null && !same(again, out)) return',
  },
  {
    test: 'otlp',
    what: "the trace's queries are left out",
    file: 'tools.ts',
    from: 'queries: built.queries.map(q => q.sql),',
    to: 'queries: [],',
  },
  {
    test: 'otlp',
    what: 'a trapped run is traced as a 200',
    file: 'tools.ts',
    from: 'status = ran.failed ? 500 : (res?.status ?? 500),',
    to: 'status = ran.failed ? 200 : (res?.status ?? 500),',
  },
  {
    test: 'budget',
    what: 'a trap is not replayed as the same trap',
    file: 'runner.ts',
    from: 'if (out === null && messageOf(e) === failed) return',
    to: 'if (out === null && messageOf(e) === `${failed}.`) return',
  },
  {
    test: 'budget',
    what: 'bodies are cut at twice the limit',
    file: 'tools.ts',
    from: 'cut = bytes > LIMITS.responseBodyBytes,',
    to: 'cut = bytes > 2 * LIMITS.responseBodyBytes,',
  },
  {
    test: 'limits',
    what: 'nine files are taken',
    file: 'tools.ts',
    from: 'if (files.length > LIMITS.files)',
    to: 'if (files.length > LIMITS.files + 1)',
  },
  {
    test: 'limits',
    what: 'the source limit counts characters per file, not bytes in all',
    file: 'tools.ts',
    from: "bytes += enc.encode(f['text']).length;",
    to: "bytes = f['text'].length;",
  },
  {
    test: 'limits',
    what: 'twenty-one requests are taken',
    file: 'tools.ts',
    from: 'if (requests.length > LIMITS.requests)',
    to: 'if (requests.length > LIMITS.requests + 1)',
  },
  {
    test: 'limits',
    what: 'the body limit is off by one',
    file: 'tools.ts',
    from: 'if (enc.encode(body).length > LIMITS.requestBodyBytes)',
    to: 'if (enc.encode(body).length > LIMITS.requestBodyBytes + 1)',
  },
  {
    test: 'limits',
    what: 'a file name may hold a path',
    file: 'tools.ts',
    from: 'const FILE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,62}\\.tape$/;',
    to: 'const FILE_NAME = /^[./A-Za-z0-9_][./A-Za-z0-9_-]{0,62}\\.tape$/;',
  },
  {
    test: 'limits',
    what: 'unknown arguments are ignored',
    file: 'tools.ts',
    from: 'const extra = Object.keys(args).filter(k => !known.includes(k));',
    to: 'const extra: string[] = [];',
  },
  {
    test: 'limits',
    what: 'requests from pages are let in',
    file: 'serve.ts',
    from: "if (request.headers.has('origin'))",
    to: "if (request.headers.has('x-origin'))",
  },
  {
    test: 'limits',
    what: 'any content type is taken',
    file: 'serve.ts',
    from: 'if (!/^application\\/json\\s*(;|$)/i.test(type))',
    to: 'if (false)',
  },
  {
    test: 'limits',
    what: 'the kill switch does nothing',
    file: 'serve.ts',
    from: "if (gate.killSwitch === 'on')",
    to: "if (gate.killSwitch === 'yes')",
  },
  {
    test: 'limits',
    what: 'the rate limit keys on the address itself',
    file: 'serve.ts',
    from: 'await gate.limiter.limit({ key: meta.ip_hash });',
    to: "await gate.limiter.limit({ key: request.headers.get('cf-connecting-ip') ?? '' });",
  },
  {
    test: 'limits',
    what: 'a body is read whole whatever its size',
    file: 'serve.ts',
    from: 'if (n > MAX_BODY) {',
    to: 'if (n > 100 * MAX_BODY) {',
  },
  {
    test: 'limits',
    what: 'the wall guard waits for ever',
    file: 'tools.ts',
    from: "timer = setTimeout(() => resolve('timeout'), ms);",
    to: "timer = setTimeout(() => resolve('timeout'), ms + 3_600_000);",
  },
  {
    test: 'malformed',
    what: 'a body that is not JSON is taken as no arguments',
    file: 'serve.ts',
    from: "return no(refused(400, 'bad_json', 'the body is not JSON'));",
    to: 'args = {};',
  },
  {
    test: 'headers',
    what: 'nosniff is not sent',
    file: 'serve.ts',
    from: "'x-content-type-options': 'nosniff',",
    to: '',
  },
  {
    test: 'response headers',
    what: "a run's result leaves out the headers the program set",
    file: 'tools.ts',
    from: '...(ran.failed || !res || res.headers.length === 0 ? {} : { headers: res.headers }),',
    to: '',
  },
  {
    test: 'log',
    what: 'the log line leaves out the address hash',
    file: 'serve.ts',
    from: '  ip_hash: meta.ip_hash,\n',
    to: '',
  },
  {
    test: 'log',
    what: 'the log line holds the whole MCP message, source and all',
    file: 'serve.ts',
    from: "seen.method = typeof method === 'string' ? method.slice(0, 64) : null;",
    to: 'seen.method = text;',
  },
  {
    test: 'limits',
    what: 'the address is hashed without the salt',
    file: 'serve.ts',
    from: 'enc.encode(`${ip}\\u0000${day}\\u0000${salt}`)',
    to: 'enc.encode(`${ip}\\u0000${day}`)',
  },
  {
    test: 'limits',
    what: 'the address is hashed without the day',
    file: 'serve.ts',
    from: 'enc.encode(`${ip}\\u0000${day}\\u0000${salt}`)',
    to: 'enc.encode(`${ip}\\u0000${salt}`)',
  },
  {
    test: 'limits',
    what: 'a deployment without IP_SALT serves anyway',
    file: 'serve.ts',
    from: '  if (!gate.salt)\n    return no(',
    to: '  if (false)\n    return no(',
  },
  {
    test: 'trace',
    what: 'the line trace shows an arm tried and not taken as taken',
    file: 'tools.ts',
    from: '!matched(e.site, i)) out.push(`  ✗ ${at(s.file, s.line)}`);',
    to: '!matched(e.site, i)) out.push(`  ✓ ${at(s.file, s.line)}`);',
  },
  {
    test: 'trace',
    what: "the line trace leaves out the trap's line",
    file: 'tools.ts',
    from: "if (error !== null) out.push(`  ✗ ${error}${last ? ` at ${at(last.file, last.line)}` : ''}`);",
    to: 'if (error !== null) out.push(`  ✗ ${error}`);',
  },
  {
    test: 'trace',
    what: 'trace: "none" gives the OTLP',
    file: 'tools.ts',
    from: "      modes.trace === 'full'",
    to: "      modes.trace !== 'lines'",
  },
  {
    test: 'compact',
    what: 'compact effects show every row',
    file: 'tools.ts',
    from: "const shown = e.rows && (mode === 'full' || e.rows.length <= LIMITS.compactRows);",
    to: 'const shown = e.rows;',
  },
  {
    test: 'compact',
    what: 'compact effects cut at 21 rows, not 20',
    file: 'tools.ts',
    from: "const shown = e.rows && (mode === 'full' || e.rows.length <= LIMITS.compactRows);",
    to: "const shown = e.rows && (mode === 'full' || e.rows.length <= LIMITS.compactRows + 1);",
  },
  {
    test: 'clock',
    what: 'at_ms is ignored',
    file: 'runner.ts',
    from: '        setClock(last);\n',
    to: '',
  },
  {
    test: 'clock',
    what: 'due timers do not run',
    file: 'runner.ts',
    from: 'key !== undefined && fired < MAX_WOKEN;',
    to: 'key !== undefined && fired < 0;',
  },
  {
    test: 'clock',
    what: 'a timer runs a millisecond late',
    file: 'runner.ts',
    from: 'const now = start + last;',
    to: 'const now = start + last - 1;',
  },
  {
    test: 'clock',
    what: 'the real clock is not put back',
    file: 'runner.ts',
    from: '    Date.now = realNow;\n',
    to: '',
  },
  {
    test: 'limits',
    what: 'at_ms may go back',
    file: 'tools.ts',
    from: 'if (ms < before)',
    to: 'if (ms < before - 1000)',
  },
  {
    test: 'determinism',
    what: 'random() is seeded from the clock',
    file: 'runner.ts',
    from: 'random: seeded(7)',
    to: 'random: seeded(Date.now() + Math.floor(Math.random() * 1000))',
  },
];

async function runTests(m: Mods, only: string | null): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>();
  for (const t of tests) {
    if (only !== null && t.name !== only) continue;
    let problems: string[];
    try {
      // a test that never answers fails (a guard planted away leaves a run waiting for ever)
      let timer: ReturnType<typeof setTimeout> | undefined;
      problems = await Promise.race([
        t.run(m),
        new Promise<string[]>(resolve => {
          timer = setTimeout(() => resolve(['did not finish in 30 s']), 30_000);
        }),
      ]);
      clearTimeout(timer);
    } catch (e) {
      problems = [`threw: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`];
    }
    found.set(t.name, problems);
  }
  return found;
}

if (process.argv.includes('--plants')) {
  let caught = 0;
  for (const p of PLANTS) {
    const m = await modules(p);
    const problems = (await runTests(m, p.test)).get(p.test) ?? [];
    if (problems.length > 0) {
      caught++;
      console.log(`caught plant for "${p.test}": ${p.what}`);
    } else console.log(`MISSED plant for "${p.test}": ${p.what}`);
  }
  console.log(
    caught === PLANTS.length
      ? `all ${PLANTS.length} plants caught`
      : `${PLANTS.length - caught} of ${PLANTS.length} plants missed`,
  );
  process.exit(caught === PLANTS.length ? 0 : 1);
} else {
  const found = await runTests(await modules(null), null);
  let failed = 0;
  for (const [name, problems] of found) {
    console.log(`${problems.length === 0 ? 'ok  ' : 'FAIL'} ${name}`);
    for (const p of problems) console.log(`       ${p}`);
    if (problems.length > 0) failed++;
  }
  console.log(failed === 0 ? `all ${found.size} tests pass` : `${failed} of ${found.size} tests failed`);
  process.exit(failed === 0 ? 0 : 1);
}
