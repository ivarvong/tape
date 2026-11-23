// compiler/rule.ts: what decode's 400 says of a value that fails its type's refinement. Only the forms a client can
// act on are said: bounds on its length in bytes (`len(self)`) or characters (`char_count(v: self)`), and a numeric
// range, each with literal bounds: `Key = View where len(self) >= 1 and len(self) <= 64` refused is "expected Key, 1
// to 64 bytes", `Qty = Int where self >= 1 and self <= 9` is "expected Qty, 1 to 9". Any other condition (a call, a
// flag, a pattern) is "not a valid Slug": the program's source is never echoed into a 400. The compiled decoder
// (compiler/wire.ts, compiler/gen/decode.ts) and the reference interpreter (interp/json.ts) both say it from here.
import type { Expr, Program, TypeDecl } from './ast.ts';

const decText = (v: bigint, s: number): string => {
  const neg = v < 0n,
    d = (neg ? -v : v).toString().padStart(s + 1, '0');
  return `${neg ? '-' : ''}${s > 0 ? `${d.slice(0, -s)}.${d.slice(-s)}` : d}`;
};
/** A literal bound's text, or null. */
function bound(e: Expr): string | null {
  if (e.k === 'int') return String(e.v);
  if (e.k === 'dec') return decText(e.v, e.s);
  if (e.k === 'float') return String(e.v);
  if (e.k === 'neg') {
    const x = bound(e.e);
    return x === null ? null : `-${x}`;
  }
  return null;
}
const conjuncts = (e: Expr): Expr[] => (e.k === 'bin' && e.op === 'and' ? [...conjuncts(e.l), ...conjuncts(e.r)] : [e]);
const isSelf = (e: Expr): boolean => e.k === 'var' && e.name === 'self';
// `len(self)` or `char_count(v: self)`, however its one argument is written
const lengthIn =
  (name: string) =>
  (e: Expr): boolean =>
    e.k === 'call' && e.name === name && e.args.length === 1 && e.args[0] !== undefined && isSelf(e.args[0].value);
const isLen = lengthIn('len'),
  isChars = lengthIn('char_count');
const FLIP: Readonly<Record<string, string>> = { '<': '>', '<=': '>=', '>': '<', '>=': '<=', '==': '==' };

type Bounds = { lo?: string; loOpen?: boolean; hi?: string; hiOpen?: boolean; eq?: string };
/** `x op k` (or `k op x`) as a bound on x, where x is what `of` accepts; false when it is not one. */
function addBound(b: Bounds, e: Expr, of: (x: Expr) => boolean): boolean {
  if (e.k !== 'bin' || !(e.op in FLIP)) return false;
  const [x, k, op] = of(e.l) ? [e.l, e.r, e.op] : of(e.r) ? [e.r, e.l, FLIP[e.op] ?? ''] : [null, e.r, ''];
  // a literal only: a bound the program names (`flags.max_per_order`) is source, not said
  const v = x ? bound(k) : null;
  if (v === null) return false;
  if (op === '==') b.eq = v;
  else if (op === '>=' || op === '>') [b.lo, b.loOpen] = [v, op === '>'];
  else [b.hi, b.hiOpen] = [v, op === '<'];
  return true;
}
function said(b: Bounds, unit: string): string | null {
  const text = saidIn(b, unit === '' ? '' : ` ${unit}`);
  // "at least 1 character", "1 byte"
  return text !== null && unit !== '' && (text === `1 ${unit}` || text.endsWith(` 1 ${unit}`))
    ? text.slice(0, -1)
    : text;
}
function saidIn(b: Bounds, u: string): string | null {
  if (b.eq !== undefined) return `${b.eq}${u}`;
  if (b.lo !== undefined && b.hi !== undefined && !b.loOpen && !b.hiOpen) return `${b.lo} to ${b.hi}${u}`;
  const lo = b.lo === undefined ? null : `${b.loOpen ? 'more than' : 'at least'} ${b.lo}${u}`;
  const hi = b.hi === undefined ? null : `${b.hiOpen ? 'less than' : 'at most'} ${b.hi}${u}`;
  return lo && hi ? `${lo} and ${hi}` : (lo ?? hi);
}

/** What a Dec[scale] must be, after "expected ": std/json.tape's json_dec_kind says the same. */
export const decExpected = (scale: number): string =>
  scale === 0 ? 'an integer' : `a number with at most ${scale} decimal${scale === 1 ? '' : 's'}`;

/**
 * The same, of a list's element: an author's message has no word of its own that says it carries no path (as
 * `missing`, `expected …` and `not a valid …` do), so it is marked with the `: ` the element's index goes before
 * (json_join, and interp/json.ts's join, put `[1]` before it: `codes[1]: two or more capital letters`).
 */
export const elementRefusalOf = (prog: Program, name: string): string =>
  prog.types.get(name)?.refine?.message === undefined ? refusalOf(prog, name) : `: ${refusalOf(prog, name)}`;

/**
 * The problem decode says of a value that fails the refinement of `name` (its base's too, when the base is
 * refined): `expected Key, 1 to 64 bytes` when every condition is a bound it can say, else `not a valid Key`.
 */
export function refusalOf(prog: Program, name: string): string {
  const own = prog.types.get(name)?.refine?.message;
  if (own !== undefined) return own;
  const preds: Expr[] = [];
  const seen = new Set<string>();
  for (let n: string | undefined = name; n !== undefined && !seen.has(n);) {
    seen.add(n);
    const r: TypeDecl['refine'] = prog.types.get(n)?.refine;
    if (!r) break;
    preds.unshift(...conjuncts(r.pred));
    n = r.base.name;
  }
  const bytes: Bounds = {},
    chars: Bounds = {},
    value: Bounds = {};
  const plain = preds.every(
    p => addBound(bytes, p, isLen) || addBound(chars, p, isChars) || addBound(value, p, isSelf),
  );
  const parts = [said(bytes, 'bytes'), said(chars, 'characters'), said(value, '')].filter(x => x !== null);
  return plain && parts.length > 0 ? `expected ${name}, ${parts.join(', ')}` : `not a valid ${name}`;
}
