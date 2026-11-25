// apps/playground/src/main.ts: the page. An example's programs are edited in place (editor.ts, highlighted by
// highlight.tape compiled in this page), compiled on every keystroke on the worker thread (worker.ts), linked here
// to SQLite in the page (sqlite.ts) and run (workbench.ts). Every request shows its response, its effect log, the
// trace made from that log, the rows it left, and its OTLP/JSON drawn as SVG by trace.tape, also compiled here.
import type { Built, Refused } from '../../../compiler.ts';
import { instantiate, responseOf } from '../../../host.ts';
import type { App, Cell } from '../../../host.ts';
import { std } from '../../../std.ts';
import initSqlJs from '../vendor/sql.js-1.10.3/sql-wasm.js';
import { DATA } from './data.ts';
import type { ExampleData } from './data.ts';
import { Editor, escapeHtml as esc } from './editor.ts';
import { logView, splitSvg } from './hero.ts';
import type { Mark } from './editor.ts';
import type { Fault, Preset } from '../examples.ts';
import { loadSqlite, nodeSql } from './sqlite.ts';
import type { SimResult } from './simulate.ts';
import { Workbench } from './workbench.ts';
import type { Diagnostic, Exchange, Line, RunView } from './workbench.ts';
import type { Answer, Ask } from './worker.ts';

type Config = { worker: string; sqlite: string; sqliteIntegrity: string; highlight: string; trace: string };
const $ = (id: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`#${id}`);
  if (!el) throw new Error(`no #${id}`);
  return el;
};
/** An element of the page that must be of one kind: a form, a select, an input. */
const $of = <T extends HTMLElement>(id: string, kind: abstract new () => T): T => {
  const el = $(id);
  if (!(el instanceof kind)) throw new TypeError(`#${id} is not a ${kind.name}`);
  return el;
};
/** The element an event happened on, or the nearest one around it that matches sel. */
const around = (e: Event, sel: string): HTMLElement | null =>
  e.target instanceof Element ? e.target.closest<HTMLElement>(sel) : null;
/** The id of the element an event happened on ('' for none). */
const targetId = (e: Event): string => (e.target instanceof Element ? e.target.id : '');
const enc = new TextEncoder(),
  dec = new TextDecoder();
/** The page's settings, which build.ts writes into it as JSON: every field a string, or the page cannot start. */
function configOf(text: string): Config {
  const v: unknown = JSON.parse(text);
  const field = (k: keyof Config): string => {
    const x: unknown = typeof v === 'object' && v !== null ? Reflect.get(v, k) : undefined;
    if (typeof x !== 'string') throw new TypeError(`the page's config has no ${k}`);
    return x;
  };
  return {
    worker: field('worker'),
    sqlite: field('sqlite'),
    sqliteIntegrity: field('sqliteIntegrity'),
    highlight: field('highlight'),
    trace: field('trace'),
  };
}
const config = configOf($('config').textContent ?? '{}');
const times: Record<string, number> = { script: performance.now() };
const ms = (n: number): string =>
  n < 1 ? `${(n * 1000).toFixed(0)} µs` : n < 10 ? `${n.toFixed(1)} ms` : `${n.toFixed(0)} ms`;
const kb = (n: number): string => `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
const store = {
  get: (k: string): string | null => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string): void => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode: the choice lasts this visit */
    }
  },
};

// the theme and its button are site.ts's (run before the first paint)

// ---------- the layout: a divider between the panes (drag it, or arrow keys on it), and on a phone one pane at a time

const layout = $('layout'),
  split = $('split');
const setSplit = (pct: number): void => {
  const v = Math.min(75, Math.max(30, Math.round(pct)));
  layout.style.setProperty('--split', `${v}%`);
  split.setAttribute('aria-valuenow', String(v));
};
const savedSplit = Number(store.get('split'));
if (savedSplit > 0) setSplit(savedSplit);
split.addEventListener('pointerdown', e => {
  split.setPointerCapture(e.pointerId);
  split.classList.add('dragging');
  document.body.classList.add('dragging-split');
  const box = layout.getBoundingClientRect();
  const move = (m: PointerEvent): void => setSplit(((m.clientX - box.left) / box.width) * 100);
  const up = (): void => {
    split.classList.remove('dragging');
    document.body.classList.remove('dragging-split');
    split.removeEventListener('pointermove', move);
    store.set('split', split.getAttribute('aria-valuenow') ?? '');
  };
  split.addEventListener('pointermove', move);
  split.addEventListener('pointerup', up, { once: true });
  split.addEventListener('pointercancel', up, { once: true });
});
split.addEventListener('keydown', e => {
  const now = Number(split.getAttribute('aria-valuenow'));
  const step = e.shiftKey ? 10 : 2;
  const to =
    e.key === 'ArrowLeft'
      ? now - step
      : e.key === 'ArrowRight'
        ? now + step
        : e.key === 'Home'
          ? 30
          : e.key === 'End'
            ? 75
            : null;
  if (to === null) return;
  e.preventDefault();
  setSplit(to);
  store.set('split', split.getAttribute('aria-valuenow') ?? '');
});
split.addEventListener('dblclick', () => {
  setSplit(56);
  store.set('split', '56');
});

function showView(view: string): void {
  layout.dataset['view'] = view;
  for (const b of document.querySelectorAll<HTMLElement>('#views [data-view]')) {
    const on = b.dataset['view'] === view;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  }
  if (view === 'trace' && tab !== 'spans') {
    tab = 'spans';
    renderResult();
  }
}
$('views').addEventListener('click', e => {
  const b = around(e, '[data-view]');
  if (b?.dataset['view']) showView(b.dataset['view']);
});
$('views').addEventListener('keydown', e => {
  const views = ['code', 'run', 'trace'],
    at = views.indexOf(layout.dataset['view'] ?? 'code');
  const to = e.key === 'ArrowRight' ? (at + 1) % 3 : e.key === 'ArrowLeft' ? (at + 2) % 3 : -1;
  if (to < 0) return;
  e.preventDefault();
  showView(views[to] ?? 'code');
  document.querySelector<HTMLElement>(`#views [data-view="${views[to]}"]`)?.focus();
});
const phone = matchMedia('(max-width: 760px)');

// the shortcut as this platform writes it; ⌘↵ / Ctrl↵ sends from anywhere on the page
const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
for (const k of document.querySelectorAll('#send kbd')) k.textContent = mac ? '⌘↵' : 'Ctrl ↵';
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    if (phone.matches && layout.dataset['view'] === 'code') showView('run');
    void send();
  }
});

// ---------- the worker

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
type AskOf<K extends Ask['kind']> = Omit<Extract<Ask, { kind: K }>, 'id'>;
function ask<K extends Ask['kind']>(q: AskOf<K>, transfer: Transferable[] = []): Promise<Answer> {
  const id = ++asked;
  return new Promise(resolve => {
    waiting.set(id, resolve);
    worker.postMessage({ ...q, id }, transfer);
  });
}
async function compiled(
  file: string,
  text: string,
  o: { trace?: boolean; withStd?: boolean } = {},
): Promise<{ result: Built | Refused; ms: number }> {
  const a = await ask<'compile'>({ kind: 'compile', file, text, ...o });
  if (a.kind === 'error') throw new Error(a.message);
  if (a.kind !== 'compile') throw new Error(`worker answered ${a.kind}`);
  return { result: a.result, ms: a.ms };
}

// ---------- the parts of the page

const editor = new Editor($('editor'));
// the status is in the header, and (where the header has no room for it) above the editor
const statuses = [
  { el: $('status'), text: $('status-text') },
  { el: $('status-2'), text: $('status-2-text') },
];
function say(text: string, kind: '' | 'ok' | 'bad' | 'busy' = ''): void {
  for (const st of statuses) {
    st.text.textContent = text;
    st.el.dataset['kind'] = kind;
  }
}

let sqliteWasm: ArrayBuffer | null = null;
async function startSqlite(): Promise<void> {
  times['sqlite-start'] = performance.now();
  const r = await fetch(config.sqlite, { integrity: config.sqliteIntegrity });
  if (!r.ok) throw new Error(`SQLite did not load (${r.status})`);
  sqliteWasm = await r.arrayBuffer();
  await loadSqlite(initSqlJs, sqliteWasm.slice(0));
}
// started now and awaited later: the editor and the highlighter do not wait for SQLite
// oxlint-disable-next-line unicorn/prefer-top-level-await
const sqlite = startSqlite();

/** A pure program compiled at build time and run here by host.ts: bytes in, bytes out (the highlighter, the trace
 * renderer). `build` is how long fetching and compiling its Wasm took in this page. */
type Tool = { app: App; build: number; wasm: number };
async function tool(url: string): Promise<Tool> {
  const t0 = performance.now();
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} did not load (${r.status})`);
  const bytes = await r.arrayBuffer();
  const app = instantiate(await WebAssembly.compile(bytes), {});
  return { app, build: performance.now() - t0, wasm: bytes.byteLength };
}

type Stats = {
  highlighter: { ms: number; wasm: number };
  renderer: { ms: number; wasm: number; error: string | null };
  compiles: { file: string; ms: number; bytes: number }[];
  svg: number[];
  ready: boolean;
};
const stats: Stats = {
  highlighter: { ms: 0, wasm: 0 },
  renderer: { ms: 0, wasm: 0, error: null },
  compiles: [],
  svg: [],
  ready: false,
};

// ---------- examples and their programs

let example: ExampleData | undefined;
let texts: Record<string, string> = {};
let current = '';
let bench: Workbench | null = null;
let diagnostics: Record<string, Diagnostic[]> = {};
let shown: Exchange | null = null;
let tab = 'response';
let trace: Tool | null = null;
const svgs = new WeakMap<Exchange, { svg: string; ms: number } | { error: string }>();

const exampleSelect = $of('example', HTMLSelectElement);
exampleSelect.innerHTML = DATA.examples.map(ex => `<option value="${esc(ex.id)}">${esc(ex.title)}</option>`).join('');
exampleSelect.addEventListener('change', () => {
  void load(exampleSelect.value);
});

async function load(id: string): Promise<void> {
  const ex = DATA.examples.find(e => e.id === id) ?? DATA.examples[0];
  if (!ex) return;
  example = ex;
  exampleSelect.value = ex.id;
  if (location.hash !== `#${ex.id}`) history.replaceState(null, '', `#${ex.id}`);
  texts = Object.fromEntries(ex.files.map(f => [f.name, f.text]));
  diagnostics = {};
  shown = null;
  presetFaults = {};
  presetFlags = {};
  $('blurb').textContent = ex.blurb;
  await sqlite;
  bench = new Workbench(std, nodeSql);
  bench.declare(ex.files.map(f => f.name));
  current = ex.files[0]?.name ?? '';
  renderTabs();
  editor.value = texts[current] ?? '';
  renderPresets();
  renderResult();
  renderHistory();
  $('sim').hidden = true;
  say('Compiling…', 'busy');
  await Promise.all(ex.files.map(f => recompile(f.name)));
  renderKnobs();
  const first = ex.presets[0];
  if (first) fillPreset(first);
}

/** Compile a program on the worker, latest text wins; one compile in flight per program. */
const inflight = new Map<string, { pending: boolean }>();
async function recompile(name: string): Promise<void> {
  const busy = inflight.get(name);
  if (busy) {
    busy.pending = true;
    return;
  }
  const state = { pending: false };
  inflight.set(name, state);
  try {
    for (;;) {
      state.pending = false;
      const text = texts[name] ?? '',
        r = await compiled(`${name}.tape`, text);
      if (!bench || texts[name] === undefined) return;
      const found = bench.accept(name, text, r.result, r.ms);
      diagnostics[name] = found;
      stats.compiles.push({ file: name, ms: r.ms, bytes: r.result.wasm?.length ?? 0 });
      showDiagnostics();
      if (!state.pending) break;
    }
  } finally {
    inflight.delete(name);
  }
  renderKnobs();
}

editor.onInput(text => {
  if (!example || !(current in texts)) return;
  texts[current] = text;
  void recompile(current);
});

function renderTabs(): void {
  if (!example) return;
  $('tabs').innerHTML = example.files
    .map(f => {
      const bad = (diagnostics[f.name]?.length ?? 0) > 0;
      return `<button type="button" role="tab" data-file="${esc(f.name)}" aria-selected="${f.name === current}" title="${esc(f.from)}">${esc(f.name)}<span class="ext">.tape</span>${bad ? '<span class="dot bad" aria-label="does not compile"></span>' : ''}</button>`;
    })
    .join('');
}
$('tabs').addEventListener('click', e => {
  const b = around(e, '[data-file]');
  const name = b?.dataset['file'];
  if (!name || name === current) return;
  current = name;
  editor.value = texts[name] ?? '';
  renderTabs();
  showDiagnostics();
});

function showDiagnostics(): void {
  renderTabs();
  const mine = diagnostics[current] ?? [];
  const marks: Mark[] = mine
    .filter(d => d.file === `${current}.tape`)
    .map(d => ({ line: d.line, code: d.code, message: d.message, hint: d.hint }));
  editor.setMarks(marks);
  const all = Object.values(diagnostics).flat();
  const box = $('problems');
  box.hidden = all.length === 0;
  box.innerHTML = all
    .slice(0, 6)
    .map(
      d =>
        `<button type="button" class="problem" data-program="${esc(d.program)}" data-line="${d.line}"><span class="where">${esc(d.file)}:${d.line}</span><b class="code">${esc(d.code)}</b><span class="msg">${esc(d.message)}</span>${d.hint ? `<span class="hint">${esc(d.hint)}</span>` : ''}</button>`,
    )
    .join('');
  const slot = bench?.slots.get(current);
  if (all.length > 0) {
    const n = all.length;
    say(`${n} problem${n === 1 ? '' : 's'}: ${all[0]?.code} at ${all[0]?.file}:${all[0]?.line}`, 'bad');
  } else if (slot?.built) {
    say(
      `${current}.tape v${slot.version} · compiled in ${ms(slot.ms)} · ${kb(slot.built.wasm.length)} of Wasm · ${slot.built.queries.length} statements`,
      'ok',
    );
  }
  $('code-meta').textContent = `${(texts[current] ?? '').split('\n').length} lines`;
}
$('problems').addEventListener('click', e => {
  const b = around(e, '.problem');
  if (!b) return;
  const program = b.dataset['program'] ?? current,
    line = Number(b.dataset['line']);
  if (program !== current && program in texts) {
    current = program;
    editor.value = texts[program] ?? '';
    showDiagnostics();
  }
  editor.revealLine(line);
});

// ---------- requests

const form = $of('form', HTMLFormElement),
  method = $of('method', HTMLSelectElement),
  path = $of('path', HTMLInputElement),
  body = $of('body', HTMLTextAreaElement),
  toSelect = $of('to', HTMLSelectElement);
let presetFaults: Record<string, Fault> = {};
let presetFlags: Record<string, Record<string, number | boolean>> = {};

function renderPresets(): void {
  if (!example) return;
  $('presets').innerHTML = example.presets
    .map(
      (p, i) =>
        `<button type="button" class="chip" data-preset="${i}" title="${esc(`${p.method} ${p.path}${p.note ? ` — ${p.note}` : ''}`)}"><span class="m m-${esc(p.method.toLowerCase())}">${esc(p.method)}</span>${esc(p.label)}</button>`,
    )
    .join('');
  const handlers = example.files.filter(f => /\bfn handle\(/.test(f.text)).map(f => f.name);
  toSelect.hidden = handlers.length < 2;
  toSelect.innerHTML = handlers.map(n => `<option>${esc(n)}</option>`).join('');
}
function fillPreset(p: Preset): void {
  method.value = p.method;
  path.value = p.path;
  body.value = p.body ?? '';
  toSelect.value = p.to ?? example?.files[0]?.name ?? '';
  presetFaults = p.faults ?? {};
  presetFlags = p.flags ?? {};
  // a preset says the whole setting: a flag it does not name is at its default
  for (const s of bench?.slots.values() ?? [])
    for (const f of s.built?.flags ?? []) bench?.setFlag(s.name, f.name, f.default);
  renderKnobs();
}
$('presets').addEventListener('click', e => {
  const b = around(e, '[data-preset]');
  const p = example?.presets[Number(b?.dataset['preset'])];
  if (!p) return;
  fillPreset(p);
  void send();
});
form.addEventListener('submit', e => {
  e.preventDefault();
  void send();
});

/** The calls a program can make, and its flags, as controls: what happens to each call, and each flag's value. */
function renderKnobs(): void {
  const knobs = $('knobs');
  if (!bench || !example) {
    knobs.innerHTML = '';
    return;
  }
  const targets = new Set<string>();
  for (const s of bench.slots.values())
    for (const call of Object.keys(s.built?.json.replies ?? {})) targets.add(call.split('.')[0] ?? '');
  targets.delete('');
  const stand = new Set(bench.standIns());
  for (const [name, f] of Object.entries(presetFlags))
    if (bench.slots.has(name)) for (const [k, v] of Object.entries(f)) bench.setFlag(name, k, v);
  const calls = [...targets].map(t => {
    const options: Fault[] = stand.has(t) ? ['deliver', 'reject', 'lose', 'drop'] : ['deliver', 'lose', 'drop'];
    const v = presetFaults[t] ?? 'deliver';
    return `<label class="knob${v === 'deliver' ? '' : ' on'}" title="${stand.has(t) ? `${esc(t)} is stood in for: no program here serves it` : `calls to ${esc(t)}`}"><span>${esc(t)}${stand.has(t) ? '<i>stand-in</i>' : ''}</span><select data-fault="${esc(t)}">${options.map(o => `<option${o === v ? ' selected' : ''}>${o}</option>`).join('')}</select></label>`;
  });
  const flags = [...bench.slots.values()].flatMap(s =>
    (s.built?.flags ?? []).map(f => {
      const v = s.flags[f.name] ?? f.default;
      const input =
        f.type === 'Bool'
          ? `<input type="checkbox" data-flag="${esc(s.name)}.${esc(f.name)}"${v === true ? ' checked' : ''}>`
          : `<input type="number" data-flag="${esc(s.name)}.${esc(f.name)}" value="${esc(String(v))}">`;
      return `<label class="knob${v === f.default ? '' : ' on'}"><span>${esc(f.name)}<i>flag</i></span>${input}</label>`;
    }),
  );
  knobs.innerHTML =
    calls.length + flags.length === 0
      ? ''
      : `${calls.length > 0 ? `<div class="krow"><span class="klabel">Calls</span>${calls.join('')}</div>` : ''}${flags.length > 0 ? `<div class="krow"><span class="klabel">Flags</span>${flags.join('')}</div>` : ''}`;
}
const FAULTS: readonly Fault[] = ['deliver', 'reject', 'lose', 'drop'];
const faultOf = (v: string): Fault => FAULTS.find(f => f === v) ?? 'deliver';
$('knobs').addEventListener('change', e => {
  const el = e.target;
  if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement)) return;
  const fault = el.dataset['fault'],
    flag = el.dataset['flag'];
  if (fault) presetFaults = { ...presetFaults, [fault]: faultOf(el.value) };
  if (flag && bench) {
    const [program = '', name = ''] = flag.split('.');
    const v = el instanceof HTMLInputElement && el.type === 'checkbox' ? el.checked : Number(el.value);
    presetFlags = { ...presetFlags, [program]: { ...presetFlags[program], [name]: v } };
    bench.setFlag(program, name, v);
  }
  renderKnobs();
});

let sending = false;
async function send(): Promise<void> {
  if (!bench || !example || sending) return;
  const to = toSelect.hidden !== false ? (example.files[0]?.name ?? '') : toSelect.value;
  const request = `${method.value} ${path.value.trim() || '/'}\n${body.value}`;
  bench.faults = { ...presetFaults };
  sending = true;
  $('send').setAttribute('aria-busy', 'true');
  $('result-head').innerHTML = `<span class="pending">${esc(`${method.value} ${path.value}`)} …</span>`;
  try {
    // a request waits for its program's newest text to compile
    while (inflight.size > 0)
      await new Promise(r => {
        setTimeout(r, 5);
      });
    const ex = await bench.send(to, request);
    shown = ex;
    renderResult();
    renderHistory();
    renderTimers();
    void traceFor(ex);
  } catch (err) {
    $('result-head').innerHTML =
      `<span class="badge s5">refused</span> <span class="err-text">${esc(err instanceof Error ? err.message : String(err))}</span>`;
  } finally {
    sending = false;
    $('send').removeAttribute('aria-busy');
  }
}

/** The traced build, compiled on the worker the first time a request needs it, then the trace lines again. */
async function traceFor(ex: Exchange): Promise<void> {
  if (!bench) return;
  const names = new Set<string>();
  const walk = (r: RunView): void => {
    names.add(r.program);
    for (const c of r.calls) if (c.run) walk(c.run);
  };
  walk(ex.root);
  // the bench made the trace already when it had the traced build; otherwise it is made in the worker and kept
  let fresh = false;
  for (const n of names)
    if (bench.needsTrace(n)) {
      const text = texts[n] ?? '';
      const r = await compiled(`${n}.tape`, text, { trace: true });
      bench.acceptTraced(n, text, r.result);
      fresh = true;
    }
  if (fresh && shown === ex && tab === 'trace') renderResult();
}

// ---------- the result

const statusClass = (s: number): string => `s${String(s)[0] ?? '2'}`;
function renderResult(): void {
  const head = $('result-head'),
    out = $('rbody');
  for (const b of document.querySelectorAll<HTMLElement>('.rtabs [data-tab]')) {
    b.setAttribute('aria-selected', String(b.dataset['tab'] === tab));
    b.tabIndex = b.dataset['tab'] === tab ? 0 : -1;
  }
  const ex = shown;
  if (!ex) {
    head.innerHTML = '<span class="muted">Send a request: it runs here, against SQLite in this page.</span>';
    out.innerHTML = '';
    return;
  }
  const [line = ''] = ex.request.split('\n');
  head.innerHTML = `<span class="badge ${statusClass(ex.status)}">${ex.status}</span><code class="rl">${esc(line)}</code><span class="took">${esc(ex.program)} · ${ms(ex.ms)}</span>`;
  if (tab === 'response') out.innerHTML = responseView(ex);
  else if (tab === 'log') out.innerHTML = runSections(ex.root, r => r.log, false, true);
  else if (tab === 'trace') out.innerHTML = runSections(ex.root, r => r.trace, true);
  else if (tab === 'otlp')
    out.innerHTML = `${downloads(ex)}<pre class="block json">${esc(JSON.stringify(ex.otlp, null, 2))}</pre>`;
  else if (tab === 'data') out.innerHTML = dataView();
  else out.innerHTML = spansView(ex);
}
document.querySelector('.rtabs')?.addEventListener('keydown', e => {
  if (!(e instanceof KeyboardEvent)) return;
  const k = e;
  const all = [...document.querySelectorAll<HTMLElement>('.rtabs [data-tab]')];
  const at = all.findIndex(b => b.dataset['tab'] === tab);
  const to =
    k.key === 'ArrowRight' ? (at + 1) % all.length : k.key === 'ArrowLeft' ? (at - 1 + all.length) % all.length : -1;
  if (to < 0) return;
  k.preventDefault();
  tab = all[to]?.dataset['tab'] ?? tab;
  renderResult();
  all[to]?.focus();
  if (tab === 'trace' && shown) void traceFor(shown);
});
document.querySelector('.rtabs')?.addEventListener('click', e => {
  const b = around(e, '[data-tab]');
  if (!b?.dataset['tab']) return;
  tab = b.dataset['tab'];
  renderResult();
  if (tab === 'trace' && shown) void traceFor(shown);
});

const pretty = (text: string, type: string): string => {
  if (type.startsWith('application/json'))
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  return text;
};
function responseView(ex: Exchange): string {
  const set = ex.headers.map(h => `<div class="kv"><span>${esc(h.name)}</span><code>${esc(h.value)}</code></div>`);
  return `<div class="kv"><span>content-type</span><code>${esc(ex.type)}</code></div>${set.join('')}<pre class="block response">${esc(pretty(ex.body, ex.type)) || '<span class="muted">(empty body)</span>'}</pre>`;
}

function runSections(root: RunView, lines: (r: RunView) => Line[], clickable = false, asLog = false): string {
  const section = (r: RunView, depth: number, title: string): string => {
    const ls = lines(r);
    const rows =
      asLog && ls.length > 0
        ? `<ul class="log">${logView(ls)}</ul>`
        : ls.length > 0
          ? ls
              .map(l => {
                const at = l.line !== undefined ? `<span class="ln">${l.line}</span>` : '<span class="ln"></span>';
                const mark = l.kind === 'ok' ? '✓' : l.kind === 'no' ? '✗' : '';
                const attrs =
                  clickable && l.line !== undefined
                    ? ` data-goto="${esc(r.program)}:${l.line}" tabindex="0" role="button"`
                    : '';
                return `<div class="tl k-${esc(l.kind)}${l.undone ? ' undone' : ''}"${attrs}>${at}<span class="mk">${mark}</span><span class="tx">${esc(l.text)}</span></div>`;
              })
              .join('')
          : `<div class="tl muted">${clickable ? 'Tracing… (the traced build compiles on first use)' : 'No entries.'}</div>`;
    const calls = r.calls
      .map(c => {
        const note = c.why ? `<div class="why">${esc(c.why)}</div>` : '';
        const label = `${c.e.call}.${c.e.method} → ${c.e.status}${c.fault === 'deliver' ? '' : ` (${c.fault})`}`;
        return c.run
          ? section(c.run, depth + 1, label)
          : `<div class="runv d${depth + 1}"><div class="run-title">${esc(label)}</div>${note}</div>`;
      })
      .join('');
    return `<div class="runv d${depth}"><div class="run-title">${esc(title)}</div>${asLog ? rows : `<div class="trace-lines">${rows}</div>`}${calls}</div>`;
  };
  return section(
    root,
    0,
    `${root.program}${root.method ? `.${root.method}` : ''} · ${typeof root.status === 'number' ? root.status : root.status}`,
  );
}
$('rbody').addEventListener('click', e => {
  const g = around(e, '[data-goto]');
  if (g?.dataset['goto']) goto(g.dataset['goto']);
  const c = around(e, '[data-copy]');
  if (c && shown)
    void navigator.clipboard?.writeText(JSON.stringify(shown.otlp, null, 2)).then(() => {
      c.textContent = 'Copied';
      return null;
    });
});
$('rbody').addEventListener('keydown', e => {
  const g = around(e, '[data-goto]');
  if (g?.dataset['goto'] && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    goto(g.dataset['goto']);
  }
});
function goto(where: string): void {
  const [program = '', line = '1'] = where.split(':');
  if (program !== current && program in texts) {
    current = program;
    editor.value = texts[program] ?? '';
    showDiagnostics();
  }
  editor.revealLine(Number(line));
}

function dataView(): string {
  if (!bench) return '';
  return [...bench.slots.keys()]
    .map(name => {
      const tables = bench?.tables(name) ?? [];
      const shownTables = tables
        .map(t => {
          const own = t.name.startsWith('_');
          const head = t.columns.map(c => `<th>${esc(c)}</th>`).join('');
          const rows =
            t.rows.length > 0
              ? t.rows.map(r => `<tr>${r.map(c => `<td>${esc(cellText(c))}</td>`).join('')}</tr>`).join('')
              : `<tr><td colspan="${t.columns.length}" class="muted">no rows</td></tr>`;
          return `<div class="table${own ? ' own' : ''}"><div class="tname">${esc(t.name)}${own ? '<i>the host’s</i>' : ''}<span>${t.rows.length} row${t.rows.length === 1 ? '' : 's'}</span></div><div class="tscroll"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div></div>`;
        })
        .join('');
      return `<div class="db"><div class="run-title">${esc(name)}</div>${shownTables || '<div class="muted">no tables</div>'}</div>`;
    })
    .join('');
}
const cellText = (c: Cell): string =>
  c === null ? 'NULL' : c instanceof Uint8Array || c instanceof ArrayBuffer ? `<${c.byteLength} bytes>` : String(c);

function downloads(ex: Exchange): string {
  const blob = new Blob([JSON.stringify(ex.otlp, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  setTimeout(() => URL.revokeObjectURL(url), 120_000);
  const spans = ex.otlp.resourceSpans.reduce((n, r) => n + r.scopeSpans[0].spans.length, 0);
  return `<div class="dl"><a class="btn sm" href="${url}" download="tape-trace-${ex.n}.otlp.json">Download OTLP/JSON</a><button type="button" class="btn sm ghost" data-copy>Copy</button><span class="muted">${spans} span${spans === 1 ? '' : 's'} in ${ex.otlp.resourceSpans.length} resource${ex.otlp.resourceSpans.length === 1 ? '' : 's'}</span></div>`;
}

function spansView(ex: Exchange): string {
  const svg = renderSvg(ex);
  const pic =
    'svg' in svg
      ? `<figure class="svg">${svg.svg}<figcaption>Drawn by <code>apps/trace/trace.tape</code> in this page from the request's OTLP/JSON, in ${ms(svg.ms)}</figcaption></figure>`
      : `<div class="placeholder"><b>The trace renderer did not draw this.</b><span>${esc(svg.error)}</span></div>`;
  return `${pic}${downloads(ex)}`;
}
function renderSvg(ex: Exchange): { svg: string; ms: number } | { error: string } {
  const had = svgs.get(ex);
  if (had) return had;
  let made: { svg: string; ms: number } | { error: string };
  if (!trace)
    made = { error: stats.renderer.error ?? 'apps/trace/trace.tape is not in this build (or has not compiled yet).' };
  else
    try {
      const t0 = performance.now();
      const raw = trace.app.handle(enc.encode(JSON.stringify(ex.otlp)));
      const took = performance.now() - t0;
      stats.svg.push(took);
      const svgText = dec.decode(responseOf(raw).body);
      // inline, so the page's theme reaches it; its <style> is the page's a/trace.*.css (the policy allows no inline
      // style), and nothing in it can run: the policy allows no inline script or handler either
      made = { svg: splitSvg(svgText).svg, ms: took };
    } catch (err) {
      made = { error: `trace.tape stopped: ${err instanceof Error ? err.message : String(err)}` };
    }
  // not kept while the renderer is still compiling: the page draws it again when the renderer is ready
  if (trace) svgs.set(ex, made);
  return made;
}

function renderHistory(): void {
  const box = $('history');
  const list = bench?.exchanges ?? [];
  box.hidden = list.length === 0;
  box.innerHTML = `<div class="card-title">History <span class="muted">${list.length}</span><button type="button" class="link" id="reset">Empty the databases</button></div>${list
    .toReversed()
    .map(ex => {
      const [line = ''] = ex.request.split('\n');
      return `<button type="button" class="hrow${ex === shown ? ' on' : ''}" data-ex="${ex.n}"><span class="n">#${ex.n}</span><span class="badge ${statusClass(ex.status)}">${ex.status}</span><code>${esc(line)}</code><span class="took">${ms(ex.ms)}</span></button>`;
    })
    .join('')}`;
}
$('history').addEventListener('click', e => {
  if (targetId(e) === 'reset' && bench) {
    bench.reset();
    shown = null;
    renderHistory();
    renderResult();
    renderTimers();
    return;
  }
  const b = around(e, '[data-ex]');
  const ex = bench?.exchanges.find(x => x.n === Number(b?.dataset['ex']));
  if (!ex) return;
  shown = ex;
  renderResult();
  renderHistory();
});

// ---------- timers

function renderTimers(): void {
  const box = $('timers'),
    list = bench?.timers() ?? [];
  box.hidden = list.length === 0;
  if (list.length === 0) return;
  const now = Date.now();
  box.innerHTML = `<div class="card-title">Timers <span class="muted">set by wake(); a real object would run each when it is due</span></div>${list
    .map(
      t =>
        `<div class="timer"><code>${esc(t.program)}</code> key <b>${t.key}</b><span class="muted">${t.due > now ? `due in ${((t.due - now) / 1000).toFixed(1)} s` : 'due now'}</span><button type="button" class="btn sm" data-fire="${esc(t.program)}:${t.key}:${t.due}">Run now</button></div>`,
    )
    .join('')}`;
}
setInterval(() => {
  if ($('timers').hidden === false) renderTimers();
}, 1000);
$('timers').addEventListener('click', e => {
  const b = around(e, '[data-fire]');
  if (!b || !bench) return;
  const [program = '', key = '0', due = '0'] = (b.dataset['fire'] ?? '').split(':');
  void bench.fire(program, Number(key), Number(due)).then(ex => {
    if (ex) shown = ex;
    renderResult();
    renderHistory();
    renderTimers();
    return null;
  });
});

// ---------- format and simulate

async function formatNow(): Promise<void> {
  {
    const a = await ask<'format'>({ kind: 'format', file: `${current}.tape`, text: editor.value });
    if (a.kind !== 'format') return;
    if (a.text === null) {
      say(`tape fmt: ${a.error ?? 'refused'}`, 'bad');
      return;
    }
    if (a.text === editor.value) {
      say(`${current}.tape is in tape fmt's layout already`, 'ok');
      return;
    }
    // through the editor, so undo takes it back
    editor.area.focus();
    editor.area.select();
    // oxlint-disable-next-line typescript/no-deprecated -- no other way to edit a textarea keeps its undo stack
    if (!document.execCommand('insertText', false, a.text)) {
      editor.value = a.text;
      editor.area.dispatchEvent(new Event('input'));
    }
  }
}
$('format').addEventListener('click', () => {
  void formatNow();
});

let simulating = false;
$('simulate').addEventListener('click', () => {
  void simulateNow();
});
async function simulateNow(): Promise<void> {
  if (!example || simulating) return;
  const box = $('sim');
  simulating = true;
  box.hidden = false;
  box.innerHTML = `<div class="card-title">Simulation <span class="muted">tape sim ${esc(example.files.map(f => `${f.name}.tape`).join(' '))}</span></div><div class="sim-run"><span class="spinner"></span>Running random requests, lost and cut calls, timers and the clock against the invariants…</div>`;
  await sqlite;
  const files = example.files.map(f => ({ name: f.name, text: texts[f.name] ?? '' }));
  const a = await ask<'sim'>({
    kind: 'sim',
    files,
    wasm: (sqliteWasm ?? new ArrayBuffer(0)).slice(0),
    seeds: example.seeds ?? 300,
  });
  simulating = false;
  if (a.kind === 'error') {
    box.innerHTML = `<div class="card-title">Simulation</div><pre class="block bad">${esc(a.message)}</pre>`;
    return;
  }
  if (a.kind !== 'sim') return;
  renderSim(a.result);
}
function renderSim(r: SimResult): void {
  const box = $('sim');
  const plant = example?.plant;
  const planted = plant ? (texts[plant.file] ?? '').includes(plant.to) : false;
  const plantButton = plant
    ? `<button type="button" class="btn sm${planted ? ' ghost' : ''}" id="plant">${planted ? 'Take the bug out' : 'Plant a bug'}</button>`
    : '';
  const headline = r.failure
    ? `<div class="verdict bad"><b>${esc(r.failure.kind)}</b> ${esc(r.failure.violations.join('; '))}<span>found in run ${r.runs}, shrunk from ${r.failure.shrunkFrom} choices to ${r.failure.choices}, ${ms(r.ms)}</span></div><div class="replay"><code>${esc(r.failure.replay)}</code></div>`
    : r.ok
      ? `<div class="verdict ok"><b>Nothing wrong</b><span>${r.runs} runs, ${ms(r.ms)}</span></div>`
      : `<div class="verdict bad"><b>The simulator could not start</b></div>`;
  box.innerHTML = `<div class="card-title">Simulation <span class="muted">tape sim, in this page</span>${plantButton}<button type="button" class="link" id="sim-again">Run again</button><button type="button" class="link" id="sim-close" aria-label="Close">Close</button></div>${plant && !planted ? `<p class="muted small">${esc(`Plant: ${plant.what}. Every rule is satisfied; only a run finds it.`)}</p>` : ''}${headline}<details${r.failure ? ' open' : ''}><summary>Output</summary><pre class="block sim-out">${esc(r.lines.join('\n'))}</pre></details>`;
}
$('sim').addEventListener('click', e => {
  const id = targetId(e);
  if (id === 'sim-close') $('sim').hidden = true;
  if (id === 'sim-again') void simulateNow();
  if (id === 'plant' && example?.plant) {
    const p = example.plant;
    const text = texts[p.file] ?? '';
    const next = text.includes(p.to) ? text.replace(p.to, p.from) : text.replace(p.from, p.to);
    texts[p.file] = next;
    if (current !== p.file) current = p.file;
    editor.value = next;
    const at = next.split('\n').findIndex(l => l.includes(next.includes(p.to) ? p.to : p.from));
    if (at >= 0) editor.revealLine(at + 1);
    void recompile(p.file).then(() => simulateNow());
  }
});

// ---------- start

async function start(): Promise<void> {
  const hl = await tool(config.highlight).catch((err: unknown) => {
    console.error(err);
    return null;
  });
  if (hl) {
    stats.highlighter = { ms: hl.build, wasm: hl.wasm };
    editor.setHighlighter(text => dec.decode(responseOf(hl.app.handle(enc.encode(text))).body));
  }
  times['highlighter'] = performance.now();
  await load(location.hash.slice(1) || 'hello');
  if (!phone.matches) editor.area.focus({ preventScroll: true });
  stats.ready = true;
  times['ready'] = performance.now();
  // ms since the navigation began (as the homepage's), when a request can be sent
  document.body.dataset['ready'] = String(Math.round(times['ready']));
  tool(config.trace)
    .then(t => {
      trace = t;
      stats.renderer = { ms: t.build, wasm: t.wasm, error: null };
      if (shown && tab === 'spans') renderResult();
      return null;
    })
    .catch((err: unknown) => {
      stats.renderer.error = `apps/trace/trace.tape did not load: ${err instanceof Error ? err.message : String(err)}`;
      if (shown && tab === 'spans') renderResult();
    });
}
window.addEventListener('hashchange', () => {
  const id = location.hash.slice(1);
  if (id && id !== example?.id) void load(id);
});
Object.assign(window, {
  __pg: {
    editor,
    stats,
    times,
    get bench() {
      return bench;
    },
    get shown() {
      return shown;
    },
    send,
    load,
  },
});
try {
  await start();
} catch (err) {
  say(`The playground did not start: ${err instanceof Error ? err.message : String(err)}`, 'bad');
  console.error(err);
}
