// apps/highlight/page.ts: compile highlight.tape here, with the repository's compiler, then highlight the textarea
// on every edit. The compiler and host are the tree's own .ts files, served with their types stripped (serve.ts).
import { compile } from '../../compiler.ts';
import type { Source } from '../../compiler.ts';
import { instantiate } from '../../host.ts';

const $ = <T extends HTMLElement>(id: string, kind: abstract new () => T): T => {
  const el = document.querySelector(`#${id}`);
  if (!(el instanceof kind)) throw new TypeError(`no #${id} of the kind the page needs`);
  return el;
};
const status = $('status', HTMLElement),
  src = $('src', HTMLTextAreaElement),
  out = $('out', HTMLElement),
  code = out.firstElementChild ?? out;
const enc = new TextEncoder(),
  dec = new TextDecoder();
const say = (text: string, bad = false): void => {
  status.textContent = text;
  status.classList.toggle('bad', bad);
};
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** std.json, as serve.ts writes it: the standard library's files, each a name and its text. */
const isSources = (v: unknown): v is Source[] =>
  Array.isArray(v) &&
  v.every(
    (s: unknown) =>
      typeof s === 'object' &&
      s !== null &&
      'name' in s &&
      typeof s.name === 'string' &&
      'text' in s &&
      typeof s.text === 'string',
  );

$('theme', HTMLElement).addEventListener('click', () => {
  const root = document.documentElement,
    chosen = root.dataset['theme'],
    dark =
      chosen === undefined || chosen === '' ? matchMedia('(prefers-color-scheme: dark)').matches : chosen === 'dark';
  root.dataset['theme'] = dark ? 'light' : 'dark';
});

async function start(): Promise<void> {
  const [std, own] = await Promise.all([
    fetch('std.json').then((r): Promise<unknown> => r.json()),
    fetch('highlight.tape').then(r => r.text()),
  ]);
  if (!isSources(std)) throw new Error('std.json is not a list of files');
  const t0 = performance.now(),
    built = compile([...std, { name: 'highlight.tape', text: own }]),
    compiled = performance.now() - t0;
  if (!built.wasm) {
    say(built.errors.map(e => `${e.file}:${e.line}: ${e.code} ${e.message}`).join('\n'), true);
    return;
  }
  const app = instantiate(new WebAssembly.Module(built.wasm), {});
  const about = `compiled highlight.tape in ${compiled.toFixed(0)} ms (${built.wasm.length} bytes of Wasm)`;
  let queued = false;
  const render = (): void => {
    queued = false;
    const input = enc.encode(src.value),
      t = performance.now();
    try {
      const html = dec.decode(app.handle(input)),
        ms = performance.now() - t,
        cost = app.exports['cost'],
        steps = cost instanceof WebAssembly.Global ? String(cost.value) : '?';
      // The HTML is the highlighter's output: every byte of the source is escaped by it (test.ts gates this).
      code.innerHTML = html;
      say(
        `${about} · ${input.length} bytes highlighted in ${ms.toFixed(1)} ms, ${steps} steps, ${code.querySelectorAll('span').length} spans`,
      );
    } catch (e) {
      say(`${about} · ${input.length} bytes: ${messageOf(e)}`, true);
    }
  };
  src.addEventListener('input', () => {
    if (!queued) requestAnimationFrame(render);
    queued = true;
  });
  src.addEventListener('scroll', () => {
    out.scrollTop =
      (src.scrollTop / Math.max(1, src.scrollHeight - src.clientHeight)) * (out.scrollHeight - out.clientHeight);
  });
  src.value = own;
  render();
  document.body.dataset['ready'] = '1';
}

try {
  await start();
} catch (e) {
  say(`failed: ${messageOf(e)}`, true);
  console.error(e);
}
