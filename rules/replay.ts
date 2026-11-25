// rules/replay.ts: C54, C55, C56. Run twice (a retried request, a timer that fires again), a write a request or a
// timer reaches changes nothing the second time.
import type { Analysis, Assign, Expr } from '../sql/ast.ts';
import { conjunctsOf } from '../sql/tree.ts';
import { claimed, requestedOf } from './claims.ts';
import { reachable, witnessed } from './flow.ts';
import { analysisOf } from './model.ts';
import { lc } from './syntax.ts';
import type { ColumnRead, Query, Reading, Write } from './types.ts';
import { casOn, colsIn, dedupeGuard, writeOf } from './writes.ts';

/** The rules' reading, and where to say why a write passes (for C88, which refuses `repeat: True` on one). */
type Asked = Reading & { readonly why?: (reason: string) => void };
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
function rewritten(r: Asked, q: Query, s: Write, w: Rewrite, opTables: ReadonlySet<string>): void {
  const { bad } = r;
  const t = r.tables.get(s.table);
  const cs = conjunctsOf(w.where) ?? [];
  const dedupe = dedupeGuard(cs, s, t, opTables);
  if (dedupe === false)
    return bad(
      'C56',
      q.at,
      `this write's op-id guard (NOT EXISTS …) does not name the ${s.table} row it changes, so the same op id sent for another row is taken for a repeat of this one, and that write is lost`,
      `Constrain the guard by the row's key as well, with the parameter the write uses for it (${(t?.pk ?? []).map(c => `${c} = :${c}`).join(' AND ') || 'the key'}), and record the op id with that key.`,
    );
  const reads = readsOf(r, q, s, w);
  const dependent = w.assigns.filter(x => !settles(x, reads) && colsIn(x.expr, reads.a).some(reads.mine));
  if (dedupe)
    return r.why?.('its WHERE guards it by an op id (NOT EXISTS …), so a second run finds the op and writes nothing');
  if (dependent.length === 0)
    return r.why?.(
      'every column it sets is given a value, none computed from the row it changes, so a second run writes the same values',
    );
  const names = [lc(s.table), lc(s.alias)].filter(Boolean);
  if (w.assigns.some(x => casOn(cs, lc(x.col), w.assigns, names)))
    return r.why?.('its WHERE is a compare-and-set on a column it changes, so a second run matches no row');
  if (witnessed(cs, q, r.calls))
    return r.why?.(
      'it runs only after an op-id claim (an INSERT … ON CONFLICT DO NOTHING the request must pass first) or a count checked before it, so a second run of the request stops before it',
    );
  bad(
    'C54',
    q.at,
    `run twice (a retried request, a timer that fires again), this write applies twice: ${dependent.map(x => `${x.col} = ${q.raw.slice(x.expr.s, x.expr.e).trim()}`).join(', ')} depends on the row it changes, and nothing at the top level of its WHERE stops a second run`,
    `Make the second run a no-op: compare-and-set on a column it changes (\`AND state = 'pending'\` with a new state, \`AND version = :version\` with version = version + 1), or guard it by an op id (\`AND NOT EXISTS (SELECT 1 FROM ops WHERE op = :op AND key = :key)\`), or claim the op id first and write only once it is yours: \`let 1 = sql_exec(query: "INSERT INTO ops(op) VALUES (:op) ON CONFLICT(op) DO NOTHING", op) else -> …\` before the write, with \`rollback\` where the write then fails. Any one of these is enough: with it, \`repeat: True\` is refused (C88). Only if none is meant, because every attempt is meant to count, say so in the call: \`repeat: True\`.`,
  );
}

// C55: an INSERT gives a whole unique key, so a second run meets the first one's row
function inserted(r: Asked, q: Query, s: Extract<Write, { kind: 'insert' }>): void {
  const t = r.tables.get(s.table);
  if (!t) return;
  const cols = new Set((s.cols ?? t.cols).map(lc));
  const unique = t.uniques.find(u => u.length > 0 && u.every(c => cols.has(lc(c))));
  if (unique)
    return r.why?.(
      `it inserts a whole unique key of ${s.table} (${unique.join(', ')}), so a second run meets the first one's row`,
    );
  r.bad(
    'C55',
    q.at,
    `run twice (a retried request, a timer that fires again), this INSERT makes a second ${s.table} row: it does not insert a whole unique key of ${s.table} (${t.uniques.map(u => u.join(', ')).join('; ') || 'the table has none but its rowid'})`,
    `Take a key from the client (a client key, an op id), keep it in a UNIQUE column, insert it, and say ON CONFLICT(that column) DO NOTHING; then read the row back by that key. If the call is meant to make a new row on each call (no client key: two POSTs make two rows, and clients do not retry it), or every attempt is meant to count, say so in the call: \`repeat: True\`.`,
  );
}

export function replayRules(r: Reading): void {
  const checked = reachable(r.prog, r.calls);
  const requested = requestedOf(r);
  // the tables the program records op ids in: those it inserts into. A statement that does not parse (C67 says
  // so) still names its table, read from its text, so that a write it guards is not refused as well
  const unread = (q: Query): string[] => {
    const into = q.ast ? null : /^\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+"?(\w+)"?/i.exec(q.raw)?.[1];
    return into ? [lc(into)] : [];
  };
  const opTables = new Set(r.queries.flatMap(q => (q.ast?.k === 'insert' ? [lc(q.ast.table)] : unread(q))));
  for (const q of r.queries) {
    if (!q.repeat) {
      if (checked.has(q.fn.name)) replayOf(r, q, opTables);
      continue;
    }
    // `repeat: True` is only for a write these rules would refuse: C88 where they have nothing to say
    const found: string[] = [];
    let reason = checked.has(q.fn.name)
      ? 'it is not a write'
      : 'no request or timer reaches it (only what handle and woken run is run again)';
    if (checked.has(q.fn.name))
      replayOf(
        {
          ...r,
          bad: code => {
            found.push(code);
          },
          why: said => {
            reason = said;
          },
        },
        q,
        opTables,
      );
    if (!found.includes('C54') && !found.includes('C55') && !claimed(r, q, requested))
      r.bad(
        'C88',
        q.at,
        `this call says \`repeat: True\`, and a second run of its statement changes nothing more: ${reason}`,
        'Take the argument out: it is only for a write the retry rules (C54, C55, C95) would refuse, one that computes a column from the row it changes (`n = n + 1`), takes the next row of many, or inserts a row with no unique key, with nothing to stop a second run.',
      );
  }
}
function replayOf(r: Asked, q: Query, opTables: ReadonlySet<string>): void {
  const s = writeOf(q.ast);
  if (s?.kind === 'update') rewritten(r, q, s, { assigns: s.assigns, where: s.where }, opTables);
  else if (s?.kind === 'insert' && s.upsert) rewritten(r, q, s, { assigns: s.upsert, where: s.upsertWhere }, opTables);
  else if (s?.kind === 'insert') inserted(r, q, s);
}
