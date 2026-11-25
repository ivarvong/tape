// scan(v, at, set) and scan_plain(v, at): one loop (compiler/gen/scan.ts). scan_plain is that loop for the bytes that
// end a JSON string's plain run. Against a Tape byte loop and a byte loop here, under three builds and the
// interpreter; the step count (one per 16 bytes read, rounded up) under the builds that inline and that do not;
// the traps for `at` outside 0..len.
import '../node25.ts';
import { compile } from '../compiler.ts';
import type { Options } from '../compiler.ts';
import { JSON_PLAIN, hasByte } from '../compiler/byteset.ts';
import { lex } from '../compiler/lex.ts';
import { interpret, Trap } from '../interp.ts';
import { std } from '../std.ts';
import { bare, codes, finish, handleBare, same, answered } from './harness.ts';

const BS = String.fromCodePoint(92);
const QT = String.fromCodePoint(34);
/** A text literal whose bytes are these. A byte a literal cannot spell is refused here, not guessed. */
function tapeText(bytes: readonly number[]): string {
  let s = QT;
  for (const b of bytes) {
    if (b === 34) s += BS + QT;
    else if (b === 92) s += BS + BS;
    else if (b === 10) s += `${BS}n`;
    else if (b === 13) s += `${BS}r`;
    else if (b === 9) s += `${BS}t`;
    else if (b === 8) s += `${BS}b`;
    else if (b === 12) s += `${BS}f`;
    else if (b >= 32 && b < 127) s += String.fromCodePoint(b);
    else throw new Error(`cannot spell byte ${b}`);
  }
  return s + QT;
}
const spelled = (literal: string): readonly number[] | null => {
  const tok = lex('set.tape', `fn f() -> Int {\n  ${literal}\n}\n`).find(t => t.t === 'str');
  return tok?.t === 'str' ? tok.v : null;
};

type SetSpec = { name: string; bytes: readonly number[]; literal?: string };
const literalOf = (s: SetSpec): string => s.literal ?? tapeText(s.bytes);
const latin = 'àáâãäåæçèéêëìíîï';
const SETS: SetSpec[] = [
  { name: 'empty', bytes: [] },
  { name: 'a', bytes: [97] },
  { name: 'aaa', bytes: [97, 97, 97] },
  { name: 'a-nl', bytes: [97, 10] },
  { name: 'ba', bytes: [98, 97] },
  { name: 'ab', bytes: [97, 98] },
  { name: 'specials', bytes: [92, 96, 60, 91, 93] },
  { name: 'plains', bytes: [92, 96, 42, 95, 91, 33, 60, 10] },
  { name: 'html', bytes: [38, 60, 62, 34] },
  { name: 'sixteen', bytes: Array.from({ length: 16 }, (_, i) => 97 + i) },
  { name: 'seventeen', bytes: Array.from({ length: 17 }, (_, i) => 97 + i) },
  { name: 'eacute', bytes: [195, 169], literal: '"é"' },
  { name: 'latin15', bytes: [...new TextEncoder().encode(latin.slice(0, 15))], literal: `"${latin.slice(0, 15)}"` },
  { name: 'latin16', bytes: [...new TextEncoder().encode(latin)], literal: `"${latin}"` },
];
for (const s of SETS) {
  const got = spelled(literalOf(s));
  const want = [...new Set(s.bytes)].toSorted((x, y) => x - y);
  const have = got === null ? null : [...new Set(got)].toSorted((x, y) => x - y);
  same(`the literal of ${s.name} is its bytes`, have, want);
}

const cond = (bytes: readonly number[]): string =>
  bytes.length === 0 ? 'False' : [...new Set(bytes)].map(b => `v[at] == ${b}`).join(' or ');
const differ = SETS.map(
  (s, i) => `fn slow${i}(v: View, at: Int) -> Int {
  match {
    at >= len(v) or ${cond(s.bytes)} -> at
    else -> slow${i}(v, at: at + 1)
  }
}

fn each${i}(v: View, at: Int, out: Buf) -> Buf {
  match {
    at > len(v) -> out
    slow${i}(v, at) != scan(v, at, set: ${literalOf(s)}) -> out |> push(byte: 33)
    else -> each${i}(v, at: at + 1, out: out |> write_int(value: scan(v, at, set: ${literalOf(s)})) |> push(byte: 32))
  }
}

fn one${i}(out: Buf, v: View) -> Buf {
  each${i}(v, at: 0, out) |> push(byte: 124)
}
`,
).join('\n');
const program = `${differ}
fn handle(raw: View) -> Response {
  buf() ${SETS.map((_, i) => `|> one${i}(v: raw)`).join(' ')} |> respond(status: 200)
}
`;

/** The body of a 200 answer, as answerText pictures it. */
const bodyOf = (answer: string): string => answer.replace(/^200\n/, '');
/** What a byte loop answers at every offset, the fast answers separated by |. */
function expect(v: Uint8Array): string {
  return SETS.map(s => {
    const set = new Set(s.bytes);
    let out = '';
    for (let at = 0; at <= v.length; at++) {
      let i = at;
      while (i < v.length && !set.has(v[i] ?? -1)) i++;
      out += `${i} `;
    }
    return `${out}|`;
  }).join('');
}
/** Where the answers break the scan's meaning, or null. */
function broken(v: Uint8Array, text: string): string | null {
  const parts = text.split('|');
  if (parts.length !== SETS.length + 1) return `sections ${parts.length}`;
  for (let s = 0; s < SETS.length; s++) {
    const set = new Set(SETS[s]?.bytes ?? []);
    const nums = (parts[s] ?? '')
      .split(' ')
      .filter(x => x !== '')
      .map(Number);
    if (nums.length !== v.length + 1) return `${SETS[s]?.name} has ${nums.length} answers`;
    for (let at = 0; at < nums.length; at++) {
      const end = nums[at] ?? -1;
      if (end < at || end > v.length) return `${SETS[s]?.name} at ${at} ends at ${end}`;
      if (end < v.length && !set.has(v[end] ?? -1)) return `${SETS[s]?.name} at ${at} stops on ${v[end]}`;
      for (let k = at; k < end; k++) if (set.has(v[k] ?? -1)) return `${SETS[s]?.name} at ${at} passed ${k}`;
    }
  }
  return null;
}

const stops = [0, 10, 33, 34, 38, 42, 60, 62, 91, 92, 93, 95, 96, 97, 113, 120, 127, 128, 169, 195, 255];
const texts: Uint8Array[] = [new Uint8Array()];
for (let n = 1; n <= 40; n++) {
  const b = new Uint8Array(n).fill(120);
  b[n - 1] = stops[n % stops.length] ?? 120;
  texts.push(b);
}
for (const pos of [0, 15, 16, 17, 31, 32]) {
  const marked = new Uint8Array(40).fill(120);
  marked[pos] = 60;
  texts.push(marked);
  const short = new Uint8Array(pos + 1).fill(32);
  short[pos] = 97;
  texts.push(short);
}
texts.push(
  new Uint8Array(40).fill(97),
  Uint8Array.from({ length: 40 }, (_, i) => (i * 7) & 255),
);
let seed = 11;
const rand = (n: number): number => {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return (seed >>> 8) % n;
};
for (let k = 0; k < 40; k++) texts.push(Uint8Array.from({ length: rand(49) }, () => rand(256)));

const builds: [string, Partial<Options>][] = [
  ['default', {}],
  ['no reuse', { reuse: false }],
  ['tail calls off', { tailCalls: false }],
];
const sources = [...std, { name: 'scan.tape', text: program }];
for (const [label, o] of builds) {
  const r = compile(sources, { ...o, exports: ['handle'] });
  if (!r.wasm) throw new Error(`${label}: ${r.errors.map(e => e.message).join('; ')}`);
  const b = bare(new WebAssembly.Module(r.wasm));
  let agree = 0;
  const bad: string[] = [];
  for (const v of texts) {
    const got = bodyOf(handleBare(b, v));
    if (got !== expect(v)) {
      if (bad.length < 2) bad.push(`${got.slice(0, 80)} wanted ${expect(v).slice(0, 80)}`);
      continue;
    }
    const why = broken(v, got);
    if (why !== null) {
      if (bad.length < 2) bad.push(why);
      continue;
    }
    agree++;
  }
  same(`${label}: scan against a Tape byte loop on ${texts.length} texts`, agree, texts.length);
  same(`${label}: no property broke`, bad, []);
}
const it = interpret(sources);
let interpAgree = 0;
for (const v of texts.slice(0, 24)) if (bodyOf(answered(it.handle(v))) === expect(v)) interpAgree++;
same('the interpreter: scan against the byte loop on 24 texts', interpAgree, 24);

const part = (text: string, name: string): string => text.split('|')[SETS.findIndex(s => s.name === name)] ?? '';
const sample = bodyOf(
  handleBare(
    bare(
      new WebAssembly.Module(
        (() => {
          const r = compile(sources, { exports: ['handle'] });
          if (!r.wasm) throw new Error(r.errors.map(e => e.message).join('; '));
          return r.wasm;
        })(),
      ),
    ),
    new Uint8Array(24).fill(120),
  ),
);
same('a repeated byte is one member', part(sample, 'a'), part(sample, 'aaa'));
same('the order of a set does not change the answer', part(sample, 'ba'), part(sample, 'ab'));

// ---- steps: one per 16 bytes read, rounded up, on top of a recursive function's own entries
const steps = `fn go(raw: View) -> Int {
  scan(raw, at: 0, set: "a")
}

fn plain(raw: View) -> Int {
  scan_plain(raw, at: 0)
}

fn empty_set(raw: View) -> Int {
  scan(raw, at: 0, set: "")
}

fn at_end(raw: View) -> Int {
  scan(raw, at: len(raw), set: "a")
}

fn past(raw: View) -> Int {
  scan(raw, at: len(raw) + 1, set: "a")
}

fn minus(raw: View) -> Int {
  scan(raw, at: -1, set: "a")
}

fn plain_past(raw: View) -> Int {
  scan_plain(raw, at: len(raw) + 1)
}

fn plain_minus(raw: View) -> Int {
  scan_plain(raw, at: -1)
}

fn walk(raw: View) -> Int {
  visit(raw, at: 0)
}

fn visit(v: View, at: Int) -> Int {
  let e = scan(v, at, set: "b")
  match {
    e >= len(v) -> e
    else -> visit(v, at: e + 1)
  }
}
`;
const fill = (n: number, byte = 120): Uint8Array => new Uint8Array(n).fill(byte);
const withByte = (n: number, at: number, byte: number): Uint8Array => {
  const b = fill(n);
  b[at] = byte;
  return b;
};
type StepCase = { fn: string; bytes: Uint8Array; value: string; steps: number };
const STEP_CASES: StepCase[] = [
  { fn: 'go', bytes: fill(0), value: '0', steps: 0 },
  { fn: 'go', bytes: fill(1, 97), value: '0', steps: 1 },
  { fn: 'go', bytes: fill(16), value: '16', steps: 1 },
  { fn: 'go', bytes: fill(17), value: '17', steps: 2 },
  { fn: 'go', bytes: withByte(16, 15, 97), value: '15', steps: 1 },
  { fn: 'go', bytes: withByte(17, 16, 97), value: '16', steps: 2 },
  { fn: 'plain', bytes: fill(0), value: '0', steps: 0 },
  { fn: 'plain', bytes: Uint8Array.of(34), value: '0', steps: 1 },
  { fn: 'plain', bytes: fill(32), value: '32', steps: 2 },
  { fn: 'plain', bytes: fill(33), value: '33', steps: 3 },
  { fn: 'empty_set', bytes: fill(0), value: '0', steps: 0 },
  { fn: 'empty_set', bytes: fill(16), value: '16', steps: 1 },
  { fn: 'empty_set', bytes: fill(17), value: '17', steps: 2 },
  { fn: 'at_end', bytes: fill(4), value: '4', steps: 0 },
  { fn: 'walk', bytes: fill(32), value: '32', steps: 3 },
  { fn: 'walk', bytes: Uint8Array.of(97), value: '1', steps: 2 },
  { fn: 'walk', bytes: Uint8Array.of(98), value: '1', steps: 3 },
  { fn: 'walk', bytes: Uint8Array.of(98, 120, 98), value: '3', steps: 5 },
  { fn: 'past', bytes: fill(0), value: 'trap 3', steps: 0 },
  { fn: 'minus', bytes: fill(3), value: 'trap 3', steps: 0 },
  { fn: 'plain_past', bytes: fill(2), value: 'trap 3', steps: 0 },
  { fn: 'plain_minus', bytes: fill(0), value: 'trap 3', steps: 0 },
];
const STEP_EXPORTS = ['go', 'plain', 'empty_set', 'at_end', 'past', 'minus', 'plain_past', 'plain_minus', 'walk'];
type Exports = WebAssembly.Instance['exports'];
const globalOf = (ex: Exports, name: string): WebAssembly.Global => {
  const g = ex[name];
  if (!(g instanceof WebAssembly.Global)) throw new TypeError(`no global ${name}`);
  return g;
};
function runInt(ex: Exports, fn: string, bytes: Uint8Array): { value: string; steps: number } {
  const reset = ex['reset'],
    alloc = ex['alloc'],
    f = ex[fn],
    memory = ex['memory'];
  if (typeof reset !== 'function' || typeof alloc !== 'function' || typeof f !== 'function')
    throw new TypeError(`no ${fn}`);
  if (!(memory instanceof WebAssembly.Memory)) throw new TypeError('no memory');
  reset();
  const at = Number(alloc(bytes.length));
  if (bytes.length > 0) new Uint8Array(memory.buffer, at, bytes.length).set(bytes);
  let value: string;
  try {
    value = String(f(at, bytes.length));
  } catch {
    value = `trap ${Number(globalOf(ex, 'why').value)}`;
  }
  return { value, steps: Number(globalOf(ex, 'cost').value) };
}
function instance(text: string, exports: string[], o: Partial<Options> = {}): Exports {
  const r = compile([...std, { name: 'steps.tape', text }], { ...o, exports });
  if (!r.wasm) throw new Error(r.errors.map(e => `${e.code}:${e.line} ${e.message}`).join('; '));
  return new WebAssembly.Instance(new WebAssembly.Module(r.wasm), {
    env: { float_text: (): number => 0, float_of: (): number => 0 },
  }).exports;
}
const stepBuilds: [string, Partial<Options>][] = [
  ['default', {}],
  ['no inline, steps in the global', { inline: false, localSteps: false }],
  ['tail calls off', { tailCalls: false }],
  ['checked', { check: true }],
];
const ran = stepBuilds.map(([label, o]) => ({ label, ex: instance(steps, STEP_EXPORTS, o) }));
for (const c of STEP_CASES) {
  const got = ran.map(b => runInt(b.ex, c.fn, c.bytes));
  same(
    `${c.fn} on ${c.bytes.length} bytes is ${c.value} in ${c.steps} steps, on every build`,
    got.map(g => `${g.value} @${g.steps}`),
    ran.map(() => `${c.value} @${c.steps}`),
  );
}
const free = instance(steps, STEP_EXPORTS, { reductions: false });
same('with the step count off, a long scan costs nothing', runInt(free, 'go', fill(100)), {
  value: '100',
  steps: 0,
});
const limit0 = instance(steps, STEP_EXPORTS, { reductionLimit: 0 });
same('a scan that reads nothing is within a limit of 0', runInt(limit0, 'go', fill(0)), { value: '0', steps: 0 });
same('a scan that reads a byte passes a limit of 0', runInt(limit0, 'go', fill(1, 97)).value, 'trap 2');
const limit1 = instance(steps, STEP_EXPORTS, { reductionLimit: 1 });
same('16 bytes read is one step, inside a limit of 1', runInt(limit1, 'go', fill(16)), { value: '16', steps: 1 });
same('17 bytes read is two steps, past a limit of 1', runInt(limit1, 'go', fill(17)).value, 'trap 2');

const stepIt = interpret([...std, { name: 'steps.tape', text: steps }]);
let stepInterp = 0;
for (const c of STEP_CASES) {
  if (c.value.startsWith('trap')) {
    try {
      stepIt.call(c.fn, [c.bytes]);
    } catch (e) {
      if (e instanceof Trap && `trap ${e.code}` === c.value) stepInterp++;
    }
  } else {
    const got = stepIt.call(c.fn, [c.bytes]);
    if (typeof got === 'bigint' && String(got) === c.value) stepInterp++;
  }
}
same('the interpreter agrees on the answers, traps included', stepInterp, STEP_CASES.length);

// ---- a set that is not a text literal
const handle = (body: string): string => `fn handle(raw: View) -> Response {\n  ${body}\n  empty(status: 200)\n}\n`;
same('a computed set is C93', codes(handle('let n = scan(raw, at: 0, set: raw)')), ['C93:2']);
same('a hole in the set is C93', codes(handle(`let n = scan(raw, at: 0, set: "a${BS}(raw)")`)), ['C93:2']);
same('a joined set is C93', codes(handle('let n = scan(raw, at: 0, set: "ab" ++ raw)')), ['C93:2']);
same('a missing set is C13', codes(handle('let n = scan(raw, at: 0)')), ['C13:2']);
const shadow = `fn scan(v: View, at: Int, set: View) -> Int {\n  at\n}\nfn go(raw: View) -> Int {\n  scan(v: raw, at: 1, set: "a")\n}\n`;
same('a program may define its own scan', codes(shadow, { exports: ['go'] }), []);
const shadowed = instance(shadow, ['go']);
same('its own scan is the one that runs', runInt(shadowed, 'go', fill(4)).value, '1');
// the built-in qualifies the program's calls to `file.scan`. That name has to stay the recursive function:
// without it, corpus/md.tape's render went from 63,515 steps to 52,851 (same HTML) because `inline`, `code_at`
// and `run_at` no longer counted (seen failing).
const recur = `fn scan(n: Int) -> Int {
  match {
    n <= 0 -> 0
    else -> scan(n: n - 1)
  }
}
fn go() -> Int {
  scan(n: 10)
}
`;
const rec = instance(recur, ['go']);
const recGo = rec['go'],
  recReset = rec['reset'];
if (typeof recGo !== 'function' || typeof recReset !== 'function') throw new TypeError('no go');
recReset();
same(
  'a program function named scan counts each entry',
  [String(recGo()), Number(globalOf(rec, 'cost').value)],
  ['0', 11],
);
// A program's own scan takes its first argument with no name, like any function of the program: the built-in
// qualifies the call to `file.scan`, and that name's parameters are the program's (pipes.ts). It was C11, "function
// scan has no parameter raw", when the argument's name was not the parameter's, and C10 for an expression.
const positional = (arg: string): string =>
  `fn scan(v: View, at: Int) -> Int {\n  len(v) + at\n}\nfn go(raw: View) -> Int {\n  scan(${arg}, at: 1)\n}\n`;
same('its own scan takes a bare name as its first argument', codes(positional('raw'), { exports: ['go'] }), []);
same('and an expression', codes(positional('slice(raw, from: 0, to: 2)'), { exports: ['go'] }), []);
same('which is the first parameter', runInt(instance(positional('raw'), ['go']), 'go', fill(4)).value, '5');
same(
  "a later file's scan takes it too",
  codes(
    [
      { name: 'a.tape', text: 'fn go(raw: View) -> Int {\n  b.scan(raw, at: 1)\n}\n' },
      { name: 'b.tape', text: 'fn scan(v: View, at: Int) -> Int {\n  at\n}\n' },
    ],
    { exports: ['go'] },
  ),
  [],
);
const own = interpret([...std, { name: 'own.tape', text: shadow }]).call('go', [fill(4)]);
same('the interpreter calls that scan too', typeof own === 'bigint' ? String(own) : 'not an int', '1');

const jsonStop = (b: number): boolean => b < 32 || b >= 128 || b === 34 || b === 92;
let jsonBits = 0;
for (let b = 0; b < 256; b++) if (hasByte(JSON_PLAIN, b) === jsonStop(b)) jsonBits++;
same('scan_plain stops on the JSON plain-run bytes', jsonBits, 256);

finish();
