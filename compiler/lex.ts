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

/**
 * The words that carry a statement on from the line before when a line starts with one, as `|>` does: the binary
 * operators, `and` and `or`. Not `-`, which also starts an expression (`-x`); not `not`, which only starts one. No
 * statement starts with any of these, so a line that does is always the rest of the one before.
 */
export const CONTINUES: ReadonlySet<string> = new Set([
  '|>',
  '++',
  '==',
  '!=',
  '<=',
  '>=',
  '<<',
  '>>',
  '+',
  '*',
  '/',
  '%',
  '<',
  '>',
  '&',
  '|',
  '^',
  'and',
  'or',
]);
// A newline ends a statement unless a ( or [ is open; several in a row are one. (A line after one that ends with
// `->` holds that arm's or step's value: the parser reads past the newline there, compiler/parse/expr.ts armBody.)
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
const digit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';
/**
 * A number: digits, then `.` and digits, then an exponent, then `f` for a Float (`1.5f`, `2f`, `1e-3f`); digits
 * alone are an Int, and digits with a point are a Dec whose scale is the digits after the point (`12.30` is a
 * Dec[2]). An exponent without the `f` is refused.
 */
function number(sc: Scan): void {
  const src = sc.text;
  let end = runEnd(src, sc.i, digit);
  const point = src[end] === '.' && digit(src[end + 1]);
  if (point) end = runEnd(src, end + 1, digit);
  const sign = src[end + 1] === '+' || src[end + 1] === '-' ? 1 : 0;
  const exponent = (src[end] === 'e' || src[end] === 'E') && digit(src[end + 1 + sign]);
  if (exponent) end = runEnd(src, end + 1 + sign, digit);
  const written = src.slice(sc.i, end);
  if (src[end] !== 'f' || wordChar(src[end + 1])) {
    if (exponent)
      fail(
        here(sc),
        'L06',
        `${written} is not a number Tape has: an exponent is only for a Float, which ends in f`,
        `Write \`${written}f\` for a Float, or the digits of an exact number (\`1000\`, \`0.001\`).`,
      );
    const [whole = '', fraction = ''] = written.split('.');
    if (fraction.length > 18)
      fail(
        here(sc),
        'L06',
        `${written} has ${fraction.length} digits after the point, and a Dec has at most 18`,
        `A Dec[s] holds s digits after the point, s from 0 to 18. A measurement with more is a Float: \`${written}f\`.`,
      );
    if (point) sc.toks.push({ t: 'dec', v: BigInt(whole + fraction), s: fraction.length, ...here(sc) });
    else sc.toks.push({ t: 'int', v: BigInt(written), ...here(sc) });
    sc.i = end;
    return;
  }
  // more than 20 significant digits may round either way on another engine (ECMAScript's RoundMVResult)
  const significant = written
    .replace(/[eE].*$/, '')
    .replace('.', '')
    .replace(/^0+/, '')
    .replace(/0+$/, '');
  const v = Number(written);
  if (significant.length > 20 || !Number.isFinite(v))
    fail(
      here(sc),
      'L06',
      significant.length > 20
        ? `${written}f has more than 20 significant digits`
        : `${written}f is beyond the largest Float, about 1.8e308`,
      'A Float literal has at most 20 significant digits and is at most about 1.8e308; a Float holds about 17.',
    );
  sc.toks.push({ t: 'float', v, ...here(sc) });
  sc.i = end + 1;
}
// a keyword, a name that opens with a capital (a type or a constructor), or any other name
function word(sc: Scan): void {
  const end = runEnd(sc.text, sc.i, wordChar),
    w = sc.text.slice(sc.i, end);
  if ((w === 'and' || w === 'or') && sc.toks.at(-1)?.t === 'nl') sc.toks.pop();
  sc.toks.push({ t: KEYWORDS.has(w) ? 'kw' : /^[A-Z]/.test(w) ? 'Id' : 'id', v: w, ...here(sc) });
  sc.i = end;
}
// Is the `{` at the cursor the body of a migration or of an invariant? Then it is SQL, kept as written: a `migration`
// among the last 4 tokens, or, among the last 9 and with no new line after it, `invariant "name"` that starts a line.
// Only those tokens are read: searching all of them before every `{` was 19.8% of the hosted compiler's CPU in
// production (profiles of tape dddd2c92, 2026-11-23). test/lex-sql.ts checks it against the search it replaced.
export function opensSql(toks: readonly Token[]): boolean {
  const n = toks.length;
  for (let k = n - 1; k >= Math.max(0, n - 4); k--) if (toks[k]?.t === 'kw' && toks[k]?.v === 'migration') return true;
  for (let k = n - 1; k >= Math.max(0, n - 9); k--) {
    const t = toks[k];
    if (t?.t === 'nl') return false;
    if (t?.t === 'id' && t.v === 'invariant' && toks[k + 1]?.t === 'str' && (k === 0 || toks[k - 1]?.t === 'nl'))
      return true;
  }
  return false;
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
// what a character Tape does not have usually meant, in the language it came from
const MEANT: Readonly<Record<string, [string, string]>> = {
  '`': [
    'a backtick: Tape has no quoted names',
    'A name is written as it is, a reserved word too where it names a field (`Event(type: View)`, `e.type`); text is in double quotes, `"…"`.',
  ],
  "'": [
    'a single quote: Tape text is in double quotes',
    'Text is in double quotes: `"text"`. Single quotes are for SQL text inside a query.',
  ],
  ';': ['a semicolon: a new line ends a step in Tape', 'Put the next step on its own line.'],
  '!': ['a `!`: Tape negates with `not`', 'Write `not` for negation, and `!=` for not equal: `not done`, `n != 0`.'],
  '?': [
    'a question mark: Tape has no `?` operator',
    'An Option is taken apart with a step: `let Some(value) = e else -> …`.',
  ],
  '&&': ['&& for and: Tape writes `and`', 'Write `a and b`.'],
  '||': ['|| for or: Tape writes `or`', 'Write `a or b`.'],
};
function operator(sc: Scan): void {
  const two = sc.text.slice(sc.i, sc.i + 2),
    meant = two === '&&' || two === '||' ? MEANT[two] : undefined;
  if (meant) return fail(here(sc), 'L01', meant[0], meant[1]);
  const op = OPS.find(o => sc.text.startsWith(o, sc.i));
  if (!op) {
    const ch = sc.text[sc.i] ?? '',
      known = Object.hasOwn(MEANT, ch) ? MEANT[ch] : undefined;
    return fail(
      here(sc),
      'L01',
      known ? known[0] : `unexpected character ${JSON.stringify(ch)}`,
      known
        ? known[1]
        : 'Tape has no such character outside a text literal or a comment. Put it in a text literal, or after `//`.',
    );
  }
  if (op === '(' || op === '[' || op === '{') sc.open.push(op);
  if (op === ')' || op === ']' || op === '}') sc.open.pop();
  // a line that starts with |> or a binary operator carries on the step before it
  if (CONTINUES.has(op) && sc.toks.at(-1)?.t === 'nl') sc.toks.pop();
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
  else if (digit(ch)) number(sc);
  else if (/[A-Za-z]/.test(ch) || (ch === '_' && wordChar(next))) word(sc);
  else if (ch === '{' && opensSql(sc.toks)) sql(sc);
  else operator(sc);
}
// Files lexed already in this process, by name and text: the standard library is in every compile (81 KB, most of
// what a small program lexes), and the hosted compiler sees one program again and again. The tokens are frozen,
// so a pass that changed one would throw rather than change another compile's; a least recently used file goes
// once the texts held pass LEXED_CHARS (500,000 characters: std and a few hosted programs, which are at most 64 KB;
// std's 16,408 tokens hold 1.8 MB, 23 bytes of heap a character: the cache holds at most ~11 MB).
const LEXED = new Map<string, readonly Token[]>();
export const LEXED_CHARS = 500_000;
let lexedChars = 0;
const frozen = (v: unknown): void => {
  if (typeof v !== 'object' || v === null || Object.isFrozen(v)) return;
  Object.freeze(v);
  for (const x of Object.values(v)) frozen(x);
};
/** lex, from the cache when this file with this text was lexed before. */
export function lexed(file: string, source: string): readonly Token[] {
  const key = `${file}\0${source}`;
  const had = LEXED.get(key);
  if (had) {
    LEXED.delete(key);
    LEXED.set(key, had);
    return had;
  }
  const toks = lex(file, source);
  if (source.length > LEXED_CHARS) return toks;
  frozen(toks);
  for (const [k] of LEXED) {
    if (lexedChars + source.length <= LEXED_CHARS) break;
    LEXED.delete(k);
    lexedChars -= k.length - k.indexOf('\0') - 1;
  }
  LEXED.set(key, toks);
  lexedChars += source.length;
  return toks;
}
/** How many files the cache holds, and their characters (test/lex-cache.ts). */
export const lexedHeld = (): { files: number; chars: number } => ({ files: LEXED.size, chars: lexedChars });

export function lex(file: string, source: string): Token[] {
  const sc: Scan = { file, text: source, toks: [], open: [], i: 0, line: 1 };
  while (sc.i < source.length) step(sc);
  sc.toks.push({ t: 'nl', ...here(sc) }, { t: 'eof', ...here(sc) });
  return sc.toks;
}
