// rules/final.ts: C80 (added in round 3 of the timer-rule mutants, experiments/c78/round3.ts). `final` on a constructor says that asking again gives the same outcome, and C79
// lets a timer's run leave a row on a final outcome (for a request to act on). The compiler checks the declaration
// where the constructor is made: every decision on the way to it (the conditions and guards of the arms it is in,
// those of the arms before them, the subjects of the matches, in its function and in each caller that answers with
// it) reads only what a second run reads the same: arguments, stored rows, constants, a call's reply (a call
// carries a once key, C41, so the callee repeats its stored reply). Not the clock, and not an `ask`'s reply (a read
// has no key). A clock reading that can only change one way is allowed where it is: `now() > t` (or `>=`, or
// `t < now()`) with t not itself read from the clock, true on the arm it guards; `now() < t`, false on the arms
// after it. A matched final constructor is the other half: C79 lets a path end there only when the value comes
// from a call (with its once key), not from an ask.
import { eachExpr, partsOf } from '../compiler/ast.ts';
import type { Call, CondArm, Ctor, Expr, FnDecl, Match, PatArm, Program } from '../compiler/ast.ts';
import { bindsOf, resultsOf } from './origins.ts';
import { argFor, calleeOf } from './syntax.ts';
import { isRemote, pathsOf } from './timers.ts';
import type { CallSite, Report } from './types.ts';

type Calls = ReadonlyMap<string, readonly CallSite[]>;
/** `memo`: for each expression, whether it is volatile, by how many steps were left to follow it. */
type Reader = { readonly prog: Program; readonly calls: Calls; readonly memo: Map<Expr, (boolean | undefined)[]> };
/** A decision a second run may make otherwise: its line, what it is, and the caller it was found in. */
type Doubt = { readonly at: number; readonly what: string; readonly via?: string };

// How far a value is followed from where it is read: through the `let` or pattern that binds a name, a parameter's
// arguments at each call site, and the body of a function called. An expression itself is read whole, however deep
// it is written. Past this many steps a value counts as one a second run reads the same.
const STEPS = 8;

const isNow = (e: Expr): boolean => e.k === 'call' && e.name === 'now';
const keyed = (e: Call): boolean => e.args.some(a => a.label === 'once');
const argsOf = (e: Call): Expr[] => e.args.map(a => a.value);

/** Does a name hold what the clock or an ask's reply gave: through its `let`, its pattern's subject, or its callers. */
function volatileName(rd: Reader, e: Extract<Expr, { k: 'var' }>, f: FnDecl, steps: number): boolean {
  if (steps === 0) return false;
  const b = bindsOf(f).get(e);
  if (b?.k === 'let') return volatile(rd, b.value, b.fn, steps - 1);
  if (b?.k === 'pat') return !!b.subject && volatile(rd, b.subject, b.fn, steps - 1);
  if (b?.k !== 'param') return false;
  return (rd.calls.get(f.name) ?? []).some(({ from, node }) => {
    const arg = argFor(node, f, b.name);
    return !!arg && volatile(rd, arg, from, steps - 1);
  });
}

function volatileCall(rd: Reader, e: Call, f: FnDecl, steps: number): boolean {
  const inArgs = argsOf(e).some(x => volatile(rd, x, f, steps));
  if (isRemote(e)) return !keyed(e) || inArgs;
  if (inArgs) return true;
  const callee = calleeOf(rd.prog, e.name, f);
  const g = callee === null ? undefined : rd.prog.fns.get(callee);
  return !!g && steps > 0 && volatile(rd, g.body, g, steps - 1);
}

/** Does an expression read the clock or an ask's reply (directly, through its names, or in what it calls)? */
function volatile(rd: Reader, e: Expr, f: FnDecl, steps = STEPS): boolean {
  const known = rd.memo.get(e) ?? [];
  const had = known[steps];
  if (had !== undefined) return had;
  const is =
    isNow(e) ||
    (e.k === 'call'
      ? volatileCall(rd, e, f, steps)
      : e.k === 'var'
        ? volatileName(rd, e, f, steps)
        : e.k !== 'lambda' && partsOf(e).some(x => volatile(rd, x, f, steps)));
  known[steps] = is;
  rd.memo.set(e, known);
  return is;
}

/** A clock reading on the greater side of a comparison (later, it is only more true) or the lesser side. */
function clockSide(rd: Reader, c: Expr, f: FnDecl): 'grows' | 'shrinks' | null {
  if (c.k !== 'bin' || !['<', '<=', '>', '>='].includes(c.op)) return null;
  const [big, small] = c.op === '>' || c.op === '>=' ? [c.l, c.r] : [c.r, c.l];
  if (isNow(big) && !volatile(rd, small, f)) return 'grows';
  if (isNow(small) && !volatile(rd, big, f)) return 'shrinks';
  return null;
}

/** Would a second run find the condition as this one did, given it was `truth` here? */
function stableAs(rd: Reader, c: Expr, truth: boolean, f: FnDecl): boolean {
  if (c.k === 'bin' && (c.op === 'and' || c.op === 'or'))
    return stableAs(rd, c.l, truth, f) && stableAs(rd, c.r, truth, f);
  const side = clockSide(rd, c, f);
  return side ? side === (truth ? 'grows' : 'shrinks') : !volatile(rd, c, f);
}

/** The first decision of a match, up to its arm i, that a second run may make otherwise. */
function doubtIn(rd: Reader, mt: Match, i: number, f: FnDecl): Doubt | null {
  if (mt.subject && volatile(rd, mt.subject, f))
    return { at: mt.subject.line ?? mt.line, what: 'the value it matches on' };
  const arms: readonly (PatArm | CondArm)[] = mt.arms;
  for (const [j, a] of arms.slice(0, i + 1).entries()) {
    const [test, word] = 'pat' in a ? [a.guard, 'guard'] : [a.cond, 'condition'];
    if (test && !stableAs(rd, test, j === i, f))
      return { at: a.line, what: j === i ? `the ${word} of its arm` : `the ${word} of an arm before it` };
  }
  return null;
}

/**
 * The first decision on the way to a node (in its function, then up its call sites) that a second run may decide
 * otherwise. A caller decides too when it answers with what this function made (the call is what its arm returns);
 * where it passes the value on as data (`retry_at(decided: backoff(…))`), the decision is the callee's.
 */
function unstable(rd: Reader, f: FnDecl, node: Expr, depth = 0, seen: ReadonlySet<string> = new Set()): Doubt | null {
  const path = pathsOf(f).get(node);
  if (!path) return null;
  for (const [mt, i] of path.arms) {
    const doubt = doubtIn(rd, mt, i, f);
    if (doubt) return doubt;
  }
  if (depth >= 4 || seen.has(f.name)) return null;
  const within = new Set([...seen, f.name]);
  for (const { from, node: call } of rd.calls.get(f.name) ?? []) {
    if (!resultsOf(from.body).includes(call)) continue;
    const doubt = unstable(rd, from, call, depth + 1, within);
    if (doubt) return { ...doubt, via: doubt.via ?? from.name };
  }
  return null;
}

/** Every place a constructor declared final is made. */
function madeFinal(prog: Program): { n: Ctor; f: FnDecl }[] {
  const final = new Set([...prog.types.values()].flatMap(d => d.variants.filter(v => v.final).map(v => v.name)));
  if (final.size === 0) return [];
  const made: { n: Ctor; f: FnDecl }[] = [];
  for (const f of prog.fns.values())
    eachExpr(f.body, n => {
      if (n.k === 'ctor' && final.has(n.name)) made.push({ n, f });
    });
  return made;
}

export function finalRules(prog: Program, calls: Calls, bad: Report): void {
  const rd: Reader = { prog, calls, memo: new Map() };
  for (const { n, f } of madeFinal(prog)) {
    const u = unstable(rd, f, n);
    if (!u) continue;
    bad(
      'C80',
      n,
      `${n.name} is declared final (asking again gives it again), but it is made where a second run may decide otherwise: ${u.what} (${u.via ? `${u.via}, ` : ''}line ${u.at}) reads the clock, or the reply of an ask`,
      `Decide it from what a second run reads the same (a count of attempts, a stored row, a call's reply, a deadline passed: \`now() > t\`), or do not declare ${n.name} final.`,
    );
  }
}
