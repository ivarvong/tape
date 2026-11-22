// compiler/invariants.ts: an invariant is one SELECT with no placeholders, over the tables the schema has (C86).
import { sqlModel } from '../rules.ts';
import type { Select } from '../sql/ast.ts';
import { analyze, tryParse } from '../sql.ts';
import type { Invariant, Program } from './ast.ts';
import { numbered } from './sqltext.ts';
import type { Problem } from './common.ts';

/** An invariant as the module lists it. `with`: the other programs whose tables its SELECT also reads. */
export type CheckedInvariant = { name: string; settled: boolean; sql: string; with?: string[] };
type Refusal = { message: string; hint: string };
const refusal = (message: string, hint: string): Refusal => ({ message, hint });
const READS_ONLY = 'Write a SELECT that returns the rows that break the rule; none means it holds.';
const notASelect = (word: string): Refusal =>
  refusal(`it is ${word.toUpperCase()}, and an invariant only reads`, READS_ONLY);

// One that reads another program's tables (pay.ledger) is outside what the checker reads: it is run only by the
// simulator, which reports a SELECT that cannot run as a finding. Here it is only seen to be a SELECT.
function foreign(v: Invariant): Refusal | null {
  const word = v.sql.trim().split(/\s+/)[0] ?? '';
  return /^select$/i.test(word) ? null : notASelect(word.toLowerCase());
}
// the SELECT an invariant is, or why it is not one
function selectOf(v: Invariant): Select | Refusal {
  const tree = tryParse(v.sql);
  if (tree.error) return refusal(tree.error.message, 'An invariant is one SELECT whose rows are what is wrong.');
  return tree.ast.k === 'select' ? tree.ast : notASelect(tree.ast.k);
}
// what is wrong with an invariant, if anything
function problemWith(prog: Program, v: Invariant): Refusal | null {
  const own = v.with.length === 0,
    select = own ? selectOf(v) : foreign(v);
  if (numbered(v.sql).names?.length !== 0)
    return refusal('it has a placeholder, and nothing is passed to an invariant', 'Write the values into the SELECT.');
  if (select && 'message' in select) return select;
  const model = sqlModel(prog),
    first = select && model.errors.length === 0 ? analyze(select, model.schema, { src: v.sql }).errors[0] : undefined;
  if (!first) return null;
  return refusal(
    first.message,
    first.kind === 'name'
      ? "Name a table and column the program's schema (its migrations) has."
      : 'Write it in the SQL the checker reads.',
  );
}
/** The program's invariants that are sound; a problem with one is added to `found`. */
export function checkInvariants(prog: Program, found: Problem[]): CheckedInvariant[] {
  const out: CheckedInvariant[] = [],
    seen = new Set<string>();
  for (const v of prog.invariants ?? []) {
    const bad = seen.has(v.name)
      ? refusal('there is already an invariant with this name', 'Give each invariant its own name.')
      : problemWith(prog, v);
    seen.add(v.name);
    if (bad)
      found.push({
        code: 'C86',
        file: v.file,
        line: v.line,
        message: `invariant "${v.name}": ${bad.message}`,
        hint: bad.hint,
      });
    else out.push({ name: v.name, settled: v.settled, sql: v.sql, ...(v.with.length > 0 ? { with: v.with } : {}) });
  }
  return out;
}
