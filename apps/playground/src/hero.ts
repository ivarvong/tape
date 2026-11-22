// apps/playground/src/hero.ts: what the homepage shows, and how it is drawn. The same functions draw the page's
// static copy at build time (apps/playground/build.ts, from a run of the real compiler and host in Node) and the
// live one in the browser (src/home.ts), so what is there before the script loads is what the script draws.
import { escapeHtml as esc } from './editor.ts';
import type { Line } from './workbench.ts';

/** The program in the editor, the request the buttons send, and the line the refusal button takes out. */
export const HERO = { example: 'hello', program: 'hello', name: 'Ada' } as const;
export const requestFor = (name: string): string => `GET /hello/${name}\n`;
const REPEAT = /^[ \t]*repeat: True,[ \t]*\n/m;
export const hasRepeat = (text: string): boolean => REPEAT.test(text);
/** The program without its `repeat: True,` line (an error if it has none: the page's point would be gone). */
export function withoutRepeat(text: string): string {
  if (!REPEAT.test(text)) throw new Error('the program has no `repeat: True,` line to take out');
  return text.replace(REPEAT, '');
}
/** Put the line back where it was, after `row: Count,` (as examples/hello.tape has it). */
export function withRepeat(text: string, original: string): string {
  if (REPEAT.test(text)) return text;
  const line = REPEAT.exec(original)?.[0] ?? '';
  const at = original.indexOf(line),
    before = original.slice(0, at),
    anchor = before.slice(before.lastIndexOf('\n', before.length - 2) + 1);
  const i = text.indexOf(anchor);
  return i < 0 ? text : text.slice(0, i + anchor.length) + line + text.slice(i + anchor.length);
}
/** Where `repeat: True,` would go back into a text that lost it, as a line to add after a line number (1-based). */
export function repeatFix(text: string, original: string): { after: number; text: string } | undefined {
  const put = withRepeat(text, original);
  if (put === text) return undefined;
  const a = put.split('\n'),
    b = text.split('\n');
  const i = a.findIndex((l, k) => l !== b[k]);
  return i < 0 ? undefined : { after: i, text: a[i] ?? '' };
}
/** The multi-program request drawn below the hero: the fulfillment example's "No carrier" preset. */
export const FULFILLMENT = { example: 'fulfillment', preset: 'No carrier' } as const;

/** A request as the page lists it, with the arm of the program's own code its run took last (from its trace). */
export type Shown = { n: number; line: string; status: number; body: string; arm?: Arm | null };
export type Arm = { line: number; text: string };
/** A diagnostic as the page shows it. */
export type Refusal = { file: string; line: number; code: string; message: string; hint?: string | undefined };

const statusClass = (s: number): string => `s${String(s)[0] ?? '2'}`;

/** The last arm a run's trace says it took in the program's own code (✓), if any. */
export function armOf(trace: readonly Line[]): Arm | null {
  const ok = trace.findLast(l => l.kind === 'ok' && typeof l.line === 'number');
  return ok?.line === undefined ? null : { line: ok.line, text: ok.text };
}

export function responsesView(list: readonly Shown[]): string {
  return list
    .map(
      (x, i) =>
        `<li${i === list.length - 1 ? ' class="new"' : ''}><span class="n">#${x.n}</span><span class="badge ${statusClass(x.status)}">${x.status}</span><code class="rb">${esc(x.body) || '<span class="muted">(empty)</span>'}</code>${x.arm ? `<span class="arm" data-line="${x.arm.line}" title="${esc(x.arm.text)}">took line ${x.arm.line}</span>` : '<span></span>'}<code class="rq">${esc(x.line)}</code></li>`,
    )
    .join('');
}

/**
 * The moment the page is about: the same request, sent again, took another arm. Said only when the runs show it:
 * the last two runs sent the same request and their traces end in different lines.
 */
export function momentView(list: readonly Shown[]): string {
  const [a, b] = list.slice(-2);
  if (!a || !b || a.line !== b.line || !a.arm || !b.arm || a.arm.line === b.arm.line) return '';
  return `<p class="moment" role="note"><span class="glyph" aria-hidden="true">↳</span><span><b>Same request, another arm.</b> #${b.n} took line ${b.arm.line}, where #${a.n} took line ${a.arm.line}: <code>${esc(b.arm.text.length > 64 ? `${b.arm.text.slice(0, 63)}…` : b.arm.text)}</code></span></p>`;
}

/** The effect log: what the host recorded, one entry an item; a query in the program's own words and its values. */
export function logView(lines: readonly Line[]): string {
  return lines
    .map(l => {
      if (l.sql) {
        const q = esc(l.sql.query).replaceAll(/(:[A-Za-z_]\w*)/g, '<span class="ph">$1</span>');
        const binds = l.sql.binds
          .map(([k, v]) => `<span><code>${esc(k)}</code> = <span class="v">${esc(v)}</span></span>`)
          .join('');
        return `<li class="k-sql"><span class="lk">sql</span><code class="lq">${q}</code><span class="lb">${binds}<span class="lr">${esc(l.sql.result)}</span></span></li>`;
      }
      const [kind = '', ...rest] = l.text.split(/\s+/);
      return `<li class="k-${esc(l.kind)}"><span class="lk">${esc(kind)}</span><code class="lq">${esc(rest.join(' '))}</code></li>`;
    })
    .join('');
}

/** The trace computed from the log: each function entered, each arm tried (✓ taken, ✗ not), with its line. */
export function traceView(lines: readonly Line[]): string {
  return lines
    .map(l => {
      const mark = l.kind === 'ok' ? '✓' : l.kind === 'no' ? '✗' : '';
      const label = l.kind === 'ok' ? ' aria-label="taken"' : l.kind === 'no' ? ' aria-label="not taken"' : '';
      return `<div class="tl k-${esc(l.kind)}"><span class="ln">${l.line ?? ''}</span><span class="mk"${label}>${mark}</span><span class="tx">${esc(l.text)}</span></div>`;
    })
    .join('');
}

/**
 * A refusal as rustc and Elm show one: the rule and the message, the program's lines around the one refused with
 * that line underlined, and what the compiler says to change. `source` is the text that was compiled; `fix`, a line
 * that put back after the refused line would make it compile, is shown as an added line.
 */
export function refusalView(
  d: Refusal,
  source = '',
  o: { live?: boolean; fix?: { after: number; text: string } | undefined } = {},
): string {
  const lines = source.split('\n');
  const at = d.line;
  const from = Math.max(1, at - 1),
    to = Math.min(lines.length, Math.max(at + 2, o.fix?.after ?? 0));
  const width = String(to).length;
  const row = (n: number | string, text: string, cls = ''): string =>
    `<span class="fl${cls ? ` ${cls}` : ''}"><span class="fn">${String(n).padStart(width)}</span>${esc(text)}</span>`;
  let frame = '';
  if (source && lines[at - 1] !== undefined) {
    const rows: string[] = [];
    for (let n = from; n <= to; n++) {
      const text = lines[n - 1] ?? '';
      rows.push(row(n, text, n === at ? 'at' : ''));
      if (n === at) {
        const lead = /^\s*/.exec(text)?.[0].length ?? 0,
          body = text.trimEnd().length - lead;
        rows.push(
          `<span class="fl caret"><span class="fn"></span>${' '.repeat(lead)}${'^'.repeat(Math.max(1, body))}</span>`,
        );
      }
      if (o.fix && o.fix.after === n) rows.push(row('+', o.fix.text, 'add'));
    }
    frame = `<pre class="frame" aria-label="${esc(d.file)}, lines ${from} to ${to}">${rows.join('')}</pre>`;
  }
  return `<div class="refusal"${o.live ? ' role="alert"' : ''}><div class="rhead"><span class="sev">error[${esc(d.code)}]</span><span class="where">${esc(d.file)}:${d.line}</span></div><p class="msg">${esc(d.message)}</p>${frame}${d.hint ? `<p class="help"><b>help</b><span>${esc(d.hint)}</span></p>` : ''}</div>`;
}

/**
 * trace.tape's SVG, to be put in the page: its <style> is the same text for every trace, and is served as a file
 * (the page's policy allows no inline style), so it is taken out here. Returns the SVG and the style it had.
 */
export function splitSvg(svg: string): { svg: string; style: string } {
  const m = /<style>([\s\S]*?)<\/style>/.exec(svg);
  if (!m || !/^\s*<svg[\s>]/.test(svg)) throw new Error(`trace.tape did not draw an SVG: ${svg.slice(0, 80)}`);
  return { svg: svg.replace(m[0], ''), style: m[1] ?? '' };
}
