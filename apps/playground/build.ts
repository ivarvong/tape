// apps/playground/build.ts: the playground as static files, every one but the page named by its content.
//   node apps/playground/build.ts [out]        writes out/ (default apps/playground/dist): index.html, _headers, a/*
//
// No bundler and no dependencies. Each module the page reaches (its own src/, and the repository's compiler, host,
// simulator, formatter and the service's OTLP view) is read, its TypeScript types are stripped (node:module's
// stripTypeScriptTypes: the code is erasable TypeScript), and its imports are rewritten to the names of the files
// they become, `<name>.<hash>.js`, where the hash is of the rewritten text. The graph has no cycles (checked), so
// the files are written leaves first and a change anywhere renames the files that import it, up to the page:
// every file under a/ can be cached for ever (`immutable`), and only index.html is fetched again.
//
// Four modules of the tree are Node's, and the page is given its own in their place: nodesql.ts (node:sqlite) is
// src/sqlite.ts (sql.js), std.ts (node:fs) is the standard library's texts as a constant, src/data.ts is the
// examples as a constant, node25.ts (a version check) is nothing, and node:fs (fmt.ts reads files for the CLI) is a
// stub that throws. Any other node: import is an error. Nothing the page loads comes from anywhere but its own origin.
import '../../node25.ts';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { basename, dirname, relative, resolve } from 'node:path';
import { std } from '../../std.ts';
import { artefacts } from './artefacts.ts';
import type { Artefacts } from './artefacts.ts';
import { readData } from './src/data.ts';
import { logView, momentView, refusalView, repeatFix, responsesView, traceView } from './src/hero.ts';

export const ROOT = resolve(new URL('../../', import.meta.url).pathname);
const HERE = resolve(ROOT, 'apps/playground');
const VENDOR = resolve(HERE, 'vendor/sql.js-1.10.3');
// sql-wasm.js: the SRI hash cdnjs publishes for it; sql-wasm.wasm: the hash of the file cdnjs served (22 Nov 2026)
const PINNED: Record<string, string> = {
  'sql-wasm.js': 'sha512-+6Q7hv5pGUBXOuHWw8OdQx3ac7DzM3oJhYqz7SHDku0yl9EBdMqegoPed4GsHRoNF/VQYK2LTYewAIEBrEf/3w==',
  'sql-wasm.wasm': 'sha512-CJH7qneqrGY0mG25MkTl5ngjoTBv3m1bJXG0OVXK/kAe2n+IZdDtdqfgbspy+ozOSjA9g8bzCkcwpcZE9jcTZA==',
};

/** An import or re-export with a source, or a bare `import '…'`, at the start of a line (as every one here is). */
export const IMPORT =
  /^([ \t]*(?:import|export)[ \t]+(?:type[ \t]+)?(?:[\w$]+[ \t]*,[ \t]*)?(?:\{[^}]*\}|\*(?:[ \t]+as[ \t]+[\w$]+)?|[\w$]+)[ \t]+from[ \t]+|[ \t]*import[ \t]+)(['"])([^'"\n]+)\2/gm;

export const sri = (bytes: Uint8Array | string): string =>
  `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
const short = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex').slice(0, 16);

type Module = { path: string; text: string; deps: { spec: string; to: string }[] };
export type Built = {
  /** published path -> contents */
  files: Map<string, Uint8Array | string>;
  /** the page's entry, worker and the modules (published paths), for reporting */
  entry: string;
  worker: string;
  home: string;
  modules: number;
  bytes: number;
};

/** What a page module is given in place of a module of the tree, by path. */
export function replacements(): Record<string, string> {
  const data = readData();
  return {
    [resolve(ROOT, 'node25.ts')]: '// node25.ts checks the Node version; the page has none to check\nexport {};\n',
    [resolve(ROOT, 'std.ts')]:
      `// std.ts, for the page: the standard library's files, as the compiler takes them\nexport const std = ${JSON.stringify(std)};\n`,
    // the highlighter and the trace renderer reach the page compiled (a/highlight.*.wasm, a/trace.*.wasm), not as text
    [resolve(HERE, 'src/data.ts')]:
      `// data.ts, for the page: the examples, read at build time\nexport const DATA = ${JSON.stringify({ ...data, highlight: '', trace: null })};\n`,
    'node:fs':
      "// node:fs, for the page: fmt.ts imports readFileSync for the command line's sake\nexport const readFileSync = () => {\n  throw new Error('there are no files in the page');\n};\n",
    // sql.js is a script, not a module: it sets `module = undefined` (an undeclared name, an error in a module's
    // strict mode), so the name is declared here; and its loader is exported
    [resolve(VENDOR, 'sql-wasm.js')]:
      `// sql.js 1.10.3, as a module\nvar module;\n${readFileSync(resolve(VENDOR, 'sql-wasm.js'), 'utf8')}\nexport default initSqlJs;\n`,
  };
}

const ALIAS: Record<string, string> = { [resolve(ROOT, 'nodesql.ts')]: resolve(HERE, 'src/sqlite.ts') };

/** Every module the entries reach, read and stripped, with where each import goes. */
export function graph(
  entries: readonly string[],
  virtual: Readonly<Record<string, string>> = replacements(),
): Map<string, Module> {
  const mods = new Map<string, Module>();
  const visit = (path: string): void => {
    if (mods.has(path)) return;
    const own = virtual[path] ?? null;
    if (own === null && path.startsWith('node:')) throw new Error(`a page module imports ${path}, which no page has`);
    const source = own ?? readFileSync(path, 'utf8');
    const base = path;
    const text = path.endsWith('.ts') ? stripTypeScriptTypes(source, { mode: 'strip' }) : source;
    if (/\bimport\s*\(/.test(text.replaceAll(/\/\/.*$/gm, '').replaceAll(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g, '')))
      throw new Error(`${relative(ROOT, path)} has a dynamic import, which the build does not follow`);
    const deps = [...text.matchAll(IMPORT)].map(m => {
      const spec = m[3] ?? '';
      const to = spec.startsWith('.') ? resolve(dirname(base), spec) : spec;
      // one module, not two copies: the simulator's nodesql.ts and the page's sqlite.ts must share the SQLite they load
      return { spec, to: ALIAS[to] ?? to };
    });
    mods.set(path, { path, text, deps });
    for (const d of deps) visit(d.to);
  };
  for (const e of entries) visit(e);
  return mods;
}

/** Modules leaves first; throws on a cycle (a hash of a module would then depend on itself). */
export function order(mods: ReadonlyMap<string, Module>): Module[] {
  const done = new Set<string>(),
    open = new Set<string>(),
    out: Module[] = [];
  const visit = (p: string, path: string[]): void => {
    if (done.has(p)) return;
    if (open.has(p)) throw new Error(`import cycle: ${[...path, p].map(x => relative(ROOT, x)).join(' -> ')}`);
    open.add(p);
    const m = mods.get(p);
    if (!m) throw new Error(`no module ${p}`);
    for (const d of m.deps) visit(d.to, [...path, p]);
    open.delete(p);
    done.add(p);
    out.push(m);
  };
  for (const p of mods.keys()) visit(p, []);
  return out;
}

/** A module's published name: its own name and the hash of its text with its imports rewritten. */
function emit(mods: Module[]): Map<string, { name: string; text: string }> {
  const named = new Map<string, { name: string; text: string }>();
  for (const m of mods) {
    const text = m.text.replaceAll(IMPORT, (_all, lead: string, q: string, spec: string) => {
      const dep = m.deps.find(d => d.spec === spec),
        to = dep ? named.get(dep.to) : undefined;
      if (!to) throw new Error(`${relative(ROOT, m.path)}: import ${spec} not resolved`);
      return `${lead}${q}./${to.name}${q}`;
    });
    const stem = m.path.startsWith('node:') ? m.path.slice(5) : basename(m.path).replace(/\.(ts|js)$/, '');
    named.set(m.path, { name: `${stem}.${short(text)}.js`, text });
  }
  return named;
}

const csp = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self'",
  "style-src 'self'",
  "img-src 'self' blob: data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');
// frame-ancestors only counts in a header (a <meta> policy may not hold it)
const cspHeader = `${csp}; frame-ancestors 'none'`;

/** The repository, where the homepage's links to the language, the status, the terms and the source go. */
export const GITHUB = 'https://github.com/ivarvong/tape';

/** Every `{{name}}` in a page's text, given; a name not given, or given and not there, is an error. */
export function fill(page: string, values: Readonly<Record<string, string>>, file: string): string {
  for (const k of Object.keys(values)) if (!page.includes(`{{${k}}}`)) throw new Error(`${file} has no {{${k}}}`);
  // a function, not a string: a replacement text with `$&` in it (an SVG, a program) is put in as it is
  const out = page.replaceAll(/\{\{(\w+)\}\}/g, (all, k: string) => {
    const v = values[k];
    if (v === undefined) throw new Error(`${file} has a placeholder left: ${all}`);
    return v;
  });
  return out;
}

const esc = (s: string): string =>
  s.replaceAll(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
const kb = (n: number): string => `${(n / 1024).toFixed(1)} KB`;

/** The homepage's text for its build-time artefacts. */
function homeValues(a: Artefacts): Record<string, string> {
  const second = a.runs.at(-1);
  if (!second) throw new Error('no runs');
  const lines = a.hello.text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const at = lines.findIndex(l => /^\s*repeat: True,\s*$/.test(l));
  if (at < 0) throw new Error('hello.tape has no repeat: True line');
  const diff = [at - 1, at, at + 1]
    .map(i => (i === at ? `<span class="del">-${esc(lines[i] ?? '')}</span>` : ` ${esc(lines[i] ?? '')}`))
    .join('\n');
  const f = a.fulfillment;
  const calls = f.calls.map(c => `<code>${esc(c.name)}</code>${c.failed ? ' (failed)' : ''}`);
  const story = `${calls.slice(0, -1).join(', ')} and ${calls.at(-1) ?? ''}.${f.note ? ` The order's note: “${esc(f.note)}”.` : ''}`;
  return {
    gutter: lines.map((_, i) => `${i + 1}\n`).join(''),
    hello: a.hello.html,
    name: esc(second.line.replace(/^GET \/hello\//, '')),
    responses: responsesView(a.runs),
    moment: momentView(a.runs),
    of: `#${second.n}`,
    log: logView(second.log),
    trace: traceView(second.trace),
    spans: a.helloSvg,
    diff,
    refusal: refusalView(a.refusal, a.refused, { fix: repeatFix(a.refused, a.hello.text) }),
    ful_story: story,
    ful_svg: f.svg,
    ful_line: esc(f.line),
    ful_label: esc(f.label),
    ful_status: String(f.status),
    ful_spans: String(f.spans),
    ful_services: `${f.services.length} programs`,
    sim_clean: String(a.sim.clean),
    sim_what: esc(a.sim.what.replace(/\s*\(LANGUAGE\.md section 9\)$/, '')),
    sim_run: String(a.sim.found.run),
    sim_from: String(a.sim.found.shrunkFrom),
    sim_to: String(a.sim.found.choices),
    sim_violation: esc(a.sim.found.violation),
    wasm: kb(a.hello.wasm),
  };
}

export async function build({ made }: { made?: Artefacts } = {}): Promise<Built> {
  for (const [file, want] of Object.entries(PINNED)) {
    const got = sri(readFileSync(resolve(VENDOR, file)));
    if (got !== want) throw new Error(`vendor/${file} is not the pinned sql.js 1.10.3 file (${got})`);
  }
  const art = made ?? (await artefacts());
  const main = resolve(HERE, 'src/main.ts'),
    worker = resolve(HERE, 'src/worker.ts'),
    home = resolve(HERE, 'src/home.ts');
  const mods = graph([main, worker, home]);
  const named = emit(order(mods));
  const files = new Map<string, Uint8Array | string>();
  let bytes = 0;
  for (const { name, text } of named.values()) {
    files.set(`a/${name}`, text);
    bytes += text.length;
  }
  const asset = (name: string, body: Uint8Array | string): string => {
    const dot = name.lastIndexOf('.'),
      published = `a/${name.slice(0, dot)}.${short(body)}${name.slice(dot)}`;
    files.set(published, body);
    return published;
  };
  const css = asset('style.css', readFileSync(resolve(HERE, 'style.css'), 'utf8'));
  const wasmBytes = readFileSync(resolve(VENDOR, 'sql-wasm.wasm'));
  const wasm = asset('sql-wasm.wasm', wasmBytes);
  const icon = asset('icon.svg', readFileSync(resolve(HERE, 'icon.svg'), 'utf8'));
  const homeCss = asset('home.css', readFileSync(resolve(HERE, 'home.css'), 'utf8'));
  const pgCss = asset('playground.css', readFileSync(resolve(HERE, 'playground.css'), 'utf8'));
  // in a layer: the page's own sheets (unlayered) set the --tr-* colours it reads, whatever its selectors
  const traceCss = asset(
    'trace.css',
    `/* apps/trace/trace.tape's style, as it draws it, in a layer below the page's */\n@layer trace {\n${art.traceCss}\n}\n`,
  );
  const site = asset(
    'site.js',
    stripTypeScriptTypes(readFileSync(resolve(HERE, 'site.ts'), 'utf8'), { mode: 'strip' }),
  );
  // the highlighter and the trace renderer, compiled at build time: the editor highlights before the compiler loads
  const hlWasm = asset('highlight.wasm', art.tools.highlight);
  const trWasm = asset('trace.wasm', art.tools.trace);
  const nameOf = (p: string): string => `a/${named.get(p)?.name}`;
  // the modules an entry reaches, for modulepreload
  const reach = (entry: string): string[] => {
    const seen = new Set<string>();
    const walk = (p: string): void => {
      if (seen.has(p)) return;
      seen.add(p);
      for (const d of mods.get(p)?.deps ?? []) walk(d.to);
    };
    walk(entry);
    return [...seen].map(nameOf);
  };
  // the highlighter first (the editor needs it), then the modules, then SQLite (640 KB, needed to send): measured at
  // 375 px on Fast 4G, SQLite fetched by the script instead made Send ready ~90 ms later and the editor no sooner
  const preloads = (entries: string[], up: string): string =>
    [
      `<link rel="preload" href="${up}${hlWasm}" as="fetch" crossorigin>`,
      ...new Set(entries.flatMap(reach)).values().map(m => `<link rel="modulepreload" href="${up}${m}">`),
      `<link rel="preload" href="${up}${wasm}" as="fetch" crossorigin>`,
    ].join('\n');
  const config = (up: string): string =>
    JSON.stringify({
      worker: up + nameOf(worker),
      sqlite: up + wasm,
      sqliteIntegrity: sri(wasmBytes),
      highlight: up + hlWasm,
      trace: up + trWasm,
    }).replaceAll('<', '\\u003c');

  // the playground, one level down: its files are the site's a/, one directory up
  const playground = fill(
    readFileSync(resolve(HERE, 'index.html'), 'utf8'),
    {
      csp,
      css: `../${css}`,
      pgcss: `../${pgCss}`,
      tracecss: `../${traceCss}`,
      site: `../${site}`,
      github: GITHUB,
      icon: `../${icon}`,
      // as before the homepage: the worker's modules too (the simulator, the formatter), which it fetches at once
      preload: preloads([main, worker], '../'),
      config: config('../'),
      main: `../${nameOf(main)}`,
    },
    'index.html',
  );
  files.set('playground/index.html', playground);
  // the homepage, with what the build ran
  const page = fill(
    readFileSync(resolve(HERE, 'home.html'), 'utf8'),
    {
      csp,
      css,
      homecss: homeCss,
      tracecss: traceCss,
      icon,
      site,
      // the hero's own modules; the worker's simulator and formatter it never asks for are left to the playground
      preload: preloads([home], ''),
      config: config(''),
      main: nameOf(home),
      github: GITHUB,
      ...homeValues(art),
    },
    'home.html',
  );
  files.set('index.html', page);
  // for a static host that reads it (Cloudflare's static assets do): hashed files for ever, the pages never cached
  const pageHeaders = `  Cache-Control: no-cache\n  Content-Security-Policy: ${cspHeader}\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n`;
  files.set(
    '_headers',
    `/a/*\n  Cache-Control: public, max-age=31536000, immutable\n  X-Content-Type-Options: nosniff\n${['/', '/index.html', '/playground/', '/playground/index.html'].map(p => `${p}\n${pageHeaders}`).join('')}`,
  );
  return { files, entry: nameOf(main), worker: nameOf(worker), home: nameOf(home), modules: named.size, bytes };
}

export function write(b: Built, out: string): void {
  rmSync(out, { recursive: true, force: true });
  for (const [path, body] of b.files) {
    mkdirSync(dirname(resolve(out, path)), { recursive: true });
    writeFileSync(resolve(out, path), body);
  }
}

if (import.meta.main) {
  const out = resolve(process.argv[2] ?? resolve(HERE, 'dist'));
  const t0 = performance.now(),
    b = await build();
  write(b, out);
  const total = [...b.files.values()].reduce(
    (n, f) => n + (typeof f === 'string' ? Buffer.byteLength(f) : f.length),
    0,
  );
  console.log(
    `${relative(process.cwd(), out) || out}: ${b.files.size} files, ${(total / 1024).toFixed(0)} KB (${b.modules} modules, ${(b.bytes / 1024).toFixed(0)} KB of script) in ${(performance.now() - t0).toFixed(0)} ms`,
  );
}
