// rules/machines/check.ts: one machine read against the queries of one program (C58-C62).
import type { Problem } from '../../compiler/common.ts';
import type { Analysis, Assign, Expr, Statement } from '../../sql/ast.ts';
import { conjunctsOf } from '../../sql/tree.ts';
import { analysisOf } from '../model.ts';
import { guardOf, namesOneRow } from '../move.ts';
import { comparisonsOf, tablesNamed } from '../statecol.ts';
import { lc, stripComments } from '../syntax.ts';
import type { Query, RuleTable, Value, Write } from '../types.ts';
import { writeOf } from '../writes.ts';
import { ENV_LIMIT, reaching, showNode, sqlValue } from './paths.ts';
import type { Env, MachineContext, MachineDecl, Narrowings } from './paths.ts';

/** What one write does to the column: its moves as `from\0to`, and the states its rows start in. */
export type Wrote = { moves: Set<string>; starts: Set<string> };
/** The problems, and what the program does to the column where that can be told (C77 reads `writes`). */
export type MachineReading = {
  problems: Problem[];
  moves: Set<string>;
  starts: Set<string>;
  writes: Map<Query, Wrote>;
};
type Reading = MachineReading & {
  readonly m: MachineDecl;
  readonly ctx: MachineContext;
  readonly table: RuleTable | undefined;
  readonly states: ReadonlySet<string>;
  readonly declared: ReadonlySet<string>;
  readonly label: string;
};
/** One query over the machine's table: its tree, and the paths that reach it. */
type Site = {
  readonly q: Query;
  readonly ast: Statement;
  readonly analysis: Analysis | null;
  readonly nar: Narrowings | undefined;
  readonly envs: readonly Env[];
  readonly unknownWhy: string;
};
type Insert = Extract<Write, { kind: 'insert' }>;
type Where = { readonly assigns: readonly Assign[]; readonly where: Expr | null; readonly what: string };
type Place = { readonly file?: string; readonly line?: number };

const moveKey = (from: string, to: string): string => `${from}\u0000${to}`;
const fmtMoves = (m: MachineDecl): string => m.moves.map(x => `"${x.from}" -> "${x.to}"`).join(', ');
const followable = (e: Expr): e is Value => (e.k === 'lit' && e.type === 'text') || e.k === 'param';

function bad(r: Reading, code: string, at: Place, message: string, hint: string): void {
  r.problems.push({ code, file: at.file ?? '', line: at.line ?? 0, message, hint });
}
function wrote(r: Reading, q: Query): Wrote {
  const had = r.writes.get(q);
  if (had) return had;
  const w: Wrote = { moves: new Set(), starts: new Set() };
  r.writes.set(q, w);
  return w;
}
function cannot(r: Reading, q: Query, why: string): void {
  const { m, label } = r;
  const col = m.column;
  bad(
    r,
    'C60',
    q.at,
    `this statement writes ${m.table}.${col}, and the states it reads or sets cannot be told here: ${why}. ${label} cannot check it, so it is refused rather than passed`,
    `Write the state as a literal ('${m.states[1] ?? m.start}') or pass it as a parameter that is a literal at every call site; compare-and-set with \`WHERE ${col} = …\`; insert one row at a time with VALUES, in "${m.start}".`,
  );
}

// a trigger the program declares that writes the table: its writes are not read here, so it is refused (sql.ts
// refuses CREATE TRIGGER itself, C67; this is the same refusal for a version read under another's machine)
function foreignTriggers(r: Reading): void {
  const { m, label } = r;
  const { schema, migrations } = r.ctx.prog;
  const writesTable = new RegExp(`\\b(?:UPDATE(?: OR \\w+)?|INTO)\\s+["\`[]?${m.table}\\b`, 'i');
  for (const st of [...schema, ...migrations.flatMap(x => x.statements)]) {
    const flat = stripComments(st).replaceAll(/\s+/g, ' ');
    if (!/^\s*CREATE (TEMP |TEMPORARY )?TRIGGER\b/i.test(flat)) continue;
    if (!writesTable.test(flat.replace(/^.*?\bBEGIN\b/i, ''))) continue;
    bad(
      r,
      'C60',
      m,
      `a trigger this program declares writes ${m.table}; ${label} cannot read the writes of a trigger, so it is refused rather than passed`,
      `Write ${m.table} from the program's own queries, where each write is checked.`,
    );
  }
}

// outside the subset (C67 refuses it in its own program); read under another version's machine, a statement
// that may write the table cannot be passed
function unread(r: Reading, q: Query): void {
  if (!r.ctx.foreign || !new RegExp(`\\b${r.m.table}\\b`, 'i').test(q.raw)) return;
  if (!/\b(UPDATE|INSERT|REPLACE|DELETE)\b/i.test(q.raw)) return;
  cannot(r, q, `the statement is outside the SQL the checker reads (${q.error?.message})`);
}

function siteOf(r: Reading, q: Query, ast: Statement): Site {
  const { ctx } = r;
  const a = analysisOf(q.raw, ast, ctx.schema);
  const nar = ctx.narrow.get(q.at);
  const mine = ctx.envs.get(q.fn.name);
  return {
    q,
    ast,
    analysis: a.errors.some(e => e.kind === 'name') ? null : a,
    nar,
    envs: [...(mine?.list.values() ?? [])].flatMap((env): Env[] => {
      const reached = reaching(env, q.fn, nar);
      return reached ? [reached] : [];
    }),
    unknownWhy: mine?.too
      ? `${q.fn.name} is reached by more than ${ENV_LIMIT} paths`
      : `a value is not a literal on every path to ${q.fn.name}`,
  };
}

// C61: every literal (or parameter traced to one) compared with the column is a state
function misspelt(r: Reading, site: Site): void {
  const { m, label } = r;
  const { q } = site;
  const col = m.column;
  for (const operand of comparisonsOf(site.ast, m, site.analysis))
    for (const env of site.envs) {
      const v = sqlValue(operand, q, env, site.nar);
      if (typeof v !== 'string' || r.states.has(v)) continue;
      bad(
        r,
        'C61',
        q.at,
        `"${v}" is compared with ${m.table}.${col}, but it is not one of the states of ${label} (${m.states.map(x => `"${x}"`).join(', ')}): no row is in it, so this never matches`,
        'Use one of the declared states, or declare the state with a move into it.',
      );
      return;
    }
}

// C58: a DELETE says which state it expects
function removal(r: Reading, q: Query, where: Expr | null, names: readonly string[]): void {
  const { m } = r;
  const col = m.column;
  if ((conjunctsOf(where) ?? []).some(c => guardOf(c, names, col))) return;
  bad(
    r,
    'C58',
    q.at,
    `this DELETE of rows of ${m.table} does not say which ${col} it expects, so it also removes a row that another request has moved on (an order cancelled after it was paid, a hold released after it was used)`,
    `Add \`AND ${col} = '…'\` (the state a row may be removed in), or \`AND ${col} IN (…)\`, to its WHERE, at the top level: not inside an OR.`,
  );
}

/**
 * The move a write makes on one path, noted: null when it is declared, 'unknown' when it cannot be told, the move
 * as text when it is not declared. A from known only by what it is not is each declared state it is not.
 */
function moveOn(r: Reading, site: Site, froms: readonly Expr[], toNode: Expr, env: Env): string | null {
  const { m } = r;
  const { q, nar } = site;
  const to = sqlValue(toNode, q, env, nar);
  const fs = froms.flatMap((f): (string | null)[] => {
    const v = sqlValue(f, q, env, nar);
    return v !== null && typeof v === 'object' ? m.states.filter(x => !v.not.includes(x)) : [v];
  });
  if (typeof to !== 'string' || fs.includes(null)) return 'unknown';
  for (const f of fs) {
    if (f === null || f === to) continue;
    r.moves.add(moveKey(f, to));
    wrote(r, q).moves.add(moveKey(f, to));
    if (!r.declared.has(moveKey(f, to))) return `"${f}" -> "${to}"`;
  }
  return null;
}

/** The guard of a write on the column: the states its WHERE accepts. Without one it is refused (C58). */
function guardFor(r: Reading, q: Query, w: Where, names: readonly string[]): Expr[] | null {
  const { m } = r;
  const col = m.column;
  const { what } = w;
  for (const c of conjunctsOf(w.where) ?? []) {
    const guard = guardOf(c, names, col);
    if (guard) return guard;
  }
  bad(
    r,
    'C58',
    q.at,
    `this ${what} of a row of ${m.table} does not say which ${col} it expects, so it also writes onto a row that another request has moved on (a note on a finished order, a payment on a declined sale)`,
    `Add \`AND ${col} = '…'\` (the state this write belongs to), or \`AND ${col} IN (…)\`, to its WHERE, at the top level: not inside an OR.`,
  );
  return null;
}

// C62: a compare-and-set on one row whose caller cannot tell "moved first" from "no such row"
function sameAnswer(r: Reading, q: Query, where: Expr | null, names: readonly string[]): void {
  const { m } = r;
  const col = m.column;
  if (q.via === 'sql_move') return;
  if (!namesOneRow(where, names, r.ctx.schema.tables.get(lc(m.table)) ?? r.table)) return;
  bad(
    r,
    'C62',
    q.at,
    `this compare-and-set on ${m.table}.${col} goes through ${q.via}, which gives the same answer (${q.via === 'sql_exec' ? '0 rows' : 'None'}) when another request moved the row first and when there is no such row: a lost race is then handled as a missing row (J4)`,
    `Write it with sql_move(db, row: …, query: "UPDATE ${m.table} SET … WHERE <key> AND ${col} = … RETURNING …"), and match on Moved(value), Raced(now) and NoRow. The re-read of a row it replaces is derived from the statement.`,
  );
}

/** What an upsert's `excluded.column` stands for: the value the INSERT gives that column. */
function written(r: Reading, s: Write, expr: Expr): Expr {
  if (expr.k !== 'col' || lc(expr.table) !== 'excluded' || s.kind !== 'insert') return expr;
  const i = (s.cols ?? r.table?.cols ?? []).findIndex(c => lc(c) === lc(expr.name));
  return (i >= 0 ? s.vals?.[i] : undefined) ?? expr;
}

// C58, C59, C62: an UPDATE, or the DO UPDATE of an upsert
function update(r: Reading, site: Site, s: Write, names: readonly string[], w: Where): void {
  const { m, label } = r;
  const { q } = site;
  const col = m.column;
  const guard = guardFor(r, q, w, names);
  if (!guard) return;
  if (s.kind === 'update') sameAnswer(r, q, w.where, names);
  const set = w.assigns.find(x => lc(x.col) === lc(col));
  if (!set) return;
  const expr = written(r, s, set.expr);
  if (!followable(expr))
    return cannot(r, q, `it sets ${col} to \`${showNode(q, expr)}\`, which is not a text literal or a parameter`);
  for (const env of site.envs) {
    const made = moveOn(r, site, guard, expr, env);
    if (made === 'unknown') return cannot(r, q, site.unknownWhy);
    if (made === null) continue;
    bad(
      r,
      'C59',
      q.at,
      `this write moves ${m.table}.${col} ${made}, which ${label} does not declare`,
      `Declared: ${fmtMoves(m)}. Declare the move, or guard the write by a state it may leave.`,
    );
    return;
  }
}

/** Why the states an INSERT gives cannot be read, or null. */
function unreadable(s: Insert, col: string, cols: readonly string[]): string | null {
  if (s.replace)
    return 'REPLACE deletes a row that has the same key and inserts a new one in the start state, a move back that no trigger sees';
  // INSERT … SELECT that leaves the column out starts every row it makes in the column's DEFAULT, as VALUES does
  if (s.select && (!s.cols || s.cols.some(c => lc(c) === lc(col))))
    return 'INSERT … SELECT takes its states from a query';
  if (s.rows > 1) return `it inserts ${s.rows} rows at once`;
  if (s.vals && cols.length !== s.vals.length) return 'its column list and its VALUES differ in length';
  return null;
}

function startsIn(r: Reading, q: Query, state: string): void {
  r.starts.add(state);
  wrote(r, q).starts.add(state);
}

// C59, C60: the state an INSERT names for its row
function inserted(r: Reading, site: Site, v: Expr | undefined): void {
  const { m, label } = r;
  const { q } = site;
  const col = m.column;
  if (!v) return cannot(r, q, 'its column list and its VALUES differ in length');
  if (!followable(v))
    return cannot(r, q, `it inserts ${col} as \`${showNode(q, v)}\`, which is not a text literal or a parameter`);
  for (const env of site.envs) {
    const x = sqlValue(v, q, env, site.nar);
    if (typeof x !== 'string') return cannot(r, q, site.unknownWhy);
    startsIn(r, q, x);
    if (x === m.start) continue;
    bad(
      r,
      'C59',
      q.at,
      `a row of ${m.table} starts in "${x}", but ${label} starts in "${m.start}"`,
      `Insert the row in "${m.start}", then move it with an UPDATE the machine declares.`,
    );
    return;
  }
}

const TEXT_LITERAL = /^'((?:[^']|'')*)'$/;

// C59: an INSERT that leaves the column out starts its row in the column's DEFAULT
function defaulted(r: Reading, q: Query): void {
  const { m, label } = r;
  const col = m.column;
  const defaults = r.table?.defaults ?? {};
  const name = Object.keys(defaults).find(k => lc(k) === lc(col));
  const dv = name === undefined ? undefined : defaults[name];
  if (dv === undefined || dv === null || !TEXT_LITERAL.test(dv))
    return bad(
      r,
      'C59',
      q.at,
      `this INSERT leaves ${col} out, and ${m.table}.${col} has ${dv === undefined ? 'no DEFAULT' : `DEFAULT ${dv}`}: the row does not start in "${m.start}"`,
      `Insert ${col} as '${m.start}', or give the column DEFAULT '${m.start}'.`,
    );
  const state = dv.slice(1, -1).replaceAll("''", "'");
  startsIn(r, q, state);
  if (state !== m.start)
    bad(
      r,
      'C59',
      q.at,
      `this INSERT leaves ${col} out, so the row starts in its DEFAULT ${dv}, but ${label} starts in "${m.start}"`,
      `Insert ${col} as '${m.start}'.`,
    );
}

function insertion(r: Reading, site: Site, s: Insert, names: readonly string[]): void {
  const col = r.m.column;
  const cols = s.cols ?? r.table?.cols ?? [];
  const why = unreadable(s, col, cols);
  if (why !== null) return cannot(r, site.q, why);
  const i = cols.findIndex(c => lc(c) === lc(col));
  if (i >= 0) inserted(r, site, s.vals?.[i]);
  else defaulted(r, site.q);
  if (s.upsert)
    update(r, site, s, names, { assigns: s.upsert, where: s.upsertWhere, what: 'upsert (ON CONFLICT … DO UPDATE)' });
}

function start(m: MachineDecl, ctx: MachineContext): Reading {
  const { tables } = ctx;
  return {
    m,
    ctx,
    table: tables.get(m.table) ?? [...tables.entries()].find(([k]) => lc(k) === lc(m.table))?.[1],
    states: new Set(m.states),
    declared: new Set(m.moves.map(x => moveKey(x.from, x.to))),
    label: `machine ${m.table}.${m.column}`,
    problems: [],
    moves: new Set(),
    starts: new Set(),
    writes: new Map(),
  };
}

/**
 * One machine read against one program: the problems, and what the program does to the column (the moves and the
 * starting states its writes make, when they can be told). When the machine is another version's (machinePlan),
 * the same reading finds what this program would do under it; ctx.tables and ctx.schema are then the newest
 * version's. Every query is read (not only the writes a request reaches: a move is wrong whoever makes it).
 */
export function checkMachine(m: MachineDecl, ctx: MachineContext): MachineReading {
  const r = start(m, ctx);
  if (ctx.foreign) foreignTriggers(r);
  for (const q of ctx.queries) {
    if (!q.ast) {
      unread(r, q);
      continue;
    }
    if (!tablesNamed(q.ast).has(lc(m.table))) continue;
    const site = siteOf(r, q, q.ast);
    misspelt(r, site);
    const s = writeOf(q.ast);
    if (!s || lc(s.table) !== lc(m.table)) continue;
    const names = [lc(m.table), lc(s.alias)].filter(Boolean);
    if (s.kind === 'delete') removal(r, q, s.where, names);
    else if (s.kind === 'update') update(r, site, s, names, { assigns: s.assigns, where: s.where, what: 'UPDATE' });
    else insertion(r, site, s, names);
  }
  return { problems: r.problems, moves: r.moves, starts: r.starts, writes: r.writes };
}
