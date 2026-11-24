// fuzz/gen.ts: random well-typed Tape programs over every value a pure program holds: Int at its edges (overflow,
// division, shifts), Bool, View (slices, holes, `++`, the byte scans of std/text.tape), Float (the math functions,
// parse_float), Dec at several scales (mul, div, round, rescale, to_dec, parse_dec), Option, List (fold, range,
// map, filter), Map, a record and a sum type, write_json and decode round trips, and recursive helpers (tail and
// not) with fuel. program(seed) is the source of `fn handle(raw: View) -> Buf`, which writes every value it made
// into its answer, so a value computed wrong shows in the bytes. The generator only ever writes programs the
// compiler should take: a refusal is either a generator bug or a compiler bug, and is reported as a finding.
import { unreachable } from '../compiler/ast.ts';
import { rng } from './rng.ts';
import type { Rng } from './rng.ts';

export type Ty =
  | { k: 'Int' }
  | { k: 'Bool' }
  | { k: 'View' }
  | { k: 'Float' }
  | { k: 'Dec'; s: number }
  | { k: 'List'; of: Ty }
  | { k: 'Opt'; of: Ty }
  | { k: 'Map' }
  | { k: 'R' }
  | { k: 'S' };
const INT: Ty = { k: 'Int' },
  BOOL: Ty = { k: 'Bool' },
  VIEW: Ty = { k: 'View' },
  FLOAT: Ty = { k: 'Float' },
  MAP: Ty = { k: 'Map' },
  R: Ty = { k: 'R' },
  S: Ty = { k: 'S' };
const D = (s: number): Ty => ({ k: 'Dec', s });
const L = (of: Ty): Ty => ({ k: 'List', of });
const O = (of: Ty): Ty => ({ k: 'Opt', of });
export const tyName = (t: Ty): string => {
  switch (t.k) {
    case 'Dec':
      return `Dec[${t.s}]`;
    case 'List':
      return `List[${tyName(t.of)}]`;
    case 'Opt':
      return `Option[${tyName(t.of)}]`;
    case 'Map':
      return 'Map[Int]';
    default:
      return t.k;
  }
};
const same = (a: Ty, b: Ty): boolean => tyName(a) === tyName(b);

export const TYPES = `type R {
  R(a: Int, b: View, c: Dec[2], d: Float, e: Option[Int], l: List[Int])
}

type S {
  A(x: Int)
  B(y: View, z: Option[View])
  C(m: Dec[2], n: List[View])
  N
}
`;
// helpers the generated code calls: each has a declared result, so a None or an Empty has a type
const HELPERS = `fn some_int(keep: Bool, v: Int) -> Option[Int] {
  match keep {
    True -> Some(value: v)
    False -> None
  }
}

fn some_view(keep: Bool, v: View) -> Option[View] {
  match keep {
    True -> Some(value: v)
    False -> None
  }
}

fn some_dec(keep: Bool, v: Dec[2]) -> Option[Dec[2]] {
  match keep {
    True -> Some(value: v)
    False -> None
  }
}

fn no_ints() -> List[Int] {
  Nil
}

fn no_views() -> List[View] {
  Nil
}

fn no_rs() -> List[R] {
  Nil
}

fn empty_map() -> Map[Int] {
  Empty
}

fn bool_text(b: Bool) -> View {
  match b {
    True -> "T"
    False -> "F"
  }
}
`;

type Env = { name: string; ty: Ty }[];
type G = {
  r: Rng;
  names: number;
  fns: string[];
  /** generated functions that can be called: name, parameter types, result */
  callable: { name: string; params: Ty[]; result: Ty }[];
  depthBudget: number;
};

const PRINTABLE = (t: Ty): boolean => ['Int', 'View', 'Float', 'Dec'].includes(t.k);
const ROUNDINGS = ['HalfEven', 'HalfUp', 'Down', 'Up', 'Floor', 'Ceiling'];
const SCALES = [0, 1, 2, 2, 2, 3, 4, 6, 9, 18];

const INT_EDGES = [
  '0',
  '1',
  '-1',
  '2',
  '7',
  '10',
  '63',
  '64',
  '255',
  '256',
  '65535',
  '2147483647',
  '-2147483648',
  '4294967296',
  '9007199254740991',
  '9007199254740993',
  '-9007199254740993',
  '3037000499',
  '3037000500',
  '4611686018427387904',
  '9223372036854775807',
  '-9223372036854775807',
  '-9223372036854775808',
];
const TEXTS = [
  '',
  'a',
  'abc',
  'Hello',
  ' x ',
  '0',
  '12',
  '-7',
  '007',
  '+3',
  '1.5',
  '-0.25',
  '1e3',
  '1e400',
  '0.1',
  '12.30',
  '9223372036854775808',
  'nan',
  'thé',
  'naïve café',
  '日本',
  '😀',
  'a,b,,c',
  'k=v&x=1',
  '\\"q\\"',
  'tab\\tnl\\n',
  '\\\\',
  '{\\"a\\":1}',
  '[1,2]',
  'ABC',
  'MiXeD',
];

function intLit(g: G): string {
  const { r } = g;
  switch (r.int(7)) {
    case 0:
      return r.one(INT_EDGES);
    case 1:
      return String(r.between(-20, 20));
    case 2:
      return String(r.big(r.one([8, 16, 32, 62, 63])));
    default:
      return String(r.int(10));
  }
}
function decLit(g: G, s: number): string {
  const { r } = g;
  const max = 10n ** 18n;
  let m: bigint;
  switch (r.int(5)) {
    case 0:
      m = r.big(r.one([4, 8, 20]));
      break;
    case 1:
      m = BigInt(r.between(-1000, 1000));
      break;
    case 2:
      m = r.one([0n, 1n, -1n, 5n, -5n, 15n, 25n, -25n, 50n, 99n]);
      break;
    case 3:
      m = r.big(59);
      break;
    default:
      m = BigInt(r.int(100000));
  }
  // at most 18 digits in the literal
  m = m % max;
  if (s === 0) return `dec(n: ${m}, scale: 0)`;
  const neg = m < 0n,
    digits = (neg ? -m : m).toString().padStart(s + 1, '0');
  const whole = digits.slice(0, digits.length - s),
    frac = digits.slice(digits.length - s);
  if (whole.length + frac.length > 18) return s === 0 ? '0.' : `0.${'0'.repeat(s)}`.replace(/\.$/, '');
  return `${neg ? '-' : ''}${whole}${s > 0 ? `.${frac}` : ''}`;
}
function floatLit(g: G): string {
  const { r } = g;
  return r.one([
    '0f',
    '1f',
    '-1f',
    '0.5f',
    '0.1f',
    '0.2f',
    '0.3f',
    '2.5f',
    '-2.5f',
    '3.5f',
    '1e-3f',
    '1e21f',
    '1e300f',
    '-1e300f',
    '1.7976931348623157e308f',
    '5e-324f',
    '2.2250738585072014e-308f',
    '9007199254740993f',
    '123456.789f',
    '6.02E23f',
    `${r.between(-100, 100)}.${r.int(1000)}f`,
    `${r.int(10)}e${r.between(-30, 30)}f`,
  ]);
}
function textLit(g: G): string {
  return `"${g.r.one(TEXTS)}"`;
}

const fresh = (g: G, p: string): string => `${p}${++g.names}`;
const varsOf = (env: Env, t: Ty): string[] => env.filter(v => same(v.ty, t)).map(v => v.name);
const smallInt = (g: G, env: Env, d: number): string =>
  // an Int from 0 to 40, for fuel and lengths: never makes a long run
  `(abs(${expr(g, INT, Math.min(d, 1), env)} % 41))`;

/** An expression of type t, at most d deep. */
export function expr(g: G, t: Ty, d: number, env: Env): string {
  const { r } = g;
  const vs = varsOf(env, t);
  if (vs.length > 0 && (d <= 0 || r.chance(4))) return r.one(vs);
  if (d <= 0) return leaf(g, t, env);
  switch (t.k) {
    case 'Int':
      return intExpr(g, d, env);
    case 'Bool':
      return boolExpr(g, d, env);
    case 'View':
      return viewExpr(g, d, env);
    case 'Float':
      return floatExpr(g, d, env);
    case 'Dec':
      return decExpr(g, t.s, d, env);
    case 'List':
      return listExpr(g, t.of, d, env);
    case 'Opt':
      return optExpr(g, t.of, d, env);
    case 'Map':
      return mapExpr(g, d, env);
    case 'R':
      return recExpr(g, d, env);
    case 'S':
      return sumExpr(g, d, env);
  }
  return unreachable(t, 'case');
}
function leaf(g: G, t: Ty, env: Env): string {
  switch (t.k) {
    case 'Int':
      return intLit(g);
    case 'Bool':
      return g.r.one(['True', 'False']);
    case 'View':
      return g.r.chance(3) && env.some(v => v.name === 'raw') ? 'raw' : textLit(g);
    case 'Float':
      return floatLit(g);
    case 'Dec':
      return decLit(g, t.s);
    case 'List':
      return t.of.k === 'Int' ? 'no_ints()' : t.of.k === 'View' ? 'no_views()' : 'no_rs()';
    case 'Opt':
      return t.of.k === 'Int'
        ? `some_int(keep: ${leaf(g, BOOL, env)}, v: ${intLit(g)})`
        : t.of.k === 'View'
          ? `some_view(keep: ${leaf(g, BOOL, env)}, v: ${textLit(g)})`
          : `some_dec(keep: ${leaf(g, BOOL, env)}, v: ${decLit(g, 2)})`;
    case 'Map':
      return 'empty_map()';
    case 'R':
      return recExpr(g, 0, env);
    case 'S':
      return 'N';
  }
  return unreachable(t, 'case');
}
const sub = (g: G, t: Ty, d: number, env: Env): string => expr(g, t, d - 1, env);

function intExpr(g: G, d: number, env: Env): string {
  const { r } = g;
  const I = (): string => sub(g, INT, d, env);
  switch (r.int(41)) {
    case 0:
    case 1:
      return intLit(g);
    case 2:
    case 3:
      return `(${I()} ${r.one(['+', '-', '*'])} ${I()})`;
    case 4:
      return `(${I()} ${r.one(['/', '%'])} ${r.chance(3) ? I() : r.one(['3', '7', '-2', '10', '1', '-1', '0'])})`;
    case 5:
      return `(${I()} ${r.one(['&', '|', '^'])} ${I()})`;
    case 6:
      return `(${I()} ${r.one(['<<', '>>'])} ${r.chance(5) ? I() : `(${I()} & 63)`})`;
    case 7:
      return `-${r.one(varsOf(env, INT).length > 0 ? varsOf(env, INT) : ['(1)'])}`;
    case 8:
      return `${r.one(['wrapping_add', 'wrapping_sub', 'wrapping_mul'])}(a: ${I()}, b: ${I()})`;
    case 9:
      return `len(${sub(g, VIEW, d, env)})`;
    case 10: {
      const v = fresh(g, 'v'),
        i = fresh(g, 'i');
      return `match ${sub(g, VIEW, d, env)} {\n${v} -> match ${smallInt(g, env, d)} {\n${i} if ${i} < len(${v}) -> ${v}[${i}]\n_ -> ${I()}\n}\n}`;
    }
    case 11:
      return r.chance(3) ? `abs(${I()})` : `${r.one(['min', 'max'])}(a: ${I()}, b: ${I()})`;
    case 12:
      return `trunc(${sub(g, FLOAT, d, env)})`;
    case 13: {
      const s = r.one(SCALES);
      return `to_int(x: ${sub(g, D(s), d, env)}, rounding: ${r.one(ROUNDINGS)})`;
    }
    case 14:
      return `length(list: ${sub(g, L(r.one([INT, VIEW, R])), d, env)})`;
    case 15: {
      const acc = fresh(g, 'acc'),
        x = fresh(g, 'x');
      const inner = [...env, { name: acc, ty: INT }, { name: x, ty: INT }];
      return `fold(${sub(g, L(INT), d, env)}, from: ${I()}, by: fn(${acc}: Int, ${x}: Int) -> Int { ${expr(g, INT, Math.min(d - 1, 2), inner)} })`;
    }
    case 16: {
      const acc = fresh(g, 'acc'),
        k = fresh(g, 'k'),
        lo = fresh(g, 'lo');
      const inner = [...env, { name: acc, ty: INT }, { name: k, ty: INT }];
      return `match ${I()} {\n${lo} -> range(from: ${lo}, to: ${lo} + ${smallInt(g, env, d)} * ${r.one(['1', '3', '7'])}) |> fold(from: ${I()}, by: fn(${acc}: Int, ${k}: Int) -> Int { ${expr(g, INT, Math.min(d - 1, 2), inner)} })\n}`;
    }
    case 17: {
      const v = fresh(g, 'v');
      return `match ${sub(g, O(INT), d, env)} {\nSome(value: ${v}) -> ${expr(g, INT, d - 1, [...env, { name: v, ty: INT }])}\nNone -> ${I()}\n}`;
    }
    case 18:
      return `count(map: ${sub(g, MAP, d, env)})`;
    case 19:
      return `compare(a: ${sub(g, VIEW, d, env)}, b: ${sub(g, VIEW, d, env)})`;
    case 20:
      return `char_count(${sub(g, VIEW, d, env)})`;
    case 21: {
      const p = fresh(g, 'pv');
      return `match parse_int(text: ${sub(g, VIEW, d, env)}) {\nSome(value: ${p}) -> ${expr(g, INT, d - 1, [...env, { name: p, ty: INT }])}\nNone -> ${I()}\n}`;
    }
    case 22:
      return r.chance(2)
        ? `${sub(g, R, d, env)}.a`
        : varsOf(env, R).length > 0
          ? `(${r.one(varsOf(env, R))}.l |> length())`
          : '0';
    case 23:
      return sumMatch(g, INT, d, env);
    case 24:
    case 25:
      return callSome(g, INT, d, env) ?? I();
    case 26:
      return `match {\n${sub(g, BOOL, d, env)} -> ${I()}\nelse -> ${I()}\n}`;
    case 27: {
      const n = fresh(g, 'n');
      return `match ${sub(g, VIEW, d, env)} {\n${r.one(['"/items/"', '"a"', '""', '"1"'])} ++ decimal(${n}) -> ${n}\n_ -> ${I()}\n}`;
    }
    case 28: {
      const q = fresh(g, 'q');
      return `match isqrt(${I()}) {\nSome(value: ${q}) -> ${q}\nNone -> -1\n}`;
    }
    case 29:
      return `find(v: ${sub(g, VIEW, d, env)}, byte: ${r.one(['44', '97', '0', '32', '195'])}, at: ${smallInt(g, env, d)})`;
    case 30:
      return `find_text(v: ${sub(g, VIEW, d, env)}, sep: ${textLit(g)}, at: ${smallInt(g, env, d)})`;
    case 31:
      return `digits_end(v: ${sub(g, VIEW, d, env)}, at: ${smallInt(g, env, d)})`;
    case 32: {
      const m = fresh(g, 'm');
      return `match get(map: ${sub(g, MAP, d, env)}, key: ${sub(g, VIEW, d, env)}) {\nSome(value: ${m}) -> ${m}\nNone -> ${I()}\n}`;
    }
    case 33: {
      const x = fresh(g, 'x');
      return `fold(${sub(g, L(VIEW), d, env)}, from: ${I()}, by: fn(${x}: Int, w: View) -> Int { ${x} + len(w) })`;
    }
    case 34:
      return `match decimal(${sub(g, VIEW, d, env)}) {\nSome(value: dv) -> dv\nNone -> ${I()}\n}`;
    case 35: {
      const it = fresh(g, 'it');
      return `fold(${sub(g, L(R), d, env)}, from: ${I()}, by: fn(${it}: Int, rr: R) -> Int { ${it} ${r.one(['+', '-', '^'])} rr.a })`;
    }
    case 36:
      return `(${sub(g, VIEW, d, env)} |> len())`;
    case 37:
      return `scan_plain(v: ${sub(g, VIEW, d, env)}, at: ${smallInt(g, env, d)})`;
    case 38:
      return `scan(v: ${sub(g, VIEW, d, env)}, at: ${smallInt(g, env, d)}, set: ${r.one(['"a"', '"\\n"', '"*_[]"', '""', '"<>&"'])})`;
    default:
      return `(${I()} ${r.one(['+', '-', '*'])} ${intLit(g)})`;
  }
}
function boolExpr(g: G, d: number, env: Env): string {
  const { r } = g;
  const cmp = (t: Ty, ops: string[]): string => `${sub(g, t, d, env)} ${r.one(ops)} ${sub(g, t, d, env)}`;
  const ALL = ['<', '<=', '>', '>=', '==', '!='];
  switch (r.int(14)) {
    case 0:
    case 1:
      return cmp(INT, ALL);
    case 2:
      return cmp(FLOAT, ALL);
    case 3: {
      const s = r.one(SCALES);
      // compare across scales too: `1.50 == 1.5`
      return `${sub(g, D(s), d, env)} ${r.one(ALL)} ${sub(g, D(r.chance(2) ? s : r.one(SCALES)), d, env)}`;
    }
    case 4:
      return cmp(VIEW, ['==', '!=']);
    case 5:
      return `not (${sub(g, BOOL, d, env)})`;
    case 6:
      return `(${sub(g, BOOL, d, env)} ${r.one(['and', 'or'])} ${sub(g, BOOL, d, env)})`;
    case 7:
      return `starts_with(v: ${sub(g, VIEW, d, env)}, prefix: ${sub(g, VIEW, d, env)})`;
    case 8:
      return `${sub(g, O(r.one([INT, VIEW])), d, env)} ${r.one(['==', '!='])} None`;
    case 9:
      return `every_byte(v: ${sub(g, VIEW, d, env)}, keep: ${r.one(['is_digit', 'is_lower', 'is_alnum', 'is_space', 'is_hex'])})`;
    case 10:
      return `before(a: ${sub(g, VIEW, d, env)}, b: ${sub(g, VIEW, d, env)})`;
    case 11:
      return `same(a: ${sub(g, VIEW, d, env)}, b: ${sub(g, VIEW, d, env)})`;
    case 12:
      return `${r.one(['is_digit', 'is_upper', 'is_alpha'])}(${sub(g, INT, d, env)})`;
    default:
      return callSome(g, BOOL, d, env) ?? cmp(INT, ALL);
  }
}
function viewExpr(g: G, d: number, env: Env): string {
  const { r } = g;
  const V = (): string => sub(g, VIEW, d, env);
  switch (r.int(26)) {
    case 0:
      return textLit(g);
    case 1:
    case 2:
      return `${V()} ++ ${V()}`;
    case 3:
      return `slice(${V()}, from: ${smallInt(g, env, d)}, to: ${smallInt(g, env, d)})`;
    case 4: {
      const v = fresh(g, 'v');
      return `match ${V()} {\n${v} -> slice(${v}, from: 0, to: min(a: len(${v}), b: ${smallInt(g, env, d)}))\n}`;
    }
    case 5:
      return `${r.one(['until', 'after'])}(v: ${V()}, byte: ${r.one(['44', '61', '38', '32', '0', '97'])})`;
    case 6:
      return `lower(${V()})`;
    case 7:
      return `decimal_text(${sub(g, INT, d, env)})`;
    case 8: {
      const pieces = Array.from({ length: r.between(1, 3) }, () => {
        const t = r.one([INT, FLOAT, D(r.one(SCALES)), VIEW]);
        return `\\(${sub(g, t, Math.min(d, 2), env)})`;
      });
      // a hole holds no text literal: what goes in one is a name or an expression of names and numbers
      return holes(g, pieces, env, d);
    }
    case 9:
      return `join(list: ${sub(g, L(VIEW), d, env)}, sep: ${textLit(g)})`;
    case 10:
      return `freeze(buf: buf() |> write_json(value: ${sub(g, r.one([R, S, L(INT), L(VIEW), L(R)]), d, env)}))`;
    case 11:
      return `freeze(buf: buf() |> write_dec(value: ${sub(g, D(r.one(SCALES)), d, env)}))`;
    case 12:
      return `freeze(buf: buf() |> write_float(value: ${sub(g, FLOAT, d, env)}))`;
    case 13:
      return `freeze(buf: buf() |> write_int(value: ${sub(g, INT, d, env)}) |> push(byte: ${r.one(['32', '0', '255', '233'])}))`;
    case 14:
      return `freeze(buf: buf() |> write_json_string(text: ${V()}))`;
    case 15: {
      const v = fresh(g, 'w');
      return `match ${sub(g, O(VIEW), d, env)} {\nSome(value: ${v}) -> ${v}\nNone -> ${V()}\n}`;
    }
    case 16:
      return `${sub(g, R, d, env)}.b`;
    case 17:
      return sumMatch(g, VIEW, d, env);
    case 18:
    case 19:
      return callSome(g, VIEW, d, env) ?? V();
    case 20:
      return `concat(a: ${V()}, b: ${V()})`;
    case 21:
      return `match form_field(body: ${V()}, name: ${r.one(['"k"', '"x"', '"a"'])}) {\nSome(value: ff) -> ff\nNone -> ${V()}\n}`;
    case 22:
      return `bool_text(${sub(g, BOOL, d, env)})`;
    case 23: {
      const x = fresh(g, 'x');
      return `match ${V()} {\n${r.one(['"a"', '"k="', '"1"', '""'])} ++ ${x} -> ${x}\n${x} -> ${x} ++ ${textLit(g)}\n}`;
    }
    case 24:
      return `freeze(buf: buf() |> write_html(text: ${V()}))`;
    default:
      return `match {\n${sub(g, BOOL, d, env)} -> ${V()}\nelse -> ${V()}\n}`;
  }
}
/** a text with holes: each hole's expression bound to a name first, since a hole holds no text literal */
function holes(g: G, pieces: string[], _env: Env, _d: number): string {
  const names: string[] = [],
    binds: string[] = [];
  for (const p of pieces) {
    const inner = p.slice(2, -1);
    if (/^[a-z][a-z0-9_]*$/.test(inner)) {
      names.push(inner);
      continue;
    }
    const n = fresh(g, 'h');
    binds.push(`${n} = ${inner}`);
    names.push(n);
  }
  const text = `"${names.map(n => `\\(${n})`).join(g.r.one([' ', ',', '', ' | ']))}"`;
  // `match e { n -> … }` names a value inside an expression
  return binds.reduceRight((body, b) => {
    const [n, e] = [b.slice(0, b.indexOf(' = ')), b.slice(b.indexOf(' = ') + 3)];
    return `match ${e} {\n${n} -> ${body}\n}`;
  }, text);
}
function floatExpr(g: G, d: number, env: Env): string {
  const { r } = g;
  const F = (): string => sub(g, FLOAT, d, env);
  switch (r.int(20)) {
    case 0:
    case 1:
      return floatLit(g);
    case 2:
    case 3:
      return `(${F()} ${r.one(['+', '-', '*', '/'])} ${F()})`;
    case 4:
      return `float(${sub(g, INT, d, env)})`;
    case 5:
      return `float(${sub(g, D(r.one(SCALES)), d, env)})`;
    case 6:
      return `${r.one(['floor', 'ceil', 'sqrt', 'abs'])}(${F()})`;
    case 7:
      return `${r.one(['sin', 'cos', 'exp', 'log'])}(${F()})`;
    case 8:
      return r.chance(2) ? `atan2(y: ${F()}, x: ${F()})` : `pow(x: ${F()}, y: ${F()})`;
    case 9:
      return `${r.one(['min', 'max'])}(a: ${F()}, b: ${F()})`;
    case 10: {
      const vs = varsOf(env, FLOAT);
      return vs.length > 0 ? `-${r.one(vs)}` : `(0f - ${F()})`;
    }
    case 11: {
      const p = fresh(g, 'pf');
      return `match parse_float(text: ${sub(g, VIEW, d, env)}) {\nSome(value: ${p}) -> ${p}\nNone -> ${F()}\n}`;
    }
    case 12:
      return `${sub(g, R, d, env)}.d`;
    case 13:
    case 14:
      return callSome(g, FLOAT, d, env) ?? F();
    case 15: {
      const acc = fresh(g, 'acc'),
        x = fresh(g, 'x');
      return `fold(${sub(g, L(INT), d, env)}, from: ${F()}, by: fn(${acc}: Float, ${x}: Int) -> Float { ${acc} ${r.one(['+', '*', '-'])} float(${x}) })`;
    }
    case 16:
      return `match {\n${sub(g, BOOL, d, env)} -> ${F()}\nelse -> ${F()}\n}`;
    default:
      return `(${F()} ${r.one(['+', '-', '*', '/'])} ${floatLit(g)})`;
  }
}
function decExpr(g: G, s: number, d: number, env: Env): string {
  const { r } = g;
  const Dx = (sc = s): string => sub(g, D(sc), d, env);
  switch (r.int(22)) {
    case 0:
    case 1:
      return decLit(g, s);
    case 2:
    case 3:
      return `(${Dx()} ${r.one(['+', '-'])} ${Dx()})`;
    case 4:
      return `(${Dx()} * ${sub(g, INT, d, env)})`;
    case 5: {
      const a = r.int(s + 1);
      return `(${Dx(a)} * ${Dx(s - a)})`;
    }
    case 6: {
      const from = r.int(s + 1);
      return `rescale(x: ${Dx(from)}, to: ${s})`;
    }
    case 7: {
      if (s === 18) return Dx();
      const from = r.between(s + 1, 18);
      return `round(x: ${Dx(from)}, to: ${s}, rounding: ${r.one(ROUNDINGS)})`;
    }
    case 8:
    case 9: {
      // the point moves at most 18 places at once (C14): pick the operands' scales so it does not
      const [a, b] = pair(g, s, r.chance(2) ? 'mul' : 'div');
      const op = a.op;
      return `${op}(a: ${Dx(a.s)}, by: ${b === null ? sub(g, INT, d, env) : Dx(b)}, scale: ${s}, rounding: ${r.one(ROUNDINGS)})`;
    }
    case 10:
      return `dec(n: ${sub(g, INT, d, env)}, scale: ${s})`;
    case 11:
      return r.chance(2) ? `abs(${Dx()})` : `${r.one(['min', 'max'])}(a: ${Dx()}, b: ${Dx()})`;
    case 12:
      return `to_dec(${sub(g, FLOAT, d, env)}, scale: ${s}, rounding: ${r.one(ROUNDINGS)})`;
    case 13: {
      const p = fresh(g, 'pd');
      return `match parse_dec(text: ${sub(g, VIEW, d, env)}, scale: ${s}) {\nSome(value: ${p}) -> ${p}\nNone -> ${Dx()}\n}`;
    }
    case 14: {
      const vs = varsOf(env, D(s));
      return vs.length > 0 ? `-${r.one(vs)}` : `(${decLit(g, s)} - ${Dx()})`;
    }
    case 15:
      return s === 2 ? `${sub(g, R, d, env)}.c` : Dx();
    case 16:
    case 17:
      return callSome(g, D(s), d, env) ?? Dx();
    case 18:
      return `match {\n${sub(g, BOOL, d, env)} -> ${Dx()}\nelse -> ${Dx()}\n}`;
    case 19: {
      const acc = fresh(g, 'acc'),
        x = fresh(g, 'x');
      return `fold(${sub(g, L(INT), d, env)}, from: ${Dx()}, by: fn(${acc}: Dec[${s}], ${x}: Int) -> Dec[${s}] { ${acc} + dec(n: ${x}, scale: ${s}) })`;
    }
    default:
      return s === 2 ? `match ${sub(g, O(D(2)), d, env)} {\nSome(value: od) -> od\nNone -> ${Dx()}\n}` : Dx();
  }
}
/** scales for mul or div at scale s whose point moves at most 18 places: mul's by (sa + sb) - s, div's by s + sb - sa */
function pair(g: G, s: number, op: 'mul' | 'div'): [{ op: string; s: number }, number | null] {
  for (;;) {
    const sa = g.r.one(SCALES),
      sb = g.r.chance(3) ? null : g.r.one(SCALES);
    const moved = op === 'mul' ? sa + (sb ?? 0) - s : s + (sb ?? 0) - sa;
    if (Math.abs(moved) <= 18) return [{ op, s: sa }, sb];
  }
}
function listExpr(g: G, of: Ty, d: number, env: Env): string {
  const { r } = g;
  const Lx = (): string => sub(g, L(of), d, env);
  switch (r.int(10)) {
    case 0:
      return leaf(g, L(of), env);
    case 1:
    case 2:
      return `Cons(head: ${sub(g, of, d, env)}, tail: ${Lx()})`;
    case 3:
      return `reverse(list: ${Lx()})`;
    case 4: {
      const x = fresh(g, 'x');
      return `filter(list: ${Lx()}, keep: fn(${x}: ${tyName(of)}) -> Bool { ${expr(g, BOOL, Math.min(d - 1, 2), [...env, { name: x, ty: of }])} })`;
    }
    case 5: {
      const from = r.one([INT, VIEW, R]),
        x = fresh(g, 'x');
      return `map(list: ${sub(g, L(from), d, env)}, by: fn(${x}: ${tyName(from)}) -> ${tyName(of)} { ${expr(g, of, Math.min(d - 1, 2), [...env, { name: x, ty: from }])} })`;
    }
    case 6:
      if (of.k === 'Int') return `range(from: ${sub(g, INT, d, env)} % 1000, to: ${smallInt(g, env, d)})`;
      return Lx();
    case 7:
      return callSome(g, L(of), d, env) ?? Lx();
    case 8:
      return of.k === 'Int' ? `${sub(g, R, d, env)}.l` : Lx();
    default:
      return `match {\n${sub(g, BOOL, d, env)} -> ${Lx()}\nelse -> ${Lx()}\n}`;
  }
}
function optExpr(g: G, of: Ty, d: number, env: Env): string {
  const { r } = g;
  switch (r.int(6)) {
    case 0:
      return leaf(g, O(of), env);
    case 1:
      return `match ${sub(g, BOOL, d, env)} {\nTrue -> Some(value: ${sub(g, of, d, env)})\nFalse -> ${leaf(g, O(of), env)}\n}`;
    case 2:
      if (of.k === 'Int') return `get(map: ${sub(g, MAP, d, env)}, key: ${sub(g, VIEW, d, env)})`;
      if (of.k === 'View') return `form_field(body: ${sub(g, VIEW, d, env)}, name: ${textLit(g)})`;
      return `parse_dec(text: ${sub(g, VIEW, d, env)}, scale: 2)`;
    case 3:
      return of.k === 'Int' ? `${sub(g, R, d, env)}.e` : leaf(g, O(of), env);
    case 4:
      if (of.k === 'Int')
        return r.chance(2) ? `parse_int(text: ${sub(g, VIEW, d, env)})` : `isqrt(${sub(g, INT, d, env)})`;
      return leaf(g, O(of), env);
    default:
      return callSome(g, O(of), d, env) ?? leaf(g, O(of), env);
  }
}
function mapExpr(g: G, d: number, env: Env): string {
  const { r } = g;
  if (r.chance(4)) return 'empty_map()';
  return `put(map: ${sub(g, MAP, d, env)}, key: ${r.chance(2) ? `"${r.one(['a', 'b', 'c', 'é', ''])}"` : sub(g, VIEW, d, env)}, value: ${sub(g, INT, d, env)})`;
}
function recExpr(g: G, d: number, env: Env): string {
  const { r } = g;
  const E = (t: Ty): string => (d <= 0 ? leaf(g, t, env) : sub(g, t, d, env));
  if (d > 0 && r.chance(3)) {
    // a decode of a record write_json wrote: it must come back as itself
    const v = fresh(g, 'rd'),
      e = fresh(g, 'er');
    return `match decode(json: freeze(buf: buf() |> write_json(value: ${E(R)})), as: R) {\nOk(value: ${v}) -> ${v}\nErr(error: ${e}) -> R(a: len(${e}), b: ${e}, c: 0.00, d: 0f, e: None, l: Nil)\n}`;
  }
  if (d > 0 && r.chance(4)) return callSome(g, R, d, env) ?? `R(a: 0, b: "", c: 0.00, d: 0f, e: None, l: Nil)`;
  return `R(a: ${E(INT)}, b: ${E(VIEW)}, c: ${E(D(2))}, d: ${E(FLOAT)}, e: ${E(O(INT))}, l: ${E(L(INT))})`;
}
function sumExpr(g: G, d: number, env: Env): string {
  const { r } = g;
  switch (r.int(6)) {
    case 0:
      return `A(x: ${sub(g, INT, d, env)})`;
    case 1:
      return `B(y: ${sub(g, VIEW, d, env)}, z: ${sub(g, O(VIEW), d, env)})`;
    case 2:
      return `C(m: ${sub(g, D(2), d, env)}, n: ${sub(g, L(VIEW), d, env)})`;
    case 3: {
      const v = fresh(g, 'sd');
      return `match decode(json: freeze(buf: buf() |> write_json(value: ${sub(g, S, d, env)})), as: S) {\nOk(value: ${v}) -> ${v}\nErr(error) -> B(y: error, z: None)\n}`;
    }
    case 4:
      return callSome(g, S, d, env) ?? 'N';
    default:
      return 'N';
  }
}
function sumMatch(g: G, t: Ty, d: number, env: Env): string {
  const s = sub(g, S, d, env);
  const x = fresh(g, 'sx'),
    y = fresh(g, 'sy'),
    z = fresh(g, 'sz'),
    m = fresh(g, 'sm'),
    n = fresh(g, 'sn');
  const body = (vars: Env): string => expr(g, t, d - 1, [...env, ...vars]);
  return `match ${s} {\nA(x: ${x}) -> ${body([{ name: x, ty: INT }])}\nB(y: ${y}, z: ${z}) -> ${body([
    { name: y, ty: VIEW },
    { name: z, ty: O(VIEW) },
  ])}\nC(m: ${m}, n: ${n}) -> ${body([
    { name: m, ty: D(2) },
    { name: n, ty: L(VIEW) },
  ])}\nN -> ${body([])}\n}`;
}
/** a call of a generated function of result t, its arguments made here; null when there is none */
function callSome(g: G, t: Ty, d: number, env: Env): string | null {
  const fs = g.callable.filter(f => same(f.result, t));
  if (fs.length === 0) return null;
  const f = g.r.one(fs);
  const args = f.params.map(
    (p, i) => `p${i}: ${i === 0 && p.k === 'Int' ? smallInt(g, env, d) : sub(g, p, Math.min(d, 2), env)}`,
  );
  return `${f.name}(${args.join(', ')})`;
}

const RESULTS: Ty[] = [INT, INT, VIEW, FLOAT, D(2), D(0), D(4), BOOL, L(INT), L(VIEW), O(INT), R, S, MAP];
/** a helper: plain, recursive in tail position (an accumulator), or recursive under an operator */
function helper(g: G): void {
  const { r } = g;
  const result = r.one(RESULTS),
    name = fresh(g, 'f'),
    kind = r.int(3);
  const extra = Array.from({ length: r.int(3) }, () => r.one([INT, VIEW, FLOAT, D(2), L(INT), BOOL]));
  const params: Ty[] = [INT, ...extra];
  const env: Env = params.map((p, i) => ({ name: `p${i}`, ty: p }));
  const sig = `fn ${name}(${params.map((p, i) => `p${i}: ${tyName(p)}`).join(', ')}) -> ${tyName(result)}`;
  const rest = extra.map((_p, i) => `p${i + 1}`);
  const lets: string[] = [];
  for (let i = 0, n = r.int(3); i < n; i++) {
    const t = r.one([INT, VIEW, FLOAT, D(2), L(INT), BOOL]),
      v = fresh(g, 'l');
    lets.push(`  let ${v} = ${expr(g, t, 2, env)}`);
    env.push({ name: v, ty: t });
  }
  let body: string;
  if (kind === 0 || g.depthBudget <= 0) body = expr(g, result, 3, env);
  else {
    g.depthBudget--;
    // recursion with fuel p0: p0 counts down to 0, so the call ends (or runs out of steps, also compared)
    // callable only once its body is written: a call of itself anywhere but `again` could start its fuel over
    const self = { name, params, result };
    const again = (): string =>
      `${name}(${['p0 - 1', ...rest.map((p, i) => (r.chance(2) ? p : expr(g, params[i + 1] ?? INT, 1, env)))].map((a, i) => `p${i}: ${a}`).join(', ')})`;
    const base = expr(g, result, 2, env);
    if (kind === 1 && params.length > 1 && same(params[1] ?? INT, result)) {
      // tail recursive: the result is the second parameter carried along
      body = `match {\np0 <= 0 -> p1\nelse -> ${name}(${['p0 - 1', expr(g, result, 2, env), ...rest.slice(1)].map((a, i) => `p${i}: ${a}`).join(', ')})\n}`;
    } else if (result.k === 'Int') {
      body = `match {\np0 <= 0 -> ${base}\nelse -> ${expr(g, INT, 1, env)} ${r.one(['+', '-', '^', '*'])} ${again()}\n}`;
    } else if (result.k === 'List' && result.of.k === 'Int') {
      body = `match {\np0 <= 0 -> ${base}\nelse -> Cons(head: ${expr(g, INT, 1, env)}, tail: ${again()})\n}`;
    } else if (result.k === 'View') {
      body = `match {\np0 <= 0 -> ${base}\nelse -> ${expr(g, VIEW, 1, env)} ++ ${again()}\n}`;
    } else if (result.k === 'Dec') {
      body = `match {\np0 <= 0 -> ${base}\nelse -> ${again()} + ${decLit(g, result.s)}\n}`;
    } else {
      body = `match {\np0 <= 0 -> ${base}\nelse -> ${again()}\n}`;
    }
    g.fns.push(`${sig} {\n${lets.join('\n')}${lets.length > 0 ? '\n' : ''}  ${body}\n}\n`);
    g.callable.push(self);
    return;
  }
  g.fns.push(`${sig} {\n${lets.join('\n')}${lets.length > 0 ? '\n' : ''}  ${body}\n}\n`);
  g.callable.push({ name, params, result });
}

const LET_TYPES: Ty[] = [
  INT,
  INT,
  INT,
  VIEW,
  VIEW,
  FLOAT,
  D(2),
  D(0),
  D(4),
  D(9),
  D(18),
  BOOL,
  L(INT),
  L(VIEW),
  L(R),
  O(INT),
  O(VIEW),
  O(D(2)),
  R,
  S,
  MAP,
];
/** The source of a program whose handle writes every value it computes. */
export function program(seed: number, size = 1): string {
  return parts(seed, size).text;
}
/**
 * The program and the names of its entry points: `handle`, and `part0` … `partN`, each a few lets that build on one
 * another, written into its answer. A trap ends one part's run, not the others', so a program that traps somewhere
 * still checks the rest; handle runs every part in one request, so values are shared and released across them too.
 */
export function parts(seed: number, size = 1): { text: string; entries: string[] } {
  const r = rng(seed);
  const g: G = { r, names: 0, fns: [], callable: [], depthBudget: 2 };
  for (let i = 0, n = r.int(4 + size); i < n; i++) helper(g);
  const bodies: string[] = [],
    entries: string[] = [];
  for (let p = 0, np = 2 + r.int(2 + size); p < np; p++) {
    const env: Env = [{ name: 'raw', ty: VIEW }];
    const lets: string[] = [],
      outs: string[] = [];
    for (let i = 0, n = 1 + r.int(2 + size); i < n; i++) {
      const t = r.one(LET_TYPES),
        v = fresh(g, 'x');
      lets.push(`  let ${v} = ${expr(g, t, r.between(1, 3 + size), env)}`);
      env.push({ name: v, ty: t });
      outs.push(writeOf(v, t));
    }
    const name = `part${p}`;
    entries.push(name);
    bodies.push(
      `fn ${name}(raw: View) -> Buf {\n${lets.join('\n')}\n  buf()\n${outs.map(o => `    |> ${o}`).join('\n')}\n}\n`,
    );
  }
  const handle = `fn handle(raw: View) -> Buf {\n  buf()\n${entries.map(e => `    |> append(view: freeze(buf: ${e}(raw)))`).join('\n')}\n}\n`;
  return {
    text: `${TYPES}\n${HELPERS}\n${g.fns.join('\n')}\n${bodies.join('\n')}\n${handle}`,
    entries: ['handle', ...entries],
  };
}
function writeOf(v: string, t: Ty): string {
  if (PRINTABLE(t)) return `append(view: "${v}=\\(${v});")`;
  if (t.k === 'Bool') return `append(view: bool_text(${v}))`;
  if (t.k === 'Opt')
    return t.of.k === 'View'
      ? `write_json(value: B(y: "", z: ${v}))`
      : t.of.k === 'Int'
        ? `write_json(value: R(a: 0, b: "", c: 0.00, d: 0f, e: ${v}, l: Nil))`
        : `append(view: match ${v} {\nSome(value: ov) -> freeze(buf: buf() |> write_dec(value: ov))\nNone -> "none"\n})`;
  if (t.k === 'Map') return `append(view: "\\(count(map: ${v}))")`;
  return `write_json(value: ${v})`;
}
