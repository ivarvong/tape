// sql/parse/ddl.ts: CREATE TABLE, CREATE INDEX, ALTER TABLE and DROP.
import type {
  Alter,
  ColDef,
  Constraint,
  CreateIndex,
  CreateTable,
  Drop,
  Expr,
  IndexCol,
  References,
  SqlToken,
} from '../ast.ts';
import { type Cursor, column, direction, keyColumn } from './cursor.ts';
import { expr, primary, typeName } from './query.ts';

const ifNotExists = (c: Cursor): boolean => {
  if (!c.eatKw('IF')) return false;
  c.kw('NOT');
  c.kw('EXISTS');
  return true;
};

// ---- CREATE
export function create(c: Cursor): CreateTable | CreateIndex {
  const s = c.peek().s;
  c.kw('CREATE');
  if (c.isAnyKw('TEMP', 'TEMPORARY')) c.refuse('a TEMP object: it does not outlive the connection');
  if (c.isKw('TRIGGER'))
    c.refuse("CREATE TRIGGER: a trigger writes where no rule reads it; write from the program's own queries");
  if (c.isKw('VIEW')) c.refuse('CREATE VIEW');
  if (c.isKw('VIRTUAL')) c.refuse('CREATE VIRTUAL TABLE');
  const unique = !!c.eatKw('UNIQUE');
  if (c.eatKw('INDEX')) return createIndex(c, s, unique);
  if (unique) c.fail('expected INDEX after UNIQUE');
  c.kw('TABLE');
  return createTable(c, s);
}
// CREATE [UNIQUE] INDEX has been read
function createIndex(c: Cursor, s: number, unique: boolean): CreateIndex {
  const ifNot = ifNotExists(c),
    name = c.name('an index name');
  if (c.isOp('.')) c.refuse('a schema-qualified index name');
  c.kw('ON');
  const table = c.tableName(),
    cols = c.parenList(indexColumn),
    where = c.eatKw('WHERE') ? expr(c) : null;
  return { k: 'create_index', ...c.span(s), unique, ifNot, name, table, cols, where };
}
function indexColumn(c: Cursor): IndexCol {
  const s = c.peek().s,
    x = expr(c);
  if (c.eatKw('COLLATE')) c.name();
  const dir = direction(c);
  return { k: 'icol', ...c.span(s), expr: x, dir };
}
// CREATE TABLE has been read
function createTable(c: Cursor, s: number): CreateTable {
  const ifNot = ifNotExists(c),
    table = c.tableName();
  if (c.eatKw('AS')) c.refuse('CREATE TABLE … AS SELECT: declare the columns');
  c.op('(');
  const cols: ColDef[] = [],
    constraints: Constraint[] = [];
  do {
    if (c.isAnyKw('CONSTRAINT', 'PRIMARY', 'UNIQUE', 'CHECK', 'FOREIGN')) constraints.push(tableConstraint(c));
    else if (constraints.length > 0) c.fail('a column after a table constraint');
    else cols.push(columnDef(c));
  } while (c.eatOp(','));
  c.op(')');
  const options = tableOptions(c);
  return { k: 'create_table', ...c.span(s), ifNot, table, cols, constraints, ...options };
}
// WITHOUT ROWID and STRICT, in either order, separated by commas
function tableOptions(c: Cursor): { withoutRowid: boolean; strict: boolean } {
  const options = { withoutRowid: false, strict: false };
  const word = (t: SqlToken, w: string): boolean => t.t === 'id' && t.v.toUpperCase() === w;
  do {
    if (c.eatKw('WITHOUT')) {
      if (!word(c.peek(), 'ROWID')) c.fail('expected ROWID');
      options.withoutRowid = true;
    } else if (word(c.peek(), 'STRICT')) options.strict = true;
    else break;
    c.skip();
  } while (c.eatOp(','));
  return options;
}

// ---- a column and its constraints
type ColumnFacts = Omit<ColDef, 'k' | 's' | 'e'>;
const conflictClause = (c: Cursor): void => {
  if (c.isKw('ON') && c.isKw('CONFLICT', 1)) c.refuse('an ON CONFLICT clause on a constraint');
};
export function columnDef(c: Cursor): ColDef {
  const s = c.peek().s,
    name = c.name('a column name'),
    type = typeName(c);
  const col: ColumnFacts = {
    name,
    type,
    notNull: false,
    pk: false,
    pkDir: null,
    autoinc: false,
    unique: false,
    default: undefined,
    checks: [],
    references: null,
    collate: null,
  };
  while (columnConstraint(c, col));
  if (c.isAnyKw('GENERATED', 'AS')) c.refuse('a generated column');
  return { k: 'coldef', ...c.span(s), ...col };
}
// one constraint of a column, read into `col`; false when the next thing is not one
function columnConstraint(c: Cursor, col: ColumnFacts): boolean {
  if (c.eatKw('CONSTRAINT')) c.name();
  if (c.eatKw('PRIMARY')) {
    c.kw('KEY');
    col.pk = true;
    col.pkDir = c.eatKw('DESC') ? 'DESC' : (c.eatKw('ASC'), null);
    conflictClause(c);
    if (c.eatKw('AUTOINCREMENT')) col.autoinc = true;
  } else if (c.eatKw('NOT')) {
    c.kw('NULL');
    col.notNull = true;
    conflictClause(c);
  } else if (c.eatKw('UNIQUE')) {
    col.unique = true;
    conflictClause(c);
  } else if (c.eatKw('CHECK')) {
    c.op('(');
    col.checks.push(expr(c));
    c.op(')');
  } else if (c.eatKw('DEFAULT')) col.default = defaultValue(c);
  else if (c.eatKw('COLLATE')) col.collate = c.name('a collation');
  else if (c.eatKw('REFERENCES')) col.references = foreignKey(c);
  else return !!c.eatKw('NULL');
  return true;
}
// DEFAULT has been read: an expression in parentheses, a signed number, or a literal
function defaultValue(c: Cursor): Expr {
  const s = c.peek().s;
  if (c.eatOp('(')) {
    const x = expr(c);
    c.op(')');
    return { ...x, paren: true, ...c.span(s) };
  }
  if (c.isOp('-') || c.isOp('+')) {
    const sign = c.take().v,
      t = c.peek();
    if (t.t !== 'num') return c.fail('expected a number');
    c.skip();
    return { k: 'lit', v: Number(sign + t.v.replaceAll('_', '')), type: t.int ? 'int' : 'real', s, e: t.e };
  }
  const t = c.peek(),
    literal =
      t.t === 'str' ||
      t.t === 'num' ||
      (t.t === 'kw' && ['NULL', 'CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME'].includes(t.v)) ||
      (t.t === 'id' && /^(TRUE|FALSE)$/i.test(t.v));
  if (!literal) c.fail('expected a DEFAULT value: a literal, a signed number, or an expression in parentheses');
  return primary(c);
}
function foreignKey(c: Cursor): References {
  const table = c.tableName(),
    cols = c.isOp('(') ? c.parenList(column) : null;
  if (c.isAnyKw('ON', 'MATCH', 'DEFERRABLE', 'NOT')) c.refuse('a foreign key action (ON DELETE, MATCH, DEFERRABLE)');
  return { table, cols };
}
function tableConstraint(c: Cursor): Constraint {
  const s = c.peek().s;
  if (c.eatKw('CONSTRAINT')) c.name();
  if (c.eatKw('PRIMARY')) {
    c.kw('KEY');
    return keyConstraint(c, s, 'pk');
  }
  if (c.eatKw('UNIQUE')) return keyConstraint(c, s, 'unique');
  if (c.eatKw('CHECK')) {
    c.op('(');
    const x = expr(c);
    c.op(')');
    return { k: 'constraint', ...c.span(s), kind: 'check', expr: x };
  }
  c.kw('FOREIGN');
  c.kw('KEY');
  const cols = c.parenList(column);
  c.kw('REFERENCES');
  const references = foreignKey(c);
  return { k: 'constraint', ...c.span(s), kind: 'fk', cols, references };
}
// PRIMARY KEY or UNIQUE has been read
function keyConstraint(c: Cursor, s: number, kind: 'pk' | 'unique'): Constraint {
  c.op('(');
  const cols = c.list(keyColumn);
  if (kind === 'pk') c.eatKw('AUTOINCREMENT');
  c.op(')');
  conflictClause(c);
  return { k: 'constraint', ...c.span(s), kind, cols };
}

// ---- ALTER, DROP
export function alter(c: Cursor): Alter {
  const s = c.peek().s;
  c.kw('ALTER');
  c.kw('TABLE');
  const table = c.tableName();
  if (c.eatKw('RENAME')) return rename(c, s, table);
  if (c.eatKw('ADD')) {
    c.eatKw('COLUMN');
    const col = columnDef(c);
    return { k: 'alter', ...c.span(s), table, action: 'add_column', col };
  }
  if (c.eatKw('DROP')) {
    c.eatKw('COLUMN');
    const col = column(c);
    return { k: 'alter', ...c.span(s), table, action: 'drop_column', col };
  }
  return c.fail('expected RENAME, ADD or DROP');
}
// ALTER TABLE t RENAME has been read
function rename(c: Cursor, s: number, table: string): Alter {
  if (c.eatKw('TO')) {
    const to = c.name('a table name');
    return { k: 'alter', ...c.span(s), table, action: 'rename_table', to };
  }
  c.eatKw('COLUMN');
  const from = column(c);
  c.kw('TO');
  const to = column(c);
  return { k: 'alter', ...c.span(s), table, action: 'rename_column', from, to };
}
export function drop(c: Cursor): Drop {
  const s = c.peek().s;
  c.kw('DROP');
  const what = c.eatKw('TABLE') ? 'table' : c.eatKw('INDEX') ? 'index' : null;
  if (!what) return c.isAnyKw('TRIGGER', 'VIEW') ? c.refuse(`DROP ${c.peek().v}`) : c.fail('expected TABLE or INDEX');
  const ifExists = c.eatKw('IF') !== null;
  if (ifExists) c.kw('EXISTS');
  const name = what === 'table' ? c.tableName() : c.name('an index name');
  if (c.isOp('.')) c.refuse('a schema-qualified name');
  return { k: 'drop', ...c.span(s), what, ifExists, name };
}
