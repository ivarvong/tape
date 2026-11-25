// compiler/ast.ts: the shape of a parsed program. Every node is a variant of a union, told apart by `k`; a switch
// over one ends in `unreachable`, so a variant with no case does not compile.
export type At = { readonly line: number; readonly file: string };

/** A switch that has covered every variant reaches this with nothing left; a new variant makes the call an error. */
export const unreachable = (x: never, what = 'value'): never => {
  throw new Error(`no case for this ${what}: ${JSON.stringify(x)}`);
};

// ---- tokens
type Word = 'kw' | 'Id' | 'id' | 'op' | 'sql';
export type Token =
  | { [K in Word]: At & { t: K; v: string } }[Word]
  | (At & { t: 'str'; v: number[] })
  /** text with holes, "a \(x) b": the bytes between the holes and each hole's tokens, in turn */
  | (At & { t: 'interp'; v: ({ text: number[] } | { hole: Token[] })[] })
  | (At & { t: 'int'; v: bigint })
  /** `1.5f`: the nearest f64 to the digits */
  | (At & { t: 'float'; v: number })
  /** `12.30`: the digits without the point (1230), and how many follow it (2) */
  | (At & { t: 'dec'; v: bigint; s: number })
  | (At & { t: 'nl' | 'eof'; v?: undefined });
export type TokenOf<K extends Token['t']> = Extract<Token, { t: K }>;

// ---- types as written
export type TypeAst = At & { name: string; args: TypeAst[] };

// ---- expressions
export type BinOp =
  | ('or' | 'and')
  | ('==' | '!=' | '<' | '<=' | '>' | '>=')
  | ('|' | '^' | '&' | '<<' | '>>')
  | ('+' | '-' | '++' | '*' | '/' | '%');
/**
 * One argument: `label: value`, a bare name standing for `name: name` (pun), or the left side of `|>` (piped).
 * The label is null for a bare expression that is not a name: allowed only where the callee is a function value,
 * whose one argument is passed without a name.
 */
/** `as`: the name a query's placeholder and this argument share; the label is then its number, `p1`. */
export type Arg = At & { label: string | null; value: Expr; pun?: true; piped?: true; as?: string };
/** `type`: set by the build, the parameter's type with the function's type arguments given. */
export type Param = { name: string; typeAst: TypeAst; implicit?: boolean; type?: Resolved };
/** A type with nothing left to fill in (compiler/types.ts calls it Type). */
export type Resolved = { name: string; args: Resolved[] };
/** A step of a block: `let name = e`, `do call(…)` (a `let` under an invented name), or `let Pattern = e`. */
export type Let =
  | (At & { name: string; value: Expr; do?: true; pat?: undefined })
  | (At & { pat: Pattern; value: Expr; name?: undefined; do?: undefined });
export type Int = At & { k: 'int'; v: bigint };
/** `1.5f`, `2f`, `1e-3f`: a Float literal, the nearest f64 to its digits. */
export type FloatLit = At & { k: 'float'; v: number };
/** `12.30`, `-0.5`: a Dec literal, its digits as an Int (1230) and its scale, the digits after the point (2). */
export type DecLit = At & { k: 'dec'; v: bigint; s: number };
export type Str = At & { k: 'str'; bytes: number[]; written?: string };
/** How a use of a variable takes its value: as the owner, only to read it, or as the subject of a match. */
export type UsePos = 'own' | 'read' | 'subject';
/**
 * Set by the build (compiler/gen/ownership.ts): `clean`, an owning use that nothing else on its path outlives; `last`,
 * a use (owning or not) that nothing else on its path outlives, the last thing done with the value there.
 */
type Used = { pos?: UsePos; clean?: boolean; last?: boolean };
/** Text with holes, `"Hello, \(name)"`: its parts in order, a Str between holes and any expression in one. */
export type Interp = At & { k: 'interp'; parts: Expr[] };
export type Var = At & Used & { k: 'var'; name: string };
export type Field = At & Used & { k: 'field'; e: Expr; name: string };
export type Index = At & { k: 'index'; e: Expr; i: Expr };
export type Neg = At & { k: 'neg'; e: Expr };
export type Not = At & { k: 'not'; e: Expr };
export type Bin = At & { k: 'bin'; op: BinOp; l: Expr; r: Expr };
/** `params`: for a call that runs a query, the names of the query's placeholders in the order of their numbers. */
export type Call = At & { k: 'call'; name: string; args: Arg[]; params?: string[] };
export type Ctor = At & { k: 'ctor'; name: string; args: Arg[] };
export type Lambda = At & { k: 'lambda'; params: Param[]; retAst: TypeAst; body: Block };
export type Block = At & { k: 'block'; lets: Let[]; result: Expr };
/** An arm of `match subject { … }`. `step` marks the arm a `let P = e else …` was read as. */
export type PatArm = At & { pat: Pattern; guard?: Expr; body: Expr; step?: true };
/** An arm of `match { cond -> … else -> … }`. */
export type CondArm =
  (At & { cond: Expr; body: Expr; else?: undefined }) | (At & { else: true; body: Expr; cond?: undefined });
/** The expressions of an arm, in the order written: its guard or condition, then its body. */
export const armParts = (a: PatArm | CondArm): Expr[] =>
  'pat' in a ? (a.guard ? [a.guard, a.body] : [a.body]) : a.cond ? [a.cond, a.body] : [a.body];
export type Match = At & { k: 'match' } & ({ subject: Expr; arms: PatArm[] } | { subject: null; arms: CondArm[] });
/** A value the compiler already holds in locals, passed where an expression goes. Never written in a program. */
export type Held = At & { k: 'held'; held: { type: Resolved; locals: number[] } };
export type Expr =
  | Int
  | FloatLit
  | DecLit
  | Str
  | Interp
  | Var
  | Field
  | Index
  | Neg
  | Not
  | Bin
  | Call
  | Ctor
  | Lambda
  | Block
  | Match
  | Held;

/** decode's `as:` as a type: a name, or `List[…]` of one (an index expression as parsed); null for anything else. */
export function asType(e: Expr): TypeAst | null {
  if (e.k === 'ctor' && e.args.length === 0) return { name: e.name, args: [], line: e.line, file: e.file };
  if (e.k !== 'index' || e.e.k !== 'ctor' || e.e.name !== 'List' || e.e.args.length > 0) return null;
  const of = asType(e.i);
  return of ? { name: 'List', args: [of], line: e.line, file: e.file } : null;
}
/** The expressions written directly inside e, in the order they are written. */
export const partsOf = (e: Expr): Expr[] => {
  switch (e.k) {
    case 'int':
    case 'float':
    case 'dec':
    case 'str':
    case 'var':
    case 'held':
      return [];
    case 'interp':
      return e.parts;
    case 'field':
    case 'neg':
    case 'not':
      return [e.e];
    case 'index':
      return [e.e, e.i];
    case 'bin':
      return [e.l, e.r];
    case 'call':
    case 'ctor':
      return e.args.map(a => a.value);
    case 'lambda':
      return [e.body];
    case 'block':
      return [...e.lets.map(l => l.value), e.result];
    case 'match':
      return e.subject
        ? [e.subject, ...e.arms.flatMap(a => (a.guard ? [a.guard, a.body] : [a.body]))]
        : e.arms.flatMap(a => (a.else ? [a.body] : [a.cond, a.body]));
    default:
      return unreachable(e, 'expression');
  }
};
/** e and every expression inside it, outermost first. */
export const eachExpr = (e: Expr, visit: (e: Expr) => void): void => {
  visit(e);
  for (const part of partsOf(e)) eachExpr(part, visit);
};

/** The patterns written directly in e: the arms of a match, a `let` that takes a value apart. */
export const patternsIn = (e: Expr): Pattern[] =>
  e.k === 'match' && e.subject
    ? e.arms.map(a => a.pat)
    : e.k === 'block'
      ? e.lets.flatMap(l => (l.pat ? [l.pat] : []))
      : [];
/** The types written directly in e: a function value's parameters and result. */
export const typesIn = (e: Expr): TypeAst[] => (e.k === 'lambda' ? [...e.params.map(p => p.typeAst), e.retAst] : []);
/** t and every type among its arguments, outermost first. */
export const eachType = (t: TypeAst, visit: (t: TypeAst) => void): void => {
  visit(t);
  for (const arg of t.args) eachType(arg, visit);
};

// ---- patterns
export type AnyPat = At & { k: 'any' };
export type BindPat = At & { k: 'bind'; name: string };
/** `name = Pattern`: the whole value, once it matches. */
export type AsPat = At & { k: 'as'; name: string; pat: Pattern };
export type IntPat = At & { k: 'int'; v: bigint };
export type StrPat = At & { k: 'str'; bytes: number[] };
export type PrefixPat = At & { k: 'prefix'; bytes: number[]; rest: Pattern };
export type SuffixPat = At & { k: 'suffix'; head: Pattern; bytes: number[] };
export type SplitPat = At & { k: 'split'; head: Pattern; bytes: number[]; rest: Pattern };
/** `decimal(n)`: a function from text to an Option, matched when it gives Some. */
export type FnPat = At & { k: 'fn'; name: string; sub: Pattern };
/** `positional`: a pattern written without its field's name, `Some("")`; the build names the field (a constructor with
 * one field), or refuses it. */
export type CtorPat = At & {
  k: 'ctor';
  name: string;
  subs: { field: string; pat: Pattern; pun?: true; positional?: true }[];
};
export type Pattern = AnyPat | BindPat | AsPat | IntPat | StrPat | PrefixPat | SuffixPat | SplitPat | FnPat | CtorPat;

/** The patterns written directly inside p. */
export const patternParts = (p: Pattern): Pattern[] => {
  switch (p.k) {
    case 'any':
    case 'bind':
    case 'int':
    case 'str':
      return [];
    case 'as':
      return [p.pat];
    case 'prefix':
      return [p.rest];
    case 'suffix':
      return [p.head];
    case 'split':
      return [p.head, p.rest];
    case 'fn':
      return [p.sub];
    case 'ctor':
      return p.subs.map(s => s.pat);
    default:
      return unreachable(p, 'pattern');
  }
};
/** p and every pattern inside it, outermost first. */
export const eachPattern = (p: Pattern, visit: (p: Pattern) => void): void => {
  visit(p);
  for (const part of patternParts(p)) eachPattern(part, visit);
};

// ---- declarations
export type FieldDecl = { name: string; type: TypeAst };
export type Variant = At & { name: string; fields: FieldDecl[]; final?: true };
export type TypeDecl = At & {
  name: string;
  params: string[];
  variants: Variant[];
  private?: boolean;
  /** set by the build: a type that can contain itself, whose values are pointers into the arena */
  boxed?: boolean;
  /** `type Name = Base where condition`, with `self` as the value; `else "…"`, what decode's 400 says of a value
   * for which it does not hold */
  refine?: { base: TypeAst; pred: Expr; message?: string };
};
export type FnDecl = At & {
  name: string;
  params: Param[];
  retAst: TypeAst;
  body: Block;
  exported: boolean;
  tparams: string[];
  /** `private fn`: called only from its own file (C94); the compiler's own calls of it are not refused */
  private?: boolean;
  /** `-> R uses db, http`: the capabilities the function says it reaches by name (C101 checks it) */
  uses?: string[];
  /** set by compiler/ambient.ts: each capability the function takes by name, with the call path that reaches it */
  reached?: ReadonlyMap<string, readonly string[]>;
  /** set by the build: the result type; for a generic function made for one set of type arguments, its `base` */
  ret?: Resolved;
  base?: string;
  /** set by the build on that copy, and on each function value written in it: what each type parameter is, so a
   *  function value's parameters may name them (`fn(o: Buf, value: T) -> Buf` in std's write_rows) */
  typeArgs?: ReadonlyMap<string, Resolved>;
  /**
   * set by the build on a function's owning copy (compiler/gen/call.ts owning): the parameters it takes over from
   * its caller, so the cells it takes apart go to the next values of their size
   */
  owns?: readonly number[];
  /** set by the build on an exported function: its message and reply, its capabilities, the name it is called by */
  message?: TypeAst;
  reply?: TypeAst;
  caps?: Param[];
  method?: string;
  /** set by the build on the entry function of a function value: the function it enters, and how many of its
   *  parameters were captured */
  trampoline?: { g: FnDecl; k: number };
  /** set by the build on a function of the math library (compiler/math): its name there */
  math?: string;
};
export type Migration = At & { n: number; name: string; contract: boolean; statements: string[] };
export type Flag = At & { name: string; type: string; default: bigint | boolean };
/**
 * `machine table.column: Type { A -> B … }`. `ctors`: the constructors its moves name, in the order first named;
 * `states`, `start` and each move's `from` and `to` are their texts, as the column holds them (compiler/fieldless.ts).
 */
export type Machine = At & {
  table: string;
  column: string;
  type: string;
  ctors: string[];
  start: string | null;
  states: string[];
  moves: { from: string; to: string; line: number }[];
};
export type Invariant = At & { name: string; settled: boolean; with: string[]; sql: string };
export type Method = { kind: 'read' | 'write'; send: TypeAst; reply: TypeAst };
export type Interface = At & { name: string; methods: Map<string, Method> };

/** Everything the files of a program declare, by name. */
export type Program = {
  types: Map<string, TypeDecl>;
  ctors: Map<string, { decl: TypeDecl; vi: number }>;
  fns: Map<string, FnDecl>;
  schema: string[];
  migrations: Migration[];
  flags: Flag[];
  /** per file: the name a function was written under -> the name it is known by */
  byFile: Map<string, Map<string, string>>;
  defs: Map<string, { key: string; file: string }[]>;
  interfaces: Map<string, Interface>;
  machines: Machine[];
  invariants?: Invariant[];
  /** std's types and constructors that a program's own of the same name moved aside: name -> `std.Name` */
  renamed?: { types: Map<string, string>; ctors: Map<string, string> };
};

/** A program with nothing declared yet, for the parser to fill. */
export const emptyProgram = (): Program => ({
  types: new Map(),
  ctors: new Map(),
  fns: new Map(),
  schema: [],
  migrations: [],
  flags: [],
  byFile: new Map(),
  defs: new Map(),
  interfaces: new Map(),
  machines: [],
});
