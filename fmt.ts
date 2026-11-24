// fmt.ts: the canonical layout of a Tape file. `node tape.ts fmt [--check] files…`
//
// A statement, an arm or a step starts a line, as the language already requires. A line longer than 100 columns is
// broken, and in one way: before each `|>` of the line; failing that, before each `and` and `or` outside brackets;
// failing that, inside its widest pair of brackets, one argument to a line. A text literal is never broken, so a
// line may still be long for the text it holds. A line that starts with an operator, or follows one that ends with
// `->`, is indented once more, as a `|>` line is. `flat` is the other direction: every step on one line.
// Within a line, spacing is fixed: one space around binary operators, `->`, `<-`, `=`, `|>` and `++`; one after `,` and `:`;
// none inside brackets, before `(` or `[` of a call, a constructor, a type argument or an index, or around `.`.
// Indentation is two spaces per line that left a bracket open, and two more for a line that starts with `|>`. At most one blank line in a row, none after an
// opening `{` or before a closing `}`, none at the start, and one newline at the end. Comments, text literals and
// migration SQL are kept exactly as written; a comment after code is set off by two spaces.
//
// A file that does not parse is not formatted: the parse error is thrown, as the compiler reports it.
import { readFileSync } from 'node:fs';
import { parseProgram } from './compiler.ts';
import { BYTE_ESC, CONTINUES } from './compiler/lex.ts';

// longest first, so `->` is not read as `-`
const OPS = [
  '->',
  '|>',
  '++',
  '==',
  '!=',
  '<=',
  '>=',
  '<<',
  '>>',
  '(',
  ')',
  '{',
  '}',
  '[',
  ']',
  ',',
  ':',
  '.',
  '=',
  '<',
  '>',
  '+',
  '-',
  '*',
  '/',
  '%',
  '&',
  '|',
  '^',
  '_',
];
/**
 * In a text literal: the backslash that ends a line, and the line end, held as NUL and the line end (as wide) until
 * it is printed. As the backslash itself, the printer also found it in a migration's or an invariant's SQL, which is
 * left as written, and indented the line after it again on every run of fmt (fuzz/compile.ts, 23 November 2026).
 */
const CARRY = '\u0000\n';
const CLOSER: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}' };
const WORDS = new Set([
  'fn',
  'export',
  'type',
  'schema',
  'migration',
  'flag',
  'match',
  'with',
  'let',
  'do',
  'if',
  'else',
  'and',
  'or',
  'not',
]);

/** A token with its source text. A line break has none. */
type Tok = { t: 'word' | 'num' | 'str' | 'op' | 'sql' | 'comment'; v: string } | { t: 'nl'; v: '' };
type Prev = Tok | null;

const NUMBER = /[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?f?/y;
/** Where the run of characters that pass `test` ends, from `from`. */
const runEnd = (text: string, from: number, test: RegExp): number => {
  let j = from;
  while (test.test(text[j] ?? '')) j++;
  return j;
};

/** Is the `{` here the body of a migration or an invariant: text kept exactly as written? */
function opensSql(out: readonly Tok[]): boolean {
  const code = out.filter(x => x.t !== 'nl' && x.t !== 'comment');
  const inv = code.findLastIndex((x, k) => x.t === 'word' && x.v === 'invariant' && code[k + 1]?.t === 'str');
  const mig = Math.max(
    code.findLastIndex(x => x.t === 'word' && x.v === 'migration'),
    inv >= 0 && inv >= code.length - 9 ? code.length - 1 : -1,
  );
  return mig >= 0 && mig >= code.length - 4;
}

/** Where the SQL that opens at `i` ends: after the `}` that matches its `{` (the compiler's lexer does the same). */
function sqlEnd(text: string, i: number): number {
  let j = i + 1;
  for (let depth = 1; j < text.length && depth > 0; j++) {
    const c = text[j];
    if (c === "'" || c === '"') for (j++; j < text.length && text[j] !== c; j++);
    else if (c === '{') depth++;
    else if (c === '}') depth--;
  }
  return j;
}

/** The token at `i` and where the next one starts; null for white space, which is no token. */
function tokenAt(text: string, i: number, out: readonly Tok[]): [Tok | null, number] {
  const ch = text[i] ?? '';
  if (ch === '\n') return [{ t: 'nl', v: '' }, i + 1];
  if (ch === ' ' || ch === '\t' || ch === '\r') return [null, i + 1];
  if (ch === '/' && text[i + 1] === '/') {
    const j = runEnd(text, i, /[^\n]/);
    return [{ t: 'comment', v: text.slice(i, j).trimEnd() }, j];
  }
  if (ch === '"') {
    let j = i + 1;
    while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
    // a text carried over lines (a backslash ends each): kept without the indentation, which is fmt's to give
    return [{ t: 'str', v: text.slice(i, j + 1).replaceAll(/\\\n[ \t]*/g, CARRY) }, j + 1];
  }
  // a byte literal, kept as written: one character, or a backslash and an escape, then the closing quote
  if (ch === "'") {
    const escaped = text[i + 1] === '\\';
    const end = i + (escaped ? 4 : 3);
    if (text[end - 1] !== "'" || (escaped && !Object.hasOwn(BYTE_ESC, text[i + 2] ?? '')))
      throw new Error(`fmt: the character ${JSON.stringify(ch)} is not Tape`);
    return [{ t: 'num', v: text.slice(i, end) }, end];
  }
  if (ch >= '0' && ch <= '9') {
    // an Int, or a Float: `1.5f`, `1e-3f` (the lexer refuses the forms between)
    NUMBER.lastIndex = i;
    const j = i + (NUMBER.exec(text)?.[0].length ?? 1);
    return [{ t: 'num', v: text.slice(i, j) }, j];
  }
  if (/[A-Za-z]/.test(ch) || (ch === '_' && /[A-Za-z0-9_]/.test(text[i + 1] ?? ''))) {
    const j = runEnd(text, i, /[A-Za-z0-9_]/);
    return [{ t: 'word', v: text.slice(i, j) }, j];
  }
  if (ch === '{' && opensSql(out)) {
    const j = sqlEnd(text, i);
    return [{ t: 'sql', v: text.slice(i, j) }, j];
  }
  const op = OPS.find(o => text.startsWith(o, i));
  if (op === undefined) throw new Error(`fmt: the character ${JSON.stringify(ch)} is not Tape`);
  return [{ t: 'op', v: op }, i + op.length];
}

function tokens(text: string): Tok[] {
  const out: Tok[] = [];
  for (let i = 0; i < text.length;) {
    const [tok, next] = tokenAt(text, i, out);
    if (tok) out.push(tok);
    i = next;
  }
  return out;
}

const isWord = (x: Prev): boolean => x?.t === 'word' && !WORDS.has(x.v);
const is = (x: Prev, v: string): boolean => x?.t === 'op' && x.v === v;
// whether a `-` is a sign: nothing before it on the line, or an operator, an opening bracket, `,`, `:` or a keyword
const unary = (prev: Prev): boolean =>
  !prev ||
  (prev.t === 'op' && !is(prev, ')') && !is(prev, ']') && !is(prev, '_')) ||
  (prev.t === 'word' && WORDS.has(prev.v));

/** What goes between token a and token b on a line; `beforeA` is the token before a. */
function space(a: Prev, b: Tok, beforeA: Prev): string {
  if (!a) return '';
  if (b.t === 'comment') return '  ';
  if ([',', ')', ']', ':', '.'].some(v => is(b, v)) || ['.', '(', '['].some(v => is(a, v))) return '';
  if (is(a, '-') && unary(beforeA)) return '';
  if (is(b, '(')) return isWord(a) || is(a, ']') || (a.t === 'word' && a.v === 'fn' && !isWord(beforeA)) ? '' : ' ';
  if (is(b, '[')) return isWord(a) || is(a, ')') || is(a, ']') ? '' : ' ';
  return ' ';
}

/** A line being laid out: how far it is indented, its text so far, the two tokens before the next, and which
 * tokens it holds (from, and up to but not including, to). */
type Line = { indent: number; out: string; prev: Prev; before: Prev; from: number; to: number };
/** A bracket left open, the line it was opened on, and how far that line is indented. */
type Open = { ch: string; line: number; indent: number };

/** How far a line that starts at token k is indented: once more than the line that opened the innermost bracket
 * still open, so a bracket opened on a carried line (`|> append(`) indents what is inside it past that line; a line
 * that starts with closers stands where the line that opened the last of them stands, even when that line opened
 * another bracket still open (`twice(n: match n {` … `}, m: 3)`). */
function indentAt(toks: readonly Tok[], k: number, stack: readonly Open[]): number {
  const s = stack.slice();
  let closed: Open | null = null;
  for (let j = k; toks[j]?.t === 'op' && CLOSER[s.at(-1)?.ch ?? ''] === toks[j]?.v; j++) closed = s.pop() ?? null;
  if (closed) return closed.indent;
  const inner = s.at(-1);
  return inner ? inner.indent + 1 : 0;
}

/** The lines of a file, each with its spacing fixed; null for a run of blank lines. */
function layOut(toks: readonly Tok[]): (Line | null)[] {
  const lines: (Line | null)[] = [];
  const stack: Open[] = [];
  let line: Line | null = null;
  let lineNo = 0;
  let blank = 0;
  for (const [k, x] of toks.entries()) {
    if (x.t === 'nl') {
      if (line) lines.push(line);
      else blank++;
      line = null;
      lineNo++;
      continue;
    }
    if (!line) {
      if (blank > 0 && lines.length > 0) lines.push(null);
      blank = 0;
      const carriesOn = carries(x) || arrowBefore(toks, k) ? 1 : 0;
      line = { indent: indentAt(toks, k, stack) + carriesOn, out: '', prev: null, before: null, from: k, to: k };
    }
    line.out += space(line.prev, x, line.before) + x.v;
    line.to = k + 1;
    if (x.t === 'sql' || x.t === 'str') lineNo += (x.v.match(/\n/g) ?? []).length;
    if (x.t === 'op' && Object.hasOwn(CLOSER, x.v)) stack.push({ ch: x.v, line: lineNo, indent: line.indent });
    else if (x.t === 'op' && (x.v === ')' || x.v === ']' || x.v === '}')) stack.pop();
    [line.before, line.prev] = [line.prev, x];
  }
  if (line) lines.push(line);
  return lines;
}

// a line that starts with `|>`, a binary operator, `and` or `or` carries the step on, and so does one after a line
// that ends with `->` (compiler/lex.ts CONTINUES): indented once more, and joined back by `flat`
const carries = (x: Tok | undefined): boolean => !!x && (x.t === 'op' || x.t === 'word') && CONTINUES.has(x.v);
function arrowBefore(toks: readonly Tok[], k: number): boolean {
  for (let j = k - 1; j >= 0; j--) {
    const y = toks[j];
    if (y?.t === 'nl') continue;
    return y?.t === 'op' && y.v === '->';
  }
  return false;
}
const WIDTH = 100;
const NL: Tok = { t: 'nl', v: '' };
const opens = (x: Tok | undefined): boolean => x?.t === 'op' && (x.v === '(' || x.v === '[' || x.v === '{');
const closes = (x: Tok | undefined): boolean => x?.t === 'op' && (x.v === ')' || x.v === ']' || x.v === '}');
/** The widest of a line's physical lines: a text carried over lines has several. */
const widthOf = (l: Line): number =>
  Math.max(...l.out.split('\n').map((part, n) => 2 * (l.indent + (n > 0 ? 2 : 0)) + part.length));

/** How deep each token of a line is in the brackets opened on that line (a closer has its opener's depth). */
function depths(toks: readonly Tok[]): number[] {
  let d = 0;
  return toks.map(x => {
    if (closes(x)) d--;
    const at = d;
    if (opens(x)) d++;
    return at;
  });
}
/** The text of some tokens of a line, spaced as fmt spaces them. */
const textOf = (toks: readonly Tok[]): string =>
  toks.reduce((out, x, k) => out + space(toks[k - 1] ?? null, x, toks[k - 2] ?? null) + x.v, '');

/** A pair of round or square brackets opened and closed on a line, with something between them. */
type Group = { open: number; close: number };
function groups(toks: readonly Tok[], depth: readonly number[]): Group[] {
  const found: Group[] = [];
  toks.forEach((x, open) => {
    if (x.t !== 'op' || (x.v !== '(' && x.v !== '[')) return;
    const close = toks.findIndex((y, k) => k > open && depth[k] === depth[open] && closes(y));
    if (close > open + 1) found.push({ open, close });
  });
  return found;
}
/** Where a group's arguments end: the commas directly inside it, and its closer. */
const argEnds = (toks: readonly Tok[], depth: readonly number[], g: Group): number[] => [
  ...toks.flatMap((x, k) =>
    k > g.open && k < g.close && depth[k] === (depth[g.open] ?? 0) + 1 && x.t === 'op' && x.v === ',' ? [k] : [],
  ),
  g.close,
];
/** For each character of a literal's source (from outside any hole), whether it is inside a hole `\(…)`. A hole
 * holds no text literal (L05), so its brackets are counted as they stand. */
function inHole(s: string): boolean[] {
  const inside = Array.from({ length: s.length }, () => false);
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\') continue;
    if (s[i + 1] !== '(') {
      i++; // an escape: \\ or \" cannot start a hole
      continue;
    }
    let depth = 0;
    let j = i + 1;
    for (; j < s.length; j++) {
      inside[j] = true;
      if (s[j] === '(') depth++;
      else if (s[j] === ')' && --depth === 0) break;
    }
    i = j;
  }
  return inside;
}
/** A text too long for its line, carried over lines: broken after a space, each line as full as it may be. `tail`
 * is the width of what follows the text on its last line (a comma, a closing bracket). */
function carried(text: string, first: number, rest: number, tail: number): string {
  const lines: string[] = [];
  let left = text;
  for (let room = first; left.length + tail > room; room = rest) {
    // the last place within the room where a space is followed by something else; before a word in capitals
    // (a keyword of SQL) where there is one in the second half of the room, and not between two such words
    // (DO NOTHING, ORDER BY stay together). Never inside a hole, `\(…)`: it is an expression, and a carried
    // line ends the text, so a break there leaves the hole open (L05)
    const within = left.slice(0, Math.max(room - 1, 1));
    const open = inHole(within);
    const outside = (m: RegExpMatchArray): boolean => !open[m.index ?? 0];
    const keyword = [...within.matchAll(/(?<![A-Z]) (?=[A-Z]{2,}\b)/g)].findLast(outside)?.index;
    const at =
      keyword !== undefined && keyword >= room / 2
        ? keyword
        : [...within.matchAll(/ (?=[^ ])/g)].findLast(outside)?.index;
    if (at === undefined || at < 8) break;
    lines.push(left.slice(0, at + 1));
    left = left.slice(at + 1);
  }
  return [...lines, left].join(CARRY);
}
/** Where to break a line that is too wide: the tokens to start a new line at; none when it cannot be broken. */
function breaksOf(toks: readonly Tok[], indent: number): number[] {
  // a comment runs to the end of its line: such a line is left as it is
  if (toks.some(x => x.t === 'comment' || x.t === 'sql')) return [];
  const depth = depths(toks);
  // the step's own `|>`s: at depth 0, or after the closers a line starts with (`}) |> append(…)`)
  const pipes = toks.flatMap((x, k) => (k > 0 && depth[k] === baseOf(toks) && x.t === 'op' && x.v === '|>' ? [k] : []));
  if (pipes.length > 0) return pipes;
  // a long condition: before each `and` and `or` outside brackets, which carry the line on as `|>` does
  const logic = toks.flatMap((x, k) =>
    k > 0 && depth[k] === 0 && x.t === 'word' && (x.v === 'and' || x.v === 'or') ? [k] : [],
  );
  if (logic.length > 0) return logic;
  // the widest pair of brackets, one argument to a line: only where that makes every line narrower than this one,
  // and either the arguments then fit or there are several of them (one long text is better left where it is)
  const whole = 2 * indent + textOf(toks).length;
  const best = groups(toks, depth)
    .map(g => {
      const ends = argEnds(toks, depth, g);
      const args = ends.map((end, n) => textOf(toks.slice((ends[n - 1] ?? g.open) + 1, end)));
      const widest = Math.max(...args.map(a => 2 * (indent + 1) + a.length + 1));
      const head = 2 * indent + textOf(toks.slice(0, g.open + 1)).length;
      const tail = 2 * indent + textOf(toks.slice(g.close)).length;
      return {
        g,
        ends,
        width: g.close - g.open,
        helps: Math.max(widest, head, tail) < whole && (widest <= WIDTH || args.length > 1),
      };
    })
    .filter(c => c.helps)
    .toSorted((a, b) => b.width - a.width || b.g.open - a.g.open)[0];
  if (!best) return [];
  return [best.g.open + 1, ...best.ends.slice(0, -1).map(k => k + 1), best.g.close];
}
/** The line with its longest text carried over lines, when the line is too wide for that text alone. */
function carriedIn(toks: readonly Tok[], indent: number): Tok[] | null {
  if (toks.some(x => x.t === 'comment' || x.t === 'sql')) return null;
  const k = toks.reduce((best, x, at) => (x.t === 'str' && x.v.length > (toks[best]?.v.length ?? 0) ? at : best), -1);
  const text = toks[k];
  if (text?.t !== 'str' || text.v.includes(CARRY)) return null;
  const before = 2 * indent + textOf(toks.slice(0, k + 1)).length - text.v.length;
  const broken = carried(text.v, WIDTH - before, WIDTH - 2 * (indent + 2), textOf(toks.slice(k + 1)).length);
  return broken === text.v ? null : toks.map((x, at) => (at === k ? { t: 'str', v: broken } : x));
}

/** The depth of a line's own tokens: below 0 by the closers it starts with. */
function baseOf(toks: readonly Tok[]): number {
  let base = 0;
  for (let k = 0; k < toks.length && closes(toks[k]); k++) base--;
  return base;
}
/**
 * The `|>`s of a line that is part of a step spanning lines (it leaves a bracket open, or closes one an earlier line
 * opened), where the `|>` is the step's own, in no round or square bracket (`inside`, the innermost bracket open at
 * each token): a pipeline with a block in it (`|> append(view: match {` … `})`) is broken before each `|>`, however
 * narrow its lines, so each stage of it starts a line as it does in a pipeline that is only too wide.
 */
function spannedPipes(toks: readonly Tok[], inside: readonly (string | undefined)[]): number[] {
  if (toks.some(x => x.t === 'comment' || x.t === 'sql')) return [];
  // a bracket the line closes and did not open, or opens and does not close (`}) |> f(view: match {` does both)
  const depth = depths(toks);
  const low = Math.min(0, ...depth);
  const last = toks.at(-1);
  if (low === 0 && (depth.at(-1) ?? 0) + (opens(last) ? 1 : 0) === 0) return [];
  return toks.flatMap((x, k) =>
    k > 0 && x.t === 'op' && x.v === '|>' && (inside[k] === undefined || inside[k] === '{') ? [k] : [],
  );
}
/** For each token, the innermost bracket open where it stands. */
function insideOf(toks: readonly Tok[]): (string | undefined)[] {
  const open: string[] = [];
  return toks.map(x => {
    if (closes(x)) open.pop();
    const at = open.at(-1);
    if (opens(x)) open.push(x.v);
    return at;
  });
}

/** One pass: a line break put in at every place a line wider than WIDTH can be broken; null when there is none. */
function brokenOnce(toks: readonly Tok[]): Tok[] | null {
  const inside = insideOf(toks);
  const starts = new Set(
    layOut(toks).flatMap(l =>
      !l
        ? []
        : (widthOf(l) > WIDTH
            ? breaksOf(toks.slice(l.from, l.to), l.indent)
            : spannedPipes(toks.slice(l.from, l.to), inside.slice(l.from, l.to))
          ).map(k => l.from + k),
    ),
  );
  return starts.size === 0 ? null : toks.flatMap((x, k) => (starts.has(k) ? [NL, x] : [x]));
}
/** The tokens with a line break put in wherever a line is wider than WIDTH and can be broken; to a fixed point. */
function wrapped(toks: readonly Tok[]): Tok[] {
  let now = toks.slice();
  for (let next = brokenOnce(now), pass = 0; next !== null && pass < 400; next = brokenOnce(now), pass++) now = next;
  return carriedAll(now);
}
/** Once no line can be broken between its tokens: each line still too wide has its longest text carried over. */
function carriedAll(toks: readonly Tok[]): Tok[] {
  const out = toks.slice();
  for (const l of layOut(toks)) {
    if (!l || widthOf(l) <= WIDTH) continue;
    const line = carriedIn(toks.slice(l.from, l.to), l.indent);
    if (line) out.splice(l.from, line.length, ...line);
  }
  return out;
}
/** The tokens with every step on one line: no break inside round or square brackets, none before a `|>`. A comment
 * ends its line wherever it stands. */
function joined(toks: readonly Tok[]): Tok[] {
  const out: Tok[] = [];
  const open: string[] = [];
  for (const [k, x] of toks.entries()) {
    const inList = open.length > 0 && open.at(-1) !== '{';
    const next = toks.slice(k + 1).find(y => y.t !== 'nl');
    const afterComment = out.at(-1)?.t === 'comment';
    if (x.t === 'nl' && !afterComment && (inList || carries(next) || arrowBefore(toks, k + 1))) continue;
    if (opens(x)) open.push(x.v);
    else if (closes(x)) open.pop();
    out.push(x.t === 'str' ? { t: 'str', v: x.v.replaceAll(CARRY, '') } : x);
  }
  return out;
}

function printed(toks: readonly Tok[]): string {
  const lines = layOut(toks);
  // blank lines: none after a line ending in `{`, none before a line starting with `}` or `)`
  const kept: (Line | null)[] = [];
  lines.forEach((l, i) => {
    const p = kept.at(-1);
    const n = lines[i + 1];
    const wanted = !!p && !p.out.endsWith('{') && !p.out.endsWith('(') && !!n && !/^[})\]]/.test(n.out);
    if (l !== null || wanted) kept.push(l);
  });
  // a text carried over lines is indented twice past the line it began on
  const shown = (l: Line): string =>
    '  '.repeat(l.indent) + l.out.replaceAll(CARRY, `\\\n${'  '.repeat(l.indent + 2)}`);
  return `${kept.map(l => (l === null ? '' : shown(l))).join('\n')}\n`;
}
const tokensOf = (text: string, name: string): Tok[] => {
  parseProgram([{ name, text }]); // throws the compiler's own error for a file that does not parse
  return tokens(text.replaceAll('\r\n', '\n'));
};
/** The file in the one layout: every step on one line, then each line wider than WIDTH broken. Where the lines of
 * a step were broken before does not count, so a program has one layout however it was typed. */
export function format(text: string, name = 'file.tape'): string {
  return printed(wrapped(joined(tokensOf(text, name))));
}
/** The file with every step on one line, however long: what `format` gives back when it is formatted again. Edits
 * of a program that are written as text (a planted bug, a test's change) are made to this, so they do not depend
 * on where a line happens to be broken. */
export function flat(text: string, name = 'file.tape'): string {
  return printed(joined(tokensOf(text, name)));
}
/** A program's file, flat: what a tool that edits programs as text reads. */
export const readFlat = (path: string): string => flat(readFileSync(path, 'utf8'), path);
