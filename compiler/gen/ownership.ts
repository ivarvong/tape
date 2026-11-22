// compiler/gen/ownership.ts: who may release what. For every function: which parameters it owns (it may pass them
// on, store them or release them) and which it only reads; and for every use of a variable, whether it is a read,
// and whether an owning use is `clean`: every other use of the same variable on the same path is a read that
// finishes before the owner runs. Anything not proven clean marks the value shared, which only costs a missed reuse.
import { partsOf } from '../ast.ts';
import type { Expr, Field, FnDecl, Pattern, UsePos, Var } from '../ast.ts';
import { INTRINSICS } from '../types.ts';

type Role = 'x' | 'arg' | 'let' | 'result' | 'subject' | 'guard' | 'body';
/** One step from a function's body down to a use: the expression, the part of it gone into, and which one. */
type Step = { readonly n: Expr; readonly r: Role; readonly i: number };
type Flags = { readonly guard?: boolean; readonly lambda?: boolean; readonly argOwn?: boolean };
type Use = {
  readonly node: Var | Field;
  readonly name: string;
  readonly field: string | null;
  readonly pos: UsePos;
  readonly path: readonly Step[];
  readonly guard: boolean;
  readonly lambda: boolean;
  readonly argOwn: boolean;
};
/** The function a call names from a file, or null when there is none (or the name is ambiguous). */
export type Find = (name: string, file: string) => FnDecl | null;
type Reading = {
  readonly f: FnDecl;
  readonly find: Find;
  readonly owned: ReadonlyMap<string, readonly boolean[]>;
  readonly uses: Use[];
  /** a name bound by taking a value apart -> the parameter the value came from, or null */
  readonly derived: Map<string, string | null>;
  readonly mine: ReadonlySet<string>;
};

/** How use u stands to owner o: it finishes before o runs, it is on another path (skip), or neither can be said. */
function sequence(u: Use, o: Use): 'before' | 'skip' | 'bad' {
  const same = (a: Step | undefined, b: Step | undefined): boolean =>
    !!a && !!b && a.n === b.n && a.r === b.r && a.i === b.i;
  let d = 0;
  while (same(u.path[d], o.path[d])) d++;
  const a = u.path[d];
  const b = o.path[d];
  if (!a || !b || a.n !== b.n) return 'bad';
  if (a.n.k === 'block') return a.r === 'let' && (b.r === 'result' || a.i < b.i) ? 'before' : 'bad';
  if (a.n.k === 'match') {
    if (b.r !== 'body') return 'bad';
    return a.r === 'subject' || (a.r === 'guard' && a.i <= b.i) ? 'before' : 'skip';
  }
  return a.r === 'arg' && b.r === 'arg' && o.path.length === d + 1 ? 'before' : 'bad';
}

/** Every name a pattern binds is derived from `root`. (The head of a suffix or split pattern is not gone into.) */
function binders(rd: Reading, pat: Pattern, root: string | null): void {
  if (pat.k === 'bind' || pat.k === 'as') rd.derived.set(pat.name, root);
  if (pat.k === 'ctor') for (const x of pat.subs) binders(rd, x.pat, root);
  if (pat.k === 'fn') binders(rd, pat.sub, root);
  if (pat.k === 'prefix' || pat.k === 'split') binders(rd, pat.rest, root);
  if (pat.k === 'as') binders(rd, pat.pat, root);
}

const rootOf = (rd: Reading, e: Expr | null): string | null =>
  e?.k === 'var' ? (rd.mine.has(e.name) ? e.name : (rd.derived.get(e.name) ?? null)) : null;

function use(
  rd: Reading,
  node: Var | Field,
  name: string,
  field: string | null,
  pos: UsePos,
  path: readonly Step[],
  fl: Flags,
): void {
  node.pos = fl.lambda ? 'own' : pos;
  rd.uses.push({ node, name, field, pos: node.pos, path, guard: !!fl.guard, lambda: !!fl.lambda, argOwn: !!fl.argOwn });
}

/** How each argument of a call is taken: an intrinsic reads; a function owns unless it is known only to read. */
function argPositions(rd: Reading, e: Extract<Expr, { k: 'call' }>): UsePos[] {
  const intrinsic = INTRINSICS.has(e.name);
  let g: FnDecl | null = null;
  if (!intrinsic)
    try {
      g = rd.find(e.name, rd.f.file);
    } catch {
      g = null;
    }
  return e.args.map(a => {
    if (intrinsic) return 'read';
    if (!g) return 'own';
    const named = g.params.findIndex(pm => pm.name === a.label);
    const k = named < 0 && g.params.length === 1 ? 0 : named;
    return k >= 0 && rd.owned.get(g.name)?.[k] === false ? 'read' : 'own';
  });
}

function goMatch(rd: Reading, e: Extract<Expr, { k: 'match' }>, pos: UsePos, path: readonly Step[], fl: Flags): void {
  const at = (r: Role, i: number): Step[] => [...path, { n: e, r, i }];
  const plain = { ...fl, argOwn: false };
  if (e.subject) go(rd, e.subject, 'subject', at('subject', 0), plain);
  const root = rootOf(rd, e.subject);
  e.arms.forEach((a, i) => {
    if (root !== null && 'pat' in a) binders(rd, a.pat, root);
    const test = 'pat' in a ? a.guard : a.cond;
    if (test) go(rd, test, 'read', at('guard', i), { ...plain, guard: true });
    go(rd, a.body, pos, at('body', i), plain);
  });
}

function go(rd: Reading, e: Expr, pos: UsePos, path: readonly Step[], fl: Flags): void {
  const at = (r: Role, i: number): Step[] => [...path, { n: e, r, i }];
  const plain = { ...fl, argOwn: false };
  switch (e.k) {
    case 'int':
    case 'str':
    case 'held':
      return;
    case 'interp':
      // each hole is read, never handed over
      return e.parts.forEach((part, i) => {
        go(rd, part, 'read', at('x', i), plain);
      });
    case 'var':
      return use(rd, e, e.name, null, pos, path, fl);
    case 'field':
      // inside a function value the whole variable is captured, whichever field is read
      if (e.e.k === 'var') return use(rd, e, e.e.name, fl.lambda ? null : e.name, pos, path, fl);
      return go(rd, e.e, 'read', at('x', 0), plain);
    case 'call': {
      const takes = argPositions(rd, e);
      e.args.forEach((a, i) => {
        const p = takes[i] ?? 'own';
        go(rd, a.value, p, at('arg', i), { ...fl, argOwn: p === 'own' });
      });
      return;
    }
    case 'ctor':
      return e.args.forEach((a, i) => {
        go(rd, a.value, 'own', at('arg', i), plain);
      });
    case 'lambda':
      return go(rd, e.body, 'own', at('x', 0), { ...plain, lambda: true });
    case 'block':
      e.lets.forEach((l, i) => {
        go(rd, l.value, 'own', at('let', i), plain);
        if (l.pat && l.value.k === 'var') binders(rd, l.pat, rootOf(rd, l.value));
      });
      return go(rd, e.result, pos, at('result', 0), plain);
    case 'match':
      return goMatch(rd, e, pos, path, fl);
    case 'bin':
    case 'not':
    case 'neg':
    case 'index':
      // arithmetic, comparison and indexing only read
      return partsOf(e).forEach(part => {
        go(rd, part, 'read', at('x', 0), plain);
      });
  }
}

/** Is an owning use clean: every other use of the same value on its path is a read that is over before it? */
const clean = (o: Use, uses: readonly Use[]): boolean =>
  o.pos !== 'read' &&
  !o.guard &&
  !o.lambda &&
  uses.every(u => {
    if (u === o || u.name !== o.name || (u.field !== null && o.field !== null && u.field !== o.field)) return true;
    const r = sequence(u, o);
    return r === 'skip' || (r === 'before' && u.pos !== 'own');
  });

/** Reads one function: marks its uses, and its parameters it turns out to own. True when a parameter was new. */
function ownership(f: FnDecl, find: Find, owned: Map<string, boolean[]>): boolean {
  const rd: Reading = { f, find, owned, uses: [], derived: new Map(), mine: new Set(f.params.map(pm => pm.name)) };
  go(rd, f.body, 'own', [], {});
  for (const o of rd.uses) o.node.clean = clean(o, rd.uses);
  const mine = owned.get(f.name) ?? [];
  let changed = false;
  f.params.forEach((pm, i) => {
    if (mine[i]) return;
    const owns = rd.uses.some(
      u => u.pos === 'own' && (u.name === pm.name || (rd.derived.get(u.name) === pm.name && u.argOwn)),
    );
    if (!owns) return;
    mine[i] = true;
    changed = true;
  });
  return changed;
}

/** For each function, by name: whether it owns each of its parameters. With `reuse` off, none is known to. */
export function ownedParameters(fns: ReadonlyMap<string, FnDecl>, find: Find, reuse: boolean): Map<string, boolean[]> {
  const owned = new Map([...fns.values()].map((f): [string, boolean[]] => [f.name, f.params.map(() => false)]));
  if (!reuse) return owned;
  while ([...fns.values()].map(f => ownership(f, find, owned)).includes(true));
  return owned;
}
