// fuzz/compile.ts: the compiler on text it was never meant to see. Each seed takes a program (an example, an app, a
// std file, or one fuzz/gen.ts makes) and changes it a few times: a span deleted, copied elsewhere or swapped with
// another, a token of the language put in at random (a keyword, an operator, a bracket, a literal at an edge), a
// line cut short, a character changed, the file cut off. What comes out must be a module or a list of problems:
// the compiler must not throw, must not take more than COMPILE_MS, and a module it makes must be one WebAssembly
// takes. The formatter must not throw either on a program that parses, and must give text that formats to itself
// and compiles as the original does. Then the scaling cases: one construct repeated n, 2n and 4n times (nested
// brackets, a long chain of operators, many arms, many functions, a long text literal, deep matches); compile time
// must not grow more than about linearly (a doubling may cost at most 3.5 times as much, over 40 ms).
//   node fuzz/compile.ts --seconds 60 [--seed 1] [--shard 0/8] [--only <seed>]
import { readdirSync, readFileSync } from 'node:fs';
import { compile } from '../compiler.ts';
import { format } from '../fmt.ts';
import { std } from '../std.ts';
import { program } from './gen.ts';
import { cli, seeds } from './run.ts';
import { rng } from './rng.ts';
import type { Rng } from './rng.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const COMPILE_MS = 4000;
const tapes = (d: string): string[] =>
  readdirSync(ROOT + d)
    .filter(f => f.endsWith('.tape'))
    .map(f => `${d}/${f}`);
const CORPUS = [
  ...tapes('examples'),
  ...tapes('examples/timed'),
  ...tapes('apps/tickets'),
  ...tapes('apps/queue'),
  ...tapes('testdata/compare'),
].map(p => ({
  name: p,
  text: readFileSync(ROOT + p, 'utf8'),
}));
const TOKENS = [
  'fn',
  'export',
  'type',
  'schema',
  'migration',
  'match',
  'with',
  'let',
  'do',
  'if',
  'else',
  'and',
  'or',
  'not',
  'interface',
  'flag',
  'machine',
  'invariant',
  'where',
  'contract',
  'settled',
  'private',
  'final',
  'read',
  'write',
  '(',
  ')',
  '{',
  '}',
  '[',
  ']',
  ',',
  ':',
  '->',
  '=',
  '==',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  '+',
  '-',
  '*',
  '/',
  '%',
  '++',
  '|>',
  '&',
  '|',
  '^',
  '<<',
  '>>',
  '.',
  '_',
  '\n',
  '\\',
  '"',
  '"\\(',
  ')"',
  '//',
  '0',
  '-1',
  '9223372036854775807',
  '9223372036854775808',
  '-9223372036854775809',
  '1.5',
  '0.000000000000000001',
  '1e400f',
  '1e-400f',
  '1.5f',
  '"x"',
  '"\\u"',
  'True',
  'None',
  'Some(value: 1)',
  'Nil',
  'Empty',
  'raw',
  'Int',
  'View',
  'Buf',
  'Dec[2]',
  'Dec[19]',
  'Float',
  'Option[Int]',
  'List[View]',
  'Map[Int]',
  'Sql',
  'Remote',
  'Timer',
  'sql_first',
  'sql_exec(query: "DELETE FROM t")',
  'decode',
  'write_json',
  'fold',
  'range',
  'wake',
  'call',
  'now()',
  'self',
  'Rows[T]',
  'T',
  'repeat: True',
  'once:',
  'within: 0',
];

function mutate(r: Rng, text: string): string {
  let t = text;
  for (let n = r.between(1, 4); n > 0; n--) {
    const at = r.int(t.length + 1),
      len = r.int(Math.min(80, t.length - at) + 1);
    switch (r.int(8)) {
      case 0:
        t = t.slice(0, at) + t.slice(at + len);
        break;
      case 1: {
        const to = r.int(t.length + 1);
        t = t.slice(0, to) + t.slice(at, at + len) + t.slice(to);
        break;
      }
      case 2:
      case 3:
        t = t.slice(0, at) + ` ${r.one(TOKENS)} ` + t.slice(at);
        break;
      case 4: {
        // a line cut short
        const nl = t.indexOf('\n', at);
        if (nl > at) t = t.slice(0, at) + t.slice(nl);
        break;
      }
      case 5:
        t =
          t.slice(0, at) +
          String.fromCodePoint(
            r.one([0, 9, 10, 13, 34, 40, 41, 92, 123, 125, 0xa0, 0xe9, 0x2028, 0xfeff, 0xd800, r.int(128)]),
          ) +
          t.slice(at + 1);
        break;
      case 6:
        t = t.slice(0, at);
        break;
      default: {
        // two spans swapped
        const b = r.int(t.length + 1),
          [x, y] = at < b ? [at, b] : [b, at];
        const l2 = Math.min(len, y - x);
        t = t.slice(0, x) + t.slice(y, y + l2) + t.slice(x + l2, y) + t.slice(x, x + l2) + t.slice(y + l2);
      }
    }
  }
  return t;
}

type Out = { kind: 'module' | 'refused' | 'crash' | 'slow' | 'invalid'; detail: string; ms: number };
function compiled(text: string, name: string): Out {
  const t0 = performance.now();
  let b;
  try {
    b = compile([...std, { name, text }]);
  } catch (e) {
    return {
      kind: 'crash',
      detail: e instanceof Error ? (e.stack ?? e.message).split('\n').slice(0, 4).join(' | ') : String(e),
      ms: 0,
    };
  }
  const ms = performance.now() - t0;
  if (ms > COMPILE_MS) return { kind: 'slow', detail: `${ms.toFixed(0)} ms`, ms };
  if (b.wasm === null) {
    const e = b.errors[0];
    if (!e || typeof e.code !== 'string' || !/^[A-Z]\d{2,3}$/.test(e.code))
      return { kind: 'crash', detail: `a refusal with no code: ${JSON.stringify(e)}`, ms };
    return { kind: 'refused', detail: e.code, ms };
  }
  if (!WebAssembly.validate(b.wasm)) {
    let why = '';
    try {
      why = `WebAssembly takes it, with ${WebAssembly.Module.exports(new WebAssembly.Module(b.wasm)).length} exports`;
    } catch (e) {
      why = e instanceof Error ? e.message : String(e);
    }
    return { kind: 'invalid', detail: why, ms };
  }
  return { kind: 'module', detail: '', ms };
}
/** the formatter on text that parses: no throw, a fixed point, and the same program */
function formats(text: string, name: string, before: Out): string | null {
  let once: string, twice: string;
  try {
    once = format(text, name);
    twice = format(once, name);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    // the formatter refuses what does not parse, with the parser's problem
    if (/^[A-Z]\d{2,3}\b|line \d+/.test(m) || (e instanceof Error && e.constructor.name === 'CompileError'))
      return null;
    return `format threw: ${e instanceof Error ? (e.stack ?? m).split('\n').slice(0, 3).join(' | ') : m}`;
  }
  if (twice !== once) return 'format is not a fixed point';
  const after = compiled(once, name);
  if (
    after.kind !== before.kind ||
    (after.kind === 'refused' && after.detail !== before.detail && before.kind !== 'refused')
  )
    return `formatted, the program ${after.kind} ${after.detail}; as written ${before.kind} ${before.detail}`;
  return null;
}

export function compileCase(seed: number): { cases: number; bad: string | null; text?: string } {
  const r = rng(seed);
  const src = r.chance(3) ? { name: 'gen.tape', text: program(seed) } : r.chance(8) ? r.one(std) : r.one(CORPUS);
  const text = mutate(r, src.text);
  const out = compiled(text, src.name);
  if (out.kind === 'crash' || out.kind === 'slow' || out.kind === 'invalid')
    return { cases: 1, bad: `${src.name} changed: ${out.kind} ${out.detail}`, text };
  if (out.kind === 'module' || r.chance(4)) {
    const f = formats(text, src.name, out);
    if (f) return { cases: 1, bad: `${src.name} changed: ${f}`, text };
  }
  return { cases: 1, bad: null };
}

// ---- the scaling cases
const SCALES: [string, (n: number) => string][] = [
  ['nested parentheses', n => `fn f(n: Int) -> Int {\n  ${'('.repeat(n)}n${')'.repeat(n)}\n}\n`],
  ['a chain of +', n => `fn f(n: Int) -> Int {\n  n${' + n'.repeat(n)}\n}\n`],
  ['a chain of ++', n => `fn f(v: View) -> View {\n  v${' ++ v'.repeat(n)}\n}\n`],
  ['a chain of and', n => `fn f(n: Int) -> Bool {\n  n > 0${' and n > 1'.repeat(n)}\n}\n`],
  ['a chain of |>', n => `fn f(n: Int) -> Int {\n  n${' |> abs()'.repeat(n)}\n}\n`],
  [
    'many arms',
    n =>
      `fn f(n: Int) -> Int {\n  match n {\n${Array.from({ length: n }, (_, i) => `    ${i} -> ${i * 7}`).join('\n')}\n    _ -> 0\n  }\n}\n`,
  ],
  [
    'many text arms',
    n =>
      `fn f(v: View) -> Int {\n  match v {\n${Array.from({ length: n }, (_, i) => `    "k${i}" -> ${i}`).join('\n')}\n    _ -> 0\n  }\n}\n`,
  ],
  [
    'nested matches',
    n => `fn f(n: Int) -> Int {\n${'  match n {\n    0 -> 0\n    _ -> '.repeat(n)}n${'\n  }'.repeat(n)}\n}\n`,
  ],
  [
    'many lets',
    n =>
      `fn f(n: Int) -> Int {\n${Array.from({ length: n }, (_, i) => `  let x${i} = ${i === 0 ? 'n' : `x${i - 1}`} + 1`).join('\n')}\n  x${n - 1}\n}\n`,
  ],
  [
    'many functions in a chain',
    n =>
      Array.from(
        { length: n },
        (_, i) => `fn g${i}(n: Int) -> Int {\n  ${i === 0 ? 'n' : `g${i - 1}(n) + 1`}\n}\n`,
      ).join('\n'),
  ],
  ['a long text literal', n => `fn f(n: Int) -> Int {\n  len("${'abcdefghij'.repeat(n)}")\n}\n`],
  ['many holes', n => `fn f(n: Int) -> View {\n  "${'\\(n) '.repeat(n)}"\n}\n`],
  [
    'a deep constructor',
    n => `fn f(n: Int) -> List[Int] {\n  ${'Cons(head: n, tail: '.repeat(n)}Nil${')'.repeat(n)}\n}\n`,
  ],
  [
    'nested lambdas',
    n =>
      `fn f(n: Int) -> Int {\n  ${'fold(list: range(from: 0, to: 2), from: n, by: fn(a: Int, k: Int) -> Int { '.repeat(n)}n${' })'.repeat(n)}\n}\n`,
  ],
  [
    'many record fields',
    n =>
      `type R {\n  R(${Array.from({ length: n }, (_, i) => `f${i}: Int`).join(', ')})\n}\n\nfn f(n: Int) -> Int {\n  R(${Array.from({ length: n }, (_, i) => `f${i}: n`).join(', ')}).f0\n}\n`,
  ],
  [
    'many constructors',
    n =>
      `type S {\n${Array.from({ length: n }, (_, i) => `  C${i}(x: Int)`).join('\n')}\n}\n\nfn f(s: S) -> Int {\n  match s {\n${Array.from({ length: n }, (_, i) => `    C${i}(x) -> x + ${i}`).join('\n')}\n  }\n}\n`,
  ],
  [
    'a long SQL statement',
    n =>
      `migration 1 "t" {\n  CREATE TABLE t(id INTEGER PRIMARY KEY, a INTEGER NOT NULL)\n}\n\nfn handle(raw: View, db: Sql) -> Response {\n  let n = sql_exec(query: "UPDATE t SET a = a${' + 1'.repeat(n)} WHERE id = 1", repeat: True)\n  buf()\n}\n`,
  ],
  [
    'many SQL ORs',
    n =>
      `migration 1 "t" {\n  CREATE TABLE t(id INTEGER PRIMARY KEY, a INTEGER NOT NULL)\n}\n\ntype T { T(id: Int, a: Int) }\n\nfn handle(raw: View, db: Sql) -> Response {\n  let n = sql_first(row: T, query: "SELECT * FROM t WHERE ${Array.from({ length: n }, (_, i) => `a = ${i}`).join(' OR ')}")\n  buf()\n}\n`,
  ],
  [
    'nested SQL parentheses',
    n =>
      `migration 1 "t" {\n  CREATE TABLE t(id INTEGER PRIMARY KEY, a INTEGER NOT NULL)\n}\n\ntype T { T(id: Int, a: Int) }\n\nfn handle(raw: View, db: Sql) -> Response {\n  let n = sql_first(row: T, query: "SELECT * FROM t WHERE ${'('.repeat(n)}a = 1${')'.repeat(n)}")\n  buf()\n}\n`,
  ],
  [
    'many migrations',
    n =>
      Array.from(
        { length: n },
        (_, i) => `migration ${i + 1} "m${i}" {\n  CREATE TABLE t${i}(id INTEGER PRIMARY KEY, a INTEGER NOT NULL)\n}\n`,
      ).join('\n'),
  ],
  [
    'many invariants',
    n =>
      `migration 1 "t" {\n  CREATE TABLE t(id INTEGER PRIMARY KEY, a INTEGER NOT NULL)\n}\n\n${Array.from({ length: n }, (_, i) => `invariant "i${i}" {\n  SELECT id FROM t WHERE a = ${i}\n}\n`).join('\n')}`,
  ],
];
const timeOf = (text: string): { ms: number; out: Out } => {
  // the best of three, so one pause of the collector is not read as growth
  let best = Infinity,
    out: Out = { kind: 'module', detail: '', ms: 0 };
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    out = compiled(text, 'scale.tape');
    best = Math.min(best, performance.now() - t0);
    if (out.kind === 'crash') break;
  }
  return { ms: best, out };
};
export function scaleCase(i: number, base: number): string | null {
  const [name, make] = SCALES[i % SCALES.length] ?? SCALES[0] ?? ['', () => ''];
  const times: number[] = [];
  for (const n of [base, base * 2, base * 4]) {
    const { ms, out } = timeOf(make(n));
    if (out.kind === 'crash' || out.kind === 'invalid') return `${name} x${n}: ${out.kind} ${out.detail}`;
    times.push(ms);
  }
  const [a = 0, b = 0, c = 0] = times;
  if (c > 40 && (c / Math.max(b, 1) > 3.5 || b / Math.max(a, 1) > 3.5 * 1.5))
    return `${name}: ${base} -> ${a.toFixed(0)} ms, ${base * 2} -> ${b.toFixed(0)} ms, ${base * 4} -> ${c.toFixed(0)} ms`;
  return null;
}
export const SCALE_COUNT = SCALES.length;

if (import.meta.main) {
  const c = cli(),
    scales = process.argv.includes('--scales');
  let cases = 0,
    bad = 0;
  const start = Date.now();
  if (scales) {
    for (const base of [100, 400, 1600])
      for (let i = 0; i < SCALES.length; i++) {
        const f = scaleCase(i, base);
        cases++;
        if (f) {
          bad++;
          console.log(`FINDING compile scaling: ${f}`);
        }
      }
  } else
    for (const seed of seeds(c)) {
      const v = compileCase(seed);
      cases += v.cases;
      if (v.bad) {
        bad++;
        console.log(`FINDING compile seed=${seed}: ${v.bad}`);
        if (c.only !== null) console.log(v.text);
      }
    }
  const s = (Date.now() - start) / 1000;
  console.log(`compile: ${cases} cases, ${bad} findings, ${(cases / s).toFixed(1)} cases/s`);
}
