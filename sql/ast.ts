// sql/ast.ts: the shape of a parsed SQL statement, and of the schema that statements build. Every node is a
// variant of a union told apart by `k` and carries `s` and `e`, offsets into the statement's text.
export type Span = { s: number; e: number };

// ---- tokens
export type SqlToken = Span &
  (
    | { t: 'id'; v: string; q?: true }
    | { t: 'kw'; v: string; raw: string }
    | { t: 'str'; v: string }
    | { t: 'num'; v: string; int: boolean }
    | { t: 'param'; v: number }
    | { t: 'op'; v: string }
    | { t: 'eof'; v: '' }
  );

// ---- expressions
/** What an expression in parentheses keeps of them: `paren`, and where they open and close. */
type Wrapped = { paren?: true; ps?: number; pe?: number };
type E = Span & Wrapped;
export type LitType = 'int' | 'real' | 'text' | 'null';
/** A literal. `neg`: a number written with its minus sign. `bool`: TRUE or FALSE, which SQLite reads as 1 or 0. */
export type Lit = E & { k: 'lit'; v: string | number | null; type: LitType; neg?: true; bool?: true };
export type Param = E & { k: 'param'; n: number };
export type Col = E & { k: 'col'; table: string | null; name: string };
export type Un = E & { k: 'un'; op: string; x: Expr };
export type Bin = E & { k: 'bin'; op: string; l: Expr; r: Expr };
export type Collate = E & { k: 'collate'; x: Expr; coll: string };
export type IsNull = E & { k: 'isnull'; x: Expr; not: boolean };
export type In = E & { k: 'in'; x: Expr; not: boolean } & ({ items: Expr[]; sel: null } | { items: null; sel: Select });
export type Like = E & { k: 'like'; op: string; x: Expr; pat: Expr; esc: Expr | null; not: boolean };
export type Between = E & { k: 'between'; x: Expr; lo: Expr; hi: Expr; not: boolean };
/** A function call. `kwfn`: one written as a keyword, with no parentheses (CURRENT_TIMESTAMP). */
export type Fn = E & { k: 'fn'; name: string; args: Expr[]; star: boolean; distinct: boolean; kwfn?: true };
export type Exists = E & { k: 'exists'; sel: Select; not: boolean };
export type Case = E & { k: 'case'; base: Expr | null; whens: { when: Expr; then: Expr }[]; else: Expr | null };
export type Cast = E & { k: 'cast'; x: Expr; type: string };
export type Sub = E & { k: 'sub'; sel: Select };
export type Row = E & { k: 'row'; items: Expr[] };
export type Expr =
  Lit | Param | Col | Un | Bin | Collate | IsNull | In | Like | Between | Fn | Exists | Case | Cast | Sub | Row;

// ---- the parts of a statement
/** One item of a SELECT list or a RETURNING list: `*`, `t.*`, or an expression with the name it is given. */
export type ResultCol = Span &
  ({ k: 'rcol'; star: true; table: string | null } | { k: 'rcol'; star: false; expr: Expr; alias: string | null });
export type OrderTerm = Span & { k: 'order'; expr: Expr; dir: 'ASC' | 'DESC' };
export type Join = 'left' | 'inner' | 'cross' | ',';
/** One table of a FROM clause, or a subquery standing for one, with how it is joined to those before it. */
export type TableRef = Span & {
  k: 'tref';
  alias: string | null;
  join: Join | null;
  on: Expr | null;
  using: string[] | null;
} & ({ sub: Select; name: null } | { sub: null; name: string });
/** `col = expr`. `row`: one of the columns of `(a, b) = (x, y)`, whose values open at `rs`. */
export type Assign = Span & { k: 'assign'; col: string; expr: Expr; row?: true; rs?: number };
export type Upsert = Span & {
  k: 'upsert';
  target: string[] | null;
  targetWhere: Expr | null;
  action: 'nothing' | 'update';
  set: Assign[];
  where: Expr | null;
};
export type References = { table: string; cols: string[] | null };
export type ColDef = Span & {
  k: 'coldef';
  name: string;
  type: string;
  notNull: boolean;
  pk: boolean;
  pkDir: 'DESC' | null;
  autoinc: boolean;
  unique: boolean;
  default: Expr | undefined;
  checks: Expr[];
  references: References | null;
  collate: string | null;
};
export type Constraint = Span &
  (
    | { k: 'constraint'; kind: 'pk' | 'unique'; cols: string[] }
    | { k: 'constraint'; kind: 'check'; expr: Expr }
    | { k: 'constraint'; kind: 'fk'; cols: string[]; references: References }
  );
export type IndexCol = Span & { k: 'icol'; expr: Expr; dir: 'ASC' | 'DESC' };

// ---- statements
export type Select = Span & {
  k: 'select';
  distinct: boolean;
  cols: ResultCol[];
  from: TableRef[];
  where: Expr | null;
  group: Expr[] | null;
  having: Expr | null;
  order: OrderTerm[] | null;
  limit: Expr | null;
  offset: Expr | null;
};
export type OnConflict = 'REPLACE' | 'IGNORE' | 'ABORT' | 'FAIL' | 'ROLLBACK';
/** One `(…)` of VALUES, with where it opens. */
export type ValuesRow = Expr[] & { s: number };
export type Insert = Span & {
  k: 'insert';
  or: OnConflict | null;
  replace: boolean;
  table: string;
  alias: string | null;
  cols: string[] | null;
  values: ValuesRow[] | null;
  select: Select | null;
  defaults: boolean;
  upsert: Upsert | null;
  returning: ResultCol[] | null;
};
export type Update = Span & {
  k: 'update';
  or: OnConflict | null;
  table: string;
  alias: string | null;
  set: Assign[];
  where: Expr | null;
  returning: ResultCol[] | null;
};
export type Delete = Span & {
  k: 'delete';
  table: string;
  alias: string | null;
  where: Expr | null;
  returning: ResultCol[] | null;
};
export type CreateTable = Span & {
  k: 'create_table';
  ifNot: boolean;
  table: string;
  cols: ColDef[];
  constraints: Constraint[];
  withoutRowid: boolean;
  strict: boolean;
};
export type CreateIndex = Span & {
  k: 'create_index';
  unique: boolean;
  ifNot: boolean;
  name: string;
  table: string;
  cols: IndexCol[];
  where: Expr | null;
};
export type Alter = Span & { k: 'alter'; table: string } & (
    | { action: 'rename_table'; to: string }
    | { action: 'rename_column'; from: string; to: string }
    | { action: 'add_column'; col: ColDef }
    | { action: 'drop_column'; col: string }
  );
export type Drop = Span & { k: 'drop'; what: 'table' | 'index'; ifExists: boolean; name: string };
export type Statement = Select | Insert | Update | Delete | CreateTable | CreateIndex | Alter | Drop;
export type Part = ResultCol | OrderTerm | TableRef | Assign | Upsert | ColDef | Constraint | IndexCol;
/** Anything in the tree. */
export type SqlNode = Statement | Part | Expr;

// ---- the schema statements build
export type Affinity = 'int' | 'text' | 'blob' | 'real' | 'numeric';
export type Column = {
  name: string;
  type: string;
  aff: Affinity;
  notNull: boolean;
  default: Expr | undefined;
  pk: boolean;
  checks: Expr[];
};
/** A set of columns no two rows share: from UNIQUE in the table, or from a unique index (then `index` names it). */
export type Unique = { cols: string[]; index: string | null };
export type Table = {
  name: string;
  cols: Column[];
  pk: string[];
  uniques: Unique[];
  checks: Expr[];
  /** the column that is the rowid under another name (a lone INTEGER PRIMARY KEY), if there is one */
  rowid: string | null;
  withoutRowid: boolean;
  strict: boolean;
};
/** An index. A column is null where the index is on an expression. */
export type Index = { name: string; table: string; cols: (string | null)[]; unique: boolean; partial: boolean };
/** Tables and indexes by lower-case name. */
export type Schema = { tables: Map<string, Table>; indexes: Map<string, Index> };

// ---- what the checker finds (sql/analyze.ts)
/** The kind of a value. `any`: nothing is known of it (a parameter of unknown kind, a column of no affinity). */
export type TyName = 'int' | 'real' | 'text' | 'blob' | 'any' | 'null';
/**
 * The type of an expression: its kind and whether it can be NULL. `param`: it is the parameter ?n and nothing else.
 * `pkNull`: it is a PRIMARY KEY column that is not declared NOT NULL, named `table.column` (SQLite lets it be NULL).
 */
export type Ty = { t: TyName; null: boolean; param?: number; pkNull?: string };
/** What the checker needs of a column: a table's own, a subquery's result standing as one, or the rowid. */
export type ColFacts = { name: string; aff: Affinity; notNull: boolean; rowid?: true } & Partial<
  Pick<Column, 'type' | 'default' | 'pk' | 'checks'>
>;
/** A table as the checker reads it. `builtin`: reserved (unused now that sqlite_* is unreachable from program Sql). */
export type TableFacts = Omit<Table, 'cols' | 'strict'> & { cols: ColFacts[]; strict?: boolean; builtin?: true };
/**
 * Something a column name can come from: a table of FROM, a subquery in FROM, the table an INSERT or UPDATE
 * writes. `byName`: the table's own name still qualifies its columns though it has an alias (an INSERT's target).
 * `qualifierOnly`: its columns are reached only as `name.column` (`excluded` in an upsert).
 */
export type Source = {
  name: string | null;
  alias: string | null;
  table: TableFacts | null;
  cols: ColFacts[];
  nullable: boolean;
  byName?: true;
  qualifierOnly?: true;
  excluded?: true;
};
export type Frame = Source[];
/** What a column name was resolved to. `depth`: how many SELECTs out (0: this one; more: a correlated subquery). */
export type Ref = {
  source: Source;
  table: TableFacts | null;
  col: ColFacts;
  depth: number;
  qualified: boolean;
  excluded: boolean;
};
export type ResultColumn = { name: string } & Ty;
export type SqlProblem = { kind: string; message: string; pos: number };
export type Analysis = {
  errors: SqlProblem[];
  /** the columns a SELECT or a RETURNING gives; null for a statement that gives none, or one that is wrong */
  result: ResultColumn[] | null;
  /** what each parameter is compared with or stored into */
  params: Map<number, { t: TyName; why: string }>;
  refs: Map<Col, Ref>;
  frames: Map<SqlNode, Frame>;
};
