// compiler/gen/range.ts: what a condition match proves about an Int variable, so that `at + 1` in a loop over text
// need not test for overflow. Only two facts, each from the conditions of the arms before an arm (false there)
// and its own (true there):
//   below: x <= 2^32. `x < len(v)` held, or `x >= len(v)` did not (a length is under 2^32).
//   index: 0 <= x <= 2^32. `v[x]` was read without stopping, `x == len(v)` held, or `x != len(v)` did not.
// A part of a condition that may not have run proves nothing: the right side of `and` and `or`, unless the whole
// came out the way that runs it (`a and b` true, `a or b` false). Variables are immutable, so a fact about one
// holds wherever its binding is in scope after the point that proved it.
import type { Expr } from '../ast.ts';
import type { Binding, Ctx } from './fn.ts';

export type Fact = { readonly v: Binding; readonly index: boolean };
type Of<K extends Expr['k']> = Extract<Expr, { k: K }>;

const LENGTH_BOUND = 2n ** 32n;
// the facts in force while each function is compiled, innermost last
const ACTIVE = new WeakMap<readonly number[], Fact[]>();
const active = (c: Ctx): Fact[] => {
  const facts = ACTIVE.get(c.locals) ?? [];
  ACTIVE.set(c.locals, facts);
  return facts;
};

const variable = (c: Ctx, e: Expr): Binding | undefined => (e.k === 'var' ? c.env.get(e.name) : undefined);
// `len(v)`, the built-in one: a call of that name is it unless a local function value has the name (emitCall)
const isLength = (c: Ctx, e: Expr): boolean => e.k === 'call' && e.name === 'len' && !c.env.has('len');

/** Facts from the parts of e that are always evaluated when e is: each `v[x]` there read without stopping. */
function evaluated(c: Ctx, e: Expr, out: Fact[]): void {
  switch (e.k) {
    case 'index': {
      const v = variable(c, e.i);
      if (v) out.push({ v, index: true });
      evaluated(c, e.e, out);
      evaluated(c, e.i, out);
      return;
    }
    case 'bin':
      evaluated(c, e.l, out);
      if (e.op !== 'and' && e.op !== 'or') evaluated(c, e.r, out);
      return;
    case 'neg':
    case 'not':
      evaluated(c, e.e, out);
      return;
    case 'field':
      evaluated(c, e.e, out);
      return;
    case 'call':
    case 'ctor':
      for (const a of e.args) evaluated(c, a.value, out);
      return;
    default:
  }
}

/** A comparison of a variable with `len(…)`, and the fact it gives when it came out `truth`. */
function compared(c: Ctx, e: Of<'bin'>, truth: boolean): Fact | null {
  const flip: Readonly<Record<string, string>> = { '<': '>', '<=': '>=', '>': '<', '>=': '<=', '==': '==', '!=': '!=' };
  const [x, op] = isLength(c, e.r) ? [e.l, e.op] : isLength(c, e.l) ? [e.r, flip[e.op]] : [null, undefined];
  const v = x ? variable(c, x) : undefined;
  if (!v || op === undefined) return null;
  // x < L, x <= L true, or x > L, x >= L false: x <= L; x == L true, or x != L false: 0 <= x = L
  if ((op === '<' || op === '<=') === truth && ['<', '<=', '>', '>='].includes(op)) return { v, index: false };
  if ((op === '==') === truth && (op === '==' || op === '!=')) return { v, index: true };
  return null;
}

/** What a condition proves when it came out `truth`. */
export function proved(c: Ctx, e: Expr, truth: boolean): Fact[] {
  const out: Fact[] = [];
  evaluated(c, e, out);
  if (e.k === 'not') out.push(...proved(c, e.e, !truth));
  if (e.k === 'bin' && ((e.op === 'and' && truth) || (e.op === 'or' && !truth)))
    out.push(...proved(c, e.l, truth), ...proved(c, e.r, truth));
  const f = e.k === 'bin' ? compared(c, e, truth) : null;
  if (f) out.push(f);
  return out;
}

/** f, with these facts in force; they go when it returns. */
export function withFacts<T>(c: Ctx, facts: readonly Fact[], f: () => T): T {
  const all = active(c),
    depth = all.length;
  all.push(...facts);
  try {
    return f();
  } finally {
    all.length = depth;
  }
}

/** The least and most a variable can be here, as far as the facts in force say. */
export function rangeOf(c: Ctx, e: Expr): [bigint, bigint] | null {
  const v = variable(c, e);
  if (!v) return null;
  const facts = active(c).filter(f => f.v === v);
  if (facts.length === 0) return null;
  return [facts.some(f => f.index) ? 0n : -(2n ** 63n), LENGTH_BOUND];
}
