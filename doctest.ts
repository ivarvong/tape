// doctest.ts: examples in comments, run by `node tape.ts test files…`.
//
// In any comment, a line `//   > expression` is an example and the next comment line is what it should give,
// written as a pattern (a literal, a constructor, `_` for parts that do not matter, `"prefix" ++ _`, …):
//
//   // The text before the first `byte`, or all of it.
//   //
//   //   > until(v: "key=value", byte: 61)
//   //   "key"
//   //   > decimal(v: "12a")
//   //   None
//   fn until(v: View, byte: Int) -> View { … }
//
// Each example becomes a function appended to its own file, so it calls what the file can call, compiled with
// std like any program; the compiled code decides. When one fails, the value it gave is shown, as computed by
// interp.ts. Examples run pure code: a function that needs a capability (Sql, Clock, …) cannot be called here.
import { compile } from './compiler.ts';
import type { Problem } from './compiler/common.ts';
import { interpret } from './interp.ts';
import type { Source, Value } from './interp.ts';

export type Example = { readonly line: number; readonly expr: string; readonly want: string | null };

/** How one example came out: it held, it gave something else, or it could not be run at all. */
export type Outcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string }
  | { readonly ok: false; readonly error: null; readonly got: string };

export type Result = Example & { readonly file: string } & Outcome;

type Runnable = Example & { readonly want: string; readonly fn: string };
type Built =
  | { readonly wasm: Uint8Array<ArrayBuffer>; readonly errors: readonly never[] }
  | { readonly wasm: null; readonly errors: readonly Problem[] };

const TRAPS = ['', 'out of memory', 'too many steps', 'out of bounds', 'arithmetic', 'use after release'];
const MISSING = 'an example needs what it should give on the next comment line';

export function examples(text: string): Example[] {
  const lines = text.split('\n');
  return lines.flatMap((line, i) => {
    const expr = line.match(/^\s*\/\/\s+> (.+)$/)?.[1];
    if (expr === undefined) return [];
    const want = lines[i + 1]?.match(/^\s*\/\/\s+(?!> )(\S.*)$/)?.[1];
    return [{ line: i + 1, expr: expr.trim(), want: want?.trim() ?? null }];
  });
}

const text = (bytes: Iterable<number>): string => JSON.stringify(new TextDecoder().decode(Uint8Array.from(bytes)));

/** A value from interp.ts, written as Tape. */
function shown(v: Value): string {
  if (typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (v instanceof Uint8Array) return text(v);
  if (v.k === 'buf') return `Buf ${text(v.buf)}`;
  if (v.k !== 'adt') return `<${v.k}>`;
  const fields = Object.entries(v.f).map(([k, x]) => `${k}: ${shown(x)}`);
  return fields.length > 0 ? `${v.c}(${fields.join(', ')})` : v.c;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const ended = (source: string): string => source.replace(/\n*$/, '\n');

/** The program with `target` replaced by its own text and `extra` after it, so its line numbers stay as written. */
const withAppended = (sources: readonly Source[], target: Source, extra: string): Source[] =>
  sources.map(s => (s === target ? { name: s.name, text: ended(target.text) + extra } : s));

const asMatch = (r: Runnable): string =>
  `\nfn ${r.fn}() -> Bool {\n  match ${r.expr} {\n    ${r.want} -> True\n    _ -> False\n  }\n}\n`;

const build = (sources: readonly Source[], target: Source, rs: readonly Runnable[]): Built =>
  compile(withAppended(sources, target, rs.map(asMatch).join('')), { exports: rs.map(r => r.fn) });

/** Whether each example held, by the compiled code. Examples are pure: a capability the program imports traps. */
function run(rs: readonly Runnable[], wasm: Uint8Array<ArrayBuffer>): Map<Runnable, Outcome | null> {
  const mod = new WebAssembly.Module(wasm);
  const env: Record<string, () => never> = {};
  for (const i of WebAssembly.Module.imports(mod))
    if (i.kind === 'function')
      env[i.name] = () => {
        throw new Error(`an example cannot use ${i.name}`);
      };
  const ex = new WebAssembly.Instance(mod, { env }).exports;
  const call = (name: string): unknown => {
    const f = ex[name];
    if (typeof f !== 'function') throw new TypeError(`${name} is not exported`);
    return f();
  };
  const why = (): string | undefined => {
    const g = ex['why'];
    return g instanceof WebAssembly.Global ? TRAPS[Number(g.value)] : undefined;
  };
  return new Map(
    rs.map((r): [Runnable, Outcome | null] => {
      call('reset');
      try {
        return [r, call(r.fn) === 1 ? { ok: true } : null];
      } catch (e) {
        return [r, { ok: false, error: `trapped (${why() ?? message(e)})` }];
      }
    }),
  );
}

const refusal = (e: Problem): string => `${e.code} ${e.message}${e.hint ? ` (${e.hint})` : ''}`;

/** All examples in one module; if that does not compile, each on its own, so one bad example names itself. */
function decide(sources: readonly Source[], target: Source, rs: readonly Runnable[]): Map<Runnable, Outcome | null> {
  if (rs.length === 0) return new Map();
  const all = build(sources, target, rs);
  if (all.wasm) return run(rs, all.wasm);
  const each = rs.flatMap((r): [Runnable, Outcome | null][] => {
    const one = build(sources, target, [r]);
    if (one.wasm) return [...run([r], one.wasm)];
    const first = one.errors[0];
    return [[r, { ok: false, error: first ? refusal(first) : 'did not compile' }]];
  });
  return new Map(each);
}

/** What each failing example gave, from the interpreter (types are not needed there). */
function given(sources: readonly Source[], target: Source, failing: readonly Runnable[]): Map<Runnable, string> {
  const extra = failing.map(r => `\nfn ${r.fn}_value() -> Int {\n  ${r.expr}\n}\n`).join('');
  const notShown = (e: unknown): string => `(not shown: ${message(e)})`;
  try {
    const it = interpret(withAppended(sources, target, extra));
    return new Map(
      failing.map((r): [Runnable, string] => {
        try {
          return [r, shown(it.call(`${r.fn}_value`, []))];
        } catch (e) {
          return [r, notShown(e)];
        }
      }),
    );
  } catch (e) {
    return new Map(failing.map((r): [Runnable, string] => [r, notShown(e)]));
  }
}

/** sources: every file of the program (std first); file: the one whose examples run. One result per example. */
export function doctests(sources: readonly Source[], file: string): Result[] {
  const target = sources.find(s => s.name === file);
  if (!target) throw new Error(`${file} is not one of the program's files`);
  const found = examples(target.text);
  const runnable = found.flatMap((x): Runnable[] =>
    x.want === null ? [] : [{ ...x, want: x.want, fn: `doctest_${x.line}` }],
  );
  const byLine = new Map(runnable.map(r => [r.line, r]));
  const decided = decide(sources, target, runnable);
  const got = given(
    sources,
    target,
    runnable.filter(r => decided.get(r) === null),
  );
  return found.map((x): Result => {
    const r = byLine.get(x.line);
    if (!r) return { file, ...x, ok: false, error: MISSING };
    return { file, ...x, ...(decided.get(r) ?? { ok: false, error: null, got: got.get(r) ?? '(not shown)' }) };
  });
}
