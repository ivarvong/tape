// sql/check/resolve.ts: a column name to the column it means, looking from the innermost SELECT outwards.
import type { Col, ColFacts, Frame, Ref, Source } from '../ast.ts';
import { lc } from '../tokens.ts';
import { type Check, type Stack, isRowidName, nameOf, rowidAs } from './context.ts';

type Found = { source: Source; col: ColFacts; qualified: boolean } | 'stop' | null;
const named = (s: Source, name: string): ColFacts | undefined => s.cols.find(x => lc(x.name) === lc(name));

// `table.column`: the source of that name in this frame, and its column (or its rowid under one of its names)
function qualified(k: Check, e: Col, table: string, frame: Frame): Found {
  const source = frame.find(
    s => nameOf(s) === lc(table) || (s.alias !== null && s.byName === true && lc(s.name) === lc(table)),
  );
  if (!source) return null;
  const hasRowid = source.table && !source.table.withoutRowid && isRowidName(e.name),
    col = named(source, e.name) ?? (hasRowid ? rowidAs(e.name) : null);
  if (col) return { source, col, qualified: true };
  k.err('name', `no such column: ${table}.${e.name}`, e);
  return 'stop';
}
// a bare `column`: the one source in this frame that has it, or the rowid of the one table there is
function bare(k: Check, e: Col, frame: Frame): Found {
  const open = frame.filter(s => !s.qualifierOnly),
    hits = open.filter(s => named(s, e.name)),
    [hit] = hits,
    col = hit && named(hit, e.name);
  if (hits.length > 1) {
    k.err('name', `ambiguous column name: ${e.name} (in ${hits.map(h => h.alias ?? h.name).join(' and ')})`, e);
    return 'stop';
  }
  if (hit && col) return { source: hit, col, qualified: false };
  const withRowid = open.filter(s => s.table && !s.table.withoutRowid),
    [only] = withRowid;
  return isRowidName(e.name) && only && withRowid.length === 1
    ? { source: only, col: rowidAs(e.name), qualified: false }
    : null;
}
/** What a column name means in this scope, or null with the problem noted. */
export function resolve(k: Check, e: Col, stack: Stack): Ref | null {
  for (let d = stack.length - 1; d >= 0; d--) {
    const frame = stack[d] ?? [],
      found = e.table ? qualified(k, e, e.table, frame) : bare(k, e, frame);
    if (found === 'stop') return null;
    if (found)
      return k.resolved(e, {
        source: found.source,
        table: found.source.table,
        col: found.col,
        depth: stack.length - 1 - d,
        qualified: found.qualified,
        excluded: found.qualified && !!found.source.excluded,
      });
  }
  k.err(
    'name',
    e.table ? `no such table or alias: ${e.table} (in ${e.table}.${e.name})` : `no such column: ${e.name}`,
    e,
  );
  return null;
}
