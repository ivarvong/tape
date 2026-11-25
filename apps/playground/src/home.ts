// apps/playground/src/home.ts: the homepage's live hero. The page arrives with a static copy of everything (the
// program highlighted, its two runs, their log, trace and spans, drawn at build time by apps/playground/artefacts.ts);
// this module makes it live with the playground's own modules: the highlighter and the trace renderer, compiled at
// build time and run here; the compiler on the worker thread (worker.ts) for every edit; SQLite in this page
// (sqlite.ts); and the playground's Workbench, which runs a request and makes its log, trace and OTLP. Nothing is
// sent anywhere.
import type { Built, Refused } from '../../../compiler.ts';
import { instantiate, responseOf } from '../../../host.ts';
import type { App } from '../../../host.ts';
import { std } from '../../../std.ts';
import initSqlJs from '../vendor/sql.js-1.10.3/sql-wasm.js';
import { DATA } from './data.ts';
import { Editor } from './editor.ts';
import {
  FULFILLMENT,
  HERO,
  armOf,
  hasRepeat,
  logView,
  momentView,
  refusalView,
  repeatFix,
  requestFor,
  responsesView,
  splitSvg,
  traceView,
  withRepeat,
  withoutRepeat,
} from './hero.ts';
import type { Shown } from './hero.ts';
import { loadSqlite, nodeSql } from './sqlite.ts';
import { Workbench } from './workbench.ts';
import type { Diagnostic, Exchange } from './workbench.ts';
import type { Answer, Ask } from './worker.ts';

type Config = { worker: string; sqlite: string; sqliteIntegrity: string; highlight: string; trace: string };
const $ = (id: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`#${id}`);
  if (!el) throw new Error(`no #${id}`);
  return el;
};
const button = (id: string): HTMLButtonElement => {
  const el = $(id);
  if (!(el instanceof HTMLButtonElement)) throw new TypeError(`#${id} is not a button`);
  return el;
};
const enc = new TextEncoder(),
  dec = new TextDecoder();
const parsed: unknown = JSON.parse($('config').textContent ?? '{}');
const isConfig = (v: unknown): v is Config =>
  typeof v === 'object' && v !== null && 'worker' in v && 'sqlite' in v && 'highlight' in v && 'trace' in v;
if (!isConfig(parsed)) throw new Error('the page has no config');
const config = parsed;
const ms = (n: number): string =>
  n < 1 ? `${(n * 1000).toFixed(0)} µs` : n < 10 ? `${n.toFixed(1)} ms` : `${n.toFixed(0)} ms`;
const kb = (n: number): string => `${(n / 1024).toFixed(1)} KB`;
const times: Record<string, number> = { script: performance.now() };

const status = { el: $('hero-status'), text: $('hero-status-text') };
function say(text: string, kind: '' | 'ok' | 'bad' | 'busy' = ''): void {
  status.text.textContent = text;
  status.el.dataset['kind'] = kind;
}
say('Loading…', 'busy');

// the shortcut as this platform writes it
const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
for (const k of document.querySelectorAll('.reqbar kbd')) k.textContent = mac ? '⌘↵' : 'Ctrl ↵';

// ---------- the worker: compiles off the page's thread

const worker = new Worker(config.worker, { type: 'module' });
let asked = 0;
const waiting = new Map<number, (a: Answer) => void>();
worker.addEventListener('message', (e: MessageEvent<Answer>): void => {
  waiting.get(e.data.id)?.(e.data);
  waiting.delete(e.data.id);
});
worker.addEventListener('error', (e): void => {
  console.error('worker', e.message);
});
async function compiled(file: string, text: string, trace = false): Promise<{ result: Built | Refused; ms: number }> {
  const id = ++asked;
  const q: Ask = { id, kind: 'compile', file, text, trace };
  const a = await new Promise<Answer>(resolve => {
    waiting.set(id, resolve);
    // a Worker's postMessage takes no target origin (that is window.postMessage)
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    worker.postMessage(q);
  });
  if (a.kind === 'error') throw new Error(a.message);
  if (a.kind !== 'compile') throw new Error(`worker answered ${a.kind}`);
  return { result: a.result, ms: a.ms };
}
/** A pure program compiled at build time, fetched and run here: text in, text out (the highlighter, the renderer). */
async function tool(url: string): Promise<(input: string) => string> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} did not load (${r.status})`);
  const app: App = instantiate(await WebAssembly.compile(await r.arrayBuffer()), {});
  return input => {
    return dec.decode(responseOf(app.handle(enc.encode(input))).body);
  };
}

async function startSqlite(): Promise<void> {
  const r = await fetch(config.sqlite, { integrity: config.sqliteIntegrity });
  if (!r.ok) throw new Error(`SQLite did not load (${r.status})`);
  await loadSqlite(initSqlJs, await r.arrayBuffer());
  times['sqlite'] = performance.now();
}
const highlighter = tool(config.highlight);
// the trace renderer (98 KB) is fetched once Send works: what is shown until then was drawn at build time
let rendering: Promise<(input: string) => string> | null = null;
const renderer = (): Promise<(input: string) => string> => (rendering ??= tool(config.trace));

const example = DATA.examples.find(e => e.id === HERO.example),
  file = example?.files.find(f => f.name === HERO.program);
if (!file) throw new Error(`no ${HERO.program} in this build`);
const original = file.text;
const name = HERO.program;

// ---------- the parts of the hero

const send1 = button('send'),
  send2 = button('twice'),
  repeat = button('repeat'),
  who = ((): HTMLInputElement => {
    const el = $('who');
    if (!(el instanceof HTMLInputElement)) throw new TypeError('#who is not an input');
    return el;
  })(),
  panels = $('hero-panels'),
  source = $('hero-source');
let editor: Editor | null = null;
let bench: Workbench | null = null;
let draw: ((input: string) => string) | null = null;
let problems: Diagnostic[] = [];
let built: { ms: number; wasm: number } | null = null;
const sent: Shown[] = [];
let last: Exchange | null = null;

function showState(): void {
  const [d] = problems;
  const box = $('hero-refusal');
  const text = editor?.value ?? original;
  box.innerHTML = d
    ? refusalView(d, text, { live: true, fix: hasRepeat(text) ? undefined : repeatFix(text, original) })
    : '';
  box.hidden = !d;
  panels.classList.toggle('stale', d !== undefined);
  send1.disabled = send2.disabled = d !== undefined || !bench;
  const without = !hasRepeat(text);
  repeat.innerHTML = without ? 'Put <code>repeat: True</code> back' : 'Remove <code>repeat: True</code>';
  repeat.setAttribute('aria-pressed', String(without));
  repeat.disabled = !editor;
  $('hero-try').textContent = d
    ? 'Refused: nothing runs until it compiles.'
    : sent.length >= 2 && source.dataset['live'] === 'true'
      ? 'Now break it: the compiler refuses the program.'
      : 'Send twice, then break it: the compiler refuses the program.';
  if (d) say(`Refused: ${d.code} at ${d.file}:${d.line}`, 'bad');
  else if (built) say(`Compiled in ${ms(built.ms)} in this page · ${kb(built.wasm)} of Wasm`, 'ok');
}

/** Compile the editor's text on the worker; the newest text wins, one compile in flight. */
let inflight: Promise<void> | null = null,
  again = false;
async function recompile(): Promise<void> {
  if (inflight) {
    again = true;
    return inflight;
  }
  inflight = (async () => {
    do {
      again = false;
      const text = editor?.value ?? original;
      const r = await compiled(`${name}.tape`, text);
      if (!bench) return;
      problems = bench.accept(name, text, r.result, r.ms);
      if (r.result.wasm) built = { ms: r.ms, wasm: r.result.wasm.length };
      editor?.setMarks(
        problems
          .filter(p => p.file === `${name}.tape`)
          .map(p => ({ line: p.line, code: p.code, message: p.message, hint: p.hint })),
      );
      showState();
    } while (again);
  })();
  try {
    await inflight;
  } finally {
    inflight = null;
  }
}

async function send(times_: number): Promise<void> {
  if (!bench || problems.length > 0) return;
  await (inflight ?? Promise.resolve());
  if (problems.length > 0) return;
  send1.setAttribute('aria-busy', 'true');
  try {
    // the trace is the run replayed through a build that reports each function entered: compiled on the worker
    if (bench.needsTrace(name)) {
      const text = bench.slots.get(name)?.text ?? '';
      bench.acceptTraced(name, text, (await compiled(`${name}.tape`, text, true)).result);
    }
    const n = who.value.trim().replaceAll(/[\s/?#]+/g, '') || HERO.name;
    if (source.dataset['live'] !== 'true') sent.length = 0;
    for (let i = 0; i < times_; i++) {
      const x = await bench.send(name, requestFor(n));
      sent.push({
        n: x.n,
        line: x.request.split('\n')[0] ?? '',
        status: x.status,
        body: x.body,
        arm: armOf(x.root.trace),
      });
      last = x;
    }
    source.dataset['live'] = 'true';
    source.textContent = 'run in this page';
    render();
    showState();
  } catch (err) {
    say(`The request did not run: ${err instanceof Error ? err.message : String(err)}`, 'bad');
    console.error(err);
  } finally {
    send1.removeAttribute('aria-busy');
  }
}

function render(): void {
  const x = last;
  if (!x) return;
  const shown = sent.slice(-5);
  $('hero-responses').innerHTML = responsesView(shown);
  $('hero-moment').innerHTML = momentView(shown);
  $('hero-log').innerHTML = logView(x.root.log);
  $('hero-trace').innerHTML = traceView(x.root.trace);
  for (const el of document.querySelectorAll('[data-of]')) el.textContent = `#${x.n}`;
  const arm = sent.at(-1)?.arm;
  editor?.setHits(arm ? [arm.line] : []);
  spans(x);
}
function spans(x: Exchange): void {
  const box = $('hero-spans');
  if (!draw) {
    box.innerHTML = '<p class="muted small">Drawing…</p>';
    return;
  }
  try {
    box.innerHTML = splitSvg(draw(JSON.stringify(x.otlp))).svg;
  } catch (err) {
    box.innerHTML = `<p class="small">trace.tape did not draw this: ${err instanceof Error ? err.message : String(err)}</p>`;
  }
}

send2.addEventListener('click', () => void send(2));
$('hero-form').addEventListener('submit', e => {
  e.preventDefault();
  void send(1);
});
// ⌘↵ / Ctrl↵ sends, from anywhere in the demo (the editor included)
$('hero-out')
  .closest('.window')
  ?.addEventListener('keydown', e => {
    if (!(e instanceof KeyboardEvent)) return;
    const k = e;
    if (k.key === 'Enter' && (k.metaKey || k.ctrlKey) && !send1.disabled) {
      k.preventDefault();
      void send(1);
    }
  });
repeat.addEventListener('click', () => {
  if (!editor) return;
  const now = editor.value;
  let next: string;
  try {
    next = hasRepeat(now) ? withoutRepeat(now) : withRepeat(now, original);
  } catch {
    return;
  }
  editor.value = next;
  editor.setHits([]);
  void recompile();
});

// ---------- fulfillment, run here

const fulButton = button('ful-run');
fulButton.addEventListener('click', () => void runFulfillment());
async function runFulfillment(): Promise<void> {
  const ex = DATA.examples.find(e => e.id === FULFILLMENT.example),
    preset = ex?.presets.find(p => p.label === FULFILLMENT.preset);
  if (!ex || !preset) return;
  fulButton.disabled = true;
  fulButton.textContent = 'Compiling four programs…';
  try {
    await sqlite();
    const fb = new Workbench(std, nodeSql);
    fb.declare(ex.files.map(f => f.name));
    const t0 = performance.now();
    const results = await Promise.all(ex.files.map(async f => ({ f, r: await compiled(`${f.name}.tape`, f.text) })));
    for (const { f, r } of results) {
      const bad = fb.accept(f.name, f.text, r.result, r.ms);
      if (bad.length > 0) throw new Error(`${f.name}.tape: ${bad[0]?.code} ${bad[0]?.message}`);
    }
    const compiledIn = performance.now() - t0;
    fb.faults = { ...preset.faults };
    const x = await fb.send(
      preset.to ?? ex.files[0]?.name ?? '',
      `${preset.method} ${preset.path}\n${preset.body ?? ''}`,
    );
    const d = await renderer();
    $('ful-svg').innerHTML = splitSvg(d(JSON.stringify(x.otlp))).svg;
    const n = x.otlp.resourceSpans.reduce((k, r) => k + r.scopeSpans[0].spans.length, 0);
    $('ful-live').textContent =
      `Just run in this page: four programs compiled in ${ms(compiledIn)}, answered ${x.status} in ${ms(x.ms)}, ${n} spans.`;
    fulButton.textContent = 'Run it again';
  } catch (err) {
    $('ful-live').textContent = `It did not run: ${err instanceof Error ? err.message : String(err)}`;
    fulButton.textContent = 'Run it in this page';
  } finally {
    fulButton.disabled = false;
  }
}

// ---------- start: the editor first (it needs only the highlighter), then SQLite and the first compile

let sqliteStarted: Promise<void> | null = null;
const sqlite = (): Promise<void> => (sqliteStarted ??= startSqlite());
// started at once (the page preloads it after its modules); Send waits for it
// oxlint-disable-next-line unicorn/prefer-top-level-await
sqlite().catch(() => {});

async function start(): Promise<void> {
  const hl = await highlighter;
  times['highlighter'] = performance.now();
  // the static copy is swapped for the editor: the same markup, now with a textarea over it
  const ed = new Editor($('hero-editor'));
  ed.setHighlighter(text => hl(text));
  ed.value = original;
  ed.onInput(() => void recompile());
  editor = ed;
  // the arm the build-time run took, marked as a live run's is
  const builtArm = Number(document.querySelector<HTMLElement>('#hero-responses li:last-child .arm')?.dataset['line']);
  if (builtArm > 0) ed.setHits([builtArm]);
  times['editor'] = performance.now();
  repeat.disabled = false;
  await sqlite();
  bench = new Workbench(std, nodeSql);
  bench.declare([name]);
  await recompile();
  fulButton.hidden = false;
  times['ready'] = performance.now();
  document.body.dataset['ready'] = String(Math.round(times['ready']));
  showState();
  draw = await renderer();
  times['renderer'] = performance.now();
  document.body.dataset['spans'] = String(Math.round(times['renderer']));
  if (last) spans(last);
}
Object.assign(window, {
  __home: {
    times,
    get editor() {
      return editor;
    },
    get bench() {
      return bench;
    },
    get last() {
      return last;
    },
    send,
  },
});
try {
  await start();
} catch (err) {
  say(
    `The live copy did not start: ${err instanceof Error ? err.message : String(err)}. What is shown was made when this page was built.`,
    'bad',
  );
  console.error(err);
}
