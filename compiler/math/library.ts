// compiler/math/library.ts: the math library, a port of musl's (fdlibm's trigonometry, and Arm's exp, log and pow)
// to Wasm, using only Wasm's own f64 operations, which are exactly rounded: so a result is the same bits in Node,
// in a browser and in workerd, and a replay computes what the run computed. Host Math.* is "implementation-
// approximated" (ECMA-262) and differs between engines, so it is never called.
//
// A compiled module holds only the functions its program reaches (compiler/gen/float.ts names them); the
// reference interpreter calls the same functions through a module of their own (standalone, below), so this piece
// of it is not an independent check: test/float-math.ts holds the library to musl, bit for bit, and to mpmath's
// true values (testdata/float/golden.jsonl, written by proof/float_oracle.py).
import { name, section, sleb, uleb, vec } from '../common.ts';
import { assembleBody } from './wasm.ts';
import type { Def, Linker } from './wasm.ts';
import { TRIG } from './trig.ts';
import { INVERSE } from './inverse.ts';
import { EXPLOG } from './explog.ts';

export const LIBRARY: Readonly<Record<string, Def>> = { ...TRIG, ...INVERSE, ...EXPLOG };
/** The functions a program calls by name, with their parameters' names; the rest are their helpers. */
export const PUBLIC: Readonly<Record<string, readonly string[]>> = {
  sin: ['x'],
  cos: ['x'],
  atan2: ['y', 'x'],
  exp: ['x'],
  log: ['x'],
  pow: ['x', 'y'],
};
export const defOf = (n: string): Def => {
  const d = Object.hasOwn(LIBRARY, n) ? LIBRARY[n] : undefined;
  if (!d) throw new Error(`no math function ${n}`);
  return d;
};

/**
 * The library as a module of its own: every public function exported by its name, the helpers they call, the
 * constant tables and the scratch room in one memory. For the interpreter, and for tests (a Worker cannot compile
 * it at run time, so the reference interpreter's math is Node's and the browser's only).
 */
export function standalone(): Uint8Array<ArrayBuffer> {
  const order: string[] = [];
  const index = (n: string): number => {
    defOf(n);
    const k = order.indexOf(n);
    return k >= 0 ? k : order.push(n) - 1;
  };
  const BASE = 1024;
  const data: number[] = [];
  const dataAt = new Map<string, number>();
  const link: Linker = {
    index,
    data: bytes => {
      const k = bytes.join(',');
      const had = dataAt.get(k);
      if (had !== undefined) return had;
      while (data.length % 8) data.push(0);
      const at = BASE + data.length;
      dataAt.set(k, at);
      data.push(...bytes);
      return at;
    },
    scratch: size => {
      while (data.length % 8) data.push(0);
      const at = BASE + data.length;
      data.push(...Array.from({ length: size }, () => 0));
      return at;
    },
  };
  for (const n of Object.keys(PUBLIC).filter(x => Object.hasOwn(LIBRARY, x))) index(n);
  const bodies: number[][] = [];
  for (let k = 0; k < order.length; k++) bodies.push(assembleBody(defOf(order[k] ?? ''), link));
  const sigs: string[] = [];
  const sigOf = (d: Def): number => {
    const s = `${d.params.join(',')}>${d.results.join(',')}`;
    const k = sigs.indexOf(s);
    return k >= 0 ? k : sigs.push(s) - 1;
  };
  const types = order.map(n => sigOf(defOf(n)));
  const typeBytes = sigs.map(s => {
    const [p = '', r = ''] = s.split('>');
    const vts = (t: string): number[] => (t === '' ? [] : t.split(',').map(Number));
    return [0x60, ...vec(vts(p).map(x => [x])), ...vec(vts(r).map(x => [x]))];
  });
  const pages = Math.ceil((BASE + data.length) / 65536);
  const exported = order.flatMap((n, k) => (Object.hasOwn(PUBLIC, n) ? [[...name(n), 0, ...uleb(k)]] : []));
  return new Uint8Array([
    0,
    0x61,
    0x73,
    0x6d,
    1,
    0,
    0,
    0,
    ...section(1, vec(typeBytes)),
    ...section(3, vec(types.map(t => uleb(t)))),
    ...section(5, vec([[0, ...uleb(pages)]])),
    ...section(7, vec(exported)),
    ...section(10, vec(bodies.map(b => [...uleb(b.length), ...b]))),
    ...section(11, vec([[0, 0x41, ...sleb(BASE), 0x0b, ...uleb(data.length), ...data]])),
  ]);
}
