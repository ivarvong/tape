// compiler/gen/module.ts: what one build keeps while its functions are compiled: who calls what, which imports
// the module needs and their numbers, and the tables every function adds to (signatures, text, queries).
import { eachExpr, eachPattern, eachType, patternsIn, typesIn } from '../ast.ts';
import type { Arg, Expr, FnDecl, Program, TypeAst, TypeDecl } from '../ast.ts';
import { CompileError, fail, sleb, stemOf, vec } from '../common.ts';
import type { DEFAULTS } from '../common.ts';
import { integerParams } from '../../sql/analyze.ts';
import { isStd } from '../shadow.ts';
import { key } from '../types.ts';
import { showExpr } from '../../rules/origins.ts';
import type { Served } from './served.ts';

export type Options = Omit<typeof DEFAULTS, 'pin' | 'exports' | 'rules'> & {
  pin: Record<string, unknown>;
  exports: string[];
  rules?: boolean;
};
type Place = { readonly file?: string; readonly line?: number } | null | undefined;
export type CallGraph = Map<string, Set<string>>;

// ---- who calls what

/** The functions an expression calls by name, with those its patterns call (`decimal(n)`, a split's find_text). */
export function callsIn(e: Expr, out: Set<string>): void {
  eachExpr(e, x => {
    if (x.k === 'call') out.add(x.name);
    for (const p of patternsIn(x))
      eachPattern(p, q => {
        if (q.k === 'fn') out.add(q.name === 'json' ? 'decode' : q.name);
        if (q.k === 'split') out.add('find_text');
      });
  });
}

// the functions written for nested JSON (file `wire`) are compiled only when a decode or write_json reaches them,
// so they do not decide what the module imports: their caller's own decode, call or write_json does
export function callGraph(fns: ReadonlyMap<string, FnDecl>): CallGraph {
  return new Map(
    [...fns.values()].map((f): [string, Set<string>] => {
      const calls = new Set<string>();
      if (f.file !== 'wire') callsIn(f.body, calls);
      return [f.name, calls];
    }),
  );
}

/** The functions that reach themselves. */
export function recursiveOf(fns: ReadonlyMap<string, FnDecl>, callsOf: CallGraph): Set<string> {
  const reaches = (from: string, target: string, seen = new Set<string>()): boolean => {
    for (const n of callsOf.get(from) ?? []) {
      if (n === target) return true;
      if (!fns.has(n) || seen.has(n)) continue;
      seen.add(n);
      if (reaches(n, target, seen)) return true;
    }
    return false;
  };
  return new Set([...fns.keys()].filter(n => reaches(n, n)));
}

/** What the exports reach, by the names functions are known by. */
function reachedFrom(fns: ReadonlyMap<string, FnDecl>, callsOf: CallGraph, exports: readonly string[]): Set<string> {
  const reached = new Set<string>();
  const visit = (n: string): void => {
    for (const k of fns.has(n) ? [n] : [...fns.keys()].filter(x => x.endsWith(`.${n}`))) {
      if (reached.has(k)) continue;
      reached.add(k);
      for (const c of callsOf.get(k) ?? []) visit(c);
    }
  };
  for (const n of exports) visit(n);
  return reached;
}

// ---- the imports, and the numbers of the functions after them

/** Which host functions the module imports, and the index of each function: imports first, then the runtime's. */
export type Imports = {
  usesSql: boolean;
  usesCall: boolean;
  usesMember: boolean;
  usesAsk: boolean;
  usesWake: boolean;
  usesFloat: boolean;
  CALL_IMPORT: number;
  MEMBER_IMPORT: number;
  ASK_IMPORT: number;
  WAKE_IMPORT: number;
  FLOAT_TEXT_IMPORT: number;
  FLOAT_OF_IMPORT: number;
  TRACE_IMPORT: number;
  PROFILE_IMPORT: number;
  IMPORTS: number;
  ALLOC: number;
  RESET: number;
  RESERVE: number;
  FIRST: number;
};

const c50 = (at: Place, message: string, hint: string): never => {
  throw new CompileError({ code: 'C50', file: at?.file ?? '', line: at?.line ?? 0, message, hint });
};

// wake(timer, after, key): the host calls this program's exported `woken` with Wake(key) once `after` ms have passed
function checkWoken(setter: FnDecl | undefined, served: readonly Served[]): void {
  const w = served.find(f => f.method === 'woken');
  if (!w)
    return c50(
      setter,
      'this program sets a timer (wake), but nothing exports `woken`',
      'When a wake is due, the host calls `export fn woken(…capabilities, message: Wake) -> Result[Reply, View]` with the key it was set with. Add that function.',
    );
  if (w.message.name !== 'Wake')
    c50(
      w,
      `woken takes ${key(w.message)}, but the host sends a Wake`,
      'Write `export fn woken(…, message: Wake) -> Result[…, View]`; Wake(key) is in std/core.tape.',
    );
}

type Uses = Pick<Imports, 'usesSql' | 'usesCall' | 'usesMember' | 'usesAsk' | 'usesWake' | 'usesFloat'>;

/** The index of each import that is used, in the order the module lists them, and of the functions after them. */
function numbered(uses: Uses, opts: Options): Imports {
  const n = (b: boolean): number => (b ? 1 : 0);
  const CALL_IMPORT = n(uses.usesSql);
  const MEMBER_IMPORT = CALL_IMPORT + n(uses.usesCall);
  const ASK_IMPORT = MEMBER_IMPORT + n(uses.usesMember);
  const WAKE_IMPORT = ASK_IMPORT + n(uses.usesAsk);
  const FLOAT_TEXT_IMPORT = WAKE_IMPORT + n(uses.usesWake);
  const FLOAT_OF_IMPORT = FLOAT_TEXT_IMPORT + n(uses.usesFloat);
  const TRACE_IMPORT = FLOAT_OF_IMPORT + n(uses.usesFloat);
  const PROFILE_IMPORT = TRACE_IMPORT + n(opts.trace);
  const IMPORTS = PROFILE_IMPORT + n(opts.profile);
  const after = { IMPORTS, ALLOC: IMPORTS, RESET: IMPORTS + 1, RESERVE: IMPORTS + 2, FIRST: IMPORTS + 3 };
  const before = {
    CALL_IMPORT,
    MEMBER_IMPORT,
    ASK_IMPORT,
    WAKE_IMPORT,
    FLOAT_TEXT_IMPORT,
    FLOAT_OF_IMPORT,
    TRACE_IMPORT,
    PROFILE_IMPORT,
  };
  return Object.assign(after, before, uses);
}

/** Does the program write a Float anywhere: a literal, `float(n)`, or the type in a signature or a declaration? */
function mentionsFloat(prog: Program): boolean {
  const typed = (t: TypeAst): boolean => {
    let found = false;
    eachType(t, x => {
      if (x.name === 'Float') found = true;
    });
    return found;
  };
  const inFn = (f: FnDecl): boolean => {
    if ([...f.params.map(p => p.typeAst), f.retAst].some(typed)) return true;
    let found = false;
    eachExpr(f.body, e => {
      if (e.k === 'float' || (e.k === 'call' && e.name === 'float') || typesIn(e).some(typed)) found = true;
    });
    return found;
  };
  const inType = (d: TypeDecl): boolean =>
    d.variants.some(v => v.fields.some(f => typed(f.type))) || (d.refine !== undefined && typed(d.refine.base));
  // std's own (std/json.tape reads a Float field with parse_float) counts only when a program's code or type does
  return (
    [...prog.fns.values()].some(f => !isStd(f.file) && inFn(f)) ||
    [...prog.types.values()].some(d => !isStd(d.file) && inType(d))
  );
}

export function importsOf(prog: Program, callsOf: CallGraph, opts: Options, served: readonly Served[]): Imports {
  const anyCalls = (...names: string[]): boolean => [...callsOf.values()].some(c => names.some(n => c.has(n)));
  // only what the exports reach counts: std/retry.tape calls wake, and a program that never uses it sets no timers
  const setter = [...reachedFrom(prog.fns, callsOf, opts.exports)].find(x => callsOf.get(x)?.has('wake'));
  if (setter !== undefined) checkWoken(prog.fns.get(setter), served);
  return numbered(
    {
      usesSql: [...callsOf.values()].some(s => [...s].some(x => x.startsWith('sql_'))),
      // decode, and the replies to calls and asks (decoded from JSON), and exported methods' messages
      usesCall: prog.interfaces.size > 0 || anyCalls('call', 'ask'),
      usesAsk: anyCalls('now', 'random'),
      // remote(of: family, index): the Remote of one member of a family (the host names it <family>-<index>)
      usesMember: anyCalls('remote'),
      usesWake: setter !== undefined,
      // a Float's text is the host's (env.float_text): imported by a program that has Floats at all, since which
      // hole holds one is known only once the types are
      usesFloat: mentionsFloat(prog),
    },
    opts,
  );
}

// ---- names

/** A function by the name a file uses for it: its own, else the only other one, else `file.name`. */
export function find(prog: Program, n: string, file: string, at?: Place): FnDecl | null {
  const { fns } = prog;
  const own = prog.byFile.get(file)?.get(n);
  if (own) return fns.get(own) ?? null;
  const all = prog.defs.get(n);
  const [only] = all ?? [];
  if (all?.length === 1 && only) return fns.get(only.key) ?? null;
  if (all)
    fail(
      at ?? null,
      'C45',
      `${n} is defined in ${all.map(d => d.file).join(' and ')}`,
      `Say which one: ${all.map(d => `\`${stemOf(d.file)}.${n}(…)\``).join(' or ')}.`,
    );
  const dot = n.indexOf('.');
  if (dot > 0)
    for (const [fl, names] of prog.byFile) {
      const known = stemOf(fl) === n.slice(0, dot) ? names.get(n.slice(dot + 1)) : undefined;
      if (known !== undefined) return fns.get(known) ?? null;
    }
  return fns.get(n) ?? null;
}

/** An argument as written: `name: value`, the name alone when the value is a variable of that name. */
const shownArg = (name: string, a: Arg): string =>
  a.value.k === 'var' && a.value.name === name ? name : `${name}: ${showExpr(a.value)}`;
const callee = (what: string): string | undefined => /^(?:function|constructor) (.+)$/.exec(what)?.[1];

/** The call with each unnamed argument given the name of the parameter in its place: `, as in pow(b, e: e - 1)`. */
function rewrite(what: string, names: readonly string[], args: readonly Arg[]): string {
  const fn = callee(what);
  if (fn === undefined || args.some(a => a.piped)) return '';
  const shown = args.map((a, i) => {
    const name = a.label !== null && names.includes(a.label) ? a.label : names[i];
    return name === undefined ? null : shownArg(name, a);
  });
  return shown.includes(null) ? '' : `, as in \`${fn}(${shown.join(', ')})\``;
}

/**
 * The call written out with each argument named by the parameter in its place, when there is one argument for each
 * (`every_byte(self, fn(…) …)` is `every_byte(v: self, keep: fn(…) …)`), or ''. A long argument is shown cut.
 */
function byPosition(what: string, names: readonly string[], args: readonly Arg[]): string {
  const fn = callee(what);
  if (fn === undefined || args.length !== names.length || args.some(a => a.piped)) return '';
  const shown = args.map((a, i) => {
    const name = a.label !== null && !a.pun && names.includes(a.label) ? a.label : names[i];
    return name === undefined ? null : shownArg(name, a);
  });
  return shown.includes(null) ? '' : `write \`${fn}(${shown.join(', ')})\``;
}

/** The call with the one argument that names no parameter given the one parameter no argument names, or ''. */
function renamed(what: string, names: readonly string[], args: readonly Arg[], wrong: Arg): string {
  const fn = callee(what);
  const free = names.filter(n => !args.some(a => a.label === n));
  const [only] = free;
  if (fn === undefined || free.length !== 1 || only === undefined || args.some(a => a.piped)) return '';
  const shown = args.map(a => (a === wrong ? shownArg(only, a) : a.label === null ? null : shownArg(a.label, a)));
  return shown.includes(null) || shown.some(t => t?.includes('…')) ? '' : `write \`${fn}(${shown.join(', ')})\``;
}

/**
 * Call arguments in the order of the parameters' names. A callee of one parameter takes its argument bare. The
 * `hidden` parameters are those the compiler added (the capabilities of compiler/ambient.ts): they are passed for
 * the program, so they do not count as parameters it wrote, and no refusal names them.
 */
export function orderArgs(
  what: string,
  names: readonly string[],
  args: readonly Arg[],
  at: Place,
  hidden: ReadonlySet<string> = new Set(),
): Arg[] {
  const written = names.filter(n => !hidden.has(n)),
    given = args.filter(a => a.label === null || !hidden.has(a.label)),
    list = `(${written.join(', ')})`;
  const [first] = given,
    [one] = written;
  if (written.length === 1 && given.length === 1 && first?.pun && one !== undefined && first.label !== one) {
    if (names.length === 1) return [first];
    const rest = new Map(args.filter(a => a !== first).map(a => [a.label, a]));
    return names.map(n =>
      n === one
        ? first
        : (rest.get(n) ?? fail(at, 'C13', `${what} is missing argument ${n}`, `${what} takes ${list}.`)),
    );
  }
  const by = new Map<string, Arg>();
  for (const a of args) {
    if (a.label === null)
      return fail(
        a,
        'C10',
        'arguments must be named',
        `${what} takes ${list}: the first argument may be written without its name, and each one after it is \`name: value\`${rewrite(what, written, given)}. A variable with the parameter's name can be passed bare.`,
      );
    if (!names.includes(a.label)) {
      const fix = renamed(what, written, given, a) || (a.pun ? byPosition(what, written, given) : '');
      fail(
        a,
        'C11',
        `${what} has no parameter ${a.label}`,
        a.pun
          ? `${what} takes ${list}. \`${a.label}\` was read as shorthand for \`${a.label}: ${a.label}\`; ${fix || 'write the parameter name, then the value'}.`
          : `${what} takes ${list}${fix ? `: ${fix}` : ''}.`,
      );
    }
    if (by.has(a.label)) fail(a, 'C12', `argument ${a.label} is given twice`, `Give ${a.label} once.`);
    by.set(a.label, a);
  }
  return names.map(n => by.get(n) ?? fail(at, 'C13', `${what} is missing argument ${n}`, `${what} takes ${list}.`));
}

// ---- the tables every function adds to

export const G_HP = 0,
  G_COST = 1,
  G_WHY = 2,
  G_UNDO = 3,
  // the recursion held now, in units (common.ts DEPTH_BUDGET), and the function whose call passed the budget
  G_DEPTH = 4,
  G_DEEPEST = 5;
/** The first global past the fixed ones: the free lists' heads. */
const G_FREE = 6;
// Flags live at fixed addresses, 8 bytes each, before the text literals.
export const FLAG_BASE = 16;
/** Stop, saying why. */
export const trap = (code: number): number[] => [0x41, ...sleb(code), 0x24, G_WHY, 0x00];

/** A query as the host is given it; `run` is its text with each Int and Bool parameter read as an integer. */
export type QueryEntry = {
  sql: string;
  params: string;
  row: string | null;
  columns: string[] | null;
  run: string;
  /** a write the program says is meant to apply again each time it runs (`repeat: True`) */
  repeat?: true;
};
export type Tables = {
  readonly fns: ReadonlyMap<string, FnDecl>;
  readonly first: number;
  /** the functions compiled, in the order they were first named; `indexOf` is each one's index in the module */
  readonly order: FnDecl[];
  readonly indexOf: Map<string, number>;
  readonly sigs: number[][];
  readonly sigIndex: Map<string, number>;
  readonly dataBase: number;
  readonly data: number[];
  readonly dataAt: Map<string, number>;
  readonly queries: QueryEntry[];
  /** released values wait in one list per size; the list heads are globals */
  readonly freeLists: Map<number, number>;
};

export function tables(prog: Program, first: number): Tables {
  return {
    fns: prog.fns,
    first,
    order: [],
    indexOf: new Map(),
    sigs: [],
    sigIndex: new Map(),
    dataBase: FLAG_BASE + 8 * prog.flags.length,
    data: [],
    dataAt: new Map(),
    queries: [],
    freeLists: new Map(),
  };
}

/** The index of a function in the module; naming it puts it among those to compile. */
export function fnIndex(t: Tables, n: string): number {
  const f =
    t.fns.get(n) ??
    fail(
      null,
      'C30',
      `the program has no function ${n}`,
      n === 'same'
        ? 'Comparing text needs std/core.tape: compile it together with your file.'
        : `The host calls \`${n}\`. Define it.`,
    );
  const had = t.indexOf.get(n);
  if (had !== undefined) return had;
  const index = t.first + t.order.length;
  t.indexOf.set(n, index);
  t.order.push(f);
  return index;
}

/** The index of a function type in the module's type section. */
export function sig(t: Tables, params: readonly number[], results: readonly number[]): number {
  const k = `${params.join(',')}>${results.join(',')}`;
  const had = t.sigIndex.get(k);
  if (had !== undefined) return had;
  t.sigIndex.set(k, t.sigs.length);
  t.sigs.push([0x60, ...vec(params.map(x => [x])), ...vec(results.map(x => [x]))]);
  return t.sigs.length - 1;
}

/** Where a text literal is in memory, and its length. The same bytes are kept once. */
export function literal(t: Tables, bytes: readonly number[]): [number, number] {
  const k = bytes.join(',');
  const had = t.dataAt.get(k);
  if (had !== undefined) return [had, bytes.length];
  const at = t.dataBase + t.data.length;
  t.dataAt.set(k, at);
  t.data.push(...bytes);
  return [at, bytes.length];
}

/** Constant data of the math library, at an address that is a multiple of 8; the same bytes are kept once. */
export function constData(t: Tables, bytes: readonly number[]): number {
  const k = `table:${bytes.join(',')}`;
  const had = t.dataAt.get(k);
  if (had !== undefined) return had;
  while (t.data.length % 8) t.data.push(0);
  const at = t.dataBase + t.data.length;
  t.dataAt.set(k, at);
  t.data.push(...bytes);
  return at;
}
/** Room of its own a function of the math library writes in, at an address that is a multiple of 8. */
export function room(t: Tables, size: number): number {
  while (t.data.length % 8) t.data.push(0);
  const at = t.dataBase + t.data.length;
  t.data.push(...Array.from({ length: size }, () => 0));
  return at;
}

/** The number of a query in the module's list. The same query is kept once. */
export function queryId(t: Tables, q0: Omit<QueryEntry, 'run'>): number {
  const q = { ...q0, run: integerParams(q0.sql, q0.params) };
  const k = JSON.stringify(q);
  const i = t.queries.findIndex(x => JSON.stringify(x) === k);
  return i < 0 ? t.queries.push(q) - 1 : i;
}

/** The global that heads the list of released values of one size. */
export function freeList(t: Tables, size: number): number {
  const had = t.freeLists.get(size);
  if (had !== undefined) return had;
  const g = G_FREE + t.freeLists.size;
  t.freeLists.set(size, g);
  return g;
}
