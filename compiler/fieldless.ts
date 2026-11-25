// compiler/fieldless.ts: a sum whose constructors have no fields (`type EventState { Onsale Canceled }`) is stored
// as text: in a column, in a query's parameter, and in JSON. The text of a constructor is its name in snake_case
// (`Onsale` is "onsale", `PartlyRefunded` "partly_refunded"), so data named before the type was reads unchanged. The
// compiled builds (compiler/gen, compiler/wire.ts), the host (host/memory.ts), the reference interpreter (interp/)
// and the machines (rules/machines) all say it from here.
import type { Program } from './ast.ts';

/** The text a constructor is stored as: an underscore before each capital but the first, then lower case. */
export const storedText = (ctor: string): string => ctor.replaceAll(/(?<=.)([A-Z])/g, '_$1').toLowerCase();

/**
 * The constructors of a fieldless sum, in their order, or null when `name` is not one: a declared type with no type
 * parameters and no refinement, of two constructors or more, none of which has fields. A type of one constructor
 * with no fields is a record with none (`{}` in JSON, as std's Done), not a choice; Bool is not a declared type.
 */
export function fieldlessOf(prog: Program, name: string): readonly string[] | null {
  const d = prog.types.get(name);
  if (!d || d.refine || d.params.length > 0 || d.variants.length < 2) return null;
  return d.variants.every(v => v.fields.length === 0) ? d.variants.map(v => v.name) : null;
}

// constructors with no fields that are not stored as text: a Bool is an INTEGER, None is NULL
const NOT_TEXT: ReadonlySet<string> = new Set(['True', 'False', 'None']);
/**
 * The text a constructor written with no fields (`Canceled`, in an expression or a pattern) stands for in SQL, for
 * the rules, which read the program's text before its types: only a fieldless sum's constructor can be bound to a
 * query, so a constructor of another type never reaches one.
 */
export const textOfCtor = (name: string, fields: number): string | null =>
  fields === 0 && !NOT_TEXT.has(name) ? storedText(name) : null;

/** The texts of a fieldless sum's constructors, each in JSON as a message lists them: `"onsale", "canceled"`. */
export const listed = (ctors: readonly string[]): string => ctors.map(c => JSON.stringify(storedText(c))).join(', ');

/** What decode says of a value that is no constructor's text. */
export const expectedOneOf = (ctors: readonly string[]): string => `expected one of ${listed(ctors)}`;
