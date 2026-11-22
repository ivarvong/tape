// apps/playground/src/editor.ts: a code editor that is a plain <textarea> over a <pre>. The textarea takes every
// keystroke, the selection, IME composition, undo and the caret; its text is transparent. Under it the <pre> holds
// the same text, highlighted by highlight.tape. Both sit in one grid cell inside one scroll container, with the
// same font, size, line height, padding and tab size, so they cannot drift apart and nothing has to sync scroll
// positions: the textarea is sized by the <pre>, and the container scrolls them together.
//
// Diagnostics are drawn where they are: the line is marked behind the text, the gutter number is marked, and the
// message is written at the end of the line in the <pre> (past the code, so it moves no character the textarea has).

export type Mark = { line: number; code: string; message: string; hint?: string };
export type Stats = { highlightMs: number; renderMs: number; bytes: number; spans: number };

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
export const escapeHtml = (s: string): string => s.replaceAll(/[&<>"]/g, c => ESC[c] ?? c);

/**
 * The highlighted HTML with each mark's message at the end of its line: before the line's newline, which in the
 * highlighter's output is always a literal LF outside any tag (a tag never holds one), possibly inside a span that
 * runs over several lines (SQL, a text carried on), which the message closes and reopens nothing of: it is one span.
 */
export function withMarks(html: string, marks: readonly Mark[]): string {
  if (marks.length === 0) return html;
  const byLine = new Map<number, Mark[]>();
  for (const m of marks) byLine.set(m.line, [...(byLine.get(m.line) ?? []), m]);
  let out = '',
    line = 1,
    from = 0;
  const lens = (ms: Mark[]): string =>
    `<span class="lens">${ms.map(m => `<b>${escapeHtml(m.code)}</b> ${escapeHtml(m.message)}`).join('  ·  ')}</span>`;
  for (let i = html.indexOf('\n'); ; i = html.indexOf('\n', i + 1)) {
    const at = i < 0 ? html.length : i,
      ms = byLine.get(line);
    out += html.slice(from, at) + (ms ? lens(ms) : '');
    from = at;
    line++;
    if (i < 0) break;
  }
  return out + html.slice(from);
}

export class Editor {
  readonly root: HTMLElement;
  readonly area: HTMLTextAreaElement;
  readonly code: HTMLElement;
  readonly gutter: HTMLElement;
  readonly bars: HTMLElement;
  readonly scroller: HTMLElement;
  readonly callout: HTMLElement;
  stats: Stats = { highlightMs: 0, renderMs: 0, bytes: 0, spans: 0 };
  #highlight: ((text: string) => string) | null = null;
  #html = '';
  #marks: Mark[] = [];
  /** lines a run took (an arm, from its trace), drawn as a quiet green bar */
  #hits: number[] = [];
  #lines = 0;
  #listeners: ((text: string) => void)[] = [];
  #queued = false;
  readOnly = false;

  constructor(root: HTMLElement) {
    this.root = root;
    root.classList.add('editor');
    root.innerHTML = `<div class="scroller"><div class="sheet"><pre class="gutter" aria-hidden="true"></pre><div class="stack"><div class="bars" aria-hidden="true"></div><pre class="hl" aria-hidden="true"><code></code></pre><textarea spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off" wrap="off" aria-label="Program source"></textarea></div></div></div>`;
    const q = <T extends Element>(sel: string, kind: abstract new () => T): T => {
      const el = root.querySelector(sel);
      if (!(el instanceof kind)) throw new TypeError(`editor: no ${sel}`);
      return el;
    };
    this.scroller = q('.scroller', HTMLElement);
    this.gutter = q('.gutter', HTMLElement);
    this.bars = q('.bars', HTMLElement);
    this.code = q('.hl code', HTMLElement);
    this.area = q('textarea', HTMLTextAreaElement);
    this.area.addEventListener('input', () => {
      if (this.#hits.length > 0) {
        this.#hits = [];
        this.#lines = -1;
      }
      this.render();
      for (const f of this.#listeners) f(this.area.value);
    });
    this.area.addEventListener('keydown', e => this.#key(e));
    // the first mark's message, also drawn just under its line at the editor's right edge: the end of a long line
    // (where the message is written in the <pre>) may be out of view
    this.callout = document.createElement('div');
    this.callout.className = 'callout';
    this.callout.setAttribute('role', 'note');
    root.append(this.callout);
    this.scroller.addEventListener('scroll', () => this.#place(), { passive: true });
  }

  /** The highlighter: source text in, HTML out (null until it has compiled: the text is shown plain). */
  setHighlighter(f: (text: string) => string): void {
    this.#highlight = f;
    this.render();
  }

  get value(): string {
    return this.area.value;
  }
  set value(text: string) {
    this.area.value = text;
    this.area.setSelectionRange(0, 0);
    this.scroller.scrollTo(0, 0);
    this.render();
  }
  onInput(f: (text: string) => void): void {
    this.#listeners.push(f);
  }
  setReadOnly(ro: boolean): void {
    this.readOnly = ro;
    this.area.readOnly = ro;
    this.root.classList.toggle('readonly', ro);
  }

  /** Highlight the text and draw it, with the marks. */
  render(): void {
    const text = this.area.value,
      t0 = performance.now();
    let html: string;
    try {
      html = this.#highlight ? this.#highlight(text) : escapeHtml(text);
    } catch {
      html = escapeHtml(text);
    }
    const t1 = performance.now();
    this.#html = html;
    this.#draw();
    const lines = text.split('\n').length;
    if (lines !== this.#lines) {
      this.#lines = lines;
      this.#gutter();
    }
    this.stats = { highlightMs: t1 - t0, renderMs: performance.now() - t1, bytes: text.length, spans: 0 };
  }

  #draw(): void {
    const text = this.area.value;
    // a text that ends with a line break has an empty last line the <pre> would not show: give it one space
    this.code.innerHTML = withMarks(this.#html, this.#marks) + (text.endsWith('\n') || text === '' ? ' ' : '');
    const marked = new Set(this.#marks.map(m => m.line));
    this.bars.innerHTML = [
      ...this.#hits.filter(l => !marked.has(l)).map(l => `<div class="bar hit" data-line="${l}"></div>`),
      ...[...marked].map(l => `<div class="bar" data-line="${l}"></div>`),
    ].join('');
    for (const bar of this.bars.querySelectorAll<HTMLElement>('.bar'))
      bar.style.setProperty('--row', String(Number(bar.dataset['line']) - 1));
  }

  #gutter(): void {
    const marked = new Set(this.#marks.map(m => m.line)),
      hit = new Set(this.#hits);
    let s = '';
    for (let i = 1; i <= this.#lines; i++)
      s += marked.has(i)
        ? `<span class="err">${i}</span>\n`
        : hit.has(i)
          ? `<span class="hit">${i}</span>\n`
          : `${i}\n`;
    this.gutter.innerHTML = s;
  }

  setMarks(marks: readonly Mark[]): void {
    const same = JSON.stringify(marks) === JSON.stringify(this.#marks);
    if (same) return;
    this.#marks = [...marks];
    const [first] = marks;
    this.callout.innerHTML = first
      ? `<b>${escapeHtml(first.code)}</b> ${escapeHtml(first.message)}${first.hint ? `<span>${escapeHtml(first.hint)}</span>` : ''}`
      : '';
    this.#place();
    this.#draw();
    this.#gutter();
  }

  /** Lines a run took, marked until the text changes (an edit makes them stale: they are cleared). */
  setHits(lines: readonly number[]): void {
    if (JSON.stringify(lines) === JSON.stringify(this.#hits)) return;
    this.#hits = [...lines];
    this.#draw();
    this.#gutter();
  }

  /** The callout under its line, while that line is in view. */
  #place(): void {
    const [first] = this.#marks;
    const lh = Number(getComputedStyle(this.code).lineHeight.replace('px', '')) || 20,
      pad = Number(getComputedStyle(this.code).paddingTop.replace('px', '')) || 0;
    const top = pad + (first?.line ?? 0) * lh - this.scroller.scrollTop;
    const shown = first !== undefined && top >= 0 && top + lh <= this.scroller.clientHeight;
    this.callout.hidden = !shown;
    if (shown) this.callout.style.setProperty('--top', `${top}px`);
  }

  /** Put the caret on a line (selecting it) and scroll it into view. */
  revealLine(line: number): void {
    const lines = this.area.value.split('\n'),
      n = Math.max(1, Math.min(line, lines.length));
    const start = lines.slice(0, n - 1).reduce((a, l) => a + l.length + 1, 0);
    this.area.focus({ preventScroll: true });
    this.area.setSelectionRange(start, start + (lines[n - 1]?.length ?? 0));
    const lh = Number(getComputedStyle(this.code).lineHeight.replace('px', '')) || 20;
    const y = (n - 1) * lh;
    if (y < this.scroller.scrollTop || y > this.scroller.scrollTop + this.scroller.clientHeight - 2 * lh)
      this.scroller.scrollTo({ top: Math.max(0, y - this.scroller.clientHeight / 3) });
  }

  // Tab indents two spaces (Escape first, then Tab, leaves the editor); Enter keeps the line's indentation and adds
  // two after an opening bracket. Both go through insertText, so undo keeps them.
  #escaped = false;
  #key(e: KeyboardEvent): void {
    if (this.readOnly || e.isComposing) return;
    if (e.key === 'Escape') {
      this.#escaped = true;
      return;
    }
    if (e.key === 'Tab' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !this.#escaped) {
      e.preventDefault();
      this.#insert('  ');
    } else if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const a = this.area,
        before = a.value.slice(0, a.selectionStart),
        line = before.slice(before.lastIndexOf('\n') + 1),
        indent = /^[ \t]*/.exec(line)?.[0] ?? '',
        opens = /[{([]\s*$/.test(line);
      e.preventDefault();
      this.#insert(`\n${indent}${opens ? '  ' : ''}`);
    }
    this.#escaped = false;
  }

  #insert(text: string): void {
    // execCommand keeps the browser's undo stack; where it is gone, setRangeText (no undo for this edit)
    // oxlint-disable-next-line typescript/no-deprecated -- no other way to edit a textarea keeps its undo stack
    const done = typeof document.execCommand === 'function' && document.execCommand('insertText', false, text);
    if (!done) {
      const a = this.area;
      a.setRangeText(text, a.selectionStart, a.selectionEnd, 'end');
      a.dispatchEvent(new Event('input'));
    }
  }

  /** Re-highlight on the next frame (several edits in one frame cost one). */
  queue(): void {
    if (this.#queued) return;
    this.#queued = true;
    requestAnimationFrame(() => {
      this.#queued = false;
      this.render();
    });
  }
}
