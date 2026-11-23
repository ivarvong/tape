// sql/analyze.ts: a statement checked against a schema: every name resolved, every expression typed.
//
// analyze(ast, schema, { src, params }) gives what it found (Analysis, sql/ast.ts): the problems, the columns a
// SELECT or a RETURNING gives, what each parameter is used as, and what each column name resolved to. The checks
// are in sql/check/: context.ts (what one check carries), resolve.ts (names), query.ts (expressions and SELECT),
// functions.ts (the functions it knows), statement.ts (the statements that write or build the schema).
import { unreachable } from '../compiler/ast.ts';
import type { Analysis, ResultColumn, Schema, Statement } from './ast.ts';
import { type AnalyzeOptions, Check } from './check/context.ts';
import { select } from './check/query.ts';
import { alter, createIndex, createTable, del, insert, update } from './check/statement.ts';
import { tokenize } from './tokens.ts';

export { type AnalyzeOptions, TAPE_T } from './check/context.ts';

// the columns the statement gives, if it gives any
function check(k: Check, ast: Statement): ResultColumn[] | null {
  switch (ast.k) {
    case 'select':
      return select(k, ast);
    case 'insert':
      return insert(k, ast);
    case 'update':
      return update(k, ast);
    case 'delete':
      return del(k, ast);
    case 'create_table':
      createTable(k, ast);
      return null;
    case 'create_index':
      createIndex(k, ast);
      return null;
    case 'alter':
      alter(k, ast);
      return null;
    case 'drop':
      return null;
    default:
      return unreachable(ast, 'statement');
  }
}
export function analyze(ast: Statement, schema: Schema, opts: AnalyzeOptions = {}): Analysis {
  const k = new Check(schema, opts);
  return k.result(check(k, ast));
}

/**
 * The text to run for a query whose ?n parameters have tape kinds `kinds` ('i' Int, 'b' Bool, 't' Text; upper case
 * for an Option of one, which may be NULL, and CAST(NULL AS INTEGER) is NULL). The
 * Durable Object SQL API (and node:sqlite) bind every JavaScript number as REAL: ?1 bound to 5 is 5.0, so
 * 'k' || ?1 is 'k5.0', ?1 / 2 is 2.5, and a column with no INTEGER affinity stores 5.0 (measured in workerd and
 * node:sqlite). Neither API binds a BigInt as an integer (workerd: "Cannot convert a BigInt value to a number").
 * So each Int or Bool parameter is read as CAST(?n AS INTEGER), exact for every tape Int (|n| <= 2^53).
 */
export function integerParams(sql: string, kinds: string): string {
  const whole = tokenize(sql).filter(t => t.t === 'param' && 'iIbB'.includes(kinds[t.v - 1] ?? 'x'));
  return whole.reduceRight((out, t) => `${out.slice(0, t.s)}CAST(?${t.v} AS INTEGER)${out.slice(t.e)}`, sql);
}
