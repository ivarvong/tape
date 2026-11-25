// apps/playground/test.ts: the playground's logic, without a browser, each test against an oracle that is not the
// code under test.
//   node apps/playground/test.ts            run every test; exit 1 if one fails
//   node apps/playground/test.ts --plants   plant a bug in a scratch copy of one module per test, and show that the
//                                           test it is meant for fails (exit 1 if one does not)
//
//   sqlite     the page's SQLite (sql.js through src/sqlite.ts) against node:sqlite: bound values, and every preset
//              of every example run through both, the responses and effect logs compared (nodesql.ts is the CLI's)
//   otlp       each request's OTLP/JSON against its effect logs: one trace, parents present, a client span per call
//              in every log, a server span under it for each call a program ran, times nested
//   marks      a diagnostic's message lands at the end of its line, read back from the HTML by line counting
//   build      the static files: every import resolves to a published file, every name is its content's hash,
//              no node: import is left, the page names files that exist, sql.js is the pinned file
//   examples   every example's programs compile, and the shop is its section of LANGUAGE.md, byte for byte
//   simulate   the shop passes; with the bug LANGUAGE.md section 9 plants, the invariant it names is broken
//   trace      apps/trace/trace.tape compiles and draws an SVG for a request's OTLP (skipped, loudly, without it)
//   home       the homepage's build-time copy against the command line: the program is the file, highlighted as
//              highlight.tape draws it; its runs are what `node tape.ts` answers and traces; the refusal is what
//              the compiler says; the waterfalls have the spans the caption counts; the simulator's numbers are
//              `node tape.ts sim`'s; every link is local or the repository; nothing inline the policy refuses
import '../../node25.ts';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { compile } from '../../compiler.ts';
import { instantiate, isCall, isHead, responseOf } from '../../host.ts';
import type { Effect } from '../../host.ts';
import { nodeSql as cliSql } from '../../nodesql.ts';
import { std } from '../../std.ts';
import { spawnSync } from 'node:child_process';
import type * as ArtefactsM from './artefacts.ts';
import type * as BuildM from './build.ts';
import type * as DataM from './src/data.ts';
import type * as EditorM from './src/editor.ts';
import type * as SimulateM from './src/simulate.ts';
import type * as SqliteM from './src/sqlite.ts';
import type * as LinesM from './src/lines.ts';
import type * as WorkbenchM from './src/workbench.ts';

const HERE = new URL('./', import.meta.url).pathname;
const ROOT = new URL('../../', import.meta.url).pathname;
type Mods = {
  artefacts: typeof ArtefactsM;
  sqlite: typeof SqliteM;
  workbench: typeof WorkbenchM;
  lines: typeof LinesM;
  editor: typeof EditorM;
  build: typeof BuildM;
  data: typeof DataM;
  simulate: typeof SimulateM;
};
type Plant = { test: string; what: string; file: string; from: string; to: string };

/** What this test uses of each module: a module loaded by path that exports these is taken to be that file. */
const EXPORTS: { readonly [K in keyof Mods]: readonly string[] } = {
  artefacts: ['artefacts'],
  sqlite: ['loadSqlite', 'nodeSql'],
  workbench: ['Workbench'],
  lines: ['effectLine', 'queryNames', 'traceLines'],
  editor: ['withMarks'],
  build: ['build', 'IMPORT', 'sri'],
  data: ['DATA', 'readData'],
  simulate: ['simulate'],
};
const isMod = <K extends keyof Mods>(k: K, m: unknown): m is Mods[K] =>
  typeof m === 'object' && m !== null && EXPORTS[k].every(name => name in m);

// Each module of the playground, or a planted copy of one: written elsewhere, its relative imports made absolute.
async function modules(plant: Plant | null): Promise<Mods> {
  const dir = plant ? mkdtempSync(join(tmpdir(), 'playground-plant-')) : '';
  const load = (rel: string): Promise<unknown> => {
    if (!plant || plant.file !== rel) return import(pathToFileURL(HERE + rel).href);
    const src = readFileSync(HERE + rel, 'utf8');
    if (!src.includes(plant.from)) throw new Error(`plant "${plant.what}": its text is not in ${rel}`);
    const base = new URL(rel, pathToFileURL(HERE));
    const text = src
      .replace(plant.from, plant.to)
      .replaceAll(
        /(from\s+|import\s+)'(\.{1,2}\/[^']+)'/g,
        (_m, lead: string, spec: string) => `${lead}'${new URL(spec, base).href}'`,
      )
      .replaceAll("new URL('../../', import.meta.url)", `new URL(${JSON.stringify(pathToFileURL(ROOT).href)})`)
      .replaceAll("new URL('../../../', import.meta.url)", `new URL(${JSON.stringify(pathToFileURL(ROOT).href)})`);
    const file = join(dir, rel.replaceAll('/', '_'));
    writeFileSync(file, text);
    return import(pathToFileURL(file).href);
  };
  // a module by its path, as the file it is a copy of (the `import type`s above) when it exports what is used of it
  const mod = async <K extends keyof Mods>(k: K, rel: string): Promise<Mods[K]> => {
    const m = await load(rel);
    if (!isMod(k, m)) throw new Error(`${rel} does not export what this test uses of it`);
    return m;
  };
  return {
    artefacts: await mod('artefacts', 'artefacts.ts'),
    sqlite: await mod('sqlite', 'src/sqlite.ts'),
    workbench: await mod('workbench', 'src/workbench.ts'),
    lines: await mod('lines', 'src/lines.ts'),
    editor: await mod('editor', 'src/editor.ts'),
    build: await mod('build', 'build.ts'),
    data: await mod('data', 'src/data.ts'),
    simulate: await mod('simulate', 'src/simulate.ts'),
  };
}

const require = createRequire(import.meta.url);
/** sql.js's CommonJS export: its init function. */
const isInit = (f: unknown): f is Parameters<Mods['sqlite']['loadSqlite']>[0] => typeof f === 'function';
const VENDOR = `${HERE}vendor/sql.js-1.10.3/`;
async function sqljs(m: Mods): Promise<void> {
  // sql-wasm.js is CommonJS (or a script); under this package's "type": "module" a .js file is read as a module,
  // so it is loaded from a .cjs copy
  const cjs = join(mkdtempSync(join(tmpdir(), 'sqljs-')), 'sql-wasm.cjs');
  writeFileSync(cjs, readFileSync(`${VENDOR}sql-wasm.js`));
  const init: unknown = require(cjs);
  if (!isInit(init)) throw new Error("sql-wasm.js's export is not sql.js's init function");
  const wasm = readFileSync(`${VENDOR}sql-wasm.wasm`);
  await m.sqlite.loadSqlite(init, wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
}

// A log without what differs between two runs of the same request: span ids, clocks, the build hash's own times.
function stable(effects: readonly Effect[]): unknown[] {
  return effects.map(e => {
    if (isHead(e)) return { build: e.build, flags: e.flags, method: e.method ?? null };
    if (isCall(e))
      return { call: e.call, method: e.method, send: e.send, status: e.status, reply: e.reply, once: e.once ?? null };
    if ('now' in e) return { now: 'clock' };
    if ('random' in e) return { random: 'dice' };
    if ('wake' in e) return { wake: e.wake, after: e.after };
    return e;
  });
}
type RunLike = { status: number | string; response: string; effects: Effect[]; calls: { run: RunLike | null }[] };
const flat = (r: RunLike): unknown[] => [
  r.status,
  r.response,
  stable(r.effects),
  ...r.calls.flatMap(c => (c.run ? [flat(c.run)] : [])),
];
/** A run as text, with each time read from the clock in it or an earlier run (`seen`), which differs between two
 * runs of the same requests, written as <now>. */
const runText = (r: RunLike, seen: number[]): string => {
  const walk = (x: RunLike): void => {
    for (const e of x.effects) if ('now' in e) seen.push(e.now);
    for (const c of x.calls) if (c.run) walk(c.run);
  };
  walk(r);
  return seen.reduce((t, n) => t.replaceAll(String(n), '<now>'), JSON.stringify(flat(r)));
};

// The homepage's artefacts and the build, made once for each set of modules (they take a few seconds).
const builtOf = new WeakMap<Mods, Promise<Awaited<ReturnType<Mods['build']['build']>>>>();
const built = (m: Mods): Promise<Awaited<ReturnType<Mods['build']['build']>>> => {
  let b = builtOf.get(m);
  if (!b) {
    b = m.artefacts.artefacts(m.data.readData()).then(made => m.build.build({ made }));
    builtOf.set(m, b);
  }
  return b;
};
/** HTML's text: tags out, the five entities back. */
const textOf = (html: string): string =>
  html
    .replaceAll(/<[^>]*>/g, '')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
const html = (s: string): string =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
/** The repository the homepage links to: written here, not read from build.ts. */
const REPO = 'https://github.com/ivarvong/tape';
const tape = (...args: string[]): { out: string; code: number } => {
  const r = spawnSync(process.execPath, [`${ROOT}tape.ts`, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  return { out: `${r.stdout}${r.stderr}`, code: r.status ?? -1 };
};

type Test = { name: string; run: (m: Mods) => Promise<string[]> | string[] };
const tests: Test[] = [
  {
    name: 'sqlite',
    run: async m => {
      await sqljs(m);
      const out: string[] = [];
      // bound values, as node:sqlite binds them (the oracle), for numbers, text and NULL, and a ?1 inside quotes
      const q = "SELECT typeof(?1) AS a, ?1 / 2 AS b, typeof(?2) AS c, '?1' AS d, typeof(?3) AS e, ?2 || 'x' AS f";
      const params = [7, 'seven', null];
      const node = new DatabaseSync(':memory:').prepare(q).get(...params);
      const page = m.sqlite
        .nodeSql()
        .exec(q, ...params)
        .toArray()[0];
      if (JSON.stringify(page) !== JSON.stringify({ ...node }))
        out.push(`bound values: page ${JSON.stringify(page)}, node:sqlite ${JSON.stringify({ ...node })}`);
      // more databases than sql.js can hold open (4093, counted with `new SQL.Database()` on 24 November 2026), none
      // closed, as the simulator leaves them: each still answers with the row it was given, one written in a
      // transaction and one after, while the others were made
      try {
        const many = Array.from({ length: 5000 }, (_, i) => {
          const db = m.sqlite.nodeSql();
          db.exec('CREATE TABLE t(n INTEGER PRIMARY KEY, s TEXT)');
          db.transaction(() => db.exec('INSERT INTO t VALUES (?1, ?2)', i, `row ${i}`));
          return db;
        });
        for (const [i, db] of many.entries()) db.exec('INSERT INTO t VALUES (?1, ?2)', -1 - i, 'late');
        const wrong = many.filter(
          (db, i) =>
            JSON.stringify(db.exec('SELECT n, s FROM t ORDER BY n').toArray()) !==
            JSON.stringify([
              { n: -1 - i, s: 'late' },
              { n: i, s: `row ${i}` },
            ]),
        ).length;
        if (wrong > 0) out.push(`${wrong} of 5000 databases left open lost their rows`);
        for (const db of many) db.close();
      } catch (e) {
        out.push(`5000 databases left open: ${e instanceof Error ? e.message : String(e)}`);
      }
      // every preset of every example, run through the workbench on both
      let requests = 0;
      for (const ex of m.data.DATA.examples) {
        const programs = ex.files.map(f => ({ name: f.name, text: f.text }));
        // the same seeded numbers for random(from:) on both sides (53 bits, as the host gives)
        const dice = (): (() => number) => {
          let state = 12345;
          return () => (state = (state * 48271) % 2147483647) * 4194304 + (state % 4194304);
        };
        const a = new m.workbench.Workbench(std, () => m.sqlite.nodeSql(), { random: dice }),
          b = new m.workbench.Workbench(std, cliSql, { random: dice });
        const errs = [...a.load(programs), ...b.load(programs)];
        const seenA: number[] = [],
          seenB: number[] = [];
        if (errs.length > 0) {
          out.push(`${ex.id}: ${errs[0]?.code} ${errs[0]?.message}`);
          continue;
        }
        for (const p of ex.presets) {
          const to = p.to ?? ex.files[0]?.name ?? '';
          for (const w of [a, b]) {
            w.faults = { ...p.faults };
            for (const [prog, flags] of Object.entries(p.flags ?? {}))
              for (const [k, v] of Object.entries(flags)) w.setFlag(prog, k, v);
          }
          const req = `${p.method} ${p.path}\n${p.body ?? ''}`;
          const [x, y] = await Promise.all([a.send(to, req), b.send(to, req)]);
          requests++;
          const fx = runText(x.root, seenA),
            fy = runText(y.root, seenB);
          if (fx !== fy)
            out.push(
              `${ex.id} "${p.label}": the page's SQLite and node:sqlite differ\n      page ${fx.slice(0, 300)}\n      node ${fy.slice(0, 300)}`,
            );
          for (const w of [a, b])
            for (const [prog, flags] of Object.entries(p.flags ?? {}))
              for (const k of Object.keys(flags))
                w.setFlag(prog, k, w.slots.get(prog)?.built?.flags.find(f => f.name === k)?.default ?? 0);
        }
      }
      console.log(`  sqlite: ${requests} requests through both, logs compared`);
      return out;
    },
  },
  {
    name: 'otlp',
    run: async m => {
      await sqljs(m);
      const out: string[] = [];
      let spans = 0;
      for (const id of ['orders', 'fulfillment', 'shop', 'tickets']) {
        const ex = m.data.DATA.examples.find(e => e.id === id);
        if (!ex) throw new Error(`no example ${id}`);
        const w = new m.workbench.Workbench(std, () => m.sqlite.nodeSql());
        w.load(ex.files.map(f => ({ name: f.name, text: f.text })));
        for (const p of ex.presets) {
          if (Object.values(p.faults ?? {}).includes('lose')) continue; // a lost call waits out its budget
          w.faults = { ...p.faults };
          const x = await w.send(p.to ?? ex.files[0]?.name ?? '', `${p.method} ${p.path}\n${p.body ?? ''}`);
          const all = x.otlp.resourceSpans.flatMap(r =>
            r.scopeSpans[0].spans.map(s => ({
              ...s,
              service: String(Object.values(r.resource.attributes[0]?.value ?? {})[0]),
            })),
          );
          spans += all.length;
          const ids = new Map(all.map(s => [s.spanId, s]));
          const where = `${id} "${p.label}"`;
          if (new Set(all.map(s => s.traceId)).size !== 1) out.push(`${where}: more than one trace id`);
          const roots = all.filter(s => !s.parentSpanId);
          if (roots.length !== 1) out.push(`${where}: ${roots.length} root spans`);
          for (const s of all)
            if (s.parentSpanId && !ids.has(s.parentSpanId))
              out.push(`${where}: span ${s.name} has a parent not in the trace`);
          if (ids.size !== all.length) out.push(`${where}: ${all.length - ids.size} span ids used twice`);
          // a client span (to/method, from the caller's log) and the run under it (from the callee's) name one call
          for (const s of all.filter(sp => sp.kind === 3)) {
            const [to, method] = s.name.split('/');
            for (const c of all.filter(sp => sp.parentSpanId === s.spanId))
              if (c.name !== `${to} ${method}` && c.name !== `${to} ${method} (stored reply)`)
                out.push(`${where}: the call ${s.name} has under it the run ${c.name}`);
          }
          // the oracle: the logs. Every call entry in every run is a client span; every run of a program is a span
          const runs: m_Run[] = [];
          const walk = (r: m_Run): void => {
            runs.push(r);
            for (const c of r.calls) if (c.run) walk(c.run);
          };
          walk(x.root);
          const calls = runs.reduce((n, r) => n + r.effects.filter(isCall).length, 0);
          const clients = all.filter(s => s.kind === 3).length;
          if (clients !== calls) out.push(`${where}: ${calls} calls in the logs, ${clients} client spans`);
          if (all.filter(s => s.kind !== 3).length !== runs.length)
            out.push(`${where}: ${runs.length} runs in the logs, ${all.length - clients} run spans`);
          for (const r of runs.slice(1)) {
            const s = ids.get(r.span),
              parent = s?.parentSpanId ? ids.get(s.parentSpanId) : undefined;
            if (!s || parent?.kind !== 3) out.push(`${where}: the run of ${r.program} is not under a client span`);
            else if (
              BigInt(s.startTimeUnixNano) + 1000n < BigInt(parent.startTimeUnixNano) ||
              BigInt(s.endTimeUnixNano) > BigInt(parent.endTimeUnixNano) + 1000n
            )
              out.push(`${where}: ${s.name} is not within the call that made it`);
          }
        }
      }
      console.log(`  otlp: ${spans} spans checked against their logs`);
      return out;
    },
  },
  {
    name: 'marks',
    run: m => {
      const out: string[] = [];
      // the highlighter's own output for a source with a multi-line SQL block, a carried text and an error
      const src = 'fn f() -> Int {\n  let s = "a \\\n    b"\n  1\n}\nmigration 1 "m" {\n  SELECT 1\n}\n';
      const r = compile([
        ...std,
        { name: 'highlight.tape', text: readFileSync(`${ROOT}apps/highlight/highlight.tape`, 'utf8') },
      ]);
      if (!r.wasm) return ['highlight.tape does not compile'];
      const app = instantiate(new WebAssembly.Module(r.wasm), {});
      const drawn = new TextDecoder().decode(responseOf(app.handle(new TextEncoder().encode(src))).body);
      const lines = src.split('\n').length;
      for (let line = 1; line <= lines; line++) {
        const got = m.editor.withMarks(drawn, [{ line, code: 'C99', message: 'here' }]);
        const text = got
          .replaceAll(/<[^>]+>/g, '')
          .replaceAll('&quot;', '"')
          .replaceAll('&lt;', '<')
          .replaceAll('&gt;', '>')
          .replaceAll('&amp;', '&');
        const want = src
          .split('\n')
          .map((l, i) => (i + 1 === line ? `${l}C99 here` : l))
          .join('\n');
        if (text !== want)
          out.push(
            `a mark on line ${line} is not at the end of line ${line}: ${JSON.stringify(text.split('\n')[line - 1])}`,
          );
      }
      if (m.editor.withMarks(drawn, []) !== drawn) out.push('no marks changes the HTML');
      return out;
    },
  },
  {
    name: 'names',
    run: m => {
      // every statement whose text is a query literal of the program, as the oracle reads them here (a `\` at a line
      // end carries the text on; each `:name` numbered in the order it first appears), is logged in the program's
      // words: the literal itself, and each value under its name
      const out: string[] = [];
      let checked = 0;
      for (const ex of m.data.DATA.examples)
        for (const f of ex.files) {
          const r = compile([...std, { name: `${f.name}.tape`, text: f.text }]);
          if (!r.wasm) continue;
          const literals = [...f.text.matchAll(/query: "((?:[^"\\]|\\[\s\S])*)"/g)].map(q =>
            (q[1] ?? '').replaceAll(/\\\n\s*/g, ''),
          );
          const names = m.lines.queryNames(f.text);
          for (const [i, q] of r.queries.entries()) {
            for (const lit of literals) {
              const order = [...new Set([...lit.matchAll(/:([A-Za-z_]\w*)/g)].map(x => x[1] ?? ''))];
              if (order.length === 0) continue;
              const num = lit.replaceAll(/:([A-Za-z_]\w*)/g, (_a, n: string) => `?${order.indexOf(n) + 1}`);
              if (num !== q.sql) continue;
              checked++;
              const p = order.map((_n, k) => k);
              const l = m.lines.effectLine(r, { q: i, p, r: 1 }, names);
              if (
                l.sql?.query !== lit ||
                JSON.stringify(l.sql.binds.map(b => b[0])) !== JSON.stringify(order.map(n => `:${n}`))
              )
                out.push(`${ex.id}/${f.name}: ${JSON.stringify(l.sql?.query)} for ${JSON.stringify(lit)}`);
            }
          }
        }
      if (checked < 10) out.push(`only ${checked} statements checked`);
      // a write that its run's rollback(out) or trap undid (host/run.ts marks it) says so, in the log and the trace
      const one = compile([
        ...std,
        {
          name: 'w.tape',
          text: 'schema "CREATE TABLE IF NOT EXISTS t(k TEXT)"\n\nfn handle(raw: View, db: Sql) -> Response {\n  let w = sql_exec(query: "DELETE FROM t")\n  buf() |> append(view: "\\(w)") |> respond(status: 200)\n}\n',
        },
      ]);
      if (!one.wasm) return [...out, `the undone check's program does not compile: ${one.errors[0]?.message}`];
      const undone = m.lines.effectLine(one, { q: 0, p: [], r: 2, undone: true }),
        kept = m.lines.effectLine(one, { q: 0, p: [], r: 2 });
      if (undone.sql?.result !== '2 written, undone' || undone.undone !== true)
        out.push(`an undone write in the log: ${JSON.stringify(undone)}`);
      if (kept.sql?.result !== '2 written' || kept.undone !== undefined)
        out.push(`a kept write in the log: ${JSON.stringify(kept)}`);
      const timer = m.lines.effectLine(one, { wake: 3, after: 10, due: 0, undone: true });
      if (!timer.text.endsWith(', undone') || timer.undone !== true)
        out.push(`an undone timer in the log: ${JSON.stringify(timer)}`);
      const [tl] = m.lines.traceLines(one, 'w.tape', [], [{ sql: 0, p: [], r: 2, undone: true }]);
      if (tl?.text !== 'sql [] -> 2 written, undone' || tl.undone !== true)
        out.push(`an undone write in the trace: ${JSON.stringify(tl)}`);
      console.log(`  names: ${checked} statements logged in the program's words`);
      return out;
    },
  },
  {
    name: 'build',
    run: async m => {
      const out: string[] = [];
      const b = await built(m);
      for (const [path, body] of b.files) {
        if (!path.startsWith('a/')) continue;
        const text = typeof body === 'string' ? body : Buffer.from(body).toString('latin1');
        const hash = /\.([0-9a-f]{16})\.[a-z]+$/.exec(path)?.[1];
        const own = createHash('sha256').update(body).digest('hex').slice(0, 16);
        if (hash !== own) out.push(`${path}: its name is not its content's hash (${own})`);
        if (!path.endsWith('.js')) continue;
        for (const mm of text.matchAll(m.build.IMPORT)) {
          const spec = mm[3] ?? '';
          if (spec.startsWith('node:')) out.push(`${path}: imports ${spec}`);
          else if (!spec.startsWith('./') || !b.files.has(`a/${spec.slice(2)}`))
            out.push(`${path}: imports ${spec}, which is not published`);
        }
      }
      // the homepage at the root names a/…; the playground, one level down, ../a/…
      for (const [file, up] of [
        ['index.html', ''],
        ['playground/index.html', '../'],
      ] as const) {
        const page = b.files.get(file);
        if (typeof page !== 'string') {
          out.push(`no ${file}`);
          continue;
        }
        const asset = new RegExp(`"${up.replaceAll('.', '\\.')}(a/[^"]+)"`, 'g');
        const refs = [...page.matchAll(asset)].map(r => r[1] ?? '');
        if (refs.length < 4) out.push(`${file} names only ${refs.length} published files`);
        for (const ref of refs) if (!b.files.has(ref)) out.push(`${file} names ${ref}, which is not published`);
        for (const ref of page.matchAll(/(?:href|src)="((?:\.\.\/)*a\/[^"]+)"/g))
          if (!(ref[1] ?? '').startsWith(`${up}a/`))
            out.push(`${file} names ${ref[1]}, which is not where it is from there`);
        if (!/Content-Security-Policy" content="default-src 'none'/.test(page))
          out.push(`${file} has no content security policy`);
        if (!/connect-src 'self'/.test(page)) out.push(`${file}'s policy lets the page connect elsewhere`);
        if (
          !String(b.files.get('_headers')).includes(
            `/${file.replace('index.html', '')}\n  Cache-Control: no-cache\n  Content-Security-Policy: default-src 'none'`,
          )
        )
          out.push(`_headers has no policy for /${file.replace('index.html', '')}`);
      }
      const wasm = [...b.files].find(([p]) => p.endsWith('.wasm'));
      if (!wasm || m.build.sri(wasm[1]) !== m.build.sri(readFileSync(`${VENDOR}sql-wasm.wasm`)))
        out.push('the published sql-wasm.wasm is not the vendored file');
      console.log(`  build: ${b.files.size} files, ${b.modules} modules`);
      return out;
    },
  },
  {
    name: 'examples',
    run: m => {
      const out: string[] = [];
      for (const ex of m.data.DATA.examples)
        for (const f of ex.files) {
          const r = compile([...std, { name: `${f.name}.tape`, text: f.text }]);
          if (!r.wasm) out.push(`${ex.id}/${f.name}: ${r.errors[0]?.code} ${r.errors[0]?.message}`);
          if ('from' in f && f.from.endsWith('.tape') && readFileSync(`${ROOT}${f.from}`, 'utf8') !== f.text)
            out.push(`${ex.id}/${f.name}: not the file in the tree`);
        }
      // the shop, cut by hand from LANGUAGE.md's text: after section 8's heading, its first tape block
      const doc = readFileSync(`${ROOT}LANGUAGE.md`, 'utf8').split('\n');
      const at = doc.indexOf('## 8. A whole program'),
        open = doc.indexOf('```tape', at),
        close = doc.indexOf('```', open + 1);
      const want = `${doc.slice(open + 1, close).join('\n')}\n`;
      const shop = m.data.DATA.examples.find(e => e.id === 'shop')?.files[0]?.text;
      if (shop !== want) out.push("the shop is not LANGUAGE.md section 8's program");
      return out;
    },
  },
  {
    name: 'simulate',
    run: async m => {
      await sqljs(m);
      const ex = m.data.DATA.examples.find(e => e.id === 'shop');
      const text = ex?.files[0]?.text ?? '',
        plant = ex?.plant;
      if (!plant || !text.includes(plant.from)) return ["the shop's plant does not apply to its text"];
      const clean = await m.simulate.simulate([{ name: 'shop', text }], { seeds: 60 });
      const bad = await m.simulate.simulate([{ name: 'shop', text: text.replace(plant.from, plant.to) }], {
        seeds: 60,
      });
      const out: string[] = [];
      if (!clean.ok) out.push(`the shop fails: ${clean.lines.slice(-3).join(' / ')}`);
      // the oracle: LANGUAGE.md's own words for what the simulator finds
      const said = /```diff sim (\w+): (invariant "[^"]+" does not hold)/.exec(
        readFileSync(`${ROOT}LANGUAGE.md`, 'utf8'),
      );
      if (!said) out.push('LANGUAGE.md no longer says what the simulator finds');
      else if (
        bad.ok ||
        !bad.failure ||
        bad.failure.kind !== said[1] ||
        !bad.failure.violations.some(v => v.includes(said[2] ?? ''))
      )
        out.push(
          `planted: want ${said[1]}: ${said[2]}; got ${bad.failure?.kind}: ${bad.failure?.violations.join('; ')}`,
        );
      console.log(
        `  simulate: clean ${clean.runs} runs ${clean.ms.toFixed(0)} ms; planted found, shrunk to ${bad.failure?.choices} choices in ${bad.ms.toFixed(0)} ms`,
      );
      return out;
    },
  },
  {
    name: 'trace',
    run: async m => {
      if (!existsSync(`${ROOT}apps/trace/trace.tape`)) {
        console.log('  trace: SKIPPED: apps/trace/trace.tape is not in the tree');
        return [];
      }
      await sqljs(m);
      const r = compile([...std, { name: 'trace.tape', text: readFileSync(`${ROOT}apps/trace/trace.tape`, 'utf8') }]);
      if (!r.wasm) return [`trace.tape does not compile: ${r.errors[0]?.code} ${r.errors[0]?.message}`];
      const ex = m.data.DATA.examples.find(e => e.id === 'fulfillment');
      const w = new m.workbench.Workbench(std, () => m.sqlite.nodeSql());
      w.load(ex?.files.map(f => ({ name: f.name, text: f.text })) ?? []);
      const p = ex?.presets[2];
      const x = await w.send('fulfillment', `${p?.method} ${p?.path}\n${p?.body ?? ''}`);
      const app = instantiate(new WebAssembly.Module(r.wasm), {});
      const svg = new TextDecoder().decode(
        responseOf(app.handle(new TextEncoder().encode(JSON.stringify(x.otlp)))).body,
      );
      const out: string[] = [];
      if (!svg.trimStart().startsWith('<svg')) out.push(`trace.tape did not answer with an SVG: ${svg.slice(0, 80)}`);
      const names = x.otlp.resourceSpans.flatMap(rs => rs.scopeSpans[0].spans.map(s => s.name));
      for (const n of names)
        if (!svg.includes(n.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;')))
          out.push(`the SVG does not name the span ${n}`);
      console.log(`  trace: ${names.length} spans drawn, ${svg.length} bytes of SVG`);
      return out;
    },
  },
  {
    name: 'home',
    run: async m => {
      const out: string[] = [];
      const b = await built(m);
      const page = String(b.files.get('index.html'));
      const between = (from: string, to: string): string => {
        const i = page.indexOf(from),
          j = page.indexOf(to, i + from.length);
        if (i < 0 || j < 0) {
          out.push(`the homepage has no ${from} … ${to}`);
          return '';
        }
        return page.slice(i + from.length, j);
      };
      const file = readFileSync(`${ROOT}examples/hello.tape`, 'utf8');

      // the program: the file, as highlight.tape draws it
      const code = between('<pre class="hl" aria-label="examples/hello.tape"><code>', '</code></pre>');
      if (textOf(code) !== file) out.push('the program on the homepage is not examples/hello.tape');
      const hl = compile([
        ...std,
        { name: 'highlight.tape', text: readFileSync(`${ROOT}apps/highlight/highlight.tape`, 'utf8') },
      ]);
      if (!hl.wasm) out.push('highlight.tape does not compile');
      else {
        const drawn = new TextDecoder().decode(
          responseOf(instantiate(new WebAssembly.Module(hl.wasm), {}).handle(new TextEncoder().encode(file))).body,
        );
        if (code !== drawn) out.push('the program on the homepage is not highlighted as highlight.tape draws it');
      }
      const gutter = between('<pre class="gutter" aria-hidden="true">', '</pre>');
      if (gutter.split('\n').filter(Boolean).length !== file.split('\n').length - (file.endsWith('\n') ? 1 : 0))
        out.push('the gutter does not number every line of the program');

      // its two runs: what `node tape.ts` answers, logs and traces
      const cli = tape('examples/hello.tape', 'GET /hello/Ada', 'GET /hello/Ada').out;
      const blocks = cli.split('\n→ ').slice(1);
      const answers = blocks.map(x => /← (\d+) ⏎ (.*)/.exec(x)?.slice(1, 3).join(' ') ?? '?');
      const listed = [
        ...between('<ol class="responses" id="hero-responses">', '</ol>').matchAll(
          /<span class="badge[^"]*">(\d+)<\/span><code class="rb">([^<]*)<\/code>/g,
        ),
      ].map(x => `${x[1]} ${textOf(x[2] ?? '')}`);
      if (answers.length !== 2 || JSON.stringify(listed) !== JSON.stringify(answers))
        out.push(`the homepage lists ${JSON.stringify(listed)}; node tape.ts answers ${JSON.stringify(answers)}`);
      const last = blocks.at(-1) ?? '';
      // the command line logs the statement the database is given (`?1`); the page shows the program's own words.
      // The oracle for the names: the file's query literals read here (a `\` at a line end carries the text on),
      // each `:name` numbered in the order it first appears, as LANGUAGE.md says the compiler numbers them
      const names = [...file.matchAll(/query: "((?:[^"\\]|\\[\s\S])*)"/g)].map(q =>
        (q[1] ?? '').replaceAll(/\\\n\s*/g, ''),
      );
      const named = (sql: string): string => {
        const own = names.find(q => sql.replaceAll(/\?\d+/g, '?').includes(q.replaceAll(/:[A-Za-z_]\w*/g, '?')));
        const order = [...new Set([...(own ?? '').matchAll(/:([A-Za-z_]\w*)/g)].map(x => x[1]))];
        return sql.replaceAll(/\?(\d+)/g, (all, n: string) =>
          order[Number(n) - 1] ? `:${order[Number(n) - 1]}` : all,
        );
      };
      const cliSqls = [...last.matchAll(/^ {4}(sql {5}.*)$/gm)].map(x => named(x[1] ?? ''));
      const pageSqls = [
        ...between('<ul class="log" id="hero-log">', '</ul>').matchAll(
          /<li class="k-sql"><span class="lk">sql<\/span><code class="lq">(.*?)<\/code><span class="lb">(.*?)<span class="lr">([^<]*)<\/span><\/span><\/li>/g,
        ),
      ].map(x => {
        const values = [...(x[2] ?? '').matchAll(/<span class="v">([^<]*)<\/span>/g)].map(v => textOf(v[1] ?? ''));
        return `sql     ${textOf(x[1] ?? '')}  [${values.join(',')}] -> ${textOf(x[3] ?? '')}`;
      });
      if (cliSqls.length === 0 || JSON.stringify(pageSqls) !== JSON.stringify(cliSqls))
        out.push(
          `the effect log on the homepage is not the command line's: ${JSON.stringify(pageSqls)} vs ${JSON.stringify(cliSqls)}`,
        );
      if (pageSqls.some(q => /\?\d/.test(q.split('  [')[0] ?? '')))
        out.push('the effect log on the homepage shows numbered placeholders, not the names the program gave');
      const cliTrace = (last.split('trace, from that log\n')[1] ?? '')
        .split('\n')
        .filter(l => l.trim() !== '')
        .map(l => l.trim().replace(/^([✓✗])\s+(\d+)\s+/, '$1 $2 '));
      const pageTrace = [
        ...between('id="hero-trace">', '</section>').matchAll(
          /<span class="ln">(\d*)<\/span><span class="mk"[^>]*>([^<]*)<\/span><span class="tx">([^<]*)<\/span>/g,
        ),
      ].map(x => (x[2] ? `${x[2]} ${x[1]} ${textOf(x[3] ?? '')}` : textOf(x[3] ?? '')));
      if (cliTrace.length < 4 || JSON.stringify(pageTrace) !== JSON.stringify(cliTrace))
        out.push(
          `the trace on the homepage is not the command line's:\n      ${pageTrace.join('\n      ')}\n    vs\n      ${cliTrace.join('\n      ')}`,
        );
      // each run's arm: the last ✓ line of its trace on the command line; and the moment that says they differ
      const arms = blocks.map(blk => {
        const ok = [...(blk.split('trace, from that log\n')[1] ?? '').matchAll(/✓\s+(\d+)/g)].at(-1)?.[1];
        return ok ? Number(ok) : null;
      });
      const shownArms = [
        ...between('<ol class="responses" id="hero-responses">', '</ol>').matchAll(
          /<span class="arm" data-line="(\d+)"/g,
        ),
      ].map(x => Number(x[1]));
      if (JSON.stringify(shownArms) !== JSON.stringify(arms))
        out.push(
          `the homepage says the runs took lines ${shownArms.join(', ')}; their traces end at ${arms.join(', ')}`,
        );
      const moment = between('<div id="hero-moment">', '</div>');
      const [a1, a2] = arms;
      if (
        a1 !== undefined &&
        a2 !== undefined &&
        a1 !== a2 &&
        !textOf(moment).includes(`#2 took line ${a2}, where #1 took line ${a1}`)
      )
        out.push(`the homepage does not say #2 took line ${a2} where #1 took line ${a1}: ${textOf(moment)}`);
      const bytes = Number(/examples\/hello\.tape: (\d+) bytes of Wasm/.exec(cli)?.[1] ?? 0);
      if (!bytes || !page.includes(`hello.tape is ${(bytes / 1024).toFixed(1)} KB of Wasm`))
        out.push(`the homepage does not say hello.tape is ${bytes} bytes of Wasm`);

      // the refusal: the compiler's, for the file without its repeat: True line
      const cut = file
        .split('\n')
        .filter(l => l.trim() !== 'repeat: True,')
        .join('\n');
      const [d] = compile([...std, { name: 'hello.tape', text: cut }]).errors;
      if (!d) out.push('hello.tape without repeat: True compiles');
      else {
        const shown = between('<div class="refusal">', '</p></div>');
        for (const part of [`hello.tape:${d.line}`, `error[${d.code}]`, d.message, d.hint ?? ''])
          if (!shown.includes(html(part))) out.push(`the refusal on the homepage does not say: ${part.slice(0, 70)}`);
        // its code frame: the line refused, numbered as in the text compiled, and the line that takes the refusal away
        const cutLines = cut.split('\n');
        const at = new RegExp(`<span class="fl at"><span class="fn">\\s*${d.line}</span>([^<]*)</span>`).exec(shown);
        if (!at || textOf(at[1] ?? '') !== cutLines[d.line - 1])
          out.push(`the refusal's code frame does not show line ${d.line} as compiled: ${at?.[1] ?? '(none)'}`);
        // the added line goes after the numbered line just above it in the frame
        const add =
          /<span class="fn">\s*(\d+)<\/span>[^<]*<\/span>(?:<span class="fl caret">.*?<\/span><\/span>)?<span class="fl add"><span class="fn">\s*\+<\/span>([^<]*)<\/span>/.exec(
            shown,
          );
        const after = Number(add?.[1] ?? 0),
          back = textOf(add?.[2] ?? '');
        const fixed = [...cutLines.slice(0, after), back, ...cutLines.slice(after)].join('\n');
        if (back.trim() !== 'repeat: True,' || compile([...std, { name: 'hello.tape', text: fixed }]).errors.length > 0)
          out.push(`the fix the refusal shows does not make the program compile: ${JSON.stringify(back)}`);
        if (!page.includes('<span class="del">-        repeat: True,</span>'))
          out.push('the homepage does not show the line taken out');
      }

      // the waterfalls: SVGs drawn by trace.tape, with as many rows as spans said
      const svgIn = (id: string): string => {
        const inner = between(`id="${id}"`, '</div>').replace(/^[^>]*>/, '');
        return inner.startsWith('<svg') ? inner.slice(0, inner.lastIndexOf('</svg>') + 6) : '';
      };
      const hero = svgIn('hero-spans'),
        ful = svgIn('ful-svg');
      if (!hero.includes('class="otlp-waterfall') || !hero.includes('GET /hello/Ada'))
        out.push('the hero has no waterfall of GET /hello/Ada');
      // trace.tape draws a call and the run it reached as one row, and says in its header how many spans it read
      const rows = (svg: string): number => [...svg.matchAll(/<g class="row\b/g)].length;
      const said = Number(/answered \d+: (\d+) spans across (\d+) programs/.exec(page)?.[1] ?? -1);
      const drawn = Number(/(\d+) spans?\b/.exec(textOf(ful))?.[1] ?? -1);
      if (drawn !== said || said < 6 || rows(ful) < 4 || rows(ful) > said)
        out.push(`the fulfillment waterfall reads ${drawn} spans in ${rows(ful)} rows; its caption says ${said} spans`);
      for (const p of ['inventory', 'payments', 'shipping'])
        if (!ful.includes(p)) out.push(`the fulfillment waterfall does not name ${p}`);
      if (!/<g class="row[^"]*\berr\b/.test(ful)) out.push('the fulfillment waterfall shows no failed span');
      const css = [...b.files].find(([p]) => /^a\/trace\.[0-9a-f]{16}\.css$/.test(p))?.[1];
      if (css === undefined || !String(css).includes('.otlp-waterfall{'))
        out.push("trace.tape's style is not published");

      // the simulator: `node tape.ts sim`'s numbers, on the shop and on the shop with the plant
      const shop = m.data.DATA.examples.find(e => e.id === 'shop');
      const plant = shop?.plant,
        text = shop?.files[0]?.text ?? '';
      const dir = mkdtempSync(join(tmpdir(), 'home-sim-'));
      writeFileSync(join(dir, 'shop.tape'), text);
      const clean = Number(
        /^ok\s+(\d+) runs/m.exec(tape('sim', join(dir, 'shop.tape'), '--seeds', '300').out)?.[1] ?? -1,
      );
      writeFileSync(join(dir, 'shop.tape'), plant ? text.replace(plant.from, plant.to) : text);
      const found = /^FAILED\s+run (\d+), shrunk from (\d+) choices to (\d+)/m.exec(
        tape('sim', join(dir, 'shop.tape'), '--seeds', '300').out,
      );
      if (!page.includes(`section 8 ${clean} times`))
        out.push(`the homepage does not say tape sim ran the shop ${clean} times`);
      if (
        !found ||
        !page.includes(`in run ${found[1]} and shrinks the failure from ${found[2]} choices to ${found[3]}`)
      )
        out.push(`the homepage's simulator numbers are not node tape.ts sim's (${found?.slice(1).join(', ')})`);

      // links: local files, the playground, or the repository; nothing inline that the policy refuses
      for (const [, href = ''] of page.matchAll(/href="([^"]*)"/g)) {
        if (href.startsWith('a/') && b.files.has(href)) continue;
        if (['./', '#main', 'playground/'].includes(href)) continue;
        const ex = /^playground\/#([\w-]+)$/.exec(href)?.[1];
        if (ex && m.data.DATA.examples.some(e => e.id === ex)) continue;
        if (href === REPO) continue;
        // a product: one of apps/products' directories, served under the account `demo`
        const product = /^p\/demo\/([\w-]+)\/$/.exec(href)?.[1];
        if (product && existsSync(`${ROOT}apps/products/${product}/${product}.tape`)) continue;
        const doc = href.startsWith(`${REPO}/blob/main/`) ? href.slice(`${REPO}/blob/main/`.length) : null;
        if (doc && existsSync(`${ROOT}${doc}`)) continue;
        if (doc === 'TERMS.md') continue; // written in the main checkout; not on this branch yet
        out.push(`the homepage links to ${href}, which is not local or in the repository`);
      }
      // the gallery: every program of apps/products (the tree's directories are the oracle), each with its page and
      // its source
      for (const name of readdirSync(`${ROOT}apps/products`, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name))
        for (const href of [`p/demo/${name}/`, `${REPO}/blob/main/apps/products/${name}/${name}.tape`])
          if (!page.includes(`href="${href}"`)) out.push(`the homepage does not link to ${href}`);
      if (
        (page.match(/https?:\/\/[^"\s<]+/g) ?? []).some(u => !u.startsWith(REPO) && !u.startsWith('http://www.w3.org/'))
      )
        out.push(
          `the homepage names another site: ${page.match(/https?:\/\/[^"\s<]+/g)?.find(u => !u.startsWith(REPO) && !u.startsWith('http://www.w3.org/'))}`,
        );
      for (const f of ['index.html', 'playground/index.html']) {
        const p = String(b.files.get(f));
        if (/<style|\sstyle="/.test(p)) out.push(`${f} has inline style, which its policy refuses`);
        for (const [tag] of p.matchAll(/<script\b[^>]*>/g))
          if (!/\ssrc="/.test(tag) && !/type="application\/json"/.test(tag))
            out.push(`${f} has an inline script: ${tag}`);
      }
      if (!/<h1\b/.test(page) || (page.match(/<h1\b/g) ?? []).length !== 1)
        out.push('the homepage has not exactly one h1');
      console.log(
        `  home: ${listed.length} runs, ${pageTrace.length} trace lines, ${said} spans, sim ${clean} runs clean, plant found in run ${found?.[1]}`,
      );
      return out;
    },
  },
];
type m_Run = { program: string; span: string; effects: Effect[]; calls: { run: m_Run | null }[] };

const PLANTS: Plant[] = [
  {
    test: 'sqlite',
    what: 'numbers are bound as sql.js binds them (int32 as INTEGER)',
    file: 'src/sqlite.ts',
    from: "if (typeof params[n - 1] !== 'number') continue;",
    to: 'continue;',
  },
  {
    test: 'sqlite',
    what: 'every database made stays open, past what sql.js can hold',
    file: 'src/sqlite.ts',
    from: 'if (held.size > OPEN_MAX)',
    to: 'if (held.size > Infinity)',
  },
  {
    test: 'otlp',
    what: 'a call is matched to the wrong record (the last, not its own)',
    file: 'src/workbench.ts',
    from: 'return effects.filter(isCall).map((e, i) => ({ e, rec: mine[i] ?? null }));',
    to: 'return effects.filter(isCall).map(e => ({ e, rec: mine.at(-1) ?? null }));',
  },
  {
    test: 'marks',
    what: 'a mark is put one line late',
    file: 'src/editor.ts',
    from: 'ms = byLine.get(line);',
    to: 'ms = byLine.get(line - 1);',
  },
  {
    test: 'build',
    what: 'a name is hashed before its imports are rewritten',
    file: 'build.ts',
    from: 'named.set(m.path, { name: `${stem}.${short(text)}.js`, text });',
    to: 'named.set(m.path, { name: `${stem}.${short(m.text)}.js`, text });',
  },
  {
    test: 'examples',
    what: 'the shop loses its last line break as it is cut from LANGUAGE.md',
    file: 'src/data.ts',
    from: 'const text = sectionProgram(read(f.doc), f.section);',
    to: 'const text = sectionProgram(read(f.doc), f.section)?.trimEnd() ?? null;',
  },
  {
    test: 'home',
    what: 'the second run shown is a different request from the first',
    file: 'artefacts.ts',
    from: 'second = await bench.send(hello.name, requestFor(HERO.name));',
    to: "second = await bench.send(hello.name, requestFor('Bob'));",
  },
  {
    test: 'home',
    what: "the refusal's message is cut short",
    file: 'artefacts.ts',
    from: '    message: d.message,',
    to: '    message: d.message.slice(0, 60),',
  },
  {
    test: 'home',
    what: 'the program is shown without its highlighting',
    file: 'build.ts',
    from: '    hello: a.hello.html,',
    to: '    hello: esc(a.hello.text),',
  },
  {
    test: 'home',
    what: 'the fulfillment caption counts one span fewer than the waterfall draws',
    file: 'build.ts',
    from: '    ful_spans: String(f.spans),',
    to: '    ful_spans: String(f.spans - 1),',
  },
  {
    test: 'home',
    what: "the simulator's run is misreported",
    file: 'build.ts',
    from: '    sim_run: String(a.sim.found.run),',
    to: '    sim_run: String(a.sim.found.run + 1),',
  },
  {
    test: 'home',
    what: 'the repository constant points elsewhere',
    file: 'build.ts',
    from: "export const GITHUB = 'https://github.com/ivarvong/tape';",
    to: "export const GITHUB = 'https://github.com/ivarvong/tap';",
  },
  {
    test: 'home',
    what: "the effect log shown is the first run's, under the second's number",
    file: 'build.ts',
    from: '    log: logView(second.log),',
    to: '    log: logView(a.runs[0]?.log ?? []),',
  },
  {
    test: 'names',
    what: "the effect log loses the program's names for its values (shows ?1)",
    file: 'src/lines.ts',
    from: 'if (!n.names || n.names.length === 0 || n.mixed) continue;',
    to: 'if (!n.names || n.names.length <= 1 || n.mixed) continue;',
  },
  {
    test: 'home',
    what: "a run's arm is read one trace line early",
    file: 'artefacts.ts',
    from: 'arm: armOf(x.root.trace),',
    to: 'arm: armOf(x.root.trace.slice(0, -1)),',
  },
  {
    test: 'home',
    what: 'the moment is drawn from one run, not the last two',
    file: 'build.ts',
    from: '    moment: momentView(a.runs),',
    to: '    moment: momentView(a.runs.slice(-1)),',
  },
  {
    test: 'home',
    what: "the refusal's fix is put back one line early",
    file: 'build.ts',
    from: '{ fix: repeatFix(a.refused, a.hello.text) }',
    to: '{ fix: { after: (repeatFix(a.refused, a.hello.text)?.after ?? 1) - 1, text: repeatFix(a.refused, a.hello.text)?.text ?? "" } }',
  },
  {
    test: 'build',
    what: 'the playground names its files as if it were at the root',
    file: 'build.ts',
    from: '      css: `../${css}`,',
    to: '      css,',
  },
  {
    test: 'simulate',
    what: 'a run that failed is reported as passing',
    file: 'src/simulate.ts',
    from: 'if (result.ok || !first) {',
    to: 'if (result.ok || first) {',
  },
];

async function main(): Promise<void> {
  if (process.argv.includes('--plants')) {
    // --shard i/n: the plants whose index is i modulo n, each caught or not written to
    // proof/results/playground-plants.<i>-of-<n>.json; --merge n: the n shards read back, and the line one run of
    // every plant prints (proof/all.ts runs the shards side by side; each plant is made in its own copy)
    const opt = (name: string): string => {
      const i = process.argv.indexOf(`--${name}`);
      return i < 0 ? '' : (process.argv[i + 1] ?? '');
    };
    const merging = Number(opt('merge') || '0'),
      [shardIndex = 0, shardOf = 1] = /^\d+\/\d+$/.test(opt('shard')) ? opt('shard').split('/').map(Number) : [0, 1];
    const shardFile = (i: number, n: number): string =>
      new URL(`../../proof/results/playground-plants.${i}-of-${n}.json`, import.meta.url).pathname;
    if (merging > 0) {
      const seen = new Map<number, boolean>();
      for (let i = 0; i < merging; i++) {
        const shard: unknown = JSON.parse(readFileSync(shardFile(i, merging), 'utf8'));
        const entries: unknown[] = Array.isArray(shard) ? shard : [];
        for (const e of entries)
          if (typeof e === 'object' && e !== null && 'index' in e && typeof e.index === 'number' && 'caught' in e)
            seen.set(e.index, e.caught === true);
      }
      const missed = PLANTS.filter((_, k) => seen.get(k) !== true).length;
      console.log(missed ? `${missed} plants not caught` : `all ${PLANTS.length} plants caught`);
      process.exit(missed ? 1 : 0);
    }
    let missed = 0;
    const mine: { index: number; caught: boolean }[] = [];
    for (const [index, p] of PLANTS.entries()) {
      if (index % shardOf !== shardIndex) continue;
      // examples.ts is read by data.ts: plant it there by planting data.ts's import of it
      const plant = p;
      let failing: string[] = [];
      try {
        const m = await modules(plant);
        const t = tests.find(x => x.name === p.test);
        const bad = t
          ? await Promise.resolve()
              .then(() => t.run(m))
              .catch((e: unknown) => [`threw: ${e instanceof Error ? e.message : String(e)}`])
          : ['no such test'];
        if (bad.length > 0) failing = [p.test];
      } catch (e) {
        // a plant that cannot be made (its text is gone) is not a plant caught
        console.log(`  plant for "${p.test}" not made: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
        failing = [];
      }
      const caught = failing.length > 0;
      missed += caught ? 0 : 1;
      mine.push({ index, caught });
      console.log(`${caught ? 'caught' : 'MISSED'} plant for "${p.test}": ${p.what}${caught ? '' : ''}`);
    }
    if (shardOf > 1) {
      mkdirSync(dirname(shardFile(shardIndex, shardOf)), { recursive: true });
      writeFileSync(shardFile(shardIndex, shardOf), `${JSON.stringify(mine)}\n`);
      console.log(`shard ${shardIndex} of ${shardOf}: ${mine.length} plants, ${missed} not caught`);
      process.exit(missed ? 1 : 0);
    }
    console.log(missed ? `${missed} plants not caught` : `all ${PLANTS.length} plants caught`);
    process.exit(missed ? 1 : 0);
  }
  const m = await modules(null);
  let failed = 0;
  for (const t of tests) {
    const bad = await Promise.resolve()
      .then(() => t.run(m))
      .catch((e: unknown) => [`threw: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`]);
    failed += bad.length > 0 ? 1 : 0;
    console.log(`${bad.length > 0 ? 'FAIL' : 'ok  '} ${t.name}${bad.length > 0 ? `: ${bad.length} problems` : ''}`);
    for (const b of bad.slice(0, 8)) console.log(`    ${b}`);
  }
  console.log(failed ? `${failed} of ${tests.length} tests failed` : `all ${tests.length} tests pass`);
  process.exit(failed ? 1 : 0);
}
await main();
