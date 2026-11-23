// compiler/gen/match.ts: `match`, and `let` with a pattern. A match must cover every value of what it matches;
// when it does not, the compiler names a value it misses.
import type { CondArm, Expr, Let, PatArm, Pattern } from '../ast.ts';
import { CompileError, fail } from '../common.ts';
import { BOOL, BUILTIN_TYPES, CAPABILITIES, key } from '../types.ts';
import type { Type } from '../types.ts';
import { blockType, close, ev, inLocals, need, noConsume, open, release, site } from './fn.ts';
import type { Binding, Ctx, Stored } from './fn.ts';
import { ctorOf, irrefutable, isBool, isRefine, matchPat } from './pattern.ts';
import { proved, withFacts } from './range.ts';
import type { Fact } from './range.ts';

type Match = Extract<Expr, { k: 'match' }>;
const text = (bytes: readonly number[]): string => new TextDecoder().decode(new Uint8Array(bytes));

// ---- let Ctor(field, …) = e: a pattern that cannot fail, so nothing here branches. A refutable one is refused
// with the value it would miss, and the construct that handles it.

/** The first part of a pattern that can fail to match, in words; null when none can. */
function culprit(c: Ctx, pt: Pattern, type: Type): string | null {
  const shown = (b: readonly number[]): string => JSON.stringify(text(b));
  if (pt.k === 'as') return culprit(c, pt.pat, type);
  if (pt.k === 'any' || pt.k === 'bind') return null;
  if (pt.k === 'int') return `the number ${pt.v}`;
  if (pt.k === 'str') return `the text ${shown(pt.bytes)}`;
  if (pt.k === 'prefix') return `the prefix ${shown(pt.bytes)} ++ …`;
  if (pt.k === 'suffix' || pt.k === 'split') return `the text ${shown(pt.bytes)} inside ++`;
  if (pt.k === 'fn') return `${pt.name}(…), which matches only when it returns Some`;
  if (isBool(pt)) return `${pt.name}, but the value can also be ${pt.name === 'True' ? 'False' : 'True'}`;
  if (isRefine(c, pt)) return `${pt.name}(…), a refined type whose condition can be false`;
  const a = c.B.adtOrNull(type, pt);
  const others = a && a.variants.length > 1 ? a.variants.filter(x => x.name !== pt.name).map(x => x.name) : null;
  if (others) return `${pt.name}, but the value can also be ${others.join(' or ')}`;
  for (const sb of ctorOf(c, pt, type).subs) {
    const inner = culprit(c, sb.pat, sb.fl.type);
    if (inner !== null) return `${inner} (in field ${sb.fl.name})`;
  }
  return null;
}

export function letPattern(c: Ctx, l: Extract<Let, { pat: Pattern }>): void {
  const v = noConsume(c, l, 'a destructuring let', () => inLocals(c, l.value));
  if (c.B.isLinear(v.type) || CAPABILITIES.includes(v.type.name))
    fail(l, 'C48', `a ${key(v.type)} cannot be taken apart with let`, 'Only values with fields can be destructured.');
  if (!irrefutable(c, l.pat, v.type))
    fail(
      l,
      'C48',
      `this let pattern can fail: ${culprit(c, l.pat, v.type) ?? 'part of it'}`,
      '`let` only takes apart a value that always matches: a type with one constructor, with names or `_` inside. To handle the other cases, add `else { … }` after it (a step: `let P = e else { other -> … }`), or use `match`.',
    );
  matchPat(c, l.pat, v.type, v.locals);
}

// ---- Exhaustiveness (Maranget, "Warnings for pattern matching", 2007): a value the rows do not match, or null.
// rows: one list of patterns per arm; types: the type of each column. A pattern is a wildcard, a constructor
// of a type with a known set of constructors, or a test that can fail on a type with no such set (a literal,
// a prefix, a function pattern), which never completes a column.

/** A column's type. `states`: it is a machine's column read into a row, and its states are every value it has. */
type Column = Type & { states?: string[] };
/** One of the constructors a column's values are made with, and the columns its fields add. */
type Shape = { name: string; fields: { name: string; type: Column }[] };
/** What a pattern asks of a column: a constructor (with a pattern for some fields), or a test that can fail. */
type Head = { name: string; subs: { fl: { name: string }; pat: Pattern }[] } | { name?: undefined; subs?: undefined };
const WILD: Pattern = { k: 'any', line: 0, file: '' };

/** The constructors of a column's type, when it has a known set of them. */
function shapesOf(c: Ctx, t: Column, at: object): Shape[] | null {
  if (t.states) return t.states.map(s => ({ name: JSON.stringify(s), fields: [] }));
  if (t.name === 'Bool') return ['True', 'False'].map(name => ({ name, fields: [] }));
  const stated = (f: { name: string; type: Type }): Column => {
    const states = c.B.STATES.get(`${t.name}.${f.name}`);
    return states ? { ...f.type, states } : f.type;
  };
  const adt = c.B.adtOrNull(t, at);
  return adt
    ? adt.variants.map(v => ({ name: v.name, fields: v.fields.map(f => ({ name: f.name, type: stated(f) })) }))
    : null;
}

function headOf(c: Ctx, p: Pattern, t: Column, known: boolean): Head | null {
  if (p.k === 'as') return headOf(c, p.pat, t, known);
  if (irrefutable(c, p, t)) return null;
  if (t.states)
    return p.k === 'str' && t.states.includes(text(p.bytes)) ? { name: JSON.stringify(text(p.bytes)), subs: [] } : {};
  if (p.k !== 'ctor' || !known) return {};
  return { name: p.name, subs: t.name === 'Bool' ? [] : ctorOf(c, p, t).subs };
}

/** A value of constructor `s` the rows miss, written out; or null when they cover it. */
function missedIn(
  c: Ctx,
  s: Shape,
  rows: readonly Pattern[][],
  heads: readonly (Head | null)[],
  rest: readonly Column[],
  at: object,
): string[] | null {
  const special = rows.flatMap((r, i) => {
    const h = heads[i];
    if (!h) return [[...s.fields.map(() => WILD), ...r.slice(1)]];
    if (h.name !== s.name) return [];
    return [[...s.fields.map(f => h.subs.find(x => x.fl.name === f.name)?.pat ?? WILD), ...r.slice(1)]];
  });
  const w = uncovered(c, special, [...s.fields.map(f => f.type), ...rest], at);
  if (!w) return null;
  const inner = s.fields.flatMap((f, i) => (w[i] === '_' ? [] : [`${f.name}: ${w[i]}`]));
  return [inner.length > 0 ? `${s.name}(${inner.join(', ')})` : s.name, ...w.slice(s.fields.length)];
}

export function uncovered(c: Ctx, rows: readonly Pattern[][], types: readonly Column[], at: object): string[] | null {
  const [t, ...rest] = types;
  if (!t) return rows.length > 0 ? null : [];
  const shapes = shapesOf(c, t, at);
  const heads = rows.map(r => (r[0] ? headOf(c, r[0], t, shapes !== null) : null));
  const named = (s: Shape): boolean => heads.some(h => h?.name === s.name);
  if (!shapes?.every(named)) {
    // some constructor has no arm of its own: the rows that take any value must cover the rest
    const w = uncovered(
      c,
      rows.filter((_, i) => !heads[i]).map(r => r.slice(1)),
      rest,
      at,
    );
    return w ? [shapes?.find(s => !named(s))?.name ?? '_', ...w] : null;
  }
  for (const s of shapes) {
    const missed = missedIn(c, s, rows, heads, rest, at);
    if (missed) return missed;
  }
  return null;
}

// ---- match

function checkCovered(c: Ctx, e: Match, subject: Stored): void {
  if (!e.subject) return;
  if (c.B.isLinear(subject.type) || CAPABILITIES.includes(subject.type.name))
    fail(
      e,
      'C23',
      `cannot match on a ${key(subject.type)}`,
      c.B.isLinear(subject.type)
        ? 'Match on what you read from it instead; freeze it first for the bytes: `match freeze(buf: out) { … }`.'
        : 'A capability is passed on, not looked into: match on what a call through it answers.',
    );
  const missing = uncovered(
    c,
    e.arms.filter(a => !a.guard).map(a => [a.pat]),
    [subject.type],
    e,
  );
  if (!missing) return;
  fail(
    e,
    'C24',
    `match does not cover ${missing[0]}`,
    missing[0] === '_'
      ? 'Add a last arm `_ -> …`.'
      : 'Add an arm for it, or a last arm `_ -> …`. An arm with `if` does not count: its condition can be false.',
  );
}

/** May the arm take the value apart for good: is this match the only thing that holds it? */
function wholeValue(c: Ctx, subject: Expr): boolean {
  if (!c.B.opts.reuse) return false;
  if (subject.k === 'call' || subject.k === 'ctor') return true;
  const held = subject.k === 'var' ? c.env.get(subject.name) : undefined;
  return subject.k === 'var' && held?.mode === 'owned' && subject.clean === true;
}

/** Matches the subject against an arm's pattern and guard. Gives the room to release when the arm is taken. */
function takeArm(c: Ctx, a: PatArm, expr: Expr, subject: Stored): number | null {
  const whole = wholeValue(c, expr);
  const boxed =
    whole && !BUILTIN_TYPES.has(subject.type.name) && c.B.adtOrNull(c.B.strip(subject.type), a)?.boxed === true;
  c.binderMode = whole ? 'owned' : 'borrowed';
  c.consuming = boxed;
  noConsume(c, a, 'a pattern', () => {
    matchPat(c, a.pat, subject.type, subject.locals);
  });
  c.binderMode = 'borrowed';
  c.consuming = false;
  const taken = boxed && a.pat.k === 'ctor' ? ctorOf(c, a.pat, subject.type) : null;
  const { guard } = a;
  if (guard) {
    noConsume(c, a, 'a guard', () => need(c, c.emit(guard, BOOL, false), BOOL, a, 'the guard'));
    c.code.push(0x45, 0x0d, 0);
  }
  const variant = taken?.adt.boxed ? taken.adt.variants[taken.vi] : undefined;
  return variant ? variant.size : null;
}

/** Writes one arm; gives its body's type, which is the one expected when there is one. */
function emitArm(
  c: Ctx,
  e: Match,
  a: PatArm | CondArm,
  subject: Stored | null,
  expected: Type | null,
  tail: boolean,
): Type {
  const outer = c.env;
  c.env = new Map(c.env);
  open(c, 0x02);
  const id = site(c, 'arm', a);
  ev(c, id, 0);
  let size: number | null = null;
  if ('pat' in a && subject && e.subject) size = takeArm(c, a, e.subject, subject);
  else if (!('pat' in a) && a.cond) {
    const { cond } = a;
    noConsume(c, a, 'a condition', () => need(c, c.emit(cond, BOOL, false), BOOL, a, 'the condition'));
    c.code.push(0x45, 0x0d, 0);
  }
  ev(c, id, 1);
  // nothing else can reach an unshared value matched here: its memory goes to the next value of its size
  if (subject && size !== null) release(c, subject.locals[0] ?? 0, size);
  // the arm runs when its condition held: what that proves holds in its body
  const held = !('pat' in a) && a.cond ? proved(c, a.cond, true) : [];
  const got = withFacts(c, held, () => {
    const t = c.emit(a.body, expected, tail);
    return expected ? need(c, t, expected, a, 'this arm') : t;
  });
  c.code.push(0x0c, 1);
  close(c);
  c.env = outer;
  return got;
}

const endsWithElse = (e: Match): boolean => {
  const last = e.arms.at(-1);
  return !!last && !('pat' in last) && last.else === true;
};
const handedOver = (consumed: ReadonlySet<Binding>): string =>
  [...consumed]
    .map(v => v.name)
    .toSorted()
    .join(',');

/** The first arm of a match that nothing gives a type: a C21 there says how to give it one. */
function typing(e: Match, arm: () => Type): Type {
  try {
    return arm();
  } catch (err) {
    if (!(err instanceof CompileError) || err.info.code !== 'C21') throw err;
    return fail(
      err.info,
      'C21',
      err.info.message,
      `Nothing here says the type of this match (line ${e.line}), so its first arm does, and this one cannot. Put first an arm whose value says it (\`Some(value: …)\` rather than \`None\`), or use the match where a type is expected: a function's result, an argument.`,
    );
  }
}

/**
 * A match is an expression wherever it stands. Its type is the one expected there (a function's result, a
 * parameter); where nothing expects one (`let x = match …`, an operand), it is the first arm's, without a
 * refinement, and every other arm must have it too. The block that holds the value is opened before that type is
 * known, and its type is written in once the first arm has given it.
 */
export function emitMatch(c: Ctx, e: Match, expected: Type | null, tail: boolean): Type {
  const subject = e.subject ? inLocals(c, e.subject) : null;
  if (subject) checkCovered(c, e, subject);
  else if (!endsWithElse(e))
    fail(
      e,
      'C24',
      'a condition match must end with `else -> …`',
      'Add a last arm `else -> …`: a condition match must say what it is when no condition holds.',
    );
  const before = new Set(c.consumed);
  let after: { sig: string; set: Set<Binding> } | null = null;
  let type = expected;
  const opened = c.code.length;
  open(c, 0x02, type ? c.B.slotsOf(type) : []);
  // an arm of a condition match is reached when every condition before it did not hold
  const failed: Fact[] = [];
  for (const a of e.arms) {
    c.consumed = new Set(before);
    withFacts(c, failed, () => {
      const got =
        type === null ? typing(e, () => emitArm(c, e, a, subject, null, tail)) : emitArm(c, e, a, subject, type, tail);
      if (type === null) {
        type = c.B.strip(got);
        c.code.splice(opened + 1, 1, ...blockType(c, c.B.slotsOf(type)));
      }
    });
    if (!('pat' in a) && a.cond) failed.push(...proved(c, a.cond, false));
    const sig = handedOver(c.consumed);
    if (after !== null && after.sig !== sig)
      fail(
        a,
        'C28',
        'this arm hands over different Bufs than the arms before it',
        'Every arm must use the same Bufs, so that each one has exactly one owner afterwards.',
      );
    after = { sig, set: c.consumed };
  }
  c.code.push(0x00);
  close(c);
  if (after) c.consumed = after.set;
  return (
    type ??
    fail(
      e,
      'C99',
      'a match with no arms',
      'This is a compiler bug, not a mistake in the program: please report it with the program that shows it.',
    )
  );
}
