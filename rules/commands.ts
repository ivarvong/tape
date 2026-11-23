// rules/commands.ts: what a program's matches say about the replies it handles and the rows it reads (C71, C81, C87).
import { eachExpr, eachPattern, partsOf, patternsIn } from '../compiler/ast.ts';
import type { Call, Expr, FnDecl, Match, Pattern, Program } from '../compiler/ast.ts';
import { conjunctsOf } from '../sql/tree.ts';
import { rowTablesOf } from './model.ts';
import { dec, lc } from './syntax.ts';
import type { Query, Reading, RuleTable, Write } from './types.ts';
import { predicateOn, writeOf } from './writes.ts';

const own = (f: FnDecl): boolean => !!f.file && !f.file.startsWith('std/');
const bare = (p: Pattern): Pattern => (p.k === 'as' ? p.pat : p);
const catchAll = (p: Pattern | undefined): boolean => !p || p.k === 'bind' || p.k === 'any';
const callsAny = (body: Expr, names: ReadonlySet<string>): boolean => {
  let hit = false;
  eachExpr(body, n => {
    if (n.k === 'call' && names.has(n.name)) hit = true;
  });
  return hit;
};

// ---- C87: a refusal is the callee's answer; no answer is not. An arm that takes both and sets a timer asks again
// with the same key after a refusal, and a key seen before gets the reply it got before: it asks for ever.
// (Found by the simulator standing in for a Remote: tickets' refund and four of the seven timer examples.)

/** The functions that set a timer, themselves or through what they call. */
function timerSetters(prog: Program): Set<string> {
  const reach = new Set(['wake']);
  for (let grew = true; grew;) {
    grew = false;
    for (const f of prog.fns.values()) {
      if (reach.has(f.name) || !callsAny(f.body, reach)) continue;
      reach.add(f.name);
      grew = true;
    }
  }
  return reach;
}

/** Is the value matched a call's reply: the call itself, or a parameter of type Result[_, CallError]? */
function isReply(f: FnDecl, subject: Expr | null): boolean {
  if (subject?.k === 'call') return subject.name === 'call';
  if (subject?.k !== 'var') return false;
  const t = f.params.find(p => p.name === subject.name)?.typeAst;
  return t?.name === 'Result' && t.args[1]?.name === 'CallError';
}

/** What an arm's pattern takes of a reply: a refusal alone, a refusal together with no answer, or neither. */
function takes(pat: Pattern): 'refusal' | 'both' | 'other' {
  const p = bare(pat);
  if (p.k !== 'ctor' || p.name !== 'Err') return catchAll(p) ? 'both' : 'other';
  const named = p.subs.find(s => s.field === 'error')?.pat;
  const e = named && bare(named);
  if (e?.k === 'ctor' && e.name === 'Rejected') return 'refusal';
  return catchAll(e) ? 'both' : 'other';
}

function refusalsAsked({ prog, bad }: Reading): void {
  const setters = timerSetters(prog);
  const check = (m: Match): void => {
    if (!m.subject) return;
    let refused = false;
    for (const arm of m.arms) {
      const took = takes(arm.pat);
      if (took === 'refusal') refused = true;
      if (took !== 'both' || refused || arm.guard || !callsAny(arm.body, setters)) continue;
      bad(
        'C87',
        arm.pat.line ? arm.pat : m,
        'this arm takes a refusal together with no answer, and sets a timer: after a refusal the same key gets the same refusal, so it asks for ever',
        'Give the refusal its own arm above this one, `Err(error: Rejected(reason)) -> …`, and say there what a refused call means: a state to move to, not a timer.',
      );
    }
  };
  for (const f of prog.fns.values())
    if (own(f))
      eachExpr(f.body, m => {
        if (m.k === 'match' && isReply(f, m.subject)) check(m);
      });
}

// ---- C81: a state named in a pattern on a row is one of its machine's states (C61 says the same of SQL)

function patternStates({ prog, bad }: Reading, rowTable: ReadonlyMap<string, string | null>): void {
  const seenAt = new Set<string>();
  const check = (o: Pattern): void => {
    const tb = o.k === 'ctor' ? rowTable.get(o.name) : null;
    if (o.k !== 'ctor' || !tb) return;
    for (const m of prog.machines.filter(x => lc(x.table) === lc(tb)))
      for (const sb of o.subs) {
        if (lc(sb.field) !== lc(m.column) || sb.pat.k !== 'str') continue;
        const v = dec(sb.pat.bytes);
        const key = `${sb.pat.file}:${sb.pat.line}:${v}`;
        if (m.states.includes(v) || seenAt.has(key)) continue;
        seenAt.add(key);
        bad(
          'C81',
          sb.pat.line ? sb.pat : o,
          `"${v}" is matched against ${m.table}.${m.column}, but it is not one of the states of machine ${m.table}.${m.column} (${m.states.map(x => `"${x}"`).join(', ')}): this arm can never be taken`,
          "Name one of the machine's states, or add the state to the machine.",
        );
      }
  };
  for (const f of prog.fns.values())
    if (own(f)) eachExpr(f.body, e => patternsIn(e).forEach(p => eachPattern(p, check)));
}

// ---- C71: a command built from a row names that row in its key (and, after a move, what the move wrote)

/** A pattern's row: R(…), Some(value: R(…)) or Moved(value: R(…)), with the name each column is bound to. */
type Row = {
  readonly type: string;
  readonly table: string;
  readonly binds: Map<string, string>;
  readonly moved: boolean;
};
/** A column a move set from a parameter, and the names that hold that value where the command is sent. */
type Written = { readonly col: string; readonly names: Set<string> };
/** What names a row where a command is sent: each key column's names, and what a move before it wrote. */
type Naming = { readonly keyNames: Map<string, Set<string>>; written: Written[] };
type Update = Extract<Write, { kind: 'update' }>;

function rowOf(pt: Pattern, rowTable: ReadonlyMap<string, string | null>): Row | null {
  if (pt.k === 'as') return rowOf(pt.pat, rowTable);
  if (pt.k !== 'ctor') return null;
  const only = pt.subs.length === 1 ? pt.subs[0] : undefined;
  if (only && (pt.name === 'Some' || pt.name === 'Moved')) {
    const r = rowOf(only.pat, rowTable);
    return r && { ...r, moved: pt.name === 'Moved' };
  }
  const table = rowTable.get(pt.name);
  if (!table) return null;
  const binds = new Map<string, string>();
  for (const sb of pt.subs)
    if ((sb.pat.k === 'bind' || sb.pat.k === 'as') && sb.pat.name) binds.set(lc(sb.field), sb.pat.name);
  return { type: pt.name, table, binds, moved: false };
}

const leavesOf = (x: Expr): Set<string> => {
  const out = new Set<string>();
  eachExpr(x, n => {
    if (n.k === 'var') out.add(n.name);
  });
  return out;
};
const moveOf = (queries: readonly Query[], e: Expr | undefined): Query | undefined =>
  e?.k === 'call' && e.name === 'sql_move' ? queries.find(q => q.at === e) : undefined;
const updateOf = (q: Query | undefined): Update | null => {
  const w = writeOf(q?.ast);
  return w?.kind === 'update' ? w : null;
};

/** The columns a move set from a parameter (not the key's), each named by its field and by `alsoNamed`. */
function writtenBy(
  q: Query,
  w: Update,
  row: Row,
  t: RuleTable,
  alsoNamed: (value: Expr | undefined) => string[],
): Written[] {
  return w.assigns.flatMap(x => {
    if (x.expr.k !== 'param' || t.pk.some(c => lc(c) === lc(x.col))) return [];
    const field = row.binds.get(lc(x.col));
    return [{ col: x.col, names: new Set([...(field ? [field] : []), ...alsoNamed(q.args[x.expr.n])]) }];
  });
}

// a step on the move itself (`let Moved(value: …) = sql_move(…) else …`): what it wrote is named by the arguments
// it was given, and the row's key by the arguments of its WHERE's key
function movedHere(q: Query, w: Update, row: Row, t: RuleTable, naming: Naming): void {
  const names = [lc(w.table), lc(w.alias)].filter(Boolean);
  for (const c of conjunctsOf(w.where) ?? [])
    for (const col of t.pk) {
      const pr = predicateOn(c, names, col);
      const first = pr?.op === '=' ? pr.vals[0] : undefined;
      const v = first?.k === 'param' ? q.args[first.n] : undefined;
      if (v?.k === 'var') naming.keyNames.get(lc(col))?.add(v.name);
    }
  naming.written = writtenBy(q, w, row, t, v => (v?.k === 'var' ? [v.name] : []));
}

// a row moved by the caller and passed in: what each call site's move wrote, named by the parameter of this
// function given the same value there. A site that passes anything else leaves nothing to check.
function movedByCaller(r: Reading, f: FnDecl, param: string, row: Row, t: RuleTable, naming: Naming): void {
  for (const site of r.calls.get(f.name) ?? []) {
    const q = moveOf(r.queries, site.node.args.find(a => a.label === param)?.value);
    const w = updateOf(q);
    if (!q || !w) {
      naming.written = [];
      return;
    }
    const labelled = (v: Expr | undefined): string[] =>
      v?.k !== 'var'
        ? []
        : site.node.args.flatMap(a => (a.value.k === 'var' && a.value.name === v.name && a.label ? [a.label] : []));
    naming.written.push(...writtenBy(q, w, row, t, labelled));
  }
}

function namingOf(r: Reading, f: FnDecl, subject: Expr, row: Row, t: RuleTable): Naming {
  const naming: Naming = {
    keyNames: new Map(t.pk.map(col => [lc(col), new Set([row.binds.get(lc(col))].flatMap(n => n ?? []))])),
    written: [],
  };
  if (!row.moved) return naming;
  const direct = moveOf(r.queries, subject);
  if (direct?.ast) {
    const w = updateOf(direct);
    if (w) movedHere(direct, w, row, t, naming);
  } else if (subject.k === 'var' && f.params.some(pm => pm.name === subject.name))
    movedByCaller(r, f, subject.name, row, t, naming);
  return naming;
}

function keyed({ bad }: Reading, c: Call, row: Row, t: RuleTable, { keyNames, written }: Naming): void {
  const send = c.args.find(a => a.label === 'send')?.value;
  const once = c.args.find(a => a.label === 'once')?.value;
  if (!send || !once) return; // C41 says so
  const bound = new Set(row.binds.values());
  if (![...leavesOf(send)].some(n => bound.has(n))) return; // not built from this row
  const kl = leavesOf(once);
  const missing = t.pk.filter(col => ![...(keyNames.get(lc(col)) ?? [])].some(n => kl.has(n)));
  const lost = written.filter(w => ![...w.names].some(n => kl.has(n)));
  if (missing.length > 0)
    bad(
      'C71',
      c,
      `this command is built from the ${row.table} row in ${row.type}(…), but its key does not name that row (${missing.join(', ')}): the same command for another ${row.table} row with the same values is taken for a repeat of this one, and answered with its reply`,
      `Bind the row's key in the pattern (${missing.map(col => col).join(', ')}) and put it in the key: \`once: Ctor(${missing.map(col => `${col}: ${row.binds.get(lc(col)) ?? col}`).join(', ')}, …)\`.`,
    );
  else if (lost.length > 0)
    bad(
      'C71',
      c,
      `this command is sent after a move that wrote ${lost.map(w => w.col).join(', ')}, which says which operation on the row this is, but its key does not carry it: the next ${lost[0]?.col} for the same row is taken for a repeat of this one (a period charged once, then never again)`,
      `Put it in the key: ${lost.map(w => (w.names.size > 0 ? `\`${[...w.names][0]}\`` : `bind ${w.col} in the pattern`)).join(', ')}.`,
    );
}

function commandKeys(r: Reading, rowTable: ReadonlyMap<string, string | null>): void {
  const { tables } = r;
  const check = (f: FnDecl, m: Match): void => {
    if (!m.subject) return;
    for (const arm of m.arms) {
      const row = rowOf(arm.pat, rowTable);
      if (!row) continue;
      const t = tables.get(row.table) ?? [...tables].find(([n]) => lc(n) === lc(row.table))?.[1];
      if (!t || t.pk.length === 0) continue;
      const naming = namingOf(r, f, m.subject, row, t);
      eachExpr(arm.body, c => {
        if (c.k === 'call' && c.name === 'call') keyed(r, c, row, t, naming);
      });
    }
  };
  for (const f of r.prog.fns.values())
    eachExpr(f.body, m => {
      if (m.k === 'match') check(f, m);
    });
}

// ---- C65: a command's key made only of what its message carries makes two commands with one message one (the
// ledger keyed its charge by the amount). A key that names the row the command is for, its whole primary key (what
// C71 asks of a command built from a row), names the command, even when the message carries that id too: same row,
// same command. (A key that is the same every time is C65 too, in compiler/gen/callout.ts.)

/** `a.b.c` for a variable or a field of one; null for anything else. */
const pathOf = (n: Expr): string | null => {
  if (n.k === 'var') return n.name;
  const base = n.k === 'field' ? pathOf(n.e) : null;
  return base !== null && n.k === 'field' ? `${base}.${n.name}` : null;
};
/** The variables, and fields of variables, a key is made of. */
function keyLeaves(x: Expr): Set<string> {
  const out = new Set<string>();
  const go = (n: Expr): void => {
    const path = pathOf(n);
    if (path === null) partsOf(n).forEach(go);
    else out.add(path);
  };
  go(x);
  return out;
}
/** What the message carries: its fields' values as written, through nested records. */
function carriedBy(send: Expr): Set<string> {
  const carried = new Set<string>();
  const direct = (n: Expr): void => {
    const path = pathOf(n);
    if (path !== null) carried.add(path);
    else if (n.k === 'ctor') for (const a of n.args) direct(a.value);
  };
  direct(send);
  return carried;
}
const shape = (x: Expr): string =>
  JSON.stringify(x, (k, v: unknown) =>
    k === 'line' || k === 'file' || k === 'pos' ? undefined : typeof v === 'bigint' ? String(v) : v,
  );

/** For each way f holds a row, the paths that name it by its primary key: `id` bound by Order(id, …), `order.id`. */
function rowKeys(r: Reading, f: FnDecl, rowTable: ReadonlyMap<string, string | null>): string[][] {
  const pkOf = (table: string): string[] =>
    (r.tables.get(table) ?? [...r.tables].find(([n]) => lc(n) === lc(table))?.[1])?.pk ?? [];
  const out: string[][] = [];
  const held = (pat: Pattern, value: Expr | null): void => {
    const row = rowOf(pat, rowTable);
    if (row) {
      const pk = pkOf(row.table);
      const names = pk.flatMap(col => row.binds.get(lc(col)) ?? []);
      if (pk.length > 0 && names.length === pk.length) out.push(names);
    }
    // Some(value: x) or Moved(value: x), or x, on a query that reads rows of one table
    const p = bare(pat),
      only = p.k === 'ctor' && (p.name === 'Some' || p.name === 'Moved') && p.subs.length === 1 ? p.subs[0]?.pat : p;
    const rowArg = value?.k === 'call' ? value.args.find(a => a.label === 'row')?.value : undefined;
    const table = rowArg?.k === 'ctor' ? rowTable.get(rowArg.name) : null;
    if (only?.k === 'bind' && table) {
      const pk = pkOf(table);
      if (pk.length > 0) out.push(pk.map(col => `${only.name}.${col}`));
    }
  };
  // a row the function is given: a parameter of a row type (`fn charge(order: Order)`), named by `order.id`
  for (const pm of f.params) {
    const table = pm.typeAst.args.length === 0 ? rowTable.get(pm.typeAst.name) : null;
    const pk = table ? pkOf(table) : [];
    if (pk.length > 0) out.push(pk.map(col => `${pm.name}.${col}`));
  }
  eachExpr(f.body, e => {
    if (e.k === 'match' && e.subject) for (const a of e.arms) held(a.pat, e.subject);
    if (e.k === 'block') for (const l of e.lets) if (l.pat) held(l.pat, l.value);
  });
  return out;
}

function carriedKeys(r: Reading, rowTable: ReadonlyMap<string, string | null>): void {
  for (const f of r.prog.fns.values()) {
    if (!own(f)) continue;
    let keys: string[][] | null = null;
    eachExpr(f.body, c => {
      if (c.k !== 'call' || c.name !== 'call') return;
      const send = c.args.find(a => a.label === 'send')?.value,
        once = c.args.find(a => a.label === 'once');
      if (!send || !once) return;
      const kl = keyLeaves(once.value),
        carried = carriedBy(send);
      const isCarried = (x: string): boolean => [...carried].some(h => x === h || x.startsWith(`${h}.`));
      if (kl.size === 0 || ![...kl].every(isCarried) || shape(once.value) === shape(send)) return;
      keys ??= rowKeys(r, f, rowTable);
      if (keys.some(names => names.every(n => kl.has(n)))) return;
      r.bad(
        'C65',
        once,
        `this command's key is made only of what its message carries (${[...kl].join(', ')}), so two commands with the same message are one: the second is answered with the first's reply (the ledger keyed its charge by the amount)`,
        'Key it by the row it is for: its primary key, from the row read from the table (`ForOrder(order: order.id)`), or by a key the client sent. If the message itself names the command (an event and its id), key it by the message: `once:` the same record as `send:`.',
      );
    });
  }
}

export function commandRules(r: Reading): void {
  const rowTable = rowTablesOf(r.queries);
  refusalsAsked(r);
  patternStates(r, rowTable);
  commandKeys(r, rowTable);
  carriedKeys(r, rowTable);
}
