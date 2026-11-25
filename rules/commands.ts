// rules/commands.ts: what a program's matches say about the replies it handles and the rows it reads (C71, C87).
import { eachExpr } from '../compiler/ast.ts';
import type { Call, Expr, FnDecl, Match, Pattern, Program } from '../compiler/ast.ts';
import { conjunctsOf } from '../sql/tree.ts';
import { rowTablesOf } from './model.ts';
import { lc } from './syntax.ts';
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

// ---- C87: a refusal is the callee's answer; no answer is not. An arm that takes both acts on an outcome it does
// not know. If it sets a timer, it asks again with the same key after a refusal, and a key seen before gets the
// reply it got before: it asks for ever (found by the simulator standing in for a Remote: tickets' refund and four
// of the seven timer examples). If it writes to the database or makes another call, it treats no answer as a
// refusal, or a refusal as no answer: J1 (docs/defects.md), a transport exception taken for a refusal and
// compensated for. Answering the client is what such an arm may do: the client sends again with the same key.

/** The functions that do something, themselves or through what they call: `does` says it of a body's own nodes. */
function doers(prog: Program, does: (body: Expr) => boolean): Set<string> {
  const reach = new Set([...prog.fns.values()].filter(f => does(f.body)).map(f => f.name));
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
const holds = (body: Expr, hit: (n: Expr) => boolean): boolean => {
  let found = false;
  eachExpr(body, n => {
    if (hit(n)) found = true;
  });
  return found;
};
/** What an arm may not do when it takes a refusal together with no answer, and how each is found in a body. */
type Act = { readonly what: string; readonly why: string; readonly in: (body: Expr) => boolean };
function actsOf(r: Reading): Act[] {
  const writes = new Set<Expr>(r.queries.filter(q => writeOf(q.ast) !== null).map(q => q.at));
  const direct = {
    timer: (n: Expr) => n.k === 'call' && n.name === 'wake',
    write: (n: Expr) => writes.has(n),
    // a command: `call`, or an interface's method given a once key (an `ask` is a read, and asking what happened
    // is what an unknown outcome calls for)
    call: (n: Expr) =>
      n.k === 'call' && (n.name === 'call' || (n.name.includes('.') && n.args.some(a => a.label === 'once'))),
  };
  const act = (hit: (n: Expr) => boolean, what: string, why: string): Act => {
    const reach = doers(r.prog, b => holds(b, hit));
    return { what, why, in: body => holds(body, hit) || callsAny(body, reach) };
  };
  return [
    act(direct.timer, 'sets a timer', 'after a refusal the same key gets the same refusal, so it asks for ever'),
    act(
      direct.write,
      'writes to the database',
      'with no answer the call may have run, so a write made as if it was refused (a refund, a release, a state of failure) undoes what happened, and one made as if it ran records what may not have',
    ),
    act(
      direct.call,
      'makes another call',
      'with no answer the call may have run, so a command sent as if it was refused (a refund, a compensation) undoes what happened, and one sent as if it ran builds on what may not have',
    ),
  ];
}

/** Is the value matched a call's reply: the call itself, or a parameter of type Result[_, CallError]? */
function isReply(f: FnDecl, subject: Expr | null): boolean {
  if (subject?.k === 'call') return subject.name === 'call';
  if (subject?.k !== 'var') return false;
  const t = f.params.find(p => p.name === subject.name)?.typeAst;
  return t?.name === 'Result' && t.args[1]?.name === 'CallError';
}

/** The CallErrors that are no answer: the call may have run. */
const NO_ANSWER = ['Timeout', 'Unreachable'];
/** What a catch-all takes: every CallError the arms above it left (no constructor is named `*`). */
const ALL = '*';
/** What an arm's pattern takes of a reply's errors: one CallError by name, every one left (ALL), or none. */
function takes(pat: Pattern): string | null {
  const p = bare(pat);
  if (p.k !== 'ctor' || p.name !== 'Err') return catchAll(p) ? ALL : null;
  const named = p.subs.find(s => s.field === 'error')?.pat;
  const e = named && bare(named);
  if (e?.k === 'ctor') return e.name;
  return catchAll(e) ? ALL : null;
}

function refusalsAsked(r: Reading): void {
  const acts = actsOf(r);
  const check = (m: Match): void => {
    if (!m.subject) return;
    // the errors taken by an arm above (one with a guard takes nothing for certain)
    const taken = new Set<string>();
    for (const arm of m.arms) {
      const took = takes(arm.pat);
      if (took !== null && took !== ALL && !arm.guard) taken.add(took);
      const both = took === ALL && !taken.has('Rejected') && NO_ANSWER.some(n => !taken.has(n));
      const act = both && !arm.guard ? acts.find(a => a.in(arm.body)) : undefined;
      if (!act) continue;
      r.bad(
        'C87',
        arm.pat.line ? arm.pat : m,
        `this arm takes a refusal together with no answer, and ${act.what}: ${act.why}`,
        'Give the refusal its own arm above this one, `Err(error: Rejected(reason)) -> …`, and do there what a refused call means: a state to move to. This arm then takes only no answer, where the call may have run: answer the client (it sends again with the same key), or set a timer to ask again.',
      );
    }
  };
  for (const f of r.prog.fns.values())
    if (own(f))
      eachExpr(f.body, m => {
        if (m.k === 'match' && isReply(f, m.subject)) check(m);
      });
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
  // a row taken apart by a pattern, the subject it came from, and what runs with it bound: a match arm's body, or
  // the rest of the block after a `let` (`let Order(id, amount) = order`)
  const check = (f: FnDecl, subject: Expr, pat: Pattern, body: Expr): void => {
    const row = rowOf(pat, rowTable);
    if (!row) return;
    const t = tables.get(row.table) ?? [...tables].find(([n]) => lc(n) === lc(row.table))?.[1];
    if (!t || t.pk.length === 0) return;
    const naming = namingOf(r, f, subject, row, t);
    eachExpr(body, c => {
      if (c.k === 'call' && c.name === 'call') keyed(r, c, row, t, naming);
    });
  };
  for (const f of r.prog.fns.values())
    eachExpr(f.body, e => {
      if (e.k === 'match' && e.subject) for (const arm of e.arms) check(f, e.subject, arm.pat, arm.body);
      if (e.k === 'block')
        e.lets.forEach((l, i) => {
          if (l.pat)
            check(f, l.value, l.pat, {
              k: 'block',
              lets: e.lets.slice(i + 1),
              result: e.result,
              line: e.line,
              file: e.file,
            });
        });
    });
}

export function commandRules(r: Reading): void {
  const rowTable = rowTablesOf(r.queries);
  refusalsAsked(r);

  commandKeys(r, rowTable);
}
