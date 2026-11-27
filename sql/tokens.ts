// sql/tokens.ts: SQL text to tokens, and the error every part of the reader stops with.
import type { SqlToken } from './ast.ts';

export const lc = (s: string | null | undefined): string => (s ?? '').toLowerCase();
/** A name the program's Sql cannot reach: SQLite's catalogs and the Durable Object's hidden KV table. */
export const internalSqlName = (name: string): string | null =>
  /^(sqlite_|_cf_)/i.test(name) ? `${name} is not in a program's Sql` : null;
/** `subset`: SQL that SQLite takes and tape does not. `syntax`: not SQL. The others are found by the checker. */
export type SqlErrorKind = 'syntax' | 'subset' | 'name' | 'type' | 'arity' | (string & Record<never, never>);
export class SqlError extends Error {
  readonly kind: SqlErrorKind;
  /** offset into the statement's text */
  readonly pos: number;
  /** what to write instead, when the error knows better than its kind's general advice */
  readonly fix: string | undefined;
  constructor(kind: SqlErrorKind, message: string, pos: number, fix?: string) {
    super(message);
    this.kind = kind;
    this.pos = pos;
    this.fix = fix;
  }
}

export const KEYWORDS = new Set(
  `ABORT ACTION ADD AFTER ALL ALTER ALWAYS ANALYZE AND AS ASC ATTACH AUTOINCREMENT BEFORE BEGIN BETWEEN BY
CASCADE CASE CAST CHECK COLLATE COLUMN COMMIT CONFLICT CONSTRAINT CREATE CROSS CURRENT CURRENT_DATE CURRENT_TIME
CURRENT_TIMESTAMP DATABASE DEFAULT DEFERRABLE DEFERRED DELETE DESC DETACH DISTINCT DO DROP EACH ELSE END ESCAPE EXCEPT
EXCLUDE EXCLUSIVE EXISTS EXPLAIN FAIL FILTER FIRST FOLLOWING FOR FOREIGN FROM FULL GENERATED GLOB GROUP GROUPS HAVING IF
IGNORE IMMEDIATE IN INDEX INDEXED INITIALLY INNER INSERT INSTEAD INTERSECT INTO IS ISNULL JOIN KEY LAST LEFT LIKE LIMIT
MATCH MATERIALIZED NATURAL NO NOT NOTHING NOTNULL NULL NULLS OF OFFSET ON OR ORDER OTHERS OUTER OVER PARTITION PLAN
PRAGMA PRECEDING PRIMARY QUERY RAISE RANGE RECURSIVE REFERENCES REGEXP REINDEX RELEASE RENAME REPLACE RESTRICT RETURNING
RIGHT ROLLBACK ROW ROWS SAVEPOINT SELECT SET TABLE TEMP TEMPORARY THEN TIES TO TRANSACTION TRIGGER UNBOUNDED UNION
UNIQUE UPDATE USING VACUUM VALUES VIEW VIRTUAL WHEN WHERE WINDOW WITH WITHOUT`.split(/\s+/),
);
/**
 * A name as a statement must write it to be read as one: bare when it is a plain name or a keyword SQLite takes as
 * a name (`key`), in double quotes when it is any other keyword (`"from"`) or holds other characters. What
 * compiler/rows.ts writes for `*`.
 */
export const asName = (n: string): string =>
  /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && (!KEYWORDS.has(n.toUpperCase()) || NAME_OK.has(n.toUpperCase()))
    ? n
    : `"${n.replaceAll('"', '""')}"`;
// keywords SQLite also takes as names where a name is expected (its "fallback" list, the ones programs use)
export const NAME_OK = new Set([
  'KEY',
  'ACTION',
  'NO',
  'REPLACE',
  'IGNORE',
  'ABORT',
  'FAIL',
  'ROLLBACK',
  'CONFLICT',
  'DO',
  'FIRST',
  'LAST',
  'ROW',
  'ROWS',
  'PLAN',
  'QUERY',
  'TEMP',
  'IF',
  'OF',
  'OFFSET',
  'END',
  'COLUMN',
  'DATABASE',
  'DESC',
  'ASC',
  'EACH',
  'FOR',
  'INITIALLY',
  'DEFERRED',
  'IMMEDIATE',
  'EXCLUSIVE',
  'CASCADE',
  'RESTRICT',
  'RENAME',
  'TRIGGER',
  'VIEW',
  'VIRTUAL',
  'RECURSIVE',
  'RELEASE',
  'SAVEPOINT',
  'TIES',
  'OTHERS',
  'EXCLUDE',
  'GROUPS',
  'PRECEDING',
  'FOLLOWING',
  'UNBOUNDED',
  'CURRENT',
  'PARTITION',
  'RANGE',
  'NULLS',
  'FILTER',
  'WINDOW',
  'OVER',
  'GENERATED',
  'ALWAYS',
  'MATERIALIZED',
  'BEFORE',
  'AFTER',
  'INSTEAD',
  'ANALYZE',
  'ATTACH',
  'DETACH',
  'EXPLAIN',
  'PRAGMA',
  'REINDEX',
  'VACUUM',
  'BEGIN',
  'COMMIT',
  'TRANSACTION',
  'MATCH',
  'REGEXP',
  'GLOB',
  'LIKE',
  'KEY',
  // the join keywords (SQLite's JOIN_KW: `nm ::= JOIN_KW`, `expr ::= JOIN_KW`): a column may be named `left`. They
  // are never taken as an implicit alias (that needs an id token), so `FROM a LEFT JOIN b` reads as before.
  'LEFT',
  'RIGHT',
  'FULL',
  'NATURAL',
  'CROSS',
  'INNER',
  'OUTER',
]);
const OPS = [
  '||',
  '<<',
  '>>',
  '<=',
  '>=',
  '==',
  '!=',
  '<>',
  '->>',
  '->',
  '(',
  ')',
  ',',
  '.',
  ';',
  '+',
  '-',
  '*',
  '/',
  '%',
  '<',
  '>',
  '=',
  '&',
  '|',
  '~',
];

export function tokenize(src: string): SqlToken[] {
  const out: SqlToken[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i] ?? '';
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '-' && src[i + 1] === '-') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const j = src.indexOf('*/', i + 2);
      if (j < 0) throw new SqlError('syntax', 'a comment /* … is not closed', i);
      i = j + 2;
      continue;
    }
    const s = i;
    if (c === "'") {
      let v = '';
      i++;
      for (;;) {
        if (i >= n) throw new SqlError('syntax', 'a text literal is not closed', s);
        if (src[i] === "'") {
          if (src[i + 1] === "'") {
            v += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        v += src[i++];
      }
      out.push({ t: 'str', v, s, e: i });
      continue;
    }
    if (c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      let v = '';
      i++;
      for (;;) {
        if (i >= n) throw new SqlError('syntax', `a quoted name ${c}… is not closed`, s);
        if (src[i] === close) {
          if (close !== ']' && src[i + 1] === close) {
            v += close;
            i += 2;
            continue;
          }
          i++;
          break;
        }
        v += src[i++];
      }
      out.push({ t: 'id', v, s, e: i, q: true });
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      if (c === '0' && /[xX]/.test(src[i + 1] ?? '')) {
        i += 2;
        while (/[0-9a-fA-F]/.test(src[i] ?? '')) i++;
        out.push({ t: 'num', v: src.slice(s, i), s, e: i, int: true });
        continue;
      }
      while (/[0-9_]/.test(src[i] ?? '')) i++;
      let int = true;
      if (src[i] === '.') {
        int = false;
        i++;
        while (/[0-9]/.test(src[i] ?? '')) i++;
      }
      if (/[eE]/.test(src[i] ?? '') && /[-+0-9]/.test(src[i + 1] ?? '')) {
        int = false;
        i += 2;
        while (/[0-9]/.test(src[i] ?? '')) i++;
      }
      if (/[A-Za-z_]/.test(src[i] ?? ''))
        throw new SqlError('syntax', `a number runs into a name at "${src.slice(s, i + 1)}"`, s);
      out.push({ t: 'num', v: src.slice(s, i), s, e: i, int });
      continue;
    }
    if (c === '?') {
      i++;
      while (/[0-9]/.test(src[i] ?? '')) i++;
      if (i === s + 1)
        throw new SqlError('subset', 'a ? placeholder with no name: a query names each value it takes, `:id`', s);
      out.push({ t: 'param', v: Number(src.slice(s + 1, i)), s, e: i });
      continue;
    }
    if (c === ':' || c === '@' || c === '$')
      throw new SqlError(
        'subset',
        `the placeholder "${src.slice(s, s + 12).split(/[\s,)]/)[0]}": only the query of a call takes values, each written :name`,
        s,
      );
    if (/[A-Za-z_\u0080-\uFFFF]/.test(c)) {
      while (/[A-Za-z0-9_$\u0080-\uFFFF]/.test(src[i] ?? '')) i++;
      const v = src.slice(s, i),
        u = v.toUpperCase();
      if (u === 'X' && src[i] === "'") throw new SqlError('subset', "a blob literal X'…': tape has no blob type", s);
      out.push(KEYWORDS.has(u) ? { t: 'kw', v: u, raw: v, s, e: i } : { t: 'id', v, s, e: i });
      continue;
    }
    const at = i;
    const op = OPS.find(o => src.startsWith(o, at));
    if (!op) throw new SqlError('syntax', `the character "${c}" is not SQL`, s);
    i += op.length;
    out.push({ t: 'op', v: op, s, e: i });
  }
  out.push({ t: 'eof', v: '', s: n, e: n });
  return out;
}
