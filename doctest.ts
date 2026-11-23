// doctest.ts: examples in comments, run by `node tape.ts test files…` (cli/test.ts, doctests) and by tape-mcp's test
// tool (mcp/src/tools.ts).
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
// prepare compiles them and finish reads what host/examples.ts gave; the calls are made where Wasm can be compiled:
// in Node (cli/test.ts) or, for tape-mcp, in its Dynamic Worker, as a Worker cannot compile Wasm itself. So this file
// compiles no module and runs in either.
import { compile } from './compiler.ts';
import type { Problem } from './compiler/common.ts';
import type { Called } from './host/examples.ts';
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

const refusal = (e: Problem): string => `${e.code} ${e.message}${e.hint ? ` (${e.hint})` : ''}`;

/** A module of examples to call (host/examples.ts, callExamples): its Wasm and its example functions, in order. */
export type Batch = { readonly wasm: Uint8Array<ArrayBuffer>; readonly fns: readonly string[] };
/** A file's examples, compiled: the modules left to call, and the examples decided without them. */
export type Prepared = {
  readonly batches: readonly Batch[];
  readonly sources: readonly Source[];
  readonly target: Source;
  readonly found: readonly Example[];
  readonly runnable: readonly Runnable[];
  readonly decided: ReadonlyMap<string, Outcome>;
};

/**
 * Compile a file's examples: all in one module; if that does not compile, each alone, so one bad example names
 * itself, and the rest in one module again (each alone, should they still not compile together).
 */
export function prepare(sources: readonly Source[], file: string): Prepared {
  const target = sources.find(s => s.name === file);
  if (!target) throw new Error(`${file} is not one of the program's files`);
  const found = examples(target.text);
  const runnable = found.flatMap((x): Runnable[] =>
    x.want === null ? [] : [{ ...x, want: x.want, fn: `doctest_${x.line}` }],
  );
  const decided = new Map<string, Outcome>();
  const batchOf = (rs: readonly Runnable[]): Batch | null => {
    const b = build(sources, target, rs);
    return b.wasm ? { wasm: b.wasm, fns: rs.map(r => r.fn) } : null;
  };
  const all = runnable.length === 0 ? null : batchOf(runnable);
  if (all || runnable.length === 0) return { batches: all ? [all] : [], sources, target, found, runnable, decided };
  const good = runnable.filter(r => {
    const one = build(sources, target, [r]);
    if (one.wasm) return true;
    const first = one.errors[0];
    decided.set(r.fn, { ok: false, error: first ? refusal(first) : 'did not compile' });
    return false;
  });
  const together = good.length === 0 ? null : batchOf(good);
  const batches = together ? [together] : good.flatMap(r => batchOf([r]) ?? []);
  return { batches, sources, target, found, runnable, decided };
}

const outcomeOf = (c: Called | undefined): Outcome | null =>
  c === true ? { ok: true } : c === false ? null : { ok: false, error: c ? `trapped (${c.trapped})` : 'did not run' };

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

/**
 * The results, given what each batch's functions gave (callExamples, in the batches' order): one per example,
 * with what a failing one gave instead, from the interpreter.
 */
export function finish(p: Prepared, called: readonly (readonly Called[])[]): Result[] {
  const { sources, target, found, runnable } = p;
  const decided = new Map(p.decided);
  p.batches.forEach((b, i) =>
    b.fns.forEach((fn, j) => {
      const o = outcomeOf(called[i]?.[j]);
      if (o) decided.set(fn, o);
    }),
  );
  const byLine = new Map(runnable.map(r => [r.line, r]));
  const got = given(
    sources,
    target,
    runnable.filter(r => !decided.has(r.fn)),
  );
  return found.map((x): Result => {
    const r = byLine.get(x.line);
    if (!r) return { file: target.name, ...x, ok: false, error: MISSING };
    return {
      file: target.name,
      ...x,
      ...(decided.get(r.fn) ?? { ok: false, error: null, got: got.get(r) ?? '(not shown)' }),
    };
  });
}
