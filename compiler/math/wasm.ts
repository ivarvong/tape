// compiler/math/wasm.ts: a small typed builder of Wasm function bodies, for the math library (compiler/math/*.ts),
// which is written in it the way musl's C is written: locals, the 32-bit halves of a double, if/else, loops.
// Each expression carries its Wasm type, and an operator given the wrong one throws while the library is built,
// so a slip in a port is a build error and not a module that fails to validate.
import { F64, I32, I64, f64 as f64Const, sleb, uleb } from '../common.ts';

export type VT = typeof F64 | typeof I32 | typeof I64;
/** An expression: its type and its code. */
export type E = { readonly t: VT; readonly c: readonly number[] };
/** A local: an expression that reads it, and its index. */
export type Local = E & { readonly i: number };

/**
 * What a body is built against: the index of another function of the library (naming one puts it in the module),
 * where constant data is (the same bytes are kept once), and room of its own the function may write in.
 */
export type Linker = {
  index: (name: string) => number;
  data: (bytes: readonly number[]) => number;
  scratch: (size: number) => number;
};
/** One function of the library: its parameter and result types, and its body. */
export type Def = {
  readonly params: readonly VT[];
  readonly results: readonly VT[];
  readonly body: (b: Body) => void;
};

const NAME: Record<VT, string> = { [F64]: 'f64', [I32]: 'i32', [I64]: 'i64' };
const same = (op: string, ...es: E[]): VT => {
  const [first] = es;
  if (!first || es.some(e => e.t !== first.t)) throw new TypeError(`${op}: ${es.map(e => NAME[e.t]).join(', ')}`);
  return first.t;
};
const want = (op: string, t: VT, e: E): void => {
  if (e.t !== t) throw new TypeError(`${op} takes ${NAME[t]}, not ${NAME[e.t]}`);
};
const op = (t: VT, opcode: number | readonly number[], ...es: E[]): E => ({
  t,
  c: [...es.flatMap(e => e.c), ...(typeof opcode === 'number' ? [opcode] : opcode)],
});

// ---- constants
export const f = (x: number): E => ({ t: F64, c: f64Const(x) });
export const i = (n: number): E => ({ t: I32, c: [0x41, ...sleb(n | 0)] });
export const l = (n: bigint): E => ({ t: I64, c: [0x42, ...sleb(BigInt.asIntN(64, n))] });
/** A C hex float, `0x1.62e42fefa0000p-8`: exact, as the digits say. */
export function hex(s: string): number {
  const m = /^(-?)0x([0-9a-f]+)(?:\.([0-9a-f]*))?p([+-]?\d+)$/i.exec(s);
  if (!m) throw new SyntaxError(`not a hex float: ${s}`);
  const [, sign = '', whole = '', frac = '', exp = '0'] = m;
  const digits = BigInt(`0x${whole}${frac}`);
  const v = Number(digits) * 2 ** (Number(exp) - 4 * frac.length);
  if (BigInt(Number(digits)) !== digits) throw new RangeError(`more digits than a double holds: ${s}`);
  return sign ? -v : v;
}
/** The double whose bits are `u`. */
export function asDouble(u: bigint): number {
  const d = new DataView(new ArrayBuffer(8));
  d.setBigUint64(0, BigInt.asUintN(64, u));
  return d.getFloat64(0);
}

// ---- arithmetic and comparison, by the operands' type
type ByType = Partial<Record<VT, number>>;
const by =
  (name: string, codes: ByType, result?: VT) =>
  (a: E, b: E): E => {
    const t = same(name, a, b);
    const code = codes[t];
    if (code === undefined) throw new TypeError(`${name} has no ${NAME[t]} form`);
    return op(result ?? t, code, a, b);
  };
export const add = by('add', { [F64]: 0xa0, [I32]: 0x6a, [I64]: 0x7c });
export const sub = by('sub', { [F64]: 0xa1, [I32]: 0x6b, [I64]: 0x7d });
export const mul = by('mul', { [F64]: 0xa2, [I32]: 0x6c, [I64]: 0x7e });
export const div = by('div', { [F64]: 0xa3, [I32]: 0x6d, [I64]: 0x7f });
export const divU = by('divU', { [I32]: 0x6e, [I64]: 0x80 });
export const remU = by('remU', { [I32]: 0x70, [I64]: 0x82 });
export const and = by('and', { [I32]: 0x71, [I64]: 0x83 });
export const or = by('or', { [I32]: 0x72, [I64]: 0x84 });
export const xor = by('xor', { [I32]: 0x73, [I64]: 0x85 });
export const shl = by('shl', { [I32]: 0x74, [I64]: 0x86 });
export const shrS = by('shrS', { [I32]: 0x75, [I64]: 0x87 });
export const shrU = by('shrU', { [I32]: 0x76, [I64]: 0x88 });
export const eq = by('eq', { [F64]: 0x61, [I32]: 0x46, [I64]: 0x51 }, I32);
export const ne = by('ne', { [F64]: 0x62, [I32]: 0x47, [I64]: 0x52 }, I32);
export const lt = by('lt', { [F64]: 0x63, [I32]: 0x48, [I64]: 0x53 }, I32);
export const gt = by('gt', { [F64]: 0x64, [I32]: 0x4a, [I64]: 0x55 }, I32);
export const le = by('le', { [F64]: 0x65, [I32]: 0x4c, [I64]: 0x57 }, I32);
export const ge = by('ge', { [F64]: 0x66, [I32]: 0x4e, [I64]: 0x59 }, I32);
export const ltU = by('ltU', { [I32]: 0x49, [I64]: 0x54 }, I32);
export const gtU = by('gtU', { [I32]: 0x4b, [I64]: 0x56 }, I32);
export const leU = by('leU', { [I32]: 0x4d, [I64]: 0x58 }, I32);
export const geU = by('geU', { [I32]: 0x4f, [I64]: 0x5a }, I32);

const unary =
  (name: string, t: VT, code: number | readonly number[], result: VT = t) =>
  (a: E): E => {
    want(name, t, a);
    return op(result, code, a);
  };
export const neg = unary('neg', F64, 0x9a);
export const abs = unary('abs', F64, 0x99);
export const sqrt = unary('sqrt', F64, 0x9f);
export const floor = unary('floor', F64, 0x9c);
export const eqz = (a: E): E => op(I32, a.t === I64 ? 0x50 : 0x45, a);
/** The leading zero bits of an i64 (64 for 0). */
export const clz = unary('clz', I64, 0x79);
/** (double)u for an unsigned i64, rounded to the nearest (a tie to the even one). */
export const toFU = unary('toFU', I64, 0xba, F64);
/** (double)n for an i32, an i64; (int32_t)x and (int64_t)x for a double in range (else the module traps). */
export const toF = (a: E): E => op(F64, a.t === I64 ? 0xb9 : 0xb7, a);
export const toI32 = unary('toI32', F64, 0xaa, I32);
/** The bits of a double, and the double of bits. */
export const bits = unary('bits', F64, 0xbd, I64);
export const double = unary('double', I64, 0xbf, F64);
export const wrap = unary('wrap', I64, 0xa7, I32);
export const extU = unary('extU', I32, 0xad, I64);
export const extS = unary('extS', I32, 0xac, I64);
/** The high and low 32 bits of a double (GET_HIGH_WORD, GET_LOW_WORD). */
export const hi = (x: E): E => wrap(shrU(bits(x), l(32n)));
export const lo = (x: E): E => wrap(bits(x));
/** The double with these 32-bit halves (INSERT_WORDS). */
export const words = (h: E, w: E): E => double(or(shl(extU(h), l(32n)), extU(w)));
/** a if c else b, both computed. */
export const select = (c: E, a: E, b: E): E => {
  want('select', I32, c);
  return op(same('select', a, b), 0x1b, a, b, c);
};
/** p[0] + x*(p[1] + x*(p[2] + …)): Horner's rule, as C writes it. */
export const poly = (x: E, cs: readonly number[]): E =>
  cs.reduceRight<E | null>((acc, k) => (acc ? add(f(k), mul(x, acc)) : f(k)), null) ?? f(0);
/** Memory at an address: a double, an i32, an i64. */
export const loadF = (at: E, offset = 0): E => op(F64, [0x2b, 3, ...uleb(offset)], at);
export const loadI = (at: E, offset = 0): E => op(I32, [0x28, 2, ...uleb(offset)], at);
export const loadL = (at: E, offset = 0): E => op(I64, [0x29, 3, ...uleb(offset)], at);

// ---- a body: its locals, and statements written in order
export class Body {
  readonly code: number[] = [];
  readonly locals: VT[] = [];
  readonly params: Local[];
  readonly link: Linker;
  readonly results: readonly VT[];
  private readonly labels: (string | null)[] = [];
  constructor(def: Def, link: Linker) {
    this.params = def.params.map((t, k) => ({ t, i: k, c: [0x20, ...uleb(k)] }));
    this.results = def.results;
    this.link = link;
  }
  /** Parameter k. */
  p(k: number): Local {
    const v = this.params[k];
    if (!v) throw new RangeError(`no parameter ${k}`);
    return v;
  }
  /** A new local, set to `init` when given. */
  local(t: VT, init?: E): Local {
    const k = this.params.length + this.locals.length;
    this.locals.push(t);
    const v: Local = { t, i: k, c: [0x20, ...uleb(k)] };
    if (init) this.set(v, init);
    return v;
  }
  let(init: E): Local {
    return this.local(init.t, init);
  }
  set(v: Local, e: E): void {
    want('set', v.t, e);
    this.code.push(...e.c, 0x21, ...uleb(v.i));
  }
  /** Several locals from a call that gives several values. */
  setAll(vs: readonly Local[], name: string, ...args: E[]): void {
    this.code.push(...args.flatMap(a => a.c), 0x10, ...uleb(this.link.index(name)));
    for (const v of vs.toReversed()) this.code.push(0x21, ...uleb(v.i));
  }
  ret(...es: E[]): void {
    es.forEach((e, k) => want('return', this.results[k] ?? I32, e));
    this.code.push(...es.flatMap(e => e.c), 0x0f);
  }
  private nested(kind: number, label: string | null, inner: () => void): void {
    this.code.push(kind, 0x40);
    this.labels.push(label);
    inner();
    this.labels.pop();
    this.code.push(0x0b);
  }
  if(c: E, then: () => void, otherwise?: () => void): void {
    want('if', I32, c);
    this.code.push(...c.c, 0x04, 0x40);
    this.labels.push(null);
    then();
    if (otherwise) {
      this.code.push(0x05);
      otherwise();
    }
    this.labels.pop();
    this.code.push(0x0b);
  }
  /** `block name { … }`: `br(name)` leaves it. */
  block(name: string, inner: () => void): void {
    this.nested(0x02, name, inner);
  }
  /** `loop name { … }`: `br(name)` starts it again. */
  loop(name: string, inner: () => void): void {
    this.nested(0x03, name, inner);
  }
  private depth(name: string): number {
    const k = this.labels.lastIndexOf(name);
    if (k < 0) throw new Error(`no label ${name}`);
    return this.labels.length - 1 - k;
  }
  br(name: string): void {
    this.code.push(0x0c, ...uleb(this.depth(name)));
  }
  brIf(name: string, c: E): void {
    want('brIf', I32, c);
    this.code.push(...c.c, 0x0d, ...uleb(this.depth(name)));
  }
  /** `while (c) { … }` */
  while(c: E, inner: () => void): void {
    const n = `while${this.labels.length}`;
    this.block(`${n}.end`, () => {
      this.loop(n, () => {
        this.brIf(`${n}.end`, eqz(c));
        inner();
        this.br(n);
      });
    });
  }
  store(at: E, v: E, offset = 0): void {
    want('store at', I32, at);
    const code = v.t === F64 ? [0x39, 3] : v.t === I64 ? [0x37, 3] : [0x36, 2];
    this.code.push(...at.c, ...v.c, ...code, ...uleb(offset));
  }
  call(name: string, results: VT, ...args: E[]): E {
    return { t: results, c: [...args.flatMap(a => a.c), 0x10, ...uleb(this.link.index(name))] };
  }
  /** Constant data placed in memory: its address, as an i32. */
  data(bytes: readonly number[]): E {
    return i(this.link.data(bytes));
  }
}

/** A body's bytes as the code section holds them: its locals, run-length, then its code. */
export function assembleBody(def: Def, link: Linker): number[] {
  const b = new Body(def, link);
  def.body(b);
  const runs: [number, VT][] = [];
  for (const t of b.locals) {
    const last = runs.at(-1);
    if (last?.[1] === t) last[0]++;
    else runs.push([1, t]);
  }
  // a body ends by returning: what is left after the last statement is never reached
  return [...uleb(runs.length), ...runs.flatMap(([n, t]) => [...uleb(n), t]), ...b.code, 0x00, 0x0b];
}

/** Doubles as the bytes memory holds them, little-endian. */
export const doubles = (xs: readonly number[]): number[] => {
  const d = new DataView(new ArrayBuffer(8 * xs.length));
  xs.forEach((x, k) => {
    d.setFloat64(8 * k, x, true);
  });
  return [...new Uint8Array(d.buffer)];
};
export const words64 = (xs: readonly bigint[]): number[] => {
  const d = new DataView(new ArrayBuffer(8 * xs.length));
  xs.forEach((x, k) => {
    d.setBigUint64(8 * k, BigInt.asUintN(64, x), true);
  });
  return [...new Uint8Array(d.buffer)];
};
export const ints32 = (xs: readonly number[]): number[] => {
  const d = new DataView(new ArrayBuffer(4 * xs.length));
  xs.forEach((x, k) => {
    d.setInt32(4 * k, x, true);
  });
  return [...new Uint8Array(d.buffer)];
};
export { F64, I32, I64 };
