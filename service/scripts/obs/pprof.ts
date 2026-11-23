// obs/pprof.ts: just enough of pprof's protobuf (profile.proto) to read a Workers profile: its functions, locations
// and samples, the time each bucket of the hosted tools takes (buckets()), and naming the frames the source map left
// anonymous (an arrow function's location is its definition line: named from the source there, as
// `<enclosing>.<anon>`). Pure, checked by test/obs.ts; profile.ts writes the files and runs go tool pprof.
import { gunzipSync } from 'node:zlib';

type Field = { f: number; wt: number; n: bigint; bytes: Uint8Array; start: number; end: number };

function varint(b: Uint8Array, i: number): [bigint, number] {
  let r = 0n,
    s = 0n;
  for (;;) {
    const c = b[i++];
    if (c === undefined) throw new Error('truncated varint');
    r |= BigInt(c & 0x7f) << s;
    s += 7n;
    if (c < 0x80) return [r, i];
  }
}
/** The fields of one message, in order, each with where it is in the buffer (to copy it unchanged). */
export function fields(b: Uint8Array): Field[] {
  const out: Field[] = [];
  for (let i = 0; i < b.length;) {
    const start = i;
    const [key, j] = varint(b, i);
    const f = Number(key >> 3n),
      wt = Number(key & 7n);
    i = j;
    let n = 0n,
      bytes: Uint8Array = new Uint8Array(0);
    if (wt === 0) [n, i] = varint(b, i);
    else if (wt === 2) {
      const [len, k] = varint(b, i);
      bytes = b.subarray(k, k + Number(len));
      i = k + Number(len);
    } else if (wt === 1) i += 8;
    else if (wt === 5) i += 4;
    else throw new Error(`wire type ${wt}`);
    if (i > b.length) throw new Error('truncated field');
    out.push({ f, wt, n, bytes, start, end: i });
  }
  return out;
}
/** A repeated integer field: packed (one length-delimited field) or not (one field each). */
const ints = (fs: Field[], f: number): number[] =>
  fs
    .filter(x => x.f === f)
    .flatMap(x => {
      if (x.wt === 0) return [Number(x.n)];
      const out: number[] = [];
      for (let i = 0; i < x.bytes.length;) {
        const [v, j] = varint(x.bytes, i);
        out.push(Number(BigInt.asIntN(64, v)));
        i = j;
      }
      return out;
    });
const one = (fs: Field[], f: number): number => Number(fs.find(x => x.f === f)?.n ?? 0n);

export function encVarint(n: number | bigint): number[] {
  let v = BigInt(n);
  const out: number[] = [];
  do {
    const c = Number(v & 0x7fn);
    v >>= 7n;
    out.push(v > 0n ? c | 0x80 : c);
  } while (v > 0n);
  return out;
}
const encField = (f: number, v: number | Uint8Array): number[] =>
  typeof v === 'number'
    ? [...encVarint((f << 3) | 0), ...encVarint(v)]
    : [...encVarint((f << 3) | 2), ...encVarint(v.length), ...v];

export type Fn = { id: number; name: string; file: string; line: number };
export type Profile = {
  types: { type: string; unit: string }[];
  strings: string[];
  functions: Map<number, Fn>;
  /** each location's functions, innermost first (inlined frames) */
  locations: Map<number, number[]>;
  /** each sample's locations, leaf first, and its values (one per type) */
  samples: { locs: number[]; values: number[] }[];
};
export function decode(raw: Uint8Array): Profile {
  const b = raw[0] === 0x1f && raw[1] === 0x8b ? new Uint8Array(gunzipSync(raw)) : raw;
  const top = fields(b);
  const dec = new TextDecoder();
  const strings = top.filter(x => x.f === 6).map(x => dec.decode(x.bytes));
  const str = (i: number): string => strings[i] ?? '';
  const functions = new Map<number, Fn>();
  for (const x of top.filter(t => t.f === 5)) {
    const fs = fields(x.bytes);
    const id = one(fs, 1);
    functions.set(id, { id, name: str(one(fs, 2)), file: str(one(fs, 4)), line: one(fs, 5) });
  }
  const locations = new Map<number, number[]>();
  for (const x of top.filter(t => t.f === 4)) {
    const fs = fields(x.bytes);
    locations.set(
      one(fs, 1),
      fs.filter(l => l.f === 4).map(l => one(fields(l.bytes), 1)),
    );
  }
  const samples = top
    .filter(t => t.f === 2)
    .map(x => {
      const fs = fields(x.bytes);
      return { locs: ints(fs, 1), values: ints(fs, 2) };
    });
  const types = top
    .filter(t => t.f === 1)
    .map(x => {
      const fs = fields(x.bytes);
      return { type: str(one(fs, 1)), unit: str(one(fs, 2)) };
    });
  return { types, strings, functions, locations, samples };
}

/** A sample's frames, outermost (root) first: each a function's name and file. */
export function stackOf(p: Profile, locs: readonly number[]): Fn[] {
  const out: Fn[] = [];
  for (const l of locs.toReversed())
    for (const f of (p.locations.get(l) ?? []).toReversed()) {
      const fn = p.functions.get(f);
      if (fn) out.push(fn);
    }
  return out;
}

/**
 * Where a sample of the hosted service goes. The rules read the stack from the root: the first frame that decides
 * wins. Durations are the profile's own unit (the value whose unit is nanoseconds or, for heap, bytes).
 */
export function bucketOf(stack: readonly Fn[]): string {
  const leaf = stack.at(-1)?.name ?? '';
  if (leaf === '(garbage collector)') return 'gc';
  if (leaf === '(program)' || leaf === '(idle)' || stack.length <= 1) return 'runtime (program, idle)';
  const has = (name: string, file?: RegExp): number =>
    stack.findIndex(f => f.name === name && (file === undefined || file.test(f.file)));
  const inCompile = stack.findIndex(f => /^\.\.\/(compiler|rules)\/|^\.\.\/compiler\.ts$/.test(f.file));
  const sha = stack.findIndex(f => f.name === 'sha256');
  if (inCompile >= 0) {
    const which =
      has('compiled', /tools\.ts$/) >= 0 && has('compiled', /tools\.ts$/) < inCompile
        ? 'compile'
        : has('runTool') >= 0
          ? 'compile, traced build (line trace)'
          : has('testTool') >= 0
            ? 'compile, doc examples build'
            : 'compile, other';
    return sha >= 0 ? `${which}: sha256` : which;
  }
  for (const [name, b] of [
    ['lineTraceOf', 'line trace rendering'],
    ['otlp', 'OTLP trace rendering'],
    ['joinedOf', 'OTLP trace rendering'],
    ['effectsOut', 'effects rendering'],
    ['resultOf', 'result rendering'],
    ['namesOf', 'result rendering'],
    ['toolResult', 'JSON (tool result)'],
    ['runnerOf', 'runner (Loader, hash, RPC)'],
    ['runIn', 'runner (Loader, hash, RPC)'],
    ['examplesIn', 'runner (Loader, hash, RPC)'],
    ['ipHash', 'ip hash'],
  ] as const)
    if (has(name) >= 0) return b;
  if (stack.some(f => /^JSON\.|stringify|^parse$/.test(f.name) && f.file === '')) return 'JSON';
  if (has('serve', /serve\.ts$/) >= 0) return 'serve, other';
  return 'other';
}
export function buckets(p: Profile): { unit: string; total: number; rows: [string, number][] } {
  let vi = p.types.findIndex(t => t.unit === 'nanoseconds' || t.unit === 'bytes');
  if (vi < 0) vi = p.types.length - 1;
  const by = new Map<string, number>();
  let total = 0;
  for (const s of p.samples) {
    const v = s.values[vi] ?? 0;
    total += v;
    const b = bucketOf(stackOf(p, s.locs));
    by.set(b, (by.get(b) ?? 0) + v);
  }
  return { unit: p.types[vi]?.unit ?? '', total, rows: [...by].toSorted((a, b) => b[1] - a[1]) };
}

// ---- naming anonymous frames from the source

const DECL = [
  /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\(|[A-Za-z_$][\w$]*\s*=>|function)/,
  /(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
  /^\s*([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?\(/,
];
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'return', 'catch', 'function']);
/** The name of what is defined at `line` (1-based) of the source, or `<enclosing>.<anon>` for a closure; null if none. */
export function nameAt(lines: readonly string[], line: number): string | null {
  const t = lines[line - 1];
  if (t === undefined) return null;
  for (const rx of DECL) {
    const m = rx.exec(t);
    if (m?.[1] && !KEYWORDS.has(m[1])) return m[1];
  }
  for (let j = line - 2; j >= 0 && j > line - 120; j--) {
    const s = lines[j] ?? '';
    if (/^\S/.test(s) || /^ {2}\S/.test(s)) {
      const m = (DECL[0] ?? /$^/).exec(s) ?? (DECL[1] ?? /$^/).exec(s);
      if (m?.[1]) return `${m[1]}.<anon>`;
    }
  }
  return null;
}

/** The profile with each unnamed function given a name by `namer` (file, line); every other field byte for byte. */
export function renamed(
  raw: Uint8Array,
  namer: (file: string, line: number) => string | null,
): { out: Uint8Array; n: number } {
  const b = raw[0] === 0x1f && raw[1] === 0x8b ? new Uint8Array(gunzipSync(raw)) : raw;
  const top = fields(b);
  const dec = new TextDecoder(),
    enc = new TextEncoder();
  const strings = top.filter(x => x.f === 6).map(x => dec.decode(x.bytes));
  const added: string[] = [];
  const intern = (s: string): number => {
    const i = strings.indexOf(s);
    if (i >= 0) return i;
    const j = added.indexOf(s);
    if (j >= 0) return strings.length + j;
    added.push(s);
    return strings.length + added.length - 1;
  };
  const out: number[] = [];
  let n = 0;
  for (const x of top) {
    const copy = (): void => {
      for (let i = x.start; i < x.end; i++) out.push(b[i] ?? 0);
    };
    if (x.f !== 5) {
      copy();
      continue;
    }
    const fs = fields(x.bytes);
    const name = strings[one(fs, 2)] ?? '',
      file = strings[one(fs, 4)] ?? '',
      line = one(fs, 5);
    const real = name === '' && file !== '' ? namer(file, line) : null;
    if (real === null) {
      copy();
      continue;
    }
    n++;
    const id = intern(real);
    const body = fs.flatMap(f => (f.f === 2 || f.f === 3 ? encField(f.f, id) : [...x.bytes.subarray(f.start, f.end)]));
    if (!fs.some(f => f.f === 2)) body.push(...encField(2, id));
    out.push(...encField(5, new Uint8Array(body)));
  }
  for (const s of added) out.push(...encField(6, enc.encode(s)));
  return { out: new Uint8Array(out), n };
}
