// sql/tree.ts: walking a statement's tree, and printing it back as SQL.
// Every child node of a node, for generic walks. Statements under a statement (subqueries) are included.
import { unreachable } from '../compiler/ast.ts';
import type { Expr, Lit, SqlNode } from './ast.ts';
import { KEYWORDS } from './tokens.ts';

const some = <T>(...xs: (T | null | undefined)[]): T[] => xs.filter((x): x is T => x !== null && x !== undefined);
/** The nodes written directly inside n, in the order they are written. Subqueries are included. */
export function children(n: SqlNode | null | undefined): SqlNode[] {
  if (!n) return [];
  switch (n.k) {
    case 'lit':
    case 'param':
    case 'col':
    case 'drop':
      return [];
    case 'un':
    case 'collate':
    case 'isnull':
    case 'cast':
      return [n.x];
    case 'bin':
      return [n.l, n.r];
    case 'in':
      return n.sel ? [n.x, n.sel] : [n.x, ...n.items];
    case 'like':
      return some(n.x, n.pat, n.esc);
    case 'between':
      return [n.x, n.lo, n.hi];
    case 'fn':
      return n.args;
    case 'exists':
    case 'sub':
      return [n.sel];
    case 'case':
      return some<SqlNode>(n.base, ...n.whens.flatMap(w => [w.when, w.then]), n.else);
    case 'row':
      return n.items;
    case 'rcol':
      return n.star ? [] : [n.expr];
    case 'order':
    case 'icol':
    case 'assign':
      return [n.expr];
    case 'tref':
      return some<SqlNode>(n.sub, n.on);
    case 'upsert':
      return some<SqlNode>(n.targetWhere, ...n.set, n.where);
    case 'coldef':
      return some<SqlNode>(n.default, ...n.checks);
    case 'constraint':
      return n.kind === 'check' ? [n.expr] : [];
    case 'select':
      return some<SqlNode>(
        ...n.cols,
        ...n.from,
        n.where,
        ...(n.group ?? []),
        n.having,
        ...(n.order ?? []),
        n.limit,
        n.offset,
      );
    case 'insert':
      return some<SqlNode>(...(n.values ?? []).flat(), n.select, n.upsert, ...(n.returning ?? []));
    case 'update':
      return some<SqlNode>(...n.set, n.where, ...(n.returning ?? []));
    case 'delete':
      return some<SqlNode>(n.where, ...(n.returning ?? []));
    case 'create_table':
      return [...n.cols, ...n.constraints];
    case 'create_index':
      return some<SqlNode>(...n.cols, n.where);
    case 'alter':
      return n.action === 'add_column' ? [n.col] : [];
    default:
      return unreachable(n, 'SQL node');
  }
}
/** f on n and on every node inside it, outermost first. */
export function walkSql(n: SqlNode | null | undefined, f: (n: SqlNode) => void): void {
  if (!n) return;
  f(n);
  for (const c of children(n)) walkSql(c, f);
}

// The top-level conjuncts of a WHERE: [] for none, null when the WHERE has a top-level OR (then no conjunct holds
// for every row it takes). Parentheses do not hide an AND: (a AND b) AND c is three conjuncts.
export function conjunctsOf(where: Expr | null | undefined): Expr[] | null {
  if (!where) return [];
  if (where.k === 'bin' && where.op === 'AND') {
    const l = conjunctsOf(where.l),
      r = conjunctsOf(where.r);
    return l && r ? [...l, ...r] : null;
  }
  if (where.k === 'bin' && where.op === 'OR') return null;
  return [where];
}

// The tree back as SQL, canonical: one space between tokens, keywords in upper case, every name quoted when it
// must be. print(parse(print(x))) === print(x) is the round-trip property the fuzz test checks.
const qn = (n: string): string =>
  /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && !KEYWORDS.has(n.toUpperCase()) ? n : `"${n.replaceAll('"', '""')}"`;
const lit = (x: Lit): string =>
  x.v === null ? 'NULL' : x.type === 'text' ? `'${String(x.v).replaceAll("'", "''")}'` : String(x.v);
export function print(n: SqlNode | null | undefined): string {
  if (!n) return '';
  const L = (xs: readonly SqlNode[]): string => xs.map(print).join(', ');
  switch (n.k) {
    case 'lit':
      return lit(n);
    case 'param':
      return `?${n.n}`;
    case 'col':
      return n.table ? `${qn(n.table)}.${qn(n.name)}` : qn(n.name);
    case 'un':
      return n.op === 'NOT' ? `NOT (${print(n.x)})` : `${n.op}(${print(n.x)})`;
    case 'bin':
      return `(${print(n.l)} ${n.op} ${print(n.r)})`;
    case 'in':
      return `(${print(n.x)}${n.not ? ' NOT' : ''} IN (${n.sel ? print(n.sel) : L(n.items)}))`;
    case 'between':
      return `(${print(n.x)}${n.not ? ' NOT' : ''} BETWEEN ${print(n.lo)} AND ${print(n.hi)})`;
    case 'like':
      return `(${print(n.x)}${n.not ? ' NOT' : ''} ${n.op} ${print(n.pat)}${n.esc ? ` ESCAPE ${print(n.esc)}` : ''})`;
    case 'isnull':
      return `(${print(n.x)} ${n.not ? 'NOTNULL' : 'ISNULL'})`;
    case 'fn':
      return n.kwfn
        ? n.name.toUpperCase()
        : `${n.name}(${n.star ? '*' : `${n.distinct ? 'DISTINCT ' : ''}${L(n.args)}`})`;
    case 'case':
      return `CASE${n.base ? ' ' + print(n.base) : ''}${n.whens.map(w => ` WHEN ${print(w.when)} THEN ${print(w.then)}`).join('')}${n.else ? ` ELSE ${print(n.else)}` : ''} END`;
    case 'cast':
      return `CAST(${print(n.x)} AS ${n.type})`;
    case 'exists':
      return `${n.not ? 'NOT ' : ''}EXISTS (${print(n.sel)})`;
    case 'sub':
      return `(${print(n.sel)})`;
    case 'row':
      return `(${L(n.items)})`;
    case 'collate':
      return `${print(n.x)} COLLATE ${qn(n.coll)}`;
    case 'rcol':
      return n.star
        ? n.table
          ? `${qn(n.table)}.*`
          : '*'
        : `${print(n.expr)}${n.alias !== null ? ` AS ${qn(n.alias)}` : ''}`;
    case 'order':
      return `${print(n.expr)} ${n.dir}`;
    case 'tref':
      return `${n.join === null ? '' : n.join === ',' ? ', ' : ` ${n.join.toUpperCase()} JOIN `}${n.sub ? `(${print(n.sub)})` : qn(n.name)}${n.alias !== null ? ` AS ${qn(n.alias)}` : ''}${n.on ? ` ON ${print(n.on)}` : ''}${n.using ? ` USING (${n.using.map(qn).join(', ')})` : ''}`;
    case 'select':
      return `SELECT ${n.distinct ? 'DISTINCT ' : ''}${L(n.cols)}${n.from.length > 0 ? ` FROM ${n.from.map(print).join('')}` : ''}${n.where ? ` WHERE ${print(n.where)}` : ''}${n.group ? ` GROUP BY ${L(n.group)}` : ''}${n.having ? ` HAVING ${print(n.having)}` : ''}${n.order ? ` ORDER BY ${L(n.order)}` : ''}${n.limit ? ` LIMIT ${print(n.limit)}` : ''}${n.offset ? ` OFFSET ${print(n.offset)}` : ''}`;
    case 'assign':
      return `${qn(n.col)} = ${print(n.expr)}`;
    case 'upsert':
      return ` ON CONFLICT${n.target ? ` (${n.target.map(qn).join(', ')})${n.targetWhere ? ` WHERE ${print(n.targetWhere)}` : ''}` : ''} DO ${n.action === 'nothing' ? 'NOTHING' : `UPDATE SET ${L(n.set)}${n.where ? ` WHERE ${print(n.where)}` : ''}`}`;
    case 'insert':
      return `${n.replace ? 'REPLACE' : `INSERT${n.or ? ` OR ${n.or}` : ''}`} INTO ${qn(n.table)}${n.alias !== null ? ` AS ${qn(n.alias)}` : ''}${n.cols ? ` (${n.cols.map(qn).join(', ')})` : ''}${n.defaults ? ' DEFAULT VALUES' : n.values ? ` VALUES ${n.values.map(r => `(${L(r)})`).join(', ')}` : ` ${print(n.select)}`}${n.upsert ? print(n.upsert) : ''}${n.returning ? ` RETURNING ${L(n.returning)}` : ''}`;
    case 'update':
      return `UPDATE${n.or ? ` OR ${n.or}` : ''} ${qn(n.table)}${n.alias !== null ? ` AS ${qn(n.alias)}` : ''} SET ${L(n.set)}${n.where ? ` WHERE ${print(n.where)}` : ''}${n.returning ? ` RETURNING ${L(n.returning)}` : ''}`;
    case 'delete':
      return `DELETE FROM ${qn(n.table)}${n.alias !== null ? ` AS ${qn(n.alias)}` : ''}${n.where ? ` WHERE ${print(n.where)}` : ''}${n.returning ? ` RETURNING ${L(n.returning)}` : ''}`;
    case 'coldef':
      return `${qn(n.name)}${n.type ? ' ' + n.type : ''}${n.pk ? ` PRIMARY KEY${n.pkDir ? ' ' + n.pkDir : ''}${n.autoinc ? ' AUTOINCREMENT' : ''}` : ''}${n.notNull ? ' NOT NULL' : ''}${n.unique ? ' UNIQUE' : ''}${n.checks.map(c => ` CHECK (${print(c)})`).join('')}${n.default !== undefined ? ` DEFAULT (${print(n.default)})` : ''}${n.collate ? ` COLLATE ${qn(n.collate)}` : ''}${n.references ? ` REFERENCES ${qn(n.references.table)}${n.references.cols ? ` (${n.references.cols.map(qn).join(', ')})` : ''}` : ''}`;
    case 'constraint':
      return n.kind === 'check'
        ? `CHECK (${print(n.expr)})`
        : n.kind === 'fk'
          ? `FOREIGN KEY (${n.cols.map(qn).join(', ')}) REFERENCES ${qn(n.references.table)}${n.references.cols ? ` (${n.references.cols.map(qn).join(', ')})` : ''}`
          : `${n.kind === 'pk' ? 'PRIMARY KEY' : 'UNIQUE'} (${n.cols.map(qn).join(', ')})`;
    case 'create_table':
      return `CREATE TABLE ${n.ifNot ? 'IF NOT EXISTS ' : ''}${qn(n.table)} (${[...n.cols, ...n.constraints].map(print).join(', ')})${[n.withoutRowid ? ' WITHOUT ROWID' : '', n.strict ? ' STRICT' : ''].filter(Boolean).join(',')}`;
    case 'icol':
      return `${print(n.expr)} ${n.dir}`;
    case 'create_index':
      return `CREATE ${n.unique ? 'UNIQUE ' : ''}INDEX ${n.ifNot ? 'IF NOT EXISTS ' : ''}${qn(n.name)} ON ${qn(n.table)} (${L(n.cols)})${n.where ? ` WHERE ${print(n.where)}` : ''}`;
    case 'alter':
      return `ALTER TABLE ${qn(n.table)} ${n.action === 'rename_table' ? `RENAME TO ${qn(n.to)}` : n.action === 'rename_column' ? `RENAME COLUMN ${qn(n.from)} TO ${qn(n.to)}` : n.action === 'add_column' ? `ADD COLUMN ${print(n.col)}` : `DROP COLUMN ${qn(n.col)}`}`;
    case 'drop':
      return `DROP ${n.what.toUpperCase()} ${n.ifExists ? 'IF EXISTS ' : ''}${qn(n.name)}`;
    default:
      return unreachable(n, 'SQL node');
  }
}
