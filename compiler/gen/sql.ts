// compiler/gen/sql.ts: sql_exec, sql_all, sql_first and sql_move. A query is a text literal, so the module lists
// every statement it can run; its parameters are written into a block of 16-byte cells the host reads.
import type { Arg, Call, TypeAst } from '../ast.ts';
import { I32, fail, sleb, uleb } from '../common.ts';
import { sqlModel, tablesOf } from '../../rules/model.ts';
import { movePlan } from '../../rules/move.ts';
import { inNames } from '../sqltext.ts';
import { analyze } from '../../sql/analyze.ts';
import { tryParse } from '../../sql/parse.ts';
import { INT, T, key } from '../types.ts';
import type { Type } from '../types.ts';
import { decodeRow } from './decode.ts';
import { buildVariant, close, fresh, get, open, set } from './fn.ts';
import type { Ctx, Place } from './fn.ts';
import type { Adt, FlatField } from './layout.ts';

type Stop = (at: Place, code: string, message: string, hint: string) => never;
const i32 = (n: number): number[] => [0x41, ...sleb(n)];
const variantOf = (adt: Adt, name: string): number => adt.variants.findIndex(v => v.name === name);

// ---- The query read by sql.ts against the program's schema (its schema statements and migrations): it parses
// (C67: outside the subset the checker takes), every name resolves (C68), and every value is of its column's
// kind, a NOT NULL column gets no NULL, and the row type is the query's columns, by name, kind and nullability
// (C69). A schema that does not build is reported by the rules (C67, C68), not again at each query.

const KIND_HINT: Readonly<Record<string, string>> = {
  name: "Name a table and column the program's schema (its migrations) has.",
  subset: 'Write it in the SQL the checker reads.',
};
const OTHER_HINT =
  "Store and compare values of the column's own kind: Int and Bool for INTEGER, View for TEXT; give a NOT NULL column a value that cannot be NULL.";
const codeOf = (kind: string): string => (kind === 'subset' ? 'C67' : kind === 'name' ? 'C68' : 'C69');

type Column = { name: string; t: string; null: boolean; param?: number; pkNull?: string };

/** One column of the result against the field of the row type it is read into. */
function checkColumn(qa: Arg, c: Column, f: FlatField, i: number, kinds: string, stop: Stop): void {
  const opt = f.type.name === 'Option';
  const base = (opt ? f.type.args[0]?.name : undefined) ?? f.type.name;
  const want = base === 'View' ? 'text' : 'int';
  if (c.name !== f.name)
    stop(
      qa,
      'C69',
      `column ${i + 1} of the query is \`${c.name}\`, and field ${i + 1} of the row type is \`${f.name}\``,
      `Name the column with AS ${f.name}, or reorder the fields.`,
    );
  const t =
    c.t === 'any' && c.param !== undefined && c.param !== 0 ? (kinds[c.param - 1] === 't' ? 'text' : 'int') : c.t;
  if (t !== want)
    stop(
      qa,
      'C69',
      `column ${c.name} is ${t === 'int' ? 'an integer' : t === 'text' ? 'text' : t === 'real' ? 'a real number' : t === 'blob' ? 'of no declared type' : t === 'null' ? 'always NULL' : 'of a type the checker cannot tell'}, and field ${f.name} is ${key(f.type)}`,
      base === 'View' ? 'A View field reads a TEXT column.' : 'An Int or Bool field reads an INTEGER column.',
    );
  if (c.null && !opt)
    stop(
      qa,
      'C69',
      `column ${c.name} may be NULL, and field ${f.name} is ${key(f.type)}, which cannot hold it: reading such a row stops the request${c.pkNull ? ` (${c.pkNull} is a PRIMARY KEY, but SQLite lets a PRIMARY KEY column hold NULL unless it is declared NOT NULL, it is an INTEGER PRIMARY KEY, or its table is WITHOUT ROWID or STRICT)` : ''}`,
      c.pkNull
        ? `Add NOT NULL to the column in its migration: \`${c.pkNull.split('.')[1]} ${c.t === 'int' ? 'INTEGER' : 'TEXT'} PRIMARY KEY NOT NULL\`.`
        : `Make the field Option[${base}], or select coalesce(${c.name}, …), or declare the column NOT NULL.`,
    );
  if (!c.null && opt)
    stop(
      qa,
      'C69',
      `column ${c.name} is never NULL, and field ${f.name} is ${key(f.type)}: its None can never happen`,
      `Make the field ${base}.`,
    );
}

function check(
  c: Ctx,
  qa: Arg,
  via: string,
  q: string,
  kinds: string,
  row: readonly FlatField[] | null,
  stop: Stop,
): void {
  const model = sqlModel(c.B.prog);
  const tree = tryParse(q);
  if (tree.error) return; // C67: the rules report it, for every query
  if (model.errors.length > 0) return;
  const a = analyze(tree.ast, model.schema, { src: q, params: kinds });
  const [first] = a.errors;
  if (first) stop(qa, codeOf(first.kind), `${via}: ${first.message}`, KIND_HINT[first.kind] ?? OTHER_HINT);
  if (!row) return;
  const res = a.result;
  if (!res) {
    if (via === 'sql_move') return;
    return stop(
      qa,
      'C69',
      `${via} reads a row, but this ${tree.ast.k.toUpperCase()} gives none`,
      'Add RETURNING with the columns of the row type, or use sql_exec.',
    );
  }
  const names = row.map(f => f.name);
  if (res.length !== row.length)
    stop(
      qa,
      'C69',
      `the query gives ${res.length} column${res.length === 1 ? '' : 's'} (${res.map(x => x.name).join(', ')}) and the row type has ${row.length} field${row.length === 1 ? '' : 's'} (${names.join(', ')})`,
      'Select exactly the fields of the row type, in its order.',
    );
  res.forEach((col, i) => {
    const f = row[i];
    if (f) checkColumn(qa, col, f, i, kinds, stop);
  });
}

/** Thrown to leave a query once its problem is written down. */
class Recorded extends Error {}

/** Checks a query; what is wrong is recorded for the build to report with the rules' problems, in source order. */
function checkSql(
  c: Ctx,
  qa: Arg,
  via: string,
  q: string,
  kinds: string,
  row: readonly FlatField[] | null,
  names: readonly string[],
): void {
  // the checker read the numbered statement; what it says is said in the program's names
  const stop: Stop = (at, code, message, hint) => {
    c.B.sqlFound.push({
      code,
      file: at?.file ?? '',
      line: at?.line ?? 0,
      message: inNames(message, names),
      hint: inNames(hint, names),
    });
    throw new Recorded();
  };
  try {
    check(c, qa, via, q, kinds, row, stop);
  } catch (x) {
    if (!(x instanceof Recorded)) throw x;
  }
}

// ---- the call

/** The query of a call, its placeholders, and the row type it reads into (none for sql_exec). */
type Query = {
  qa: Arg;
  q: string;
  n: number;
  rowT: Type | null;
  /** the call says `repeat: True` */
  repeat: boolean;
  arg: (name: string) => Arg | undefined;
};

const NOT_VALUES = ['db', 'query', 'row', 'repeat', 'no_floor'];
function queryOf(c: Ctx, e: Call): Query {
  const arg = (n: string): Arg | undefined => e.args.find(a => a.label === n);
  const takes = `${e.name} takes (db, ${e.name === 'sql_exec' ? '' : 'row, '}query, and a value for each name in the query).`;
  for (const a of e.args) if (a.label === null) fail(a, 'C10', 'arguments must be named', takes);
  const db =
    arg('db') ??
    fail(
      e,
      'C13',
      `${e.name} is missing argument db`,
      "Pass the function's Sql parameter: every call that reaches the database names it.",
    );
  const dv = db.value.k === 'var' ? c.env.get(db.value.name) : undefined;
  if (dv?.type.name !== 'Sql')
    fail(
      db,
      'C14',
      'argument db should be the Sql parameter',
      "Add `db: Sql` to this function's parameters and pass it here.",
    );
  const qa =
    arg('query') ??
    fail(
      e,
      'C13',
      `${e.name} is missing argument query`,
      'Pass the statement as a text literal: `query: "SELECT * FROM t WHERE id = :id"`.',
    );
  if (qa.value.k !== 'str')
    return fail(
      qa,
      'C32',
      `the query of ${e.name} must be a text literal`,
      'Queries are fixed at compile time, so the module lists every statement it can run. Name each value it takes, `WHERE id = :id`, and pass it by that name.',
    );
  const q = new TextDecoder().decode(new Uint8Array(qa.value.bytes));
  const { params } = e;
  if (params === undefined)
    return fail(
      qa,
      'C32',
      'a query names the values it takes; this one has a ? placeholder',
      'Write `WHERE id = :id` and pass `id` (or `id: value`): the name says what the value is where it is used.',
    );
  const rowT = e.name === 'sql_exec' ? null : rowTypeOf(c, e, arg('row'));
  const fixed = ['db', 'query', ...(rowT ? ['row'] : []), 'repeat', 'no_floor'];
  const reserved = params.find(name => NOT_VALUES.includes(name));
  if (reserved !== undefined)
    fail(
      qa,
      'C32',
      `the placeholder :${reserved} has the name of an argument every query call takes`,
      `Give it another name: ${NOT_VALUES.join(', ')} are the call's own.`,
    );
  const allowed = [...fixed, ...params];
  for (const a of e.args)
    if (a.label === null || (a.as === undefined && !fixed.includes(a.label)))
      fail(a, 'C11', `${e.name} with this query has no parameter ${a.label}`, `It takes (${allowed.join(', ')}).`);
  said(arg('no_floor'), 'no_floor', 'a write that may take a count below any floor');
  const repeat = said(arg('repeat'), 'repeat', 'a write that is meant to apply again each time it runs');
  return { qa, q, n: params.length, rowT, repeat, arg };
}

/** `name: True` and nothing else: the argument is a statement about the write, read by the rules, not a value. */
function said(a: Arg | undefined, name: string, what: string): boolean {
  if (!a) return false;
  if (a.value.k !== 'ctor' || a.value.name !== 'True' || a.value.args.length > 0)
    fail(
      a,
      'C14',
      `argument ${name} should be True`,
      `Say \`${name}: True\` on ${what}, and leave the argument out otherwise.`,
    );
  return true;
}

function rowTypeOf(c: Ctx, e: Call, ra: Arg | undefined): Type {
  if (!ra) return fail(e, 'C13', `${e.name} is missing argument row`, 'Name the row type, for example `row: Todo`.');
  if (ra.value.k !== 'ctor' || ra.value.args.length > 0)
    return fail(
      ra,
      'C14',
      'argument row should be a type name',
      'Name the row type itself, `row: Todo`, not a value of it.',
    );
  const named: TypeAst = { name: ra.value.name, args: [], line: ra.line, file: ra.file };
  const rowT = c.B.resolve(named);
  c.B.rowOf(rowT, ra);
  return rowT;
}

/** Writes the parameters into a new block; gives the block's local (-1 with none) and each one's kind. */
function bindParams(c: Ctx, e: Call, query: Query): { block: number; kinds: string } {
  const { n } = query;
  if (n === 0) return { block: -1, kinds: '' };
  const block = fresh(c, I32);
  c.code.push(...i32(16 * n), 0x10, ...uleb(c.B.ALLOC), ...set(block));
  let kinds = '';
  for (let i = 0; i < n; i++) {
    const name = e.params?.[i] ?? '';
    const a =
      e.args.find(x => x.as === name) ??
      fail(
        e,
        'C13',
        `${e.name} is missing argument ${name}`,
        `The query uses :${name}: pass \`${name}\` or \`${name}: value\`.`,
      );
    c.code.push(...get(block));
    const t = c.B.strip(c.emit(a.value, null, false));
    if (t.name === 'Int') c.code.push(0x37, 0, ...uleb(16 * i));
    else if (t.name === 'Bool') c.code.push(0xad, 0x37, 0, ...uleb(16 * i));
    else if (t.name === 'View') {
      const len = fresh(c, I32);
      c.code.push(...set(len), 0x36, 0, ...uleb(16 * i), ...get(block), ...get(len), 0x36, 0, ...uleb(16 * i + 4));
    } else
      fail(
        a,
        'C14',
        `argument ${a.as ?? a.label} should be Int, Bool or View but is ${key(t)}`,
        'A query takes numbers, Bools and text. Pass a field of the record instead: `id: order.id`.',
      );
    kinds += t.name === 'Int' ? 'i' : t.name === 'Bool' ? 'b' : 't';
  }
  return { block, kinds };
}

/** `when the i32 on the stack is not zero, the row at `r`, else the other value`: both arms of one result. */
function rowOr(
  c: Ctx,
  adt: Adt,
  r: number,
  cur: number,
  some: string,
  rowT: Type,
  e: Call,
  otherwise: () => void,
): void {
  c.code.push(...get(r), 0x28, 0, 0);
  open(c, 0x04, adt.slots);
  c.code.push(...get(r), ...i32(8), 0x6a, ...set(cur));
  buildVariant(c, adt, variantOf(adt, some), decodeRow(c, rowT, cur, e));
  c.code.push(0x05);
  otherwise();
  close(c);
}

type Ran = {
  query: Query;
  block: number;
  kinds: string;
  row: readonly FlatField[];
  r: number;
  cur: number;
  rowT: Type;
};

// Moved when the UPDATE changed the row; otherwise the row read by its key alone (same transaction):
// Raced(now) when it is there, NoRow when it is not. The SELECT is derived from the UPDATE (movePlan).
function emitMove(c: Ctx, e: Call, ran: Ran): Type {
  const { B } = c;
  const { rowT, row, cur } = ran;
  const plan = movePlan(ran.query.q, B.prog.machines, tablesOf(B.prog));
  if (plan.error !== undefined)
    return fail(
      ran.query.qa,
      'C63',
      `sql_move cannot take this statement: ${plan.error}`,
      'sql_move takes `UPDATE table SET … WHERE key = :key AND state = :from RETURNING …`: the row named by its key, a compare-and-set on the state, and the columns of the row type.',
    );
  const mv = T('Move', rowT);
  const adt = B.adtOf(mv, e);
  rowOr(c, adt, ran.r, cur, 'Moved', rowT, e, () => {
    const some = plan.params.length > 0;
    const block2 = some ? fresh(c, I32) : -1;
    if (some) c.code.push(...i32(16 * plan.params.length), 0x10, ...uleb(B.ALLOC), ...set(block2));
    plan.params.forEach((n, j) => {
      const to = [...get(block2), ...i32(16 * j), 0x6a];
      c.code.push(...to, ...get(ran.block), ...i32(16 * (n - 1)), 0x6a, 0x41, 16, 0xfc, 0x0a, 0, 0);
    });
    const id2 = B.queryId({
      sql: plan.select,
      params: plan.params.map(n => ran.kinds[n - 1]).join(''),
      row: row.map(f => B.rowKind(f)).join(''),
      columns: row.map(x => x.name),
    });
    const r2 = fresh(c, I32);
    c.code.push(...i32(id2), ...(some ? get(block2) : [0x41, 0]), 0x41, 1, 0x10, 0, 0xfc, 0x03, ...set(r2));
    rowOr(c, adt, r2, cur, 'Raced', rowT, e, () => {
      buildVariant(c, adt, variantOf(adt, 'NoRow'), []);
    });
  });
  return mv;
}

export function emitSql(c: Ctx, e: Call): Type {
  const { B } = c;
  const query = queryOf(c, e);
  const { qa, q, rowT } = query;
  const { block, kinds } = bindParams(c, e, query);
  const row = rowT ? (B.rowOf(rowT, e).variants[0]?.fields ?? []) : null;
  checkSql(c, qa, e.name, q, kinds, row, e.params ?? []);
  const id = B.queryId({
    sql: q,
    params: kinds,
    row: row ? row.map(f => B.rowKind(f)).join('') : null,
    columns: row ? row.map(x => x.name) : null,
    ...(query.repeat ? { repeat: true } : {}),
  });
  c.code.push(...i32(id), ...(query.n > 0 ? get(block) : [0x41, 0]), 0x41, rowT ? 1 : 0, 0x10, 0);
  if (!rowT || !row) {
    // rows written
    c.code.push(0xfc, 0x06);
    return INT;
  }
  const r = fresh(c, I32);
  const cur = fresh(c, I32);
  // pointer to: u32 row count, pad, cells
  c.code.push(0xfc, 0x03, ...set(r));
  if (e.name === 'sql_all') {
    c.code.push(...get(r), ...i32(8), 0x6a, ...get(r), 0x28, 0, 0);
    return T('Rows', rowT);
  }
  if (e.name === 'sql_move') return emitMove(c, e, { query, block, kinds, row, r, cur, rowT });
  const opt = T('Option', rowT);
  const adt = B.adtOf(opt, e);
  rowOr(c, adt, r, cur, 'Some', rowT, e, () => {
    buildVariant(c, adt, variantOf(adt, 'None'), []);
  });
  return opt;
}
