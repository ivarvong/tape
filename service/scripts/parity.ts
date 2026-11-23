// parity.ts: the playground and the hosted compiler (mcp/src, at /mcp) run the same compiler. Both embed it, and a
// deploy (scripts/lockstep.sh) ships both from one commit; this checks the deployed pair.
//   node scripts/parity.ts <base-url> [--pin <version-id>] [--sha <commit>] [--compilers-only]
// 1. The homepage (the tape Worker, pinned with --pin) and /mcp (on the same Worker and version) name
//    the same commit (tape-version, = --sha when given) and the same compiler (tape-compiler: the hash of compiler.ts,
//    compiler/ and std/, scripts/sha.ts).
// 2. The playground's own build, as the site serves it (its compiler and std modules, fetched and imported here),
//    and the MCP compile tool agree on examples/hello.tape and on it without `repeat: True,`: the same diagnostics
//    (code and line) and the same Wasm size.
// --compilers-only: 2 alone (a tape-mcp from before the tape-compiler header). Exits 1 if any check fails.
import '../../node25.ts';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const base = (args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')) ?? '').replace(/\/$/, '');
const opt = (name: string): string | null => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? null : (args[i + 1] ?? null);
};
const pin = opt('pin'),
  sha = opt('sha'),
  compilersOnly = args.includes('--compilers-only');
if (!/^https?:\/\//.test(base) || (pin !== null && !/^[0-9a-f-]{36}$/.test(pin))) {
  console.error('usage: node scripts/parity.ts <base-url> [--pin <version-id>] [--sha <commit>]');
  process.exit(2);
}
const HELLO = readFileSync(new URL('../../examples/hello.tape', import.meta.url), 'utf8');
const WITHOUT = HELLO.replace(/^\s*repeat: True,\n/m, '');
// arithmetic, whose code the compiler's Int rules decide (0.2: exact or a trap)
const FACT =
  'fn fact(n: Int) -> Int {\n  match {\n    n <= 1 -> 1\n    else -> n * fact(n: n - 1)\n  }\n}\n\nfn handle(raw: View) -> Buf {\n  let Request(path) = request(raw)\n  respond(status: 200) |> append(view: "\\(fact(n: len(path)))")\n}\n';

let failed = 0,
  passed = 0;
const check = (ok: boolean, what: string): void => {
  if (ok) passed++;
  else {
    failed++;
    console.log(`  FAIL ${what}`);
  }
};
type J = Record<string, unknown>;
const obj = (v: unknown): J => (typeof v === 'object' && v !== null && !Array.isArray(v) ? { ...v } : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : (JSON.stringify(v) ?? 'undefined'));
const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
  'x-tape-synthetic': 'deploy-parity',
  ...(pin === null ? {} : { 'cloudflare-workers-version-overrides': `tape="${pin}"` }),
  ...extra,
});
const get = (path: string): Promise<Response> => fetch(`${base}${path}`, { headers: headers() });

// ---- 1. the same commit and compiler
const home = await get('/');
await home.arrayBuffer();
const mcpPost = async (body: unknown): Promise<{ r: Response; j: J }> => {
  const r = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: headers({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
  return { r, j: obj(await r.json()) };
};
const init = await mcpPost({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'tape-parity', version: '1' } },
});
const said = (r: Response, h: string): string => r.headers.get(h) ?? '';
check(init.r.status === 200, `/mcp initialize: ${init.r.status}`);
for (const h of compilersOnly ? [] : ['tape-version', 'tape-compiler']) {
  check(said(home, h) !== '', `the homepage has no ${h}`);
  check(
    said(init.r, h) === said(home, h),
    `${h}: the homepage ${said(home, h) || '-'}, /mcp ${said(init.r, h) || '-'}`,
  );
}
if (sha !== null) check(said(home, 'tape-version') === sha, `tape-version ${said(home, 'tape-version')}, not ${sha}`);
console.log(
  `  versions: tape ${said(home, 'tape-version')} / ${said(home, 'tape-compiler')}, mcp ${said(init.r, 'tape-version')} / ${said(init.r, 'tape-compiler')}`,
);

// ---- 2. the playground's build compiles as the hosted compiler does
/** Every hashed module the playground loads, followed through its imports. */
async function modules(): Promise<Map<string, string>> {
  const page = await (await get('/playground/')).text();
  const todo = [...page.matchAll(/(?:href|src)="(?:\.\.\/)?a\/([^"]+\.js)"/g)].map(m => m[1] ?? '');
  const got = new Map<string, string>();
  while (todo.length > 0) {
    const name = todo.pop() ?? '';
    if (name === '' || got.has(name)) continue;
    const r = await get(`/a/${name}`);
    check(r.ok, `/a/${name}: ${r.status}`);
    const text = await r.text();
    got.set(name, text);
    for (const m of text.matchAll(/(?:from\s*|import\s*\(\s*|new URL\(\s*)['"]\.\/([^'"]+\.js)['"]/g))
      todo.push(m[1] ?? '');
  }
  return got;
}
const mods = await modules();
const dir = mkdtempSync(join(tmpdir(), 'tape-parity-'));
for (const [name, text] of mods) writeFileSync(join(dir, name), text);
const named = (stem: string): string =>
  [...mods.keys()].find(n => new RegExp(`^${stem}\\.[0-9a-f]{16}\\.js$`).test(n)) ?? '';
check(
  named('compiler') !== '' && named('std') !== '',
  `the playground loads no compiler or std module (${mods.size} modules)`,
);
const compilerM: unknown = await import(pathToFileURL(join(dir, named('compiler'))).href);
const stdM: unknown = await import(pathToFileURL(join(dir, named('std'))).href);
const compile = obj(compilerM)['compile'],
  std = arr(obj(stdM)['std']);
if (typeof compile !== 'function') throw new TypeError('the playground compiler module exports no compile');
const page = (text: string): { codes: string; bytes: number | null } => {
  const r = obj(Reflect.apply(compile, undefined, [[...std, { name: 'hello.tape', text }]]));
  const errors = arr(r['errors']).map(obj);
  const wasm = r['wasm'];
  return {
    codes: errors.map(e => `${str(e['code'])}@${str(e['line'])}`).join(','),
    bytes: wasm instanceof Uint8Array ? wasm.length : null,
  };
};
let id = 1;
const hosted = async (text: string): Promise<{ codes: string; bytes: number | null }> => {
  const { j } = await mcpPost({
    jsonrpc: '2.0',
    id: ++id,
    method: 'tools/call',
    params: { name: 'compile', arguments: { files: [{ name: 'hello.tape', text }] } },
  });
  const out = obj(obj(j['result'])['structuredContent']);
  const bytes = out['wasm_bytes'];
  return {
    codes: arr(out['diagnostics'])
      .map(obj)
      .map(d => `${str(d['code'])}@${str(d['line'])}`)
      .join(','),
    bytes: typeof bytes === 'number' ? bytes : null,
  };
};
for (const [what, text] of [
  ['hello.tape', HELLO],
  ['hello.tape without repeat', WITHOUT],
  ['a factorial', FACT],
] as const) {
  const a = page(text),
    b = await hosted(text);
  check(a.codes === b.codes, `${what}: the playground says ${a.codes || 'ok'}, /mcp ${b.codes || 'ok'}`);
  check(a.bytes === b.bytes, `${what}: the playground's Wasm is ${a.bytes} bytes, /mcp's ${b.bytes}`);
  console.log(`  ${what}: ${a.codes || 'ok'}, ${a.bytes ?? '-'} bytes (both)`);
}
check(page(WITHOUT).codes.startsWith('C54@'), 'hello.tape without repeat is not C54');
console.log(
  failed === 0 ? `parity ok: ${passed} checks` : `FAIL parity: ${failed} of ${passed + failed} checks failed`,
);
process.exit(failed === 0 ? 0 : 1);
