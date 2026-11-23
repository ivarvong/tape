// interp/eval.ts: what an expression is worth. The program is walked as parsed: every switch over a kind of
// expression, pattern or operator is exhaustive.
import {
  type Arg,
  type Call,
  type Expr,
  type Param,
  type FnDecl,
  type Pattern,
  type Program,
  type TypeAst,
  unreachable,
} from '../compiler/ast.ts';
import { TRAP } from '../compiler/common.ts';
import { refinedPattern } from '../compiler/shadow.ts';
import { type Host, Trap } from './host.ts';
import { Unsupported } from './json.ts';
import { finite, floatArithmetic, mathFn, truncToInt } from './float.ts';
import {
  type Env,
  type Fn,
  type Value,
  adt,
  asAdt,
  asBool,
  asBuf,
  asBytes,
  asFloat,
  asInt,
  isFn,
  sameBytes,
  wrap,
} from './value.ts';

/** One run of a program: the program, where its effects go, and whether it has asked for its writes to be undone. */
export type Interp = {
  readonly prog: Program;
  readonly host: Partial<Host> | null;
  undone: boolean;
  /** a call of a name that is no function of the program and no intrinsic: an effect, or nothing known */
  readonly effect: (name: string, e: Call, env: Env, file: string) => Value;
};
/** A call in tail position, handed back to the loop in `run` so that a long recursion does not grow the stack. */
class Tail {
  readonly fn: Fn;
  readonly args: Value[];
  constructor(fn: Fn, args: Value[]) {
    this.fn = fn;
    this.args = args;
  }
}
const MIN = -(2n ** 63n),
  MAX = 2n ** 63n - 1n;
/** An Int result: the exact value, which must be within 64 bits, or the run stops (integer overflow). */
const fit = (x: bigint): bigint => {
  if (x < MIN || x > MAX) throw new Trap(TRAP.OVERFLOW);
  return x;
};
const enc = new TextEncoder();
const stemOf = (f: string): string => f.replace(/^.*\//, '').replace(/\.tape$/, '');
export const stop = (message: string): never => {
  throw new Error(message);
};

// ---- names and calls
/** The function a name means in a file: the file's own, the only one of that name, or `file.name`. */
export function find(it: Interp, name: string, file: string): FnDecl | null {
  const { prog } = it,
    own = prog.byFile.get(file)?.get(name),
    all = prog.defs.get(name),
    [only] = all ?? [],
    dot = name.indexOf('.');
  if (own) return prog.fns.get(own) ?? null;
  if (only && all?.length === 1) return prog.fns.get(only.key) ?? null;
  if (all) return stop(`${name} is defined in more than one file`);
  if (dot <= 0) return null;
  for (const [other, names] of prog.byFile) {
    const known = stemOf(other) === name.slice(0, dot) ? names.get(name.slice(dot + 1)) : undefined;
    if (known) return prog.fns.get(known) ?? null;
  }
  return null;
}
export const callable = (g: FnDecl): Fn => ({
  k: 'fn',
  params: g.params.map(p => p.name),
  body: g.body,
  file: g.file,
  env: null,
});
export function run(it: Interp, fn: Fn, args: Value[]): Value {
  for (let next = new Tail(fn, args); ;) {
    const env: Env = new Map(next.fn.env ?? []);
    next.fn.params.forEach((p, i) => {
      env.set(p, next.args[i] ?? stop(`missing argument ${p}`));
    });
    const r = step(it, next.fn.body, env, next.fn.file, true);
    if (!(r instanceof Tail)) return r;
    next = r;
  }
}
// the argument for a parameter: by its label, or the only one there is
const pickArg = (args: Arg[], name: string, only: boolean): Arg =>
  args.find(a => a.label === name) ?? (only ? args[0] : undefined) ?? stop(`missing argument ${name}`);
/** A function's arguments in the order of its parameters. With one written parameter (the capabilities the
 * compiler added do not count), the one argument that names no parameter is that parameter's. */
const fnArgs = (args: Arg[], params: readonly Param[]): Arg[] => {
  const written = params.filter(pm => !pm.implicit),
    [one] = written;
  return params.map(
    pm =>
      args.find(a => a.label === pm.name) ??
      (written.length === 1 && pm === one ? args.find(a => !params.some(q => q.name === a.label)) : undefined) ??
      stop(`missing argument ${pm.name}`),
  );
};
export function ev(it: Interp, e: Expr, env: Env, file: string): Value {
  const r = step(it, e, env, file, false);
  return r instanceof Tail ? stop('a tail call outside tail position') : r;
}
const selfIs = (it: Interp, pred: Expr, v: Value, file: string): boolean =>
  asBool(ev(it, pred, new Map([['self', v]]), file));
/** Does v meet every condition of type t? A refined type of a refined type meets both. */
export function meets(it: Interp, t: TypeAst, v: Value, file: string): boolean {
  const refine = it.prog.types.get(t.name)?.refine;
  return !refine || (selfIs(it, refine.pred, v, file) && meets(it, refine.base, v, file));
}

// ---- operators and intrinsics
type Bin = Extract<Expr, { k: 'bin' }>;
const equal = (l: Value, r: Value): boolean => (l instanceof Uint8Array ? sameBytes(l, asBytes(r)) : l === r);
const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};
// arithmetic on 64-bit integers: computed exactly, and a result outside 64 bits stops the run. Division stops on
// zero, and `%` wherever `/` stops (the least Int by -1 too, though its remainder, 0, would fit). Bitwise
// operators work on the 64 bits; a shift amount must be 0 to 63, and a left shift drops the bits it moves out.
type Arithmetic = '+' | '-' | '*' | '/' | '%' | '&' | '|' | '^' | '<<' | '>>';
function arithmetic(op: Arithmetic, l: bigint, r: bigint): bigint {
  switch (op) {
    case '+':
      return fit(l + r);
    case '-':
      return fit(l - r);
    case '*':
      return fit(l * r);
    case '/':
    case '%':
      if (r === 0n) throw new Trap(TRAP.DIVISION);
      fit(l / r);
      return op === '/' ? l / r : l % r;
    case '&':
      return l & r;
    case '|':
      return l | r;
    case '^':
      return l ^ r;
    case '<<':
    case '>>':
      if (r < 0n || r > 63n) throw new Trap(TRAP.SHIFT);
      return op === '<<' ? wrap(l << r) : l >> r;
    default:
      return unreachable(op, 'operator');
  }
}
function binary(it: Interp, e: Bin, env: Env, file: string): Value {
  if (e.op === 'and') return asBool(ev(it, e.l, env, file)) && asBool(ev(it, e.r, env, file));
  if (e.op === 'or') return asBool(ev(it, e.l, env, file)) || asBool(ev(it, e.r, env, file));
  const l = ev(it, e.l, env, file),
    r = ev(it, e.r, env, file);
  if (typeof l === 'number') return floatBinary(e.op, l, asFloat(r));
  switch (e.op) {
    case '++':
      return concat(asBytes(l), asBytes(r));
    case '==':
      return equal(l, r);
    case '!=':
      return !equal(l, r);
    case '<':
      return asInt(l) < asInt(r);
    case '<=':
      return asInt(l) <= asInt(r);
    case '>':
      return asInt(l) > asInt(r);
    case '>=':
      return asInt(l) >= asInt(r);
    default:
      return arithmetic(e.op, asInt(l), asInt(r));
  }
}
function floatBinary(op: Bin['op'], l: number, r: number): Value {
  switch (op) {
    case '==':
      return l === r;
    case '!=':
      return l !== r;
    case '<':
      return l < r;
    case '<=':
      return l <= r;
    case '>':
      return l > r;
    case '>=':
      return l >= r;
    case '+':
    case '-':
    case '*':
    case '/':
      return floatArithmetic(op, l, r);
    default:
      return stop(`Float has no ${op}`);
  }
}
const INTRINSIC = {
  len: ['v'],
  slice: ['v', 'from', 'to'],
  buf: [],
  push: ['buf', 'byte'],
  append: ['buf', 'view'],
  freeze: ['buf'],
  size: ['buf'],
  wrapping_add: ['a', 'b'],
  wrapping_sub: ['a', 'b'],
  wrapping_mul: ['a', 'b'],
  float: ['n'],
  trunc: ['x'],
  floor: ['x'],
  ceil: ['x'],
  sqrt: ['x'],
  abs: ['x'],
  min: ['a', 'b'],
  max: ['a', 'b'],
  sin: ['x'],
  cos: ['x'],
  atan2: ['y', 'x'],
  exp: ['x'],
  log: ['x'],
  pow: ['x', 'y'],
} as const satisfies Record<string, readonly string[]>;
type Intrinsic = keyof typeof INTRINSIC;
const isIntrinsic = (name: string): name is Intrinsic => Object.hasOwn(INTRINSIC, name);
function intrinsic(name: Intrinsic, a: Value[]): Value {
  switch (name) {
    case 'len':
      return BigInt(asBytes(a[0]).length);
    case 'slice': {
      const v = asBytes(a[0]),
        from = asInt(a[1]),
        to = asInt(a[2]);
      if (from < 0n || to < 0n || from > to || to > BigInt(v.length)) throw new Trap(TRAP.BOUNDS);
      return v.subarray(Number(from), Number(to));
    }
    case 'buf':
      return { k: 'buf', buf: [] };
    case 'push': {
      const out = asBuf(a[0]),
        byte = asInt(a[1]);
      if (byte < 0n || byte > 255n) throw new Trap(TRAP.BOUNDS);
      out.buf.push(Number(byte));
      return out;
    }
    case 'append': {
      const out = asBuf(a[0]);
      for (const b of asBytes(a[1])) out.buf.push(b);
      return out;
    }
    case 'freeze':
      return Uint8Array.from(asBuf(a[0]).buf);
    case 'size':
      return BigInt(asBuf(a[0]).buf.length);
    // the low 64 bits of the exact result, read as a signed number
    case 'wrapping_add':
      return wrap(asInt(a[0]) + asInt(a[1]));
    case 'wrapping_sub':
      return wrap(asInt(a[0]) - asInt(a[1]));
    case 'wrapping_mul':
      return wrap(asInt(a[0]) * asInt(a[1]));
    // the Float nearest the Int, a tie to the even one: ECMA-262's Number of a BigInt is correctly rounded
    case 'float':
      return Number(asInt(a[0]));
    case 'trunc':
      return truncToInt(asFloat(a[0]));
    // exact in ECMA-262, as IEEE 754 defines them
    case 'floor':
      return Math.floor(asFloat(a[0]));
    case 'ceil':
      return Math.ceil(asFloat(a[0]));
    case 'sqrt':
      return finite(Math.sqrt(asFloat(a[0])));
    case 'abs': {
      const x = a[0];
      if (typeof x === 'number') return Math.abs(x);
      return fit(asInt(x) < 0n ? -asInt(x) : asInt(x));
    }
    // Math.min and Math.max order -0 below 0, as Wasm's f64.min and f64.max do
    case 'min':
    case 'max': {
      const [x, y] = a;
      if (typeof x === 'number') return name === 'min' ? Math.min(x, asFloat(y)) : Math.max(x, asFloat(y));
      const p = asInt(x),
        q = asInt(y);
      return (name === 'min' ? q < p : q > p) ? q : p;
    }
    // the compiled module's own functions (compiler/math), run in a module of their own: not an independent check,
    // so test/float-math.ts holds them to musl and to an oracle
    case 'sin':
    case 'cos':
    case 'exp':
    case 'log':
      return finite(mathFn(name)(asFloat(a[0])));
    case 'atan2':
    case 'pow':
      return finite(mathFn(name)(asFloat(a[0]), asFloat(a[1])));
    default:
      return unreachable(name, 'intrinsic');
  }
}

// ---- expressions
type Of<K extends Expr['k']> = Extract<Expr, { k: K }>;
function field(it: Interp, e: Of<'field'>, env: Env, file: string): Value {
  if (e.e.k === 'var' && e.e.name === 'flags' && !env.has('flags')) {
    const flags = (it.host ?? fail(new Unsupported('flags'))).flags,
      v = flags?.[e.name] ?? stop(`no flag ${e.name}`);
    return typeof v === 'string' ? enc.encode(v) : typeof v === 'boolean' ? v : BigInt(v);
  }
  const of = asAdt(ev(it, e.e, env, file));
  return of.f[e.name] ?? stop(`${of.c} has no field ${e.name}`);
}
const fail = (err: Error): never => {
  throw err;
};
function call(it: Interp, e: Call, env: Env, file: string, tail: boolean): Value | Tail {
  // a call names a function unless the local of that name is one (a function value)
  const local = env.get(e.name);
  if (isFn(local)) {
    const args = e.args.map(a => ev(it, a.value, env, file));
    return tail ? new Tail(local, args) : run(it, local, args);
  }
  if (isIntrinsic(e.name)) {
    const names: readonly string[] = INTRINSIC[e.name];
    return intrinsic(
      e.name,
      names.map(n => ev(it, pickArg(e.args, n, names.length === 1).value, env, file)),
    );
  }
  const g = find(it, e.name, file);
  if (!g) return it.effect(e.name, e, env, file);
  const args = fnArgs(e.args, g.params).map(a => ev(it, a.value, env, file)),
    fn = callable(g);
  return tail ? new Tail(fn, args) : run(it, fn, args);
}
// a name that is no local: a function of the program, as a value
function named(it: Interp, name: string, file: string): Value {
  const g = find(it, name, file);
  return g ? callable(g) : stop(`unknown name ${name}`);
}
function construct(it: Interp, e: Of<'ctor'>, env: Env, file: string): Value {
  if (e.name === 'True') return true;
  if (e.name === 'False') return false;
  const c = it.prog.ctors.get(e.name),
    fields = c?.decl.variants[c.vi]?.fields ?? stop(`unknown constructor ${e.name}`);
  return adt(
    e.name,
    Object.fromEntries(
      fields.map(fl => [fl.name, ev(it, pickArg(e.args, fl.name, fields.length === 1).value, env, file)]),
    ),
  );
}
function blockOf(it: Interp, e: Of<'block'>, env: Env, file: string, tail: boolean): Value | Tail {
  for (const l of e.lets) {
    const v = ev(it, l.value, env, file);
    if (!l.pat) env.set(l.name, v);
    else if (!match(it, l.pat, v, env, file)) return stop('let pattern did not match');
  }
  return step(it, e.result, env, file, tail);
}
function matchOf(it: Interp, e: Of<'match'>, env: Env, file: string, tail: boolean): Value | Tail {
  if (e.subject) {
    const v = ev(it, e.subject, env, file);
    for (const a of e.arms)
      if (match(it, a.pat, v, env, file) && (!a.guard || asBool(ev(it, a.guard, env, file))))
        return step(it, a.body, env, file, tail);
  } else
    for (const a of e.arms) if (a.else || asBool(ev(it, a.cond, env, file))) return step(it, a.body, env, file, tail);
  return stop('no arm matched');
}
function step(it: Interp, e: Expr, env: Env, file: string, tail: boolean): Value | Tail {
  switch (e.k) {
    case 'int':
      return fit(e.v);
    case 'float':
      return e.v;
    case 'str':
      return Uint8Array.from(e.bytes);
    case 'interp':
      // each hole in turn: text as it is, an Int in decimal, a Float in the shortest digits that read back as it
      // (ECMA-262 Number::toString, as the host's float_text)
      return Uint8Array.from(
        e.parts.flatMap(part => {
          const v = ev(it, part, env, file);
          return [
            ...(typeof v === 'bigint'
              ? enc.encode(String(v))
              : typeof v === 'number'
                ? enc.encode(String(v))
                : asBytes(v)),
          ];
        }),
      );
    case 'var':
      return env.get(e.name) ?? named(it, e.name, file);
    case 'field':
      return field(it, e, env, file);
    case 'index': {
      const v = asBytes(ev(it, e.e, env, file)),
        i = asInt(ev(it, e.i, env, file)),
        byte = i < 0n ? undefined : v[Number(i)];
      if (byte === undefined) throw new Trap(TRAP.BOUNDS);
      return BigInt(byte);
    }
    case 'neg': {
      const v = ev(it, e.e, env, file);
      return typeof v === 'number' ? -v : fit(-asInt(v));
    }
    case 'not':
      return !asBool(ev(it, e.e, env, file));
    case 'bin':
      return binary(it, e, env, file);
    case 'call':
      return call(it, e, env, file, tail);
    case 'ctor':
      return construct(it, e, env, file);
    case 'lambda':
      return { k: 'fn', params: e.params.map(p => p.name), body: e.body, file: e.file, env };
    case 'block':
      return blockOf(it, e, env, file, tail);
    case 'match':
      return matchOf(it, e, env, file, tail);
    case 'held':
      throw new Error('a held value is made by the compiler, never written in a program');
    default:
      return unreachable(e, 'expression');
  }
}

// ---- patterns: does v match p? The names p binds are set in env as it goes.
type OfPat<K extends Pattern['k']> = Extract<Pattern, { k: K }>;
function matchText(
  it: Interp,
  p: OfPat<'prefix' | 'suffix' | 'split'>,
  t: Uint8Array,
  env: Env,
  file: string,
): boolean {
  const n = p.bytes.length;
  if (p.k === 'prefix')
    return t.length >= n && sameBytes(t.subarray(0, n), p.bytes) && match(it, p.rest, t.subarray(n), env, file);
  if (p.k === 'suffix') {
    const at = t.length - n;
    return at >= 0 && sameBytes(t.subarray(at), p.bytes) && match(it, p.head, t.subarray(0, at), env, file);
  }
  // split: at the first place the separator stands
  for (let i = 0; i + n <= t.length; i++)
    if (sameBytes(t.subarray(i, i + n), p.bytes))
      return match(it, p.head, t.subarray(0, i), env, file) && match(it, p.rest, t.subarray(i + n), env, file);
  return false;
}
function matchCtor(it: Interp, p: OfPat<'ctor'>, v: Value, env: Env, file: string): boolean {
  if (p.name === 'True' || p.name === 'False') return v === (p.name === 'True');
  const refined = refinedPattern(it.prog, p.name, file)?.refine;
  if (refined) return selfIs(it, refined.pred, v, file) && p.subs.every(s => match(it, s.pat, v, env, file));
  const of = asAdt(v);
  if (of.c !== p.name) return false;
  const fields = Object.keys(of.f),
    only = fields.length === 1 && p.subs.length === 1 ? fields[0] : undefined;
  // `Some(x)`: with one field and one name, the name stands for the field whatever it is called
  return p.subs.every(s => {
    const name = only !== undefined && s.pun && !(s.field in of.f) ? only : s.field;
    return match(it, s.pat, of.f[name] ?? stop(`${of.c} has no field ${name}`), env, file);
  });
}
export function match(it: Interp, p: Pattern, v: Value, env: Env, file: string): boolean {
  switch (p.k) {
    case 'any':
      return true;
    case 'bind':
      env.set(p.name, v);
      return true;
    case 'as':
      if (!match(it, p.pat, v, env, file)) return false;
      env.set(p.name, v);
      return true;
    case 'int':
      return v === p.v;
    case 'str':
      return sameBytes(asBytes(v), p.bytes);
    case 'prefix':
    case 'suffix':
    case 'split':
      return matchText(it, p, asBytes(v), env, file);
    case 'fn': {
      // `decimal(n)`: the function gives Some, and what is in it matches
      const g = find(it, p.name, file) ?? fail(new Unsupported(p.name)),
        r = asAdt(run(it, callable(g), [v])),
        inner = r.f['value'];
      return r.c === 'Some' && inner !== undefined && match(it, p.sub, inner, env, file);
    }
    case 'ctor':
      return matchCtor(it, p, v, env, file);
    default:
      return unreachable(p, 'pattern');
  }
}
