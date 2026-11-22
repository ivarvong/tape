// rules/replay.ts: C54, C55, C56. Run twice (a retried request, a timer that fires again), a write a request or a
// timer reaches changes nothing the second time.
import type { Analysis, Assign, Expr } from '../sql/ast.ts';
import { conjunctsOf } from '../sql/tree.ts';
import { reachable, witnessed } from './flow.ts';
import { analysisOf } from './model.ts';
import { lc } from './syntax.ts';
import type { ColumnRead, Query, Reading, Write } from './types.ts';
import { casOn, colsIn, dedupeGuard, writeOf } from './writes.ts';

/** The SET list of an UPDATE or of an upsert's DO UPDATE, with its WHERE. */
type Rewrite = { readonly assigns: readonly Assign[]; readonly where: Expr | null };
/** What an assignment reads: `own`, a column of the row it changes; `mine`, one the write changes. */
type Reads = {
  readonly a: Analysis | null;
  readonly own: (c: ColumnRead) => boolean;
  readonly mine: (c: ColumnRead) => boolean;
};

// `col = max(col, e)`, `min(col, e)`, `coalesce(col, e)` / `ifnull(col, e)`, with e reading no column the write
// changes: a second run computes the same value from the first run's result, so it changes nothing
function settles(x: Assign, { a, own, mine }: Reads): boolean {
  const f = x.expr;
  if (f.k !== 'fn' || f.star || f.distinct || f.args.length < 2) return false;
  const fn = lc(f.name);
  const selfAt = f.args.findIndex(g => g.k === 'col' && lc(g.name) === lc(x.col) && colsIn(g, a).every(own));
  if (selfAt < 0) return false;
  if (fn === 'coalesce' || fn === 'ifnull') {
    if (selfAt !== 0) return false;
  } else if (fn !== 'max' && fn !== 'min') return false;
  return f.args.every((g, i) => i === selfAt || !colsIn(g, a).some(mine));
}

function readsOf(r: Reading, q: Query, s: Write, w: Rewrite): Reads {
  const { model } = r;
  const mt = model.schema.tables.get(lc(s.table));
  const table = lc(mt?.name ?? s.table);
  const changed = new Set(w.assigns.map(x => lc(x.col)));
  const own = (c: ColumnRead): boolean => !c.excluded && (!c.table || lc(c.table) === table);
  return {
    a: mt && model.errors.length === 0 && q.ast ? analysisOf(q.raw, q.ast, model.schema) : null,
    own,
    mine: c => own(c) && changed.has(lc(c.name)),
  };
}

// C56: an op-id guard names the row it guards; C54: a write that depends on the row it changes is stopped the
// second time by a compare-and-set, an op id, or a count its caller checked
function rewritten(r: Reading, q: Query, s: Write, w: Rewrite, opTables: ReadonlySet<string>): void {
  const { bad } = r;
  const t = r.tables.get(s.table);
  const cs = conjunctsOf(w.where) ?? [];
  const dedupe = dedupeGuard(cs, s, t, opTables);
  if (dedupe === false)
    return bad(
      'C56',
      q.at,
      `this write's op-id guard (NOT EXISTS …) does not name the ${s.table} row it changes, so the same op id sent for another row is taken for a repeat of this one, and that write is lost`,
      `Constrain the guard by the row's key as well, with the parameter the write uses for it (${(t?.pk ?? []).map(c => `${c} = ?n`).join(' AND ') || 'the key'}), and record the op id with that key.`,
    );
  const reads = readsOf(r, q, s, w);
  const dependent = w.assigns.filter(x => !settles(x, reads) && colsIn(x.expr, reads.a).some(reads.mine));
  if (dependent.length === 0 || dedupe) return;
  const names = [lc(s.table), lc(s.alias)].filter(Boolean);
  if (w.assigns.some(x => casOn(cs, lc(x.col), w.assigns, names)) || witnessed(cs, q, r.calls)) return;
  bad(
    'C54',
    q.at,
    `run twice (a retried request, a timer that fires again), this write applies twice: ${dependent.map(x => `${x.col} = ${q.raw.slice(x.expr.s, x.expr.e).trim()}`).join(', ')} depends on the row it changes, and nothing at the top level of its WHERE stops a second run`,
    `Make the second run a no-op: compare-and-set on a column it changes (\`AND state = 'pending'\` with a new state, \`AND version = ?n\` with version = version + 1), or guard it by an op id (\`AND NOT EXISTS (SELECT 1 FROM ops WHERE op = ?k AND key = ?n)\`). If every attempt is meant to count, say so in the call: \`repeat: True\`.`,
  );
}

// C55: an INSERT gives a whole unique key, so a second run meets the first one's row
function inserted(r: Reading, q: Query, s: Extract<Write, { kind: 'insert' }>): void {
  const t = r.tables.get(s.table);
  if (!t) return;
  const cols = new Set((s.cols ?? t.cols).map(lc));
  if (t.uniques.some(u => u.length > 0 && u.every(c => cols.has(lc(c))))) return;
  r.bad(
    'C55',
    q.at,
    `run twice (a retried request, a timer that fires again), this INSERT makes a second ${s.table} row: it does not insert a whole unique key of ${s.table} (${t.uniques.map(u => u.join(', ')).join('; ') || 'the table has none but its rowid'})`,
    `Take a key from the client (a client key, an op id), keep it in a UNIQUE column, insert it, and say ON CONFLICT(that column) DO NOTHING; then read the row back by that key. If every attempt is meant to count, say so in the call: \`repeat: True\`.`,
  );
}

export function replayRules(r: Reading): void {
  const checked = reachable(r.prog, r.calls);
  const opTables = new Set(r.queries.flatMap(q => (q.ast?.k === 'insert' ? [lc(q.ast.table)] : [])));
  for (const q of r.queries) {
    if (!q.repeat) {
      if (checked.has(q.fn.name)) replayOf(r, q, opTables);
      continue;
    }
    // `repeat: True` is only for a write these rules would refuse: C88 where they have nothing to say
    const found: string[] = [];
    if (checked.has(q.fn.name))
      replayOf(
        {
          ...r,
          bad: code => {
            found.push(code);
          },
        },
        q,
        opTables,
      );
    if (!found.includes('C54') && !found.includes('C55'))
      r.bad(
        'C88',
        q.at,
        'this call says `repeat: True`, and a second run of its statement changes nothing more',
        'Take the argument out: it is only for a write that the retry rules (C54, C55) would refuse.',
      );
  }
}
function replayOf(r: Reading, q: Query, opTables: ReadonlySet<string>): void {
  const s = writeOf(q.ast);
  if (s?.kind === 'update') rewritten(r, q, s, { assigns: s.assigns, where: s.where }, opTables);
  else if (s?.kind === 'insert' && s.upsert) rewritten(r, q, s, { assigns: s.upsert, where: s.upsertWhere }, opTables);
  else if (s?.kind === 'insert') inserted(r, q, s);
}
