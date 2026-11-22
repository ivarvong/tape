// rules/guards.ts: C74. A column that some write guards as a state (`AND state = 'paid'`) is guarded by every
// write that sets it, when no machine declares its moves: the unguarded one moves a row from whatever state another
// request left it in.
import { conjunctsOf } from '../sql/tree.ts';
import { short } from './declared.ts';
import { lc } from './syntax.ts';
import type { Query, Reading } from './types.ts';
import { isValue, predicateOn, writeOf } from './writes.ts';

/** A write that sets a column to a value, and whether its WHERE says which value it expects there. */
type Setting = { readonly q: Query; readonly table: string; readonly col: string; readonly guarded: boolean };

/** Every write of a value into a column, by `table.column`. A state is set to a value; `n = n + 1` is a counter. */
function settings(queries: readonly Query[]): Map<string, Setting[]> {
  const writes = new Map<string, Setting[]>();
  for (const q of queries) {
    const s = writeOf(q.ast);
    const assigns = s?.kind === 'update' ? s.assigns : s?.kind === 'insert' ? s.upsert : null;
    if (!s || s.kind === 'delete' || !assigns) continue;
    const cs = conjunctsOf(s.kind === 'update' ? s.where : s.upsertWhere) ?? [];
    const names = [lc(s.table), lc(s.alias)].filter(Boolean);
    for (const x of assigns) {
      if (!isValue(x.expr)) continue;
      const k = `${lc(s.table)}.${lc(x.col)}`;
      const guarded = cs.some(c => predicateOn(c, names, x.col));
      writes.set(k, [...(writes.get(k) ?? []), { q, table: s.table, col: x.col, guarded }]);
    }
  }
  return writes;
}

export function guardRules({ prog, queries, bad }: Reading): void {
  for (const [k, ws] of settings(queries)) {
    if (prog.machines.some(m => `${lc(m.table)}.${lc(m.column)}` === k)) continue;
    const by = ws.find(w => w.guarded);
    if (!by) continue;
    for (const w of ws)
      if (!w.guarded)
        bad(
          'C74',
          w.q.at,
          `this write sets ${w.table}.${w.col} without saying which ${w.col} it expects, but ${by.q.at.file}:${by.q.at.line} guards it (\`${short(by.q.raw)}\`): ${w.col} is a state, and this write moves a row from whatever state another request has just left it in`,
          `Say which states it moves from, at the top level of the WHERE: \`AND ${w.col} = …\`, or \`AND ${w.col} IN (…)\` listing every state it may leave (all of them, if it may leave any). Or declare the moves: \`machine ${w.table}.${w.col} { … }\`.`,
        );
  }
}
