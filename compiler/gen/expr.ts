// compiler/gen/expr.ts: an expression checked and written as Wasm; its type is what the emitter gives back.
import { unreachable } from '../ast.ts';
import type { Arg, Expr, Variant } from '../ast.ts';
import { I32, I64, TRAP, fail, sleb, uleb } from '../common.ts';
import { BOOL, CAPABILITIES, INT, T, VIEW, key } from '../types.ts';
import type { Type } from '../types.ts';
import {
  buildVariant,
  close,
  declare,
  fresh,
  get,
  inLocals,
  loadField,
  mark,
  need,
  noConsume,
  open,
  set,
  store,
  trapIf,
} from './fn.ts';
import type { Binding, CExpr, Ctx } from './fn.ts';
import { closure, emitCall, emitLambda, fnValue } from './call.ts';
import { emitMatch, letPattern } from './match.ts';
import { emitInterp } from './text.ts';

type Of<K extends Expr['k']> = Extract<Expr, { k: K }>;
const didYouMean = (n: string | null, otherwise = ''): string => (n ? `Did you mean \`${n}\`?` : otherwise);

function emitVar(c: Ctx, e: Of<'var'>): Type {
  const { B } = c;
  if (!c.env.has(e.name) && fnValue(c, e.name)) return closure(c, B.find(e.name, c.f.file), []);
  const isFunction = (): string => (B.fns.has(e.name) ? `${e.name} is a function: call it with ${e.name}(...).` : '');
  const v =
    c.env.get(e.name) ??
    fail(e, 'C16', `unknown name ${e.name}`, didYouMean(B.nearest(e.name, [...c.env.keys()]), isFunction()));
  if (B.isLinear(v.type)) {
    if (c.consumed.has(v))
      fail(
        e,
        'C25',
        `${e.name} is used after it was handed over`,
        'A Buf has one owner at a time. Use the value the earlier call returned.',
      );
    c.consumed.add(v);
  }
  if (B.opts.reuse && e.pos !== 'read' && e.pos !== 'subject' && (v.mode === 'borrowed' || !e.clean))
    mark(c, v.type, v.locals);
  for (const l of v.locals) c.code.push(...get(l));
  return v.type;
}

/** `flags.name`: a pinned flag is its value; any other is read from the module's memory. */
function emitFlag(c: Ctx, e: Of<'field'>): Type {
  const { prog, opts } = c.B;
  const i = prog.flags.findIndex(x => x.name === e.name);
  const declareIt = `Declare it at the top of the file: \`flag ${e.name}: Bool = False\`.`;
  const nearest = (): string | null =>
    c.B.nearest(
      e.name,
      prog.flags.map(x => x.name),
    );
  const fl = prog.flags[i] ?? fail(e, 'C37', `unknown flag ${e.name}`, didYouMean(nearest(), declareIt));
  c.B.flagRead.add(fl.name);
  if (Object.hasOwn(opts.pin, fl.name)) {
    const v = opts.pin[fl.name];
    const pinned = typeof v === 'bigint' || typeof v === 'number' ? v : 0;
    const on = typeof v === 'boolean' ? v : pinned !== 0 && pinned !== 0n;
    c.code.push(...(fl.type === 'Int' ? [0x42, ...sleb(pinned)] : [0x41, on ? 1 : 0]));
  } else {
    c.code.push(0x41, ...sleb(c.B.FLAG_BASE + 8 * i), 0x29, 0, 0);
    if (fl.type === 'Bool') c.code.push(0x50, 0x45);
  }
  return fl.type === 'Int' ? INT : BOOL;
}

function emitField(c: Ctx, e: Of<'field'>): Type {
  if (e.e.k === 'var' && e.e.name === 'flags' && !c.env.has('flags')) return emitFlag(c, e);
  const s = inLocals(c, e.e);
  const a = c.B.adtOrNull(s.type, e);
  const [only] = a?.variants ?? [];
  if (!a || !only || a.variants.length !== 1)
    return fail(
      e,
      'C17',
      `${key(s.type)} has no fields to read with a dot`,
      'Only a type with one constructor has fields. For other types, use `match`.',
    );
  const missing = (): never =>
    fail(
      e,
      'C18',
      `${key(s.type)} has no field ${e.name}`,
      `Its fields are ${only.fields.map(x => x.name).join(', ')}.`,
    );
  const boxed = a.boxed ? (a.variants[0]?.fields.find(x => x.name === e.name) ?? missing()) : null;
  const flat = a.boxed ? null : (a.variants[0]?.fields.find(x => x.name === e.name) ?? missing());
  const fieldType = (boxed ?? flat ?? missing()).type;
  const from = boxed ? loadField(c, s.locals[0] ?? 0, boxed) : (flat?.slots.map(i => s.locals[i] ?? 0) ?? []);
  const base = e.e.k === 'var' ? c.env.get(e.e.name) : null;
  // a field leaving a value still held elsewhere is a second reference
  if (c.B.opts.reuse && e.pos !== 'read' && (a.boxed || !base || base.mode === 'borrowed' || !e.clean))
    mark(c, fieldType, from);
  for (const l of from) c.code.push(...get(l));
  return fieldType;
}

function emitIndex(c: Ctx, e: Of<'index'>): Type {
  const s = inLocals(c, e.e);
  need(c, s.type, VIEW, e, 'the value before [');
  need(c, c.emit(e.i, INT, false), INT, e, 'the index');
  const i = fresh(c, I64);
  c.code.push(0x22, ...uleb(i), ...get(s.locals[1] ?? 0), 0xad, 0x5a);
  trapIf(c, TRAP.BOUNDS);
  c.code.push(...get(s.locals[0] ?? 0), ...get(i), 0xa7, 0x6a, 0x2d, 0, 0, 0xad);
  return INT;
}

/** One `let name = value` or `do value` of a block: the name it declares. */
function emitLet(c: Ctx, l: Extract<Of<'block'>['lets'][number], { name: string }>): Binding {
  const type = c.emit(l.value, null, false);
  // `do` drops a number (rows written, a timer's delay, an id). A Result, a Move or an Option has outcomes
  // that would go unseen: those are matched.
  if (l.do && type.name !== 'Int')
    fail(
      l,
      'C82',
      `\`do\` would drop ${key(type)}: ${'name' in l.value ? l.value.name : undefined} has outcomes that must be read`,
      type.name === 'Option'
        ? 'Use sql_exec for a statement whose rows are not read, or match the Option.'
        : 'Match on it (or `let … else`), so each outcome is handled; `do` drops only an Int.',
    );
  if (CAPABILITIES.includes(type.name))
    fail(l, 'C08', 'a capability cannot be bound with let', 'Pass the parameter directly.');
  return declare(c, l.name, type, store(c, type), l);
}

function emitBlock(c: Ctx, e: Of<'block'>, expected: Type | null, tail: boolean): Type {
  const outer = c.env;
  const mine: Binding[] = [];
  c.env = new Map(c.env);
  for (const l of e.lets) {
    if (l.pat) letPattern(c, l);
    else mine.push(emitLet(c, l));
  }
  const type = c.emit(e.result, expected, tail);
  for (const v of mine) {
    if (!c.B.isLinear(v.type)) continue;
    if (!c.consumed.has(v)) fail(e, 'C27', `the Buf ${v.name} is never used`, 'Return it, pass it on, or `freeze` it.');
    c.consumed.delete(v);
  }
  c.env = outer;
  return type;
}

// ---- operators

function emitLogic(c: Ctx, e: Of<'bin'>, op: 'and' | 'or'): Type {
  need(c, c.emit(e.l, BOOL, false), BOOL, e, `the left side of \`${op}\``);
  if (op === 'or') c.code.push(0x45);
  open(c, 0x04, [I32]);
  noConsume(c, e, `\`${op}\``, () => need(c, c.emit(e.r, BOOL, false), BOOL, e, `the right side of \`${op}\``));
  c.code.push(0x05, 0x41, op === 'and' ? 0 : 1);
  close(c);
  return BOOL;
}

const INTO_BUF = 'Put the number in the text, `"… \\(n)"`, or write it into a Buf: `out |> write_int(value: n)`.';
const JOINS = '`++` joins two texts (View).';

// text ++ text: a new View holding both, made by std/core.tape's concat (the same function in a pattern is a prefix)
function emitConcat(c: Ctx, e: Of<'bin'>, lt: Type): Type {
  if (lt.name !== 'View')
    fail(
      e,
      'C19',
      `${key(lt)} values cannot be joined with ++`,
      lt.name === 'Buf' ? 'A Buf grows in place: `out |> append(view: text)`.' : lt.name === 'Int' ? INTO_BUF : JOINS,
    );
  const rt = c.B.strip(c.emit(e.r, VIEW, false));
  if (rt.name !== 'View')
    fail(e, 'C19', `the right side of ++ should be View but is ${key(rt)}`, rt.name === 'Int' ? INTO_BUF : JOINS);
  if (!c.B.fns.has('concat'))
    fail(
      e,
      'C30',
      'the program has no function concat',
      'Joining text with ++ needs std/core.tape: compile it together with your file.',
    );
  c.code.push(0x10, ...uleb(c.B.fnIndex('concat')));
  return VIEW;
}

function emitEquals(c: Ctx, e: Of<'bin'>, lt: Type): Type {
  const { op } = e;
  if (!['Int', 'Bool', 'View'].includes(lt.name))
    fail(e, 'C19', `${key(lt)} values cannot be compared with ${op}`, 'Use `match` to take the value apart.');
  need(c, c.emit(e.r, lt, false), lt, e, `the right side of ${op}`);
  if (lt.name === 'View') c.code.push(0x10, ...uleb(c.B.fnIndex('same')));
  else c.code.push(lt.name === 'Int' ? 0x51 : 0x46);
  if (op === '!=') c.code.push(0x45);
  return BOOL;
}

/** `/` and `%` stop on a zero divisor, and on the one division that does not fit: the least Int by -1. */
function emitDivide(c: Ctx, e: Of<'bin'>): Type {
  const l = fresh(c, I64);
  const r = fresh(c, I64);
  c.code.push(...set(l));
  need(c, c.emit(e.r, INT, false), INT, e, `the right side of ${e.op}`);
  const least = [...get(l), 0x42, ...sleb(-(2n ** 63n)), 0x51];
  const byMinusOne = [...get(r), 0x42, 0x7f, 0x51];
  c.code.push(0x22, ...uleb(r), 0x50, ...least, ...byMinusOne, 0x71, 0x72);
  trapIf(c, TRAP.ARITH);
  c.code.push(...get(l), ...get(r), e.op === '/' ? 0x7f : 0x81);
  return INT;
}

const COMPARE: Readonly<Record<string, number>> = { '<': 0x53, '<=': 0x57, '>': 0x55, '>=': 0x59 };
const ARITHMETIC: Readonly<Record<string, number>> = {
  '+': 0x7c,
  '-': 0x7d,
  '*': 0x7e,
  '&': 0x83,
  '|': 0x84,
  '^': 0x85,
  '<<': 0x86,
  '>>': 0x87,
};

function emitBin(c: Ctx, e: Of<'bin'>): Type {
  const { op } = e;
  if (op === 'and' || op === 'or') return emitLogic(c, e, op);
  const lt = c.B.strip(c.emit(e.l, null, false));
  if (op === '++') return emitConcat(c, e, lt);
  if (op === '==' || op === '!=') return emitEquals(c, e, lt);
  need(c, lt, INT, e, `the left side of ${op}`);
  if (op === '/' || op === '%') return emitDivide(c, e);
  need(c, c.emit(e.r, INT, false), INT, e, `the right side of ${op}`);
  const compare = Object.hasOwn(COMPARE, op) ? COMPARE[op] : undefined;
  const opcode = compare ?? (Object.hasOwn(ARITHMETIC, op) ? ARITHMETIC[op] : undefined);
  if (opcode !== undefined) c.code.push(opcode);
  return compare === undefined ? INT : BOOL;
}

// ---- constructors

/** The fields of a constructor, emitted in order: their types, their locals, and what each type parameter became. */
type Built = { got: Type[]; ls: number[]; bound: Map<string, Type> };

function emitFields(c: Ctx, e: Of<'ctor'>, v: Variant, args: readonly Arg[], type: Type | null): Built {
  const { decl, vi } = c.B.ctors.get(e.name) ?? fail(e, 'C20', `unknown constructor ${e.name}`, '');
  const out: Built = { got: [], ls: [], bound: new Map() };
  v.fields.forEach((fl, i) => {
    const arg = args[i] ?? fail(e, 'C13', `constructor ${e.name} is missing argument ${fl.name}`, '');
    const known = type ? (c.B.adtOf(type, e).variants[vi]?.fields[i]?.type ?? null) : null;
    const t = c.emit(arg.value, known, false);
    const param = decl.params.includes(fl.type.name) && fl.type.args.length === 0 ? fl.type.name : null;
    const first = param === null ? undefined : out.bound.get(param);
    if (known) need(c, t, known, arg, `field ${fl.name}`);
    else if (first) need(c, t, first, arg, `field ${fl.name}`);
    else if (param !== null) out.bound.set(param, t);
    const kept = store(c, t);
    out.got.push(t);
    out.ls.push(...kept);
    if (!decl.boxed && decl.variants.length > 1) mark(c, t, kept);
  });
  return out;
}

function emitCtor(c: Ctx, e: Of<'ctor'>, expected: Type | null): Type {
  const { B } = c;
  if (e.name === 'True' || e.name === 'False') {
    if (e.args.length > 0) fail(e, 'C11', `${e.name} takes no arguments`, '');
    c.code.push(0x41, e.name === 'True' ? 1 : 0);
    return BOOL;
  }
  if (B.types.get(e.name)?.refine)
    fail(
      e,
      'C36',
      `a ${e.name} cannot be built directly`,
      `${e.name} is a refined type: a value becomes one by matching the pattern \`${e.name}(name)\`, which checks its condition.`,
    );
  const { decl, vi } =
    B.ctors.get(e.name) ??
    fail(e, 'C20', `unknown constructor ${e.name}`, didYouMean(B.nearest(e.name, [...B.ctors.keys()])));
  const v = decl.variants[vi] ?? fail(e, 'C20', `unknown constructor ${e.name}`, '');
  const given = decl.params.length === 0 ? T(decl.name) : expected?.name === decl.name ? expected : null;
  const args = B.orderArgs(
    `constructor ${e.name}`,
    v.fields.map(x => x.name),
    e.args,
    e,
  );
  const { got, ls, bound } = emitFields(c, e, v, args, given);
  const type = given ?? inferred(c, e, bound);
  if (!given)
    B.adtOf(type, e).variants[vi]?.fields.forEach((fl, i) => {
      need(c, got[i] ?? fl.type, fl.type, args[i], `field ${fl.name}`);
    });
  buildVariant(c, B.adtOf(type, e), vi, ls);
  return type;
}

/** The type of a constructor of a generic type, from what its fields turned out to be. */
function inferred(c: Ctx, e: Of<'ctor'>, bound: ReadonlyMap<string, Type>): Type {
  const decl = c.B.ctors.get(e.name)?.decl ?? fail(e, 'C20', `unknown constructor ${e.name}`, '');
  const args = decl.params.map(
    pm =>
      bound.get(pm) ??
      fail(
        e,
        'C21',
        `cannot tell which ${decl.name} this ${e.name} is`,
        `Use it where a ${decl.name}[…] is expected: as an argument, or as a function's result.`,
      ),
  );
  return T(decl.name, ...args);
}

/** Writes an expression's code; gives its type. `tail`: its value is the function's result. */
export function emit(c: Ctx, e: CExpr, expected: Type | null, tail: boolean): Type {
  switch (e.k) {
    case 'int':
      c.code.push(0x42, ...sleb(e.v));
      return INT;
    case 'str': {
      const [at, n] = c.B.literal(e.bytes);
      c.code.push(0x41, ...sleb(at), 0x41, ...sleb(n));
      return VIEW;
    }
    case 'interp':
      return emitInterp(c, e);
    case 'held':
      for (const l of e.held.locals) c.code.push(...get(l));
      return e.held.type;
    case 'lambda':
      return emitLambda(c, e);
    case 'var':
      return emitVar(c, e);
    case 'neg':
      if (e.e.k === 'int') {
        c.code.push(0x42, ...sleb(-e.e.v));
        return INT;
      }
      c.code.push(0x42, 0);
      need(c, c.emit(e.e, INT, false), INT, e, 'the operand of -');
      c.code.push(0x7d);
      return INT;
    case 'not':
      need(c, c.emit(e.e, BOOL, false), BOOL, e, 'the operand of `not`');
      c.code.push(0x45);
      return BOOL;
    case 'bin':
      return emitBin(c, e);
    case 'field':
      return emitField(c, e);
    case 'index':
      return emitIndex(c, e);
    case 'ctor':
      return emitCtor(c, e, expected);
    case 'call':
      return emitCall(c, e, expected, tail);
    case 'match':
      return emitMatch(c, e, expected, tail);
    case 'block':
      return emitBlock(c, e, expected, tail);
    default:
      return unreachable(e, 'expression');
  }
}
