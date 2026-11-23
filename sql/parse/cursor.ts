// sql/parse/cursor.ts: where a parse stands in a statement's tokens, and the few things every production asks of
// it. A production is a function from a Cursor to a node; it takes the tokens it reads and leaves the rest.
import type { Span, SqlToken } from '../ast.ts';
import { NAME_OK, SqlError, lc, tokenize } from '../tokens.ts';

const END: SqlToken = { t: 'eof', v: '', s: 0, e: 0 };

export class Cursor {
  readonly src: string;
  readonly toks: readonly SqlToken[];
  pos = 0;
  constructor(src: string) {
    this.src = src;
    this.toks = tokenize(src);
  }
  /** the token k ahead; past the end, the end */
  peek(k = 0): SqlToken {
    return this.toks[Math.min(this.pos + k, this.toks.length - 1)] ?? END;
  }
  /** the token just taken */
  last(): SqlToken {
    return this.toks[this.pos - 1] ?? END;
  }
  take(): SqlToken {
    const t = this.peek();
    this.pos++;
    return t;
  }
  skip(n = 1): void {
    this.pos += n;
  }
  /** from s to the end of the token just taken: the span of a node whose parts have all been read */
  span(s: number): Span {
    return { s, e: this.last().e };
  }
  private near(t: SqlToken): string {
    return t.t === 'eof' ? 'the end of the statement' : `"${this.src.slice(t.s, t.e)}"`;
  }
  /** not SQL, with the fix when the statement can be written back corrected */
  fail(msg: string, t: SqlToken = this.peek(), fix?: string): never {
    throw new SqlError('syntax', `${msg} at ${this.near(t)}`, t.s, fix);
  }
  /** SQL that SQLite takes and tape does not */
  refuse(msg: string, t: SqlToken = this.peek()): never {
    throw new SqlError(
      'subset',
      `${msg} (at ${this.near(t)}): tape's SQL checker does not take it, so it is refused rather than guessed at`,
      t.s,
    );
  }
  isKw(v: string, k = 0): boolean {
    const t = this.peek(k);
    return t.t === 'kw' && t.v === v;
  }
  isOp(v: string, k = 0): boolean {
    const t = this.peek(k);
    return t.t === 'op' && t.v === v;
  }
  /** is one of these keywords next? */
  isAnyKw(...vs: string[]): boolean {
    return vs.some(v => this.isKw(v));
  }
  eatKw(v: string): SqlToken | null {
    return this.isKw(v) ? this.take() : null;
  }
  eatOp(v: string): SqlToken | null {
    return this.isOp(v) ? this.take() : null;
  }
  kw(v: string): SqlToken {
    return this.eatKw(v) ?? this.fail(`expected ${v}`);
  }
  op(v: string): SqlToken {
    return this.eatOp(v) ?? this.fail(`expected "${v}"`);
  }
  isName(k = 0): boolean {
    const t = this.peek(k);
    return t.t === 'id' || (t.t === 'kw' && NAME_OK.has(t.v));
  }
  /** a name: an identifier, a keyword that may be one, or (except for a column) a string, as SQLite takes it */
  name(what?: string): string {
    const t = this.peek();
    const text =
      t.t === 'id' ? t.v : t.t === 'kw' && NAME_OK.has(t.v) ? t.raw : t.t === 'str' && what !== 'column' ? t.v : null;
    // a keyword where a name goes (`AS from`): SQL takes it as a name only in double quotes
    if (text === null && t.t === 'kw')
      throw new SqlError(
        'syntax',
        `expected ${what ?? 'a name'} at ${this.near(t)}, which is a keyword of SQL`,
        t.s,
        `As a name, a keyword of SQL is written in double quotes: AS "${lc(t.raw)}" (a row type's field may have that name), or pick another name.`,
      );
    if (text === null) return this.fail(`expected ${what ?? 'a name'}`);
    this.pos++;
    return text;
  }
  /**
   * A table name: one part, or main.name. A Durable Object's SQLite has one database, main; temp and attached
   * databases are refused.
   */
  tableName(): string {
    const first = this.name('a table name');
    if (!this.isOp('.')) return first;
    if (lc(first) !== 'main')
      this.refuse(`the schema-qualified name ${first}.…: the only database is main`, this.last());
    this.pos++;
    return this.name('a table name');
  }
  /** one or more of `item`, separated by commas */
  list<T>(item: (c: Cursor) => T): T[] {
    const out = [item(this)];
    while (this.eatOp(',')) out.push(item(this));
    return out;
  }
  /** `(` a list of `item` `)` */
  parenList<T>(item: (c: Cursor) => T): T[] {
    this.op('(');
    const out = this.list(item);
    this.op(')');
    return out;
  }
  /** an optional alias: `AS name`, or (where `bare`) a name with no AS */
  alias(bare: boolean): string | null {
    if (this.eatKw('AS')) return this.name('a table alias');
    return bare && this.peek().t === 'id' ? this.name() : null;
  }
}
export const column = (c: Cursor): string => c.name('a column');
/** a column in a key or a conflict target: its collation and direction are read and not kept */
export const keyColumn = (c: Cursor): string => {
  const name = column(c);
  if (c.eatKw('COLLATE')) c.name();
  if (!c.eatKw('ASC')) c.eatKw('DESC');
  return name;
};
export const direction = (c: Cursor): 'ASC' | 'DESC' => {
  if (c.eatKw('DESC')) return 'DESC';
  c.eatKw('ASC');
  return 'ASC';
};
