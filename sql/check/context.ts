// sql/check/context.ts: what one check of one statement carries (the schema it is read against, the problems found
// so far, what each name resolved to) and the vocabulary of types the checker speaks in.
import type {
  Affinity,
  Analysis,
  Col,
  ColFacts,
  Expr,
  Frame,
  Ref,
  Schema,
  Source,
  SqlNode,
  SqlProblem,
  TableFacts,
  Ty,
  TyName,
} from '../ast.ts';
import { lc } from '../tokens.ts';

/** The kind several values have together, or `mixed` when they cannot be one kind. */
export type Unified = TyName | 'mixed';
/** Where an expression stands: whether an aggregate may, whether the SELECT has GROUP BY, the result names in scope. */
export type Ctx = { agg?: boolean; grouped?: boolean; aliases?: Map<string, Ty> };
/** The sources a name can come from: a frame for each SELECT (or statement) around it, innermost last. */
export type Stack = Frame[];
/** What the checker is told of a statement: its text (for messages) and the tape kinds of ?1, ?2 … when known. */
export type AnalyzeOptions = { src?: string; params?: string | null };

/** The SQL kind of each tape kind a parameter can have: Int, Bool, text. */
export const TAPE_T: Readonly<Record<string, TyName>> = { i: 'int', f: 'real', b: 'int', t: 'text' };
export const AFF_T: Readonly<Record<Affinity, TyName>> = {
  int: 'int',
  text: 'text',
  real: 'real',
  blob: 'blob',
  numeric: 'any',
};
export const TY = (t: TyName, nul = false, extra: Pick<Ty, 'param' | 'pkNull'> = {}): Ty => ({
  t,
  null: nul,
  ...extra,
});
export const UNKNOWN: Ty = TY('any', true);
export const isNumber = (t: TyName): boolean => t === 'int' || t === 'real';
const SHOWN: Readonly<Record<Unified, string>> = {
  int: 'an integer',
  text: 'text',
  real: 'a real number',
  blob: 'a value of no declared type',
  null: 'NULL',
  any: 'a value of unknown type',
  mixed: 'a value of unknown type',
};
export const show = (t: Unified): string => SHOWN[t];
/** The kinds a list of values has, each named once, for a message: "an integer and text". */
export const kindsOf = (ts: readonly Pick<Ty, 't'>[]): string =>
  [...new Set(ts.map(x => x.t).filter(t => t !== 'null'))].map(show).join(' and ');
export function unify(ts: readonly Pick<Ty, 't'>[]): Unified {
  if (ts.some(x => x.t === 'any')) return 'any'; // a value of unknown type may be either: nothing is known
  const real = ts.filter(x => x.t !== 'null');
  let t: Unified = real[0]?.t ?? 'null';
  for (const x of real)
    if (x.t !== t) t = (t === 'int' && x.t === 'real') || (t === 'real' && x.t === 'int') ? 'real' : 'mixed';
  return t;
}
/** `mixed` read as a type: nothing is known of the value. */
export const settled = (t: Unified): TyName => (t === 'mixed' ? 'any' : t);

// sqlite_master, which a program may read (to list its triggers, its tables)
const MASTER: TableFacts = {
  name: 'sqlite_master',
  cols: ['type', 'name', 'tbl_name', 'rootpage', 'sql'].map((n): ColFacts => ({
    name: n,
    type: n === 'rootpage' ? 'INT' : 'TEXT',
    aff: n === 'rootpage' ? 'int' : 'text',
    notNull: false,
  })),
  pk: [],
  uniques: [],
  checks: [],
  rowid: null,
  withoutRowid: false,
  builtin: true,
};
const ROWID_NAME = /^(rowid|oid|_rowid_)$/i;
export const isRowidName = (name: string): boolean => ROWID_NAME.test(name);
export const rowidAs = (name: string): ColFacts => ({ name, aff: 'int', notNull: true, rowid: true });

/** A table as something names resolve in. */
export const sourceOf = (t: TableFacts, alias: string | null, extra: Pick<Source, 'byName'> = {}): Source => ({
  name: t.name,
  alias: alias ?? null,
  table: t,
  cols: t.cols,
  nullable: false,
  ...extra,
});
/** The type of a column read from a source: NULL when the column may be, or the source is the far side of a LEFT JOIN. */
export const colType = (source: Source, c: ColFacts): Ty =>
  TY(
    AFF_T[c.aff],
    !c.notNull || source.nullable,
    !c.notNull && c.pk && !source.nullable ? { pkNull: `${source.name}.${c.name}` } : {},
  );
/** The name a source goes by in the statement. */
export const nameOf = (s: Source): string => lc(s.alias ?? s.name ?? '');

export class Check {
  readonly src: string;
  readonly schema: Schema;
  /** the tape kinds of ?1, ?2 … ('i', 'b', 't'), when the caller knows them */
  readonly kinds: string | null;
  readonly errors: SqlProblem[] = [];
  readonly refs: Analysis['refs'] = new Map();
  readonly params: Analysis['params'] = new Map();
  readonly frames: Analysis['frames'] = new Map();
  constructor(schema: Schema, opts: AnalyzeOptions) {
    this.schema = schema;
    this.src = opts.src ?? '';
    this.kinds = opts.params ?? null;
  }
  err(kind: string, message: string, at?: { s: number } | null): void {
    this.errors.push({ kind, message, pos: at?.s ?? 0 });
  }
  /** the statement's own text for a node */
  text(n: { s: number; e: number }): string {
    return this.src.slice(n.s, n.e);
  }
  table(name: string): TableFacts | undefined {
    return this.schema.tables.get(lc(name)) ?? (/^sqlite_(master|schema)$/i.test(name) ? MASTER : undefined);
  }
  /** note what a column name resolved to */
  resolved(e: Col, r: Ref): Ref {
    this.refs.set(e, r);
    return r;
  }
  inScope(node: SqlNode, frame: Frame): Frame {
    this.frames.set(node, frame);
    return frame;
  }
  /** A parameter takes the kind of what it is used with; used as two kinds, it is a problem. */
  constrain(e: Expr | null | undefined, t: Unified, why: string): void {
    if (e?.k !== 'param' || t === 'any' || t === 'null' || t === 'mixed') return;
    const had = this.params.get(e.n);
    if (!had) this.params.set(e.n, { t, why });
    else if (had.t !== t && !(isNumber(had.t) && isNumber(t)))
      this.err('type', `?${e.n} is used as ${show(had.t)} (${had.why}) and as ${show(t)} (${why})`, e);
  }
  result(result: Analysis['result']): Analysis {
    return { errors: this.errors, result, params: this.params, refs: this.refs, frames: this.frames };
  }
}
