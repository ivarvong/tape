// compiler/rule.ts: a refinement's condition as decode's 400 says it, after "expected ". The common bounds read as a
// client would write them: `len(self) >= 1 and len(self) <= 64` is "1 to 64 bytes", `self >= 1 and self <= 100`
// is "1 to 100", `self > 0` "more than 0", `self <= flags.max_per_order` "at most flags.max_per_order". A condition it cannot put so is named with its type and written out:
// "a Slug: every_byte(v: self, keep: is_lower)". The compiled decoder (compiler/wire.ts, compiler/gen/decode.ts)
// and the reference interpreter (interp/json.ts) both say it from here, so the two give the same text.
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
/** An expression as Tape, for a condition the bounds do not cover. */
function shown(e: Expr): string {
  const b = bound(e);
  if (b !== null) return b;
  if (e.k === 'var') return e.name;
  if (e.k === 'str') return JSON.stringify(new TextDecoder().decode(Uint8Array.from(e.bytes)));
  if (e.k === 'field') return `${shown(e.e)}.${e.name}`;
  if (e.k === 'bin') return `${shown(e.l)} ${e.op} ${shown(e.r)}`;
  if (e.k === 'not') return `not ${shown(e.e)}`;
  if (e.k === 'call')
    return `${e.name}(${e.args.map(a => (a.label === null ? shown(a.value) : `${a.label}: ${shown(a.value)}`)).join(', ')})`;
  return '…';
}
const conjuncts = (e: Expr): Expr[] => (e.k === 'bin' && e.op === 'and' ? [...conjuncts(e.l), ...conjuncts(e.r)] : [e]);
const isSelf = (e: Expr): boolean => e.k === 'var' && e.name === 'self';
const isLen = (e: Expr): boolean =>
  e.k === 'call' && e.name === 'len' && e.args.length === 1 && e.args[0] !== undefined && isSelf(e.args[0].value);
const FLIP: Readonly<Record<string, string>> = { '<': '>', '<=': '>=', '>': '<', '>=': '<=', '==': '==' };

type Bounds = { lo?: string; loOpen?: boolean; hi?: string; hiOpen?: boolean; eq?: string };
/** `x op k` (or `k op x`) as a bound on x, where x is what `of` accepts; false when it is not one. */
function addBound(b: Bounds, e: Expr, of: (x: Expr) => boolean): boolean {
  if (e.k !== 'bin' || !(e.op in FLIP)) return false;
  const [x, k, op] = of(e.l) ? [e.l, e.r, e.op] : of(e.r) ? [e.r, e.l, FLIP[e.op] ?? ''] : [null, e.r, ''];
  // a literal, or a value the program names (`flags.max_per_order`)
  const v = x ? (bound(k) ?? (k.k === 'field' || k.k === 'var' ? shown(k) : null)) : null;
  if (v === null) return false;
  if (op === '==') b.eq = v;
  else if (op === '>=' || op === '>') [b.lo, b.loOpen] = [v, op === '>'];
  else [b.hi, b.hiOpen] = [v, op === '<'];
  return true;
}
function said(b: Bounds, unit: string): string | null {
  const u = unit === '' ? '' : ` ${unit}`;
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
 * What a value of the refined type `name` must be, as decode's 400 says it after "expected ": its base's
 * condition too when the base is refined. The type's name when it has no condition.
 */
export function ruleOf(prog: Program, name: string): string {
  const preds: Expr[] = [];
  const seen = new Set<string>();
  for (let n: string | undefined = name; n !== undefined && !seen.has(n);) {
    seen.add(n);
    const r: TypeDecl['refine'] = prog.types.get(n)?.refine;
    if (!r) break;
    preds.unshift(...conjuncts(r.pred));
    n = r.base.name;
  }
  if (preds.length === 0) return `a valid ${name}`;
  const len: Bounds = {},
    value: Bounds = {},
    other: Expr[] = [];
  for (const p of preds) if (!addBound(len, p, isLen) && !addBound(value, p, isSelf)) other.push(p);
  if (other.length > 0) return `a ${name}: ${preds.map(shown).join(' and ')}`;
  return [said(len, 'bytes'), said(value, '')].filter(x => x !== null).join(', ');
}
