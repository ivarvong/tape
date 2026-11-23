// compiler/gen/call.ts: calls. A generic function has one compiled copy per set of type arguments; a function
// used as a value is two i32s: a slot in the module's table, and a pointer to the captured values (0 when there
// are none). Each (function, number of captured parameters) has one small entry function that loads the captured
// values and calls the real one.
import { eachExpr } from '../ast.ts';
import type { At, Call, Expr, FnDecl, Interface, TypeAst } from '../ast.ts';
import { I32, I64, fail, sleb, uleb, utf8 } from '../common.ts';
import { ROW_CALLS } from '../rows.ts';
import { BOOL, CAPABILITIES, INT, INTRINSICS, T, VIEW, key } from '../types.ts';
import type { Type } from '../types.ts';
import { fresh, get, mark, need, set } from './fn.ts';
import type { Binding, Build, CExpr, Ctx, Stored } from './fn.ts';
import type { Compiled } from './assemble.ts';
import { emitCallOut } from './callout.ts';
import { emitIntrinsic } from './intrinsic.ts';

type Lambda = Extract<Expr, { k: 'lambda' }>;
type Bind = Map<string, Type>;
const typeOf = (pm: { name: string; type?: Type }, at: object): Type =>
  pm.type ??
  fail(
    at,
    'C99',
    `the type of ${pm.name} is not known yet`,
    'This is a compiler bug, not a mistake in the program: please report it with the program that shows it.',
  );
const retOf = (g: FnDecl): Type =>
  g.ret ??
  fail(
    g,
    'C99',
    `the result type of ${g.name} is not known yet`,
    'This is a compiler bug, not a mistake in the program: please report it with the program that shows it.',
  );
const asAst = (t: Type, at: At): TypeAst => ({
  name: t.name,
  args: t.args.map(a => asAst(a, at)),
  line: at.line,
  file: at.file,
});

// ---- generic functions
// Type arguments come from the expected result type and from arguments whose type is known without context.
function unify(vars: readonly string[], bind: Bind, pat: Type, t: Type | null | undefined): void {
  if (!t) return;
  if (vars.includes(pat.name) && pat.args.length === 0) {
    if (!bind.has(pat.name)) bind.set(pat.name, t);
    return;
  }
  if (pat.name === t.name) pat.args.forEach((a, i) => unify(vars, bind, a, t.args[i]));
}

export const fnType = (params: readonly Type[], ret: Type): Type | null => {
  const [a, b] = params;
  if (params.length === 1 && a) return T('Fn', a, ret);
  return params.length === 2 && a && b ? T('Fn2', a, b, ret) : null;
};
/** Can the function of this name be used as a value: not generic, one or two parameters? */
export function fnValue(c: Ctx, n: string): boolean {
  const g = c.B.find(n, c.f.file);
  return !!g && !g.trampoline && g.tparams.length === 0 && (g.params.length === 1 || g.params.length === 2);
}

const ROW_RESULT: Readonly<Record<string, string>> = { sql_all: 'Rows', sql_first: 'Option', sql_move: 'Move' };

/** The result type of a call, when its arguments say what the callee's type parameters are. */
function peekCall(c: Ctx, e: Call): Type | null {
  // a query's result is named by its row type: Rows[R], Option[R], Move[R]
  if (ROW_CALLS.has(e.name)) {
    const r = e.args.find(x => x.label === 'row')?.value;
    return r?.k === 'ctor' && c.B.types.has(r.name) ? T(ROW_RESULT[e.name] ?? '', T(r.name)) : null;
  }
  if (INTRINSICS.has(e.name)) return null;
  const g = c.B.find(e.name, c.f.file, e);
  if (!g) return null;
  if (g.tparams.length === 0) return g.ret ?? null;
  const bind: Bind = new Map();
  for (const a of e.args) {
    const pm = g.params.find(x => x.name === a.label) ?? (g.params.length === 1 ? g.params[0] : null);
    if (pm) unify(g.tparams, bind, pm.typeAst, peek(c, a.value));
  }
  return g.tparams.every(t => bind.has(t)) ? c.B.resolve(g.retAst, bind) : null;
}

function peekCtor(c: Ctx, e: Extract<Expr, { k: 'ctor' }>): Type | null {
  if (e.name === 'True' || e.name === 'False') return BOOL;
  const made = c.B.ctors.get(e.name);
  if (!made || c.B.types.get(e.name)?.refine) return null;
  const { decl } = made;
  const bind: Bind = new Map();
  const fields = decl.variants[made.vi]?.fields ?? [];
  for (const a of e.args) {
    const fl = fields.find(x => x.name === a.label) ?? (fields.length === 1 ? fields[0] : null);
    if (fl) unify(decl.params, bind, fl.type, peek(c, a.value));
  }
  const args = decl.params.flatMap(t => bind.get(t) ?? []);
  return args.length === decl.params.length ? T(decl.name, ...args) : null;
}

/** The type of an expression where it can be told without compiling it, or null. */
export function peek(c: Ctx, e: CExpr): Type | null {
  const { B } = c;
  if (e.k === 'var') {
    const known = c.env.get(e.name)?.type;
    if (known || !fnValue(c, e.name)) return known ?? null;
    const g = B.find(e.name, c.f.file);
    return g
      ? fnType(
          g.params.map(pm => typeOf(pm, e)),
          retOf(g),
        )
      : null;
  }
  if (e.k === 'lambda')
    return fnType(
      e.params.map(pm => B.resolve(pm.typeAst)),
      B.resolve(e.retAst),
    );
  if (e.k === 'held') return e.held.type;
  if (e.k === 'field') {
    const base = e.e.k === 'var' ? c.env.get(e.e.name) : undefined;
    if (!base) return null;
    const a = B.adtOrNull(B.strip(base.type), e);
    const [only] = a?.variants ?? [];
    return a?.variants.length === 1 ? (only?.fields.find(x => x.name === e.name)?.type ?? null) : null;
  }
  if (e.k === 'int') return INT;
  if (e.k === 'str') return VIEW;
  if (e.k === 'call') return peekCall(c, e);
  return e.k === 'ctor' ? peekCtor(c, e) : null;
}

/** The copy of a generic function for the type arguments this call gives it; made the first time. */
export function instance(
  c: Ctx,
  g: FnDecl,
  args: readonly { value: Expr }[],
  expected: Type | null,
  at: object,
): FnDecl {
  const { B } = c;
  const bind: Bind = new Map();
  if (expected) unify(g.tparams, bind, g.retAst, expected);
  g.params.forEach((pm, i) => {
    const arg = args[i];
    if (arg) unify(g.tparams, bind, pm.typeAst, peek(c, arg.value));
  });
  const open = g.tparams.find(t => !bind.has(t));
  if (open !== undefined)
    fail(
      at,
      'C43',
      `cannot tell what ${open} is in this call to ${g.name}`,
      `${g.name} works for any ${open}. Bind an argument with \`let\` first, or pass the result to a function whose parameter type says what it is.`,
    );
  const name = `${g.name}[${g.tparams.map(t => key(bind.get(t) ?? T(t))).join(', ')}]`;
  const had = B.fns.get(name);
  if (had) return had;
  const made: FnDecl = {
    ...g,
    name,
    tparams: [],
    base: g.name,
    params: g.params.map(pm => ({ name: pm.name, typeAst: pm.typeAst, type: B.resolve(pm.typeAst, bind) })),
    ret: B.resolve(g.retAst, bind),
  };
  B.fns.set(name, made);
  B.callsOf.set(name, new Set([...(B.callsOf.get(g.name) ?? []), name]));
  return made;
}

// ---- functions as values

/** The entry function of a function value: (captured values' pointer, arguments...) -> result. */
export function compileEntry(B: Build, f: FnDecl & { trampoline: { g: FnDecl; k: number } }): Compiled {
  const { g, k } = f.trampoline;
  const code: number[] = [];
  let off = 0;
  for (const pm of g.params.slice(0, k))
    for (const vt of B.slotsOf(typeOf(pm, g))) {
      code.push(0x20, 0, vt === I64 ? 0x29 : 0x28, vt === I64 ? 3 : 2, ...uleb(off));
      off += 8;
    }
  const passed = g.params.slice(k).flatMap(pm => B.slotsOf(typeOf(pm, g)));
  code.push(...passed.flatMap((_, i) => [0x20, ...uleb(i + 1)]), 0x10, ...uleb(B.fnIndex(g.name)), 0x0b);
  return { sig: B.sig([I32, ...passed], B.slotsOf(retOf(g))), body: [0, ...code] };
}

/** Writes the captured values into new room and leaves its pointer on the stack. */
function capture(c: Ctx, captured: readonly Stored[]): void {
  const at = fresh(c, I32);
  const words = captured.reduce((n, v) => n + v.locals.length, 0);
  c.code.push(0x41, ...sleb(8 * words), 0x10, ...uleb(c.B.ALLOC), ...set(at));
  for (const v of captured) mark(c, v.type, v.locals);
  const words8 = captured.flatMap(v => v.locals.map((l, i) => ({ l, wide: c.B.slotsOf(v.type)[i] === I64 })));
  words8.forEach(({ l, wide }, n) => {
    c.code.push(...get(at), ...get(l), wide ? 0x37 : 0x36, wide ? 3 : 2, ...uleb(8 * n));
  });
  c.code.push(...get(at));
}

/** The value of function g with its first parameters captured: its table slot and the captured values. */
export function closure(c: Ctx, g: FnDecl | null, captured: readonly Stored[]): Type {
  const { B } = c;
  if (!g)
    return fail(
      c.f,
      'C99',
      'a function value of no function',
      'This is a compiler bug, not a mistake in the program: please report it with the program that shows it.',
    );
  const k = captured.length;
  const tr = `&${g.name}/${k}`;
  if (!B.fns.has(tr)) {
    B.fns.set(tr, { ...g, name: tr, exported: false, trampoline: { g, k }, params: [], tparams: [], ret: retOf(g) });
    B.callsOf.set(tr, new Set([g.name]));
  }
  const had = B.table.indexOf(tr);
  const slot = had < 0 ? B.table.push(tr) - 1 : had;
  B.fnIndex(tr);
  c.code.push(0x41, ...sleb(slot));
  if (k === 0) c.code.push(0x41, 0);
  else capture(c, captured);
  return (
    fnType(
      g.params.slice(k).map(pm => typeOf(pm, g)),
      retOf(g),
    ) ??
    fail(
      g,
      'C44',
      'a function value takes one or two parameters',
      'Pass a function of one or two parameters, or wrap it in one: `fn(x: Int) -> Int { f(x, y: 1) }`.',
    )
  );
}

/** The names of the enclosing function a function value uses, in the order it first uses them. */
function capturedBy(c: Ctx, e: Lambda): Binding[] {
  const own = new Set(e.params.map(pm => pm.name));
  const seen = new Set<string>();
  const captured: Binding[] = [];
  eachExpr(e.body, x => {
    if (x.k !== 'var' && x.k !== 'call') return;
    const v = c.env.get(x.name);
    if (!v || own.has(x.name) || seen.has(x.name)) return;
    seen.add(x.name);
    captured.push(v);
  });
  return captured;
}

function checkCaptured(c: Ctx, e: Lambda, captured: readonly Binding[]): void {
  for (const pm of e.params)
    if (c.env.has(pm.name))
      fail(e, 'C09', `${pm.name} is already a name here`, 'Names are never reused in a function. Pick another.');
  for (const v of captured) {
    const linear = c.B.isLinear(v.type);
    if (linear || CAPABILITIES.includes(v.type.name))
      fail(
        e,
        'C44',
        `a function value cannot capture ${v.name}, a ${key(v.type)}`,
        linear
          ? 'A Buf has one owner. Pass it as a parameter and return it.'
          : 'A capability is passed where it is used, so the call that uses it shows it. Make it a parameter of a named function.',
      );
    if (c.consumed.has(v))
      fail(
        e,
        'C25',
        `${v.name} is used after it was handed over`,
        'A Buf has one owner at a time. Use the value the earlier call returned.',
      );
  }
}

/** `fn(x: T) -> U { … }`: a function of its own, whose first parameters are the names it captures. */
export function emitLambda(c: Ctx, e: Lambda): Type {
  const { B } = c;
  if (e.params.length === 0 || e.params.length > 2)
    fail(
      e,
      'C44',
      'a function value takes one or two parameters',
      'Give it one or two parameters. For more, take a record: `fn(p: Pair) -> Int { … }`.',
    );
  const captured = capturedBy(c, e);
  checkCaptured(c, e, captured);
  const name = `fn@${e.file}:${e.line}#${B.counters.lambdas++}`;
  const made: FnDecl = {
    name,
    tparams: [],
    line: e.line,
    file: e.file,
    body: e.body,
    ret: B.resolve(e.retAst),
    retAst: e.retAst,
    exported: false,
    params: [
      ...captured.map(v => ({ name: v.name, type: v.type, typeAst: asAst(v.type, e) })),
      ...e.params.map(pm => ({ name: pm.name, type: B.resolve(pm.typeAst), typeAst: pm.typeAst })),
    ],
  };
  B.fns.set(name, made);
  const calls = new Set<string>();
  B.walk(e.body, calls);
  B.callsOf.set(name, calls);
  return closure(c, made, captured);
}

// ---- calls

// repo.method(send: …, within: …): a call through an interface
function emitInterfaceCall(c: Ctx, e: Call, cap: Binding, iface: Interface): Type {
  const mn = e.name.slice(e.name.indexOf('.') + 1);
  const m =
    iface.methods.get(mn) ??
    fail(e, 'C46', `${iface.name} has no method ${mn}`, `Its methods are ${[...iface.methods.keys()].join(', ')}.`);
  const at = { line: e.line, file: e.file };
  const extra = e.args.filter(a => a.label !== null && ['send', 'within', 'once'].includes(a.label));
  const other = e.args.find(a => !extra.includes(a));
  if (other)
    fail(
      other,
      'C11',
      `${e.name} takes (send, within${m.kind === 'write' ? ', once' : ''})`,
      `Pass the message as send:, a time limit in ms as within:${m.kind === 'write' ? ' and a key as once:' : ''}: ${e.name}(send: …, within: 2000${m.kind === 'write' ? ', once: …' : ''}).`,
    );
  return emitCallOut(c, {
    k: 'call',
    name: m.kind === 'read' ? 'ask' : 'call',
    sendType: c.B.resolve(m.send),
    ...at,
    args: [
      { label: 'to', value: { k: 'var', name: cap.name, pos: 'read', ...at }, ...at },
      { label: 'method', value: { k: 'str', bytes: utf8(mn), ...at }, ...at },
      { label: 'reply', value: { k: 'ctor', name: key(m.reply), args: [], ...at }, ...at },
      ...extra,
    ],
  });
}

/** A call of a function value held in a name: its arguments, then the captured values, through the table. */
function emitHeldCall(c: Ctx, e: Call, held: Binding): Type {
  const ps = held.type.args.slice(0, -1);
  const ret =
    held.type.args.at(-1) ??
    fail(
      e,
      'C99',
      `${e.name} has no result type`,
      'This is a compiler bug, not a mistake in the program: please report it with the program that shows it.',
    );
  if (e.args.length !== ps.length)
    fail(
      e,
      'C12',
      `${e.name} takes ${ps.length} argument${ps.length > 1 ? 's' : ''}, in order`,
      `A function value's arguments are not named: write ${e.name}(${ps.map((_p, i) => `a${i + 1}`).join(', ')}).`,
    );
  c.code.push(...get(held.locals[1] ?? 0));
  e.args.forEach((a, i) => {
    const p = ps[i] ?? ret;
    need(c, c.emit(a.value, p, false), p, a, `argument ${i + 1}`);
  });
  const type = c.B.sig([I32, ...ps.flatMap(t => c.B.slotsOf(t))], c.B.slotsOf(ret));
  c.code.push(...get(held.locals[0] ?? 0), 0x11, ...uleb(type), 0);
  return ret;
}

export function emitCall(c: Ctx, e: Call, expected: Type | null, tail: boolean): Type {
  const { B } = c;
  const dot = e.name.indexOf('.');
  const cap = dot > 0 ? c.env.get(e.name.slice(0, dot)) : undefined;
  const iface = cap ? B.prog.interfaces.get(cap.type.name) : undefined;
  if (cap && iface) return emitInterfaceCall(c, e, cap, iface);
  const held = c.env.get(e.name);
  if (held && (held.type.name === 'Fn' || held.type.name === 'Fn2')) return emitHeldCall(c, e, held);
  if (INTRINSICS.has(e.name)) return emitIntrinsic(c, e);
  const suggestion = (): string => {
    const value = dot > 0 ? e.name.slice(0, dot) : null;
    if (value !== null && c.env.has(value))
      return `\`${value}\` is a value, not a capability bound to an interface, and Tape has no methods: pass it to a function, \`${e.name.slice(dot + 1)}(…)\` with it as an argument.`;
    const n = B.nearest(e.name, [...B.fns.keys(), ...INTRINSICS.keys()]);
    return n
      ? `Did you mean \`${n}\`?`
      : `Neither the program nor std has a function \`${e.name}\`; docs/std.md lists std's.`;
  };
  const named = B.find(e.name, c.f.file, e) ?? fail(e, 'C22', `unknown function ${e.name}`, suggestion());
  const args = B.orderArgs(
    `function ${e.name}`,
    named.params.map(x => x.name),
    e.args,
    e,
    new Set(named.params.filter(x => x.implicit).map(x => x.name)),
  );
  const g = named.tparams.length > 0 ? instance(c, named, args, expected, e) : named;
  g.params.forEach((pm, i) => {
    const arg = args[i];
    if (arg) need(c, c.emit(arg.value, typeOf(pm, g), false), typeOf(pm, g), arg, `argument ${pm.name}`);
  });
  if (tail && g === c.f) {
    // a call of itself as its result: the arguments become the parameters, and the function starts again
    for (let i = c.nparams - 1; i >= 0; i--) c.code.push(...set(i));
    c.code.push(0x0c, ...uleb(c.depth - 1));
  } else c.code.push(tail && B.opts.tailCalls ? 0x12 : 0x10, ...uleb(B.fnIndex(g.name)));
  return retOf(g);
}
