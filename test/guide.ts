// docs/guide.md's quickstart against the compiler and the hosted runner's code: the program (the ```tape orders.tape
// block) compiles with the rules on and is in fmt's layout, and the `run` call of the ```json orders.tape block, made
// through mcp/src/runner.ts (what the hosted `run` tool runs, with its `remotes` if it has any), answers each request with the status
// and body of the ```text orders.tape block, as application/json (an error as application/problem+json). The answers in the guide were written from what the
// section says the service does, not copied from a run.
import '../node25.ts';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from '../compiler.ts';
import { format } from '../fmt.ts';
import { runAll, startSqlite } from '../mcp/src/runner.ts';
import type { SqlJsInit } from '../mcp/src/runner.ts';
import { answered, finish, ok, raw, std } from './harness.ts';

const guide = raw('docs/guide.md');
const block = (lang: string): string | null =>
  new RegExp(`^\`\`\`${lang} orders\\.tape\\n([\\s\\S]*?)^\`\`\`$`, 'm').exec(guide)?.[1] ?? null;
const program = block('tape') ?? '';
const call = block('json') ?? '';
const answers = block('text') ?? '';
ok('the guide has the program, its run call and its answers', program !== '' && call !== '' && answers !== '');

const build = (text: string) => compile([...std, { name: 'orders.tape', text }]);
const built = build(program);
ok(
  'the program compiles, with the rules on',
  built.wasm !== null,
  built.errors.map(e => `${e.code}:${e.line} ${e.message}`).join('; '),
);
ok("the program is in fmt's layout", format(program) === program);

// the section says that without the UNIQUE key and ON CONFLICT, the compiler refuses the INSERT (C55)
const unkeyed = program
  .replace('key TEXT NOT NULL UNIQUE,', 'key TEXT NOT NULL,')
  .replace(' ON CONFLICT(key) \\\n        DO NOTHING"', '"');
ok(
  'the INSERT without a UNIQUE key and ON CONFLICT is refused with C55, as the section says',
  unkeyed !== program && build(unkeyed).errors.some(e => e.code === 'C55'),
  build(unkeyed)
    .errors.map(e => e.code)
    .join(','),
);

type Fields = Record<string, unknown>;
const isFields = (v: unknown): v is Fields => typeof v === 'object' && v !== null && !Array.isArray(v);
const args: unknown = JSON.parse(call.replace('"…the program above…"', '""'));
const requests = isFields(args) && Array.isArray(args['requests']) ? args['requests'].map(String) : [];
const remotes = isFields(args) && isFields(args['remotes']) ? args['remotes'] : {};
const wanted = answers.replace(/\n$/, '').split('\n');
ok('one answer for each request, at least 8', requests.length === wanted.length && requests.length >= 8);

if (built.wasm) {
  // sql.js, as the hosted runner has it (a CommonJS script: loaded from a .cjs copy)
  const vendor = new URL('../apps/playground/vendor/sql.js-1.10.3/', import.meta.url).pathname;
  const cjs = join(mkdtempSync(join(tmpdir(), 'sqljs-')), 'sql-wasm.cjs');
  writeFileSync(cjs, readFileSync(`${vendor}sql-wasm.js`));
  const init: unknown = createRequire(import.meta.url)(cjs);
  const isInit = (f: unknown): f is SqlJsInit => typeof f === 'function';
  if (!isInit(init)) throw new Error("sql-wasm.js's export is not sql.js's init function");
  await startSqlite(init, new WebAssembly.Module(readFileSync(`${vendor}sql-wasm.wasm`)));
  const scripts: Record<string, Record<string, unknown[]>> = {};
  for (const [to, methods] of Object.entries(remotes))
    if (isFields(methods))
      scripts[to] = Object.fromEntries(Object.entries(methods).map(([m, l]) => [m, Array.isArray(l) ? l : []]));
  const ran = await runAll(new WebAssembly.Module(built.wasm), requests, null, scripts);
  const runs = ran.ok ? ran.runs : [];
  ok('the run call runs', ran.ok, ran.ok ? '' : ran.error);
  requests.forEach((request, i) => {
    const r = runs[i],
      [status, ...rest] = (wanted[i] ?? '').split(' ');
    const body = r?.out ? answered(r.out) : '';
    const head = body.slice(0, body.indexOf('\n')),
      got = body.slice(body.indexOf('\n') + 1);
    ok(
      `${request.replace('\n', ' ')} answers ${wanted[i] ?? ''}`,
      head === `${status ?? ''} application/${Number(status) >= 400 ? 'problem+json' : 'json'}` &&
        got === rest.join(' '),
      `got ${head} ${got}`,
    );
  });
}
finish();
