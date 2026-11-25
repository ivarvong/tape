// bench/blog.ts: the renderer and the blog, held to a record. corpus/md.tape renders corpus/blog.md; the blog is
// corpus/blog.tape compiled before it. A name is the first file's (LANGUAGE.md §4), so the blog's handle is the
// entry and the renderer's is md.handle. One database: a PUT (it renders into the cache), the cached page GET,
// that GET again, GET /posts/sunset/body (the cached article HTML, the same bytes as POST /render), the index and
// the feed. Steps are the module's cost, exactly, and bytes are the arena (heap minus its floor) within 2%, the
// same band as bench/sizes.json: an exact byte pin fails when a later change adds a custom section or a few
// bytes of code (a content type, scan, form_field) without the blog doing anything different. The record's
// step_version is the accounting those step counts were measured with.
// Both are as the host records them, with the effect log on; the log off must come out the same. The clock is
// pinned to 2026-11-24T12:00:00.000Z, so the record's etags and bytes are one run's. The feed formats it with
// std's civil, which loops over nothing; before 25 November 2026 it walked years from 1970, and an unpinned run
// changed steps on New Year's Day. bench/blog.json is that record. The same Wasm bytes are in bench/sizes.json, so
// a change that moves a module is recorded twice: here, and `node test/wasm-size.ts --write`. The feed is
// `respond_as(content: Atom)`, application/atom+xml.
//   node bench/blog.ts           compare
//   node bench/blog.ts --write   record
import '../node25.ts';
import { readFileSync, writeFileSync } from 'node:fs';
import { compile } from '../compiler.ts';
import { STEP_VERSION } from '../compiler/step-version.ts';
import { instantiate, responseOf } from '../host.ts';
import type { Answer } from '../host.ts';
import { nodeSql } from '../nodesql.ts';
import type { NodeSql } from '../nodesql.ts';
import { std } from '../std.ts';
import { functionsOf } from './suite/wasm.ts';
import {
  NOW,
  TITLE,
  bodyRequest,
  feedRequest,
  getRequest,
  getIf,
  indexRequest,
  missingRequest,
  pageRequest,
  putDated,
  putRequest,
  putTitled,
  renderRequest,
} from './suite/blog.ts';
import { finish, same } from '../test/harness.ts';

const root = new URL('../', import.meta.url).pathname;
const RECORD = `${root}bench/blog.json`;
const INSTANT = '2026-11-24T12:00:00.000Z';
const HTML = 'text/html; charset=utf-8';
const JSON_TYPE = 'application/json';
const ATOM = 'application/atom+xml; charset=utf-8';
type Count = { steps: number; bytes: number };
type Wasm = { bytes: number; functions: number };
type Recorded = {
  now: string;
  /** the step accounting the counts below were measured with */
  step_version: number;
  md: Wasm;
  blog: Wasm;
  render: Count;
  put: Count;
  get: Count;
  body: Count;
  index: Count;
  feed: Count;
};
type App = ReturnType<typeof instantiate>;
type Ran = { answer: Answer; count: Count };

function compileOf(files: readonly string[]): Uint8Array {
  const r = compile([
    ...std,
    ...files.map(f => ({ name: f.slice(f.lastIndexOf('/') + 1), text: readFileSync(root + f, 'utf8') })),
  ]);
  if (r.wasm) return r.wasm;
  throw new Error(r.errors.map(e => `${e.line} ${e.code} ${e.message}`).join('; '));
}

function header(answer: Answer, name: string): string {
  const found = answer.headers.find(h => h.name === name);
  return found === undefined ? '' : found.value;
}
const quoted = (etag: string): boolean => etag.startsWith('"') && etag.endsWith('"') && etag.includes(':');

function stepsOf(app: App): number {
  const cost = app.exports['cost'];
  const steps = cost instanceof WebAssembly.Global ? Number(cost.value) : Number.NaN;
  if (!Number.isFinite(steps)) throw new TypeError('the module exports no cost');
  return steps;
}

async function ask(app: App, db: NodeSql | null, req: Uint8Array, log: boolean): Promise<Ran> {
  const out = log
    ? await app.run(req, db ? { transaction: f => db.transaction(f) } : {})
    : db
      ? app.handleIn(f => db.transaction(f), req)
      : app.handle(req);
  return { answer: responseOf(out), count: { steps: stepsOf(app), bytes: app.bytesUsed } };
}

async function behavior(wasm: Uint8Array): Promise<void> {
  const db = nodeSql();
  const app = instantiate(new WebAssembly.Module(wasm), { sql: db, name: 'blog', log: false });
  let clock = NOW;
  const pinned = Date.now;
  Date.now = () => clock;
  try {
    const huge = await ask(app, db, pageRequest('9223372036854775807'), false);
    same('a page past an Int is a 400', huge.answer.status, 400);
    const signed = await ask(app, db, putDated(9, '2026-+2-03'), false);
    same('a signed date is a 400', signed.answer.status, 400);
    const missing = await ask(app, db, missingRequest(), false);
    same('a missing page quotes its etag', header(missing.answer, 'etag'), '"missing"');
    const created = await ask(app, db, putTitled(1, TITLE, '\rtape-base: https://tape.example/p/me/blog'), false);
    same(
      'location follows tape-base',
      [created.answer.status, header(created.answer, 'location')],
      [201, 'https://tape.example/p/me/blog/posts/sunset'],
    );
    const page = await ask(app, db, getRequest(), false);
    const tag = header(page.answer, 'etag');
    clock = NOW + 1000;
    const edited = await ask(app, db, putTitled(2, 'A Later Title'), false);
    same('a title edit is a write', edited.answer.status, 200);
    const stale = await ask(app, db, getIf(tag), false);
    same(
      'a title edit is not a 304',
      [stale.answer.status, text(stale.answer.body).includes('A Later Title')],
      [200, true],
    );
    const next = header(stale.answer, 'etag');
    const hit = await ask(app, db, getIf(next), false);
    const weak = await ask(app, db, getIf(`W/${next}`), false);
    const list = await ask(app, db, getIf(`"nope", ${next}`), false);
    const star = await ask(app, db, getIf('*'), false);
    same(
      'the new etag, a weak tag, a list and a star are 304s',
      [next !== tag, hit.answer.status, weak.answer.status, list.answer.status, star.answer.status],
      [true, 304, 304, 304, 304],
    );
  } finally {
    Date.now = pinned;
  }
}

async function blogOf(wasm: Uint8Array, log: boolean) {
  const db = nodeSql();
  const app = instantiate(new WebAssembly.Module(wasm), { sql: db, name: 'blog', log });
  return {
    put: await ask(app, db, putRequest(0), log),
    get: await ask(app, db, getRequest(), log),
    again: await ask(app, db, getRequest(), log),
    body: await ask(app, db, bodyRequest(), log),
    index: await ask(app, db, indexRequest(), log),
    feed: await ask(app, db, feedRequest(), log),
  };
}

const mdWasm = compileOf(['corpus/md.tape']);
const blogWasm = compileOf(['corpus/blog.tape', 'corpus/md.tape']);
Date.now = () => NOW;
const mdOn = instantiate(new WebAssembly.Module(mdWasm), { name: 'md', log: true });
const mdOff = instantiate(new WebAssembly.Module(mdWasm), { name: 'md', log: false });
const render = await ask(mdOn, null, renderRequest(), true);
const renderOff = await ask(mdOff, null, renderRequest(), false);
const on = await blogOf(blogWasm, true);
const off = await blogOf(blogWasm, false);

const text = (b: Uint8Array): string => new TextDecoder().decode(b);
function mismatch(a: Uint8Array, b: Uint8Array): string {
  if (a.length !== b.length) return `${a.length} bytes != ${b.length}`;
  const i = a.findIndex((x, n) => x !== b[n]);
  return i < 0 ? 'equal' : `byte ${i}`;
}
const home = text(on.index.answer.body);
const atom = text(on.feed.answer.body);
const pageTag = header(on.get.answer, 'etag');
const counts = (renderCount: Count, part: Awaited<ReturnType<typeof blogOf>>): Record<string, Count> => ({
  render: renderCount,
  put: part.put.count,
  get: part.get.count,
  body: part.body.count,
  index: part.index.count,
  feed: part.feed.count,
});

same(
  'both modules are modules WebAssembly validates',
  [WebAssembly.validate(mdWasm), WebAssembly.validate(blogWasm)],
  [true, true],
);
same('the blog module is the server plus the renderer', blogWasm.length > mdWasm.length + 20_000, true);
same('the clock is pinned', new Date(NOW).toISOString(), INSTANT);
same('POST /render', [render.answer.status, render.answer.type], [200, HTML]);
same(
  'PUT /posts/sunset',
  [on.put.answer.status, on.put.answer.type, header(on.put.answer, 'location')],
  [201, JSON_TYPE, '/posts/sunset'],
);
same(
  'GET /posts/sunset',
  [on.get.answer.status, on.get.answer.type, text(on.get.answer.body).includes(TITLE), quoted(pageTag)],
  [200, HTML, true, true],
);
same('GET /body and POST /render', mismatch(on.body.answer.body, render.answer.body), 'equal');
same('GET /', [on.index.answer.status, home.includes(TITLE), home.includes('1 post, page ')], [200, true, true]);
same(
  'GET /feed.xml',
  [
    on.feed.answer.status,
    on.feed.answer.type,
    atom.includes('<feed'),
    atom.includes(TITLE),
    atom.includes('href="posts/sunset"'),
  ],
  [200, ATOM, true, true, true],
);
same('the second GET is the same cached read', on.again.count, on.get.count);
same('the cached GET is under a tenth of the PUT', on.get.count.steps * 10 < on.put.count.steps, true);
same('log off matches log on', counts(renderOff.count, off), counts(render.count, on));
await behavior(blogWasm);

const got: Recorded = {
  now: INSTANT,
  step_version: STEP_VERSION,
  md: { bytes: mdWasm.length, functions: functionsOf(mdWasm) },
  blog: { bytes: blogWasm.length, functions: functionsOf(blogWasm) },
  render: render.count,
  put: on.put.count,
  get: on.get.count,
  body: on.body.count,
  index: on.index.count,
  feed: on.feed.count,
};
const show = (label: string, c: Count): string => `${label} ${c.steps} steps, ${c.bytes} bytes`;
console.log(
  [
    `md ${got.md.bytes} bytes, ${got.md.functions} functions`,
    `blog ${got.blog.bytes} bytes, ${got.blog.functions} functions`,
    show('render', got.render),
    show('put', got.put),
    show('get', got.get),
    show('body', got.body),
    show('index', got.index),
    show('feed', got.feed),
  ].join('; '),
);

const isNum = (v: object, k: string): boolean => typeof Reflect.get(v, k) === 'number';
const isCount = (v: unknown): v is Count =>
  typeof v === 'object' && v !== null && isNum(v, 'steps') && isNum(v, 'bytes');
const isWasm = (v: unknown): v is Wasm =>
  typeof v === 'object' && v !== null && isNum(v, 'bytes') && isNum(v, 'functions');
const isRecord = (v: unknown): v is Recorded =>
  typeof v === 'object' &&
  v !== null &&
  typeof Reflect.get(v, 'now') === 'string' &&
  typeof Reflect.get(v, 'step_version') === 'number' &&
  isWasm(Reflect.get(v, 'md')) &&
  isWasm(Reflect.get(v, 'blog')) &&
  isCount(Reflect.get(v, 'render')) &&
  isCount(Reflect.get(v, 'put')) &&
  isCount(Reflect.get(v, 'get')) &&
  isCount(Reflect.get(v, 'body')) &&
  isCount(Reflect.get(v, 'index')) &&
  isCount(Reflect.get(v, 'feed'));

const sound =
  render.answer.status === 200 &&
  on.put.answer.status === 201 &&
  on.get.answer.status === 200 &&
  on.index.answer.status === 200 &&
  on.feed.answer.status === 200 &&
  mismatch(on.body.answer.body, render.answer.body) === 'equal' &&
  on.again.count.steps === on.get.count.steps &&
  on.get.count.steps * 10 < on.put.count.steps;

if (process.argv.includes('--write')) {
  if (sound) {
    writeFileSync(RECORD, `${JSON.stringify(got, null, 2)}\n`);
    console.log(`wrote ${RECORD}`);
  } else console.log('not written');
} else {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(readFileSync(RECORD, 'utf8'));
  } catch {
    parsed = null;
  }
  const was = isRecord(parsed) ? parsed : null;
  // steps are the accounting; bytes move when the module does, and 2% is the size gate's band
  const bytesOff = (label: string, gotN: number, wasN: number): string[] =>
    Math.abs(gotN - wasN) <= 0.02 * wasN ? [] : [`${label} ${wasN} -> ${gotN} bytes`];
  const countOff = (label: string, gotC: Count, wasC: Count): string[] => [
    ...(gotC.steps === wasC.steps ? [] : [`${label} ${wasC.steps} -> ${gotC.steps} steps`]),
    ...bytesOff(label, gotC.bytes, wasC.bytes),
  ];
  const wasmOff = (label: string, gotW: Wasm, wasW: Wasm): string[] => [
    ...(gotW.functions === wasW.functions ? [] : [`${label} ${wasW.functions} -> ${gotW.functions} functions`]),
    ...bytesOff(label, gotW.bytes, wasW.bytes),
  ];
  const drift = was
    ? [
        ...(got.now === was.now ? [] : [`now ${was.now} -> ${got.now}`]),
        ...(got.step_version === was.step_version
          ? []
          : [`step_version ${String(was.step_version)} -> ${got.step_version}`]),
        ...wasmOff('md', got.md, was.md),
        ...wasmOff('blog', got.blog, was.blog),
        ...countOff('render', got.render, was.render),
        ...countOff('put', got.put, was.put),
        ...countOff('get', got.get, was.get),
        ...countOff('body', got.body, was.body),
        ...countOff('index', got.index, was.index),
        ...countOff('feed', got.feed, was.feed),
      ]
    : ['no record'];
  same('the record matches (node bench/blog.ts --write to record)', drift, []);
}

finish();
