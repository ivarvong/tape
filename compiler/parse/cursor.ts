// compiler/parse/cursor.ts: where a parse stands in a file's tokens. A production is a function from a Cursor to
// what it read.
import type { At, Token, TokenOf } from '../ast.ts';
import { decText, fail } from '../common.ts';
import { KEYWORDS, lexed } from '../lex.ts';

const text8 = new TextDecoder();
export const textOf = (bytes: number[]): string => text8.decode(new Uint8Array(bytes));
const isKind = <K extends Token['t']>(t: Token, kind: K): t is TokenOf<K> => t.t === kind;
/** a token as a message names it */
export const shown = (t: Token): string =>
  t.t === 'eof'
    ? 'the end of the file'
    : t.t === 'nl'
      ? 'the end of the line'
      : t.t === 'str' || t.t === 'interp'
        ? 'a text literal'
        : t.t === 'float'
          ? `\`${t.v}f\``
          : t.t === 'dec'
            ? `\`${decText(t.v, t.s)}\``
            : `\`${t.v}\``;
const wanted = (kind: Token['t'], v?: string): string =>
  v
    ? `\`${v}\``
    : kind === 'id'
      ? 'a name'
      : kind === 'Id'
        ? 'a capitalized name'
        : kind === 'nl'
          ? 'a new line'
          : kind;

export class Cursor {
  readonly file: string;
  readonly toks: readonly Token[];
  /** the file's text, for a diagnostic that writes a line back corrected ('' over a hole's tokens) */
  private readonly text: string;
  private readonly end: Token;
  pos = 0;
  /** over a file's text, or over tokens already read (a hole of a text literal) */
  constructor(file: string, text: string | readonly Token[]) {
    this.file = file;
    this.toks = typeof text === 'string' ? lexed(file, text) : text;
    this.text = typeof text === 'string' ? text : '';
    // lex ends every file with this token: reading past it gives it again
    this.end = this.toks.at(-1) ?? { t: 'eof', line: 1, file };
  }
  peek(ahead = 0): Token {
    return this.toks[this.pos + ahead] ?? this.end;
  }
  next(): Token {
    const t = this.peek();
    this.pos++;
    return t;
  }
  /** where a node that opens at this token stands */
  at(t: { line: number }): At {
    return { line: t.line, file: this.file };
  }
  is(kind: Token['t'], v?: string): boolean {
    const t = this.peek();
    return t.t === kind && (v === undefined || t.v === v);
  }
  eat<K extends Token['t']>(kind: K, v?: string): TokenOf<K> | null {
    const t = this.peek();
    if (!isKind(t, kind) || (v !== undefined && t.v !== v)) return null;
    this.pos++;
    return t;
  }
  expect<K extends Token['t']>(kind: K, v?: string, hint = ''): TokenOf<K> {
    const found = this.peek();
    if (kind === 'id' && v === undefined && found.t === 'kw')
      fail(
        found,
        'P01',
        `expected a name but found \`${found.v}\`, a reserved word`,
        `A reserved word (${[...KEYWORDS].join(' ')}) cannot name a variable, a parameter or a function: pick another name (\`${found.v === 'type' ? 'kind' : `${found.v}_`}\`). It can name a record's field: \`Event(${found.v}: View)\`, \`e.${found.v}\`.`,
      );
    return (
      this.eat(kind, v) ??
      fail(
        this.peek(),
        'P01',
        `expected ${wanted(kind, v)} but found ${shown(this.peek())}`,
        hint ||
          (kind === 'nl'
            ? `One step to a line: start a new line before ${shown(this.peek())}.`
            : `Write ${wanted(kind, v)} here.`),
      )
    );
  }
  /**
   * `true` or `false` where a name stands (a value, a `let`, a pattern): written as Bool literals they are `True` and
   * `False`, so this refuses them, with the line written back that way. Not a field's name, which is never a variable.
   */
  boolWord(t: Token): void {
    if (t.t !== 'id' || (t.v !== 'true' && t.v !== 'false')) return;
    const line = (this.text.split('\n')[t.line - 1] ?? '')
      .trim()
      .replaceAll(/\btrue\b/g, 'True')
      .replaceAll(/\bfalse\b/g, 'False');
    fail(
      t,
      'P01',
      'Bool literals are `True` and `False`',
      line
        ? `Write the line as \`${line}\`. A step that goes on only when a condition holds is \`let True = cond else -> …\`.`
        : 'Write `True` or `False`.',
    );
  }
  /** a record field's name: any name, a reserved word too (`type`, `match`), since it is never a variable */
  fieldName(): TokenOf<'id'> | TokenOf<'kw'> {
    return this.eat('kw') ?? this.expect('id');
  }
  skipNl(): void {
    while (this.eat('nl') !== null);
  }
  /** `item`, then more of it after each comma */
  list<T>(item: (c: Cursor) => T): T[] {
    const out = [item(this)];
    while (this.eat('op', ',')) out.push(item(this));
    return out;
  }
  /** a list that may be empty, up to and past the bracket that closes it */
  listUntil<T>(close: string, item: (c: Cursor) => T): T[] {
    const out = this.is('op', close) ? [] : this.list(item);
    this.expect('op', close);
    return out;
  }
}
