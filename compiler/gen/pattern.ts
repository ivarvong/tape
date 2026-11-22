// compiler/gen/pattern.ts: a value matched against a pattern. The code branches to the next arm when the pattern
// does not match, and binds the pattern's names on the way.
import type { CtorPat, Pattern } from '../ast.ts';
import { I32, I64, TRAP, fail, sleb, uleb } from '../common.ts';
import { shadowedHint } from '../shadow.ts';
import { BOOL, INT, T, VIEW, key } from '../types.ts';
import type { Type } from '../types.ts';
import { declare, fresh, get, loadField, mark, need, ptrSlots, set, store, trapIf } from './fn.ts';
import type { Ctx } from './fn.ts';
import type { Adt, BoxedField, FlatField } from './layout.ts';

type Field = FlatField | BoxedField;
/** A constructor pattern against a type: the constructor's index, and each sub-pattern with the field it reads. */
type Taken = { adt: Adt; vi: number; subs: { fl: Field; pat: Pattern }[] };
type Of<K extends Pattern['k']> = Extract<Pattern, { k: K }>;

export const isBool = (pt: Pattern): boolean => pt.k === 'ctor' && (pt.name === 'True' || pt.name === 'False');
export const isRefine = (c: Ctx, pt: Pattern): boolean => pt.k === 'ctor' && !!c.B.types.get(pt.name)?.refine;

function wrongType(c: Ctx, pt: CtorPat, owner: string, type: Type): never {
  const sh =
    shadowedHint(T(owner), type) ??
    (c.B.prog.renamed?.ctors.has(pt.name)
      ? `${key(type)} has its own ${pt.name} (std.${pt.name}), which this program's ${pt.name} shadows in the program's files: rename the program's constructor to match ${key(type)} here.`
      : null);
  return fail(
    pt,
    sh ? 'C76' : 'C23',
    `${pt.name} is a constructor of ${owner}, but this value is ${key(type)}`,
    sh ?? '',
  );
}

export function ctorOf(c: Ctx, pt: CtorPat, type: Type): Taken {
  const made = c.B.ctors.get(pt.name) ?? fail(pt, 'C20', `unknown constructor ${pt.name}`, '');
  if (made.decl.name !== type.name) wrongType(c, pt, made.decl.name, type);
  const adt = c.B.adtOf(type, pt);
  const fields: readonly Field[] = adt.variants[made.vi]?.fields ?? [];
  const [only] = fields;
  const subs = pt.subs.map(s => {
    // one field and one pattern: the pattern is for that field, whatever name it was written with
    if (only && fields.length === 1 && pt.subs.length === 1 && s.pun && s.field !== only.name)
      return { fl: only, pat: s.pat };
    const fl =
      fields.find(x => x.name === s.field) ??
      fail(
        pt,
        'C18',
        `${pt.name} has no field ${s.field}`,
        `Its fields are ${fields.map(x => x.name).join(', ') || 'none'}.`,
      );
    return { fl, pat: s.pat };
  });
  return { adt, vi: made.vi, subs };
}

/** Does the pattern match every value of the type? */
export function irrefutable(c: Ctx, pt: Pattern, type: Type): boolean {
  if (pt.k === 'as') return irrefutable(c, pt.pat, type);
  if (pt.k === 'any' || pt.k === 'bind') return true;
  if (pt.k !== 'ctor' || isBool(pt) || isRefine(c, pt) || !c.B.adtOrNull(type, pt)) return false;
  return (
    c.B.adtOf(type, pt).variants.length === 1 && ctorOf(c, pt, type).subs.every(s => irrefutable(c, s.pat, s.fl.type))
  );
}

/** Emits a refined type's condition for the value in `ls`; leaves an i32. */
export function emitPred(c: Ctx, t: Type, ls: number[]): void {
  const d = c.B.types.get(t.name);
  if (!d?.refine) return;
  const outer = c.env;
  c.env = new Map([['self', { name: 'self', type: c.B.strip(t), locals: ls }]]);
  need(c, c.emit(d.refine.pred, BOOL, false), BOOL, d, 'the `where` condition');
  c.env = outer;
}

/** Leave for the next arm when the i32 on the stack is not zero. */
const fails = (c: Ctx): void => {
  c.code.push(0x0d, 0);
};
const i32 = (n: number): number[] => [0x41, ...sleb(n)];
/** Whether the n bytes at `at` are not the n bytes the instructions `ptr` put on the stack. */
const differs = (c: Ctx, ptr: readonly number[], at: number, n: number): number[] => [
  ...ptr,
  ...i32(n),
  ...i32(at),
  ...i32(n),
  0x10,
  ...uleb(c.B.fnIndex('same')),
  0x45,
];

function matchStr(c: Ctx, pt: Of<'str'>, bt: Type, ls: readonly number[]): void {
  need(c, bt, VIEW, pt, "a text pattern's value");
  const [at, n] = c.B.literal(pt.bytes);
  c.code.push(...get(ls[0] ?? 0), ...get(ls[1] ?? 0), ...i32(at), ...i32(n), 0x10, ...uleb(c.B.fnIndex('same')), 0x45);
  fails(c);
}

function matchPrefix(c: Ctx, pt: Of<'prefix'>, bt: Type, ls: readonly number[]): void {
  need(c, bt, VIEW, pt, "a text pattern's value");
  const [at, n] = c.B.literal(pt.bytes);
  const [ptr = 0, len = 0] = ls;
  const p2 = fresh(c, I32);
  const l2 = fresh(c, I32);
  c.code.push(...get(len), ...i32(n), 0x49);
  fails(c);
  c.code.push(...differs(c, get(ptr), at, n));
  fails(c);
  c.code.push(...get(ptr), ...i32(n), 0x6a, ...set(p2), ...get(len), ...i32(n), 0x6b, ...set(l2));
  matchPat(c, pt.rest, VIEW, [p2, l2]);
}

function matchSuffix(c: Ctx, pt: Of<'suffix'>, bt: Type, ls: readonly number[]): void {
  need(c, bt, VIEW, pt, "a text pattern's value");
  const [at, n] = c.B.literal(pt.bytes);
  const [ptr = 0, len = 0] = ls;
  const l2 = fresh(c, I32);
  c.code.push(...get(len), ...i32(n), 0x49);
  fails(c);
  c.code.push(...get(len), ...i32(n), 0x6b, ...set(l2), ...differs(c, [...get(ptr), ...get(l2), 0x6a], at, n));
  fails(c);
  matchPat(c, pt.head, VIEW, [ptr, l2]);
}

function matchSplit(c: Ctx, pt: Of<'split'>, bt: Type, ls: readonly number[]): void {
  need(c, bt, VIEW, pt, "a text pattern's value");
  if (!c.B.fns.has('find_text'))
    fail(
      pt,
      'C30',
      'the program has no function find_text',
      'A pattern `p ++ "sep" ++ q` needs std/core.tape: compile it together with your file.',
    );
  const [at, n] = c.B.literal(pt.bytes);
  const [ptr = 0, len = 0] = ls;
  const i = fresh(c, I32);
  const p2 = fresh(c, I32);
  const l2 = fresh(c, I32);
  const w = fresh(c, I64);
  const found = [...get(ptr), ...get(len), ...i32(at), ...i32(n), 0x42, 0, 0x10, ...uleb(c.B.fnIndex('find_text'))];
  c.code.push(...found, 0x22, ...uleb(w), 0x42, 0, 0x53);
  fails(c);
  c.code.push(...get(w), 0xa7, ...set(i));
  const after = [...get(ptr), ...get(i), 0x6a, ...i32(n), 0x6a, ...set(p2)];
  const left = [...get(len), ...get(i), 0x6b, ...i32(n), 0x6b, ...set(l2)];
  c.code.push(...after, ...left);
  matchPat(c, pt.head, VIEW, [ptr, i]);
  matchPat(c, pt.rest, VIEW, [p2, l2]);
}

/** `name(pattern)`: a function that returns Option[…]; Some means it matched, and the pattern is for its value. */
function matchFn(c: Ctx, pt: Of<'fn'>, type: Type, ls: readonly number[]): void {
  // there was a pattern json(T(…)); decode does all it did and says why a body was refused, so there is one way
  if (pt.name === 'json')
    fail(
      pt,
      'C35',
      'json(…) is not a pattern',
      'Decode the bytes and match the result: `match decode(json: body, as: T) { Ok(value: T(…)) -> … Err(error) -> … }`. A type with several constructors decodes as whichever one the body fits.',
    );
  const g =
    c.B.find(pt.name, c.f.file, pt) ??
    fail(
      pt,
      'C22',
      `unknown function ${pt.name}`,
      'A lowercase name with parentheses in a pattern is a function that returns Option[…].',
    );
  const [param] = g.params;
  const { ret } = g;
  if (g.params.length !== 1 || !param?.type || ret?.name !== 'Option')
    return fail(
      pt,
      'C34',
      `${pt.name} cannot be used as a pattern`,
      'A function used as a pattern takes one value and returns Option[…]: Some means it matched, and the pattern inside is matched against its value.',
    );
  need(c, type, param.type, pt, `the value matched by ${pt.name}(…)`);
  for (const l of ls) c.code.push(...get(l));
  c.code.push(0x10, ...uleb(c.B.fnIndex(g.name)));
  const r = store(c, ret);
  const adt = c.B.adtOf(ret, pt);
  const some = adt.variants.findIndex(v => v.name === 'Some');
  const fl = adt.boxed ? undefined : adt.variants[some]?.fields[0];
  if (!fl) return fail(pt, 'C34', `${pt.name} cannot be used as a pattern`, '');
  c.code.push(...get(r[0] ?? 0), ...i32(some), 0x47);
  fails(c);
  matchPat(
    c,
    pt.sub,
    fl.type,
    fl.slots.map(i => r[i] ?? 0),
  );
}

function matchRefined(c: Ctx, pt: CtorPat, bt: Type, ls: number[]): void {
  const rt = T(pt.name);
  need(c, bt, c.B.strip(rt), pt, `the value matched by ${pt.name}(…)`);
  const [only] = pt.subs;
  if (pt.subs.length !== 1 || !only)
    return fail(pt, 'C18', `${pt.name}(…) takes one pattern`, `Write \`${pt.name}(name)\` to bind the checked value.`);
  emitPred(c, rt, ls);
  c.code.push(0x45);
  fails(c);
  matchPat(c, only.pat, rt, ls);
}

/** A constructor of a boxed type: its tag is read from memory, and each part matched is loaded from it. */
function matchBoxed(c: Ctx, taken: Taken, ptr: number): void {
  if (c.B.opts.check) {
    c.code.push(...get(ptr), 0x28, 2, 4, ...i32(-1), 0x46);
    trapIf(c, TRAP.RELEASED);
  }
  if (taken.adt.tagged) {
    c.code.push(...get(ptr), 0x28, 2, 0, ...i32(taken.vi), 0x47);
    fails(c);
  }
  const outer = c.binderMode;
  if (!c.consuming) c.binderMode = 'borrowed';
  for (const s of taken.subs) {
    if (s.pat.k === 'any' || !('vts' in s.fl)) continue;
    const got = loadField(c, ptr, s.fl);
    // a part taken out of a shared value is shared too
    if (c.B.opts.reuse && c.consuming && ptrSlots(c, s.fl.type).length > 0) {
      c.code.push(...get(ptr), 0x28, 2, 4, 0x04, 0x40);
      mark(c, s.fl.type, got);
      c.code.push(0x0b);
    }
    matchPat(c, s.pat, s.fl.type, got);
  }
  c.binderMode = outer;
}

function matchCtor(c: Ctx, pt: CtorPat, type: Type, bt: Type, ls: number[]): void {
  if (isBool(pt)) {
    need(c, bt, BOOL, pt, `the value matched by ${pt.name}`);
    c.code.push(...get(ls[0] ?? 0));
    if (pt.name === 'True') c.code.push(0x45);
    return fails(c);
  }
  if (isRefine(c, pt)) return matchRefined(c, pt, bt, ls);
  if (!c.B.adtOrNull(type, pt)) fail(pt, 'C23', `${key(type)} has no constructors to match`, '');
  const taken = ctorOf(c, pt, type);
  if (taken.adt.boxed) return matchBoxed(c, taken, ls[0] ?? 0);
  if (taken.adt.tagged) {
    c.code.push(...get(ls[0] ?? 0), ...i32(taken.vi), 0x47);
    fails(c);
  }
  for (const s of taken.subs)
    matchPat(
      c,
      s.pat,
      s.fl.type,
      s.fl.slots.map(i => ls[i] ?? 0),
    );
}

/** Matches the value in `ls` against a pattern: branches to the next arm on failure, binds names on the way. */
export function matchPat(c: Ctx, pt: Pattern, type: Type, ls: number[]): void {
  const bt = c.B.strip(type);
  switch (pt.k) {
    case 'any':
      return;
    case 'bind':
      declare(c, pt.name, type, ls, pt).mode = c.binderMode;
      return;
    case 'as':
      // The whole value and its parts are now both reachable: mark it shared first (its parts are marked as they
      // are taken out), so neither is ever released while the other is still in use. That only costs a reuse.
      mark(c, type, ls);
      matchPat(c, pt.pat, type, ls);
      declare(c, pt.name, type, ls, pt).mode = 'borrowed';
      return;
    case 'int':
      need(c, bt, INT, pt, "a number pattern's value");
      c.code.push(...get(ls[0] ?? 0), 0x42, ...sleb(pt.v), 0x52);
      return fails(c);
    case 'str':
      return matchStr(c, pt, bt, ls);
    case 'prefix':
      return matchPrefix(c, pt, bt, ls);
    case 'suffix':
      return matchSuffix(c, pt, bt, ls);
    case 'split':
      return matchSplit(c, pt, bt, ls);
    case 'fn':
      return matchFn(c, pt, type, ls);
    case 'ctor':
      return matchCtor(c, pt, type, bt, ls);
  }
}
