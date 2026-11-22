// rules/types.ts: what the rules read a program as: each query with its tree, what a statement writes, the tables.
import type { Call, Expr as TapeExpr, FnDecl, Program } from '../compiler/ast.ts';
import type { Analysis, Assign, Expr, Lit, Param, Select, Statement, Upsert, ValuesRow } from '../sql/ast.ts';
import type { ProgramSchema } from '../sql/program.ts';
import type { SqlError } from '../sql/tokens.ts';

/** A literal that is not NULL, or a parameter: what a column can be compared with and the rules can follow. */
export type Value = Lit | Param;
/** What a statement writes. A statement that only reads has none. */
export type Write =
  | { kind: 'update'; table: string; alias: string | null; assigns: Assign[]; where: Expr | null }
  | {
      kind: 'insert';
      table: string;
      alias: string | null;
      /** the columns named; [] for DEFAULT VALUES; null when the statement names none */
      cols: string[] | null;
      /** the first row of VALUES */
      vals: ValuesRow | null;
      rows: number;
      select: Select | null;
      replace: boolean;
      /** the SET list of ON CONFLICT … DO UPDATE */
      upsert: Assign[] | null;
      upsertWhere: Expr | null;
      upsertNode: Upsert | null;
    }
  | { kind: 'delete'; table: string; alias: string | null; where: Expr | null };
/** A top-level conjunct comparing a column with values: `col = v`, `v = col` or `col IN (v, …)`. */
export type Predicate = { op: '=' | 'IN'; vals: Expr[] };
/** A column an expression reads, with the table it resolved to (or the qualifier it was written with). */
export type ColumnRead = { table: string | null; name: string; excluded: boolean };

/** One sql_* call with a literal query: its text, its tree or why it has none, and the arguments by number. */
export type Query = {
  fn: FnDecl;
  via: string;
  raw: string;
  /** the call says `repeat: True`: each run of this write is meant to apply */
  repeat: boolean;
  /** the call says `no_floor: True`: this write may take a count below any floor */
  noFloor: boolean;
  ast: Statement | null;
  error: SqlError | null;
  /** "1" -> the expression given for ?1 */
  args: Record<string, TapeExpr>;
  at: Call;
};
export type CallSite = { from: FnDecl; node: Call };
/** A table as the rules use it. `uniques`: each set of columns no two rows share, the primary key first. */
export type RuleTable = {
  cols: string[];
  pk: string[];
  uniques: string[][];
  /** column -> its DEFAULT as SQL text, or null for one that is not a literal */
  defaults: Record<string, string | null>;
};
/** A machine as far as a statement is read against one: the table and column whose value it governs. */
export type MachineColumn = { table: string; column: string };
export type { Analysis };
/** What the rules read a program through: the program, each query, who calls what, and the tables. */
export type RuleContext = {
  prog: Program;
  queries: Query[];
  calls: Map<string, CallSite[]>;
  tables: Map<string, RuleTable>;
};
/** How a rule says what is wrong: the code, where, the problem, and what to write instead. */
export type Report = (
  code: string,
  at: { readonly file?: string; readonly line?: number } | null | undefined,
  message: string,
  hint: string,
) => void;
/** A program as every rule reads it, and how a rule says what is wrong. */
export type Reading = RuleContext & { readonly model: ProgramSchema; readonly bad: Report };
