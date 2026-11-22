// compiler/lex.ts: source text to tokens.
import type { Token, TokenOf } from './ast.ts';
import { fail, utf8 } from './common.ts';

export const KEYWORDS = new Set([
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
const ESC: Readonly<Record<string, number>> = { '"': 34, '\\': 92, '/': 47, n: 10, r: 13, t: 9, b: 8, f: 12 };
// where a scan stands: the tokens so far, the brackets that are open, the offset and the line
type Scan = { readonly file: string; readonly text: string; toks: Token[]; open: string[]; i: number; line: number };
const here = (sc: Scan): { line: number; file: string } => ({ line: sc.line, file: sc.file });
const wordChar = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_]/.test(c);
// the offset after the run of characters from `from` that `test` takes
const runEnd = (src: string, from: number, test: (c: string | undefined) => boolean): number => {
  let j = from;
  while (j < src.length && test(src[j])) j++;
  return j;
};

// A newline ends a statement unless a ( or [ is open; several in a row are one.
function newline(sc: Scan): void {
  const inList = sc.open.length > 0 && sc.open.at(-1) !== '{';
  if (!inList && sc.toks.length > 0 && sc.toks.at(-1)?.t !== 'nl') sc.toks.push({ t: 'nl', ...here(sc) });
  sc.line++;
  sc.i++;
}
/** A hole in a text literal, from its `\\(`: the tokens of the expression in it. */
function hole(sc: Scan): Token[] {
  const from = sc.i + 2;
  let depth = 1,
    j = from;
  for (; depth > 0; j++) {
    const c = sc.text[j];
    if (c === undefined || c === '\n' || c === '"')
      fail(
        here(sc),
        'L05',
        'a \\( hole in a text literal is not closed, or has a text literal inside it',
        'A hole holds one expression with no text literal in it: `"Hello, \\(name)"`. Bind anything longer with `let` first.',
      );
    if (c === '(') depth++;
    if (c === ')') depth--;
  }
  const inner = lex(sc.file, sc.text.slice(from, j - 1)).map(t => ({ ...t, line: sc.line }));
  sc.i = j;
  // without the line end lex adds: the hole is one expression
  return [...inner.slice(0, -2), { t: 'eof', line: sc.line, file: sc.file }];
}
// A text literal, from its opening quote: its bytes, with escapes read; with holes, the bytes between them.
function text(sc: Scan): void {
  let bytes: number[] = [];
  const parts: TokenOf<'interp'>['v'] = [];
  for (sc.i++; sc.text[sc.i] !== '"';) {
    const c = sc.text[sc.i];
    if (c === undefined || c === '\n')
      fail(
        here(sc),
        'L02',
        'text literal is not closed',
        'Close it with a double quote. To carry a long text on to the next line, end the line with a backslash.',
      );
    if (c === '\\' && sc.text[sc.i + 1] === '\n') {
      // a backslash ends the line: the text carries on after the next line's indentation
      sc.i += 2;
      sc.line++;
      while (sc.text[sc.i] === ' ' || sc.text[sc.i] === '\t') sc.i++;
    } else if (c === '\\' && sc.text[sc.i + 1] === '(') {
      parts.push({ text: bytes }, { hole: hole(sc) });
      bytes = [];
    } else if (c === '\\') {
      const next = sc.text[sc.i + 1],
        byte = ESC[next ?? ''];
      if (byte === undefined)
        fail(
          here(sc),
          'L03',
          `unknown escape \\${next} in a text literal`,
          'Text literals allow \\" \\\\ \\/ \\n \\r \\t \\b \\f, and \\( … ) for a value.',
        );
      else bytes.push(byte);
      sc.i += 2;
    } else {
      const s = String.fromCodePoint(sc.text.codePointAt(sc.i) ?? 0);
      bytes.push(...utf8(s));
      sc.i += s.length;
    }
  }
  sc.i++;
  if (parts.length === 0) sc.toks.push({ t: 'str', v: bytes, ...here(sc) });
  else sc.toks.push({ t: 'interp', v: [...parts, { text: bytes }], ...here(sc) });
}
function number(sc: Scan): void {
  const end = runEnd(sc.text, sc.i, c => c !== undefined && c >= '0' && c <= '9');
  sc.toks.push({ t: 'int', v: BigInt(sc.text.slice(sc.i, end)), ...here(sc) });
  sc.i = end;
}
// a keyword, a name that opens with a capital (a type or a constructor), or any other name
function word(sc: Scan): void {
  const end = runEnd(sc.text, sc.i, wordChar),
    w = sc.text.slice(sc.i, end);
  sc.toks.push({ t: KEYWORDS.has(w) ? 'kw' : /^[A-Z]/.test(w) ? 'Id' : 'id', v: w, ...here(sc) });
  sc.i = end;
}
// Is the `{` at the cursor the body of a migration or of an invariant? Then it is SQL, kept as written.
function opensSql(toks: readonly Token[]): boolean {
  const invariant = toks.findLastIndex(
    (t, k) => t.t === 'id' && t.v === 'invariant' && toks[k + 1]?.t === 'str' && (k === 0 || toks[k - 1]?.t === 'nl'),
  );
  const sameLine = invariant >= 0 && invariant >= toks.length - 9 && !toks.slice(invariant).some(t => t.t === 'nl');
  const opener = Math.max(
    toks.findLastIndex(t => t.t === 'kw' && t.v === 'migration'),
    sameLine ? toks.length - 1 : -1,
  );
  return opener >= 0 && opener >= toks.length - 4;
}
// SQL from its `{` to the matching `}`, skipping quoted SQL text
function sql(sc: Scan): void {
  const at = sc.line;
  let j = sc.i + 1,
    depth = 1;
  for (; j < sc.text.length && depth; j++) {
    const c = sc.text[j];
    if (c === "'" || c === '"') {
      for (j++; j < sc.text.length && sc.text[j] !== c; j++) if (sc.text[j] === '\n') sc.line++;
    } else if (c === '\n') sc.line++;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
  }
  if (depth) fail({ file: sc.file, line: at }, 'L04', "a migration's SQL is not closed", 'End it with } on its own.');
  sc.toks.push({ t: 'sql', v: sc.text.slice(sc.i + 1, j - 1), line: at, file: sc.file });
  sc.i = j;
}
function operator(sc: Scan): void {
  const op = OPS.find(o => sc.text.startsWith(o, sc.i));
  if (!op)
    return fail(
      here(sc),
      'L01',
      `unexpected character ${JSON.stringify(sc.text[sc.i])}`,
      'Tape has no such character outside a text literal or a comment. Put it in a text literal, or after `//`.',
    );
  if (op === '(' || op === '[' || op === '{') sc.open.push(op);
  if (op === ')' || op === ']' || op === '}') sc.open.pop();
  // a line that starts with |> carries on the step before it
  if (op === '|>' && sc.toks.at(-1)?.t === 'nl') sc.toks.pop();
  sc.toks.push({ t: 'op', v: op, ...here(sc) });
  sc.i += op.length;
}
// the next token, or the white space and comments before it
function step(sc: Scan): void {
  const ch = sc.text[sc.i] ?? '',
    next = sc.text[sc.i + 1];
  if (ch === '\n') newline(sc);
  else if (ch === ' ' || ch === '\t' || ch === '\r') sc.i++;
  else if (ch === '/' && next === '/') sc.i = runEnd(sc.text, sc.i, c => c !== '\n');
  else if (ch === '"') text(sc);
  else if (ch >= '0' && ch <= '9') number(sc);
  else if (/[A-Za-z]/.test(ch) || (ch === '_' && wordChar(next))) word(sc);
  else if (ch === '{' && opensSql(sc.toks)) sql(sc);
  else operator(sc);
}
export function lex(file: string, source: string): Token[] {
  const sc: Scan = { file, text: source, toks: [], open: [], i: 0, line: 1 };
  while (sc.i < source.length) step(sc);
  sc.toks.push({ t: 'nl', ...here(sc) }, { t: 'eof', ...here(sc) });
  return sc.toks;
}
