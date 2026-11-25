// What every test file here shares: the standard library, a way to read a file of the repository, and a check
// that prints one line and counts failures. A test file ends with finish(), which exits 1 if any check failed.
import { flat } from '../fmt.ts';
import { readFileSync } from 'node:fs';
import { compile } from '../compiler.ts';
import type { Built, Options, Source } from '../compiler.ts';
import type { Problem } from '../compiler/common.ts';
import { std } from '../std.ts';
import { floatOfBytes, frameAt } from '../host/memory.ts';
import { answerText, responseOf } from '../host.ts';

export { std };

// a file of the repository, by its path from the root
// A program is given with every step on one line (fmt's `flat`): the tests that change a program do it as text,
// and a change must not depend on where the formatter happened to break a line. test/layout.ts checks that the
// flat text and the file are the same program.
/** A file as it stands on disk. */
export const raw = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
export const read = (path: string): string => {
  const text = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  return path.endsWith('.tape') ? flat(text, path) : text;
};

/** A program's text, or sources of its own, with std before them. */
const withStd = (program: string | readonly Source[], name: string): Source[] => [
  ...std,
  ...(typeof program === 'string' ? [{ name, text: program }] : program),
];
/** What the compiler refuses in a program. */
export const problems = (
  program: string | readonly Source[],
  options: Partial<Options> = {},
  name = 'program.tape',
): Problem[] => compile(withStd(program, name), options).errors;
/** The same, as `code:line`. */
export const codes = (
  program: string | readonly Source[],
  options: Partial<Options> = {},
  name = 'program.tape',
): string[] => problems(program, options, name).map(e => `${e.code}:${e.line}`);
/** A program that must compile: the build, or an error with what was refused. */
export function built(
  program: string | readonly Source[],
  options: Partial<Options> = {},
  name = 'program.tape',
): Built {
  const b = compile(withStd(program, name), options);
  if (b.wasm !== null) return b;
  const [e] = b.errors;
  throw new Error(`does not compile: ${e?.code} line ${e?.line}: ${e?.message}`);
}
export const moduleOf = (b: Built): WebAssembly.Module => new WebAssembly.Module(b.wasm);
/** The functions a module exports, by name. */
export type Functions = Record<string, (...args: (number | bigint)[]) => unknown>;
export function functionsOf(module: WebAssembly.Module, imports: WebAssembly.Imports = {}): Functions {
  const out: Functions = {};
  for (const [name, f] of Object.entries(new WebAssembly.Instance(module, imports).exports)) {
    if (f instanceof WebAssembly.Global || f instanceof WebAssembly.Memory || f instanceof WebAssembly.Table) continue;
    out[name] = f;
  }
  return out;
}
/** A module instantiated with no host: its functions, its memory, and the code of its last trap (0 for none).
 * Its imports, when it has Floats, are the host's text of a Float and a Float of text (host/run.ts float_text,
 * float_of). */
export type Bare = { fns: Functions; memory: WebAssembly.Memory; why: () => number };
export function bare(module: WebAssembly.Module): Bare {
  const late: { exports: WebAssembly.Instance['exports'] | null } = { exports: null };
  const floatText = (x: number): number => {
    const b = new TextEncoder().encode(String(x)),
      { alloc, memory } = late.exports ?? {};
    if (typeof alloc !== 'function' || !(memory instanceof WebAssembly.Memory)) throw new TypeError('not linked');
    const at = Number(alloc(4 + b.length));
    new DataView(memory.buffer).setUint32(at, b.length, true);
    new Uint8Array(memory.buffer, at + 4, b.length).set(b);
    return at;
  };
  const floatOf = (ptr: number, len: number): number => {
    const { memory } = late.exports ?? {};
    if (!(memory instanceof WebAssembly.Memory)) throw new TypeError('not linked');
    return floatOfBytes(new Uint8Array(memory.buffer, ptr, len));
  };
  const { exports } = new WebAssembly.Instance(module, { env: { float_text: floatText, float_of: floatOf } });
  late.exports = exports;
  const { memory, why } = exports;
  if (!(memory instanceof WebAssembly.Memory)) throw new TypeError('the module exports no memory');
  const fns: Functions = {};
  for (const [name, f] of Object.entries(exports))
    if (!(f instanceof WebAssembly.Global || f instanceof WebAssembly.Memory || f instanceof WebAssembly.Table))
      fns[name] = f;
  return { fns, memory, why: () => (why instanceof WebAssembly.Global ? Number(why.value) : 0) };
}
/** Why a call failed: the module's trap code, or the error's own message. */
export const trapOf = (b: Bare, e: unknown): string =>
  `trap ${b.why() || (e instanceof Error ? e.message : String(e))}`;
/** `handle` called on bytes copied into the module's memory: what it answered, as host.ts answerText pictures the
 * Response (`200\nbody`, `201 application/json\n{…}`, a header after a carriage return), or `trap <why>`. */
export function handleBare(b: Bare, input: Uint8Array): string {
  call(b.fns, 'reset');
  const at = Number(call(b.fns, 'alloc', input.length));
  new Uint8Array(b.memory.buffer, at, input.length).set(input);
  try {
    const h = Number(call(b.fns, 'handle', at, input.length));
    return answerText(responseOf(frameAt(b, h)));
  } catch (e) {
    return trapOf(b, e);
  }
}
/** An answer's bytes (a module's or the interpreter's handle) as host.ts answerText pictures the Response. */
export const answered = (out: Uint8Array): string => answerText(responseOf(out));
/** An answer's body, as text: for a test that reads only the body (a JSON document, a page). */
export const answerBody = (out: Uint8Array): string => new TextDecoder().decode(responseOf(out).body);
/** One export called; an error when the module has no such function. */
export function call(fns: Functions, name: string, ...args: (number | bigint)[]): unknown {
  const f = fns[name];
  if (!f) throw new Error(`the module exports no function ${name}`);
  return f(...args);
}
/** A JSON object out of text; {} when the text is JSON of another kind. */
export function objectIn(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? Object.fromEntries(Object.entries(parsed))
    : {};
}
/** Why something failed, as text. */
export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** Wait this long. */
export const sleep = (ms: number): Promise<void> =>
  new Promise(done => {
    setTimeout(done, ms);
  });
/** `from` replaced by `to`, which must be there. */
export function swap(text: string, from: string, to: string): string {
  if (!text.includes(from)) throw new Error(`not found: ${from}`);
  return text.replace(from, to);
}
/** The line a piece of text is on. */
export const lineOf = (text: string, piece: string): number => text.slice(0, text.indexOf(piece)).split('\n').length;
/** The first program of LANGUAGE.md: the tour. */
export function tour(): string {
  const [, whole] = /```tape\n([\s\S]*?)```/.exec(read('LANGUAGE.md')) ?? [];
  if (whole === undefined) throw new Error('LANGUAGE.md has no tape program');
  // flat, as `read` gives every program
  return flat(whole, 'LANGUAGE.md');
}
/** A custom section of a module, as text. */
export function sectionText(module: WebAssembly.Module, name: string): string {
  const [bytes] = WebAssembly.Module.customSections(module, name);
  return bytes ? new TextDecoder().decode(bytes) : '';
}

let failed = 0;
export const ok = (what: string, pass: boolean, detail = ''): void => {
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${what}${detail ? `: ${detail}` : ''}`);
  if (!pass) failed++;
};
/** a BigInt is compared, and shown, as the number it is */
const plain = (_key: string, v: unknown): unknown => (typeof v === 'bigint' ? Number(v) : v);
/** `got` is `want`, compared as JSON */
export const same = (what: string, got: unknown, want: unknown): void => {
  const g = JSON.stringify(got, plain);
  const w = JSON.stringify(want, plain);
  ok(what, g === w, g === w ? '' : `got ${g}, wanted ${w}`);
};
export const finish = (): never => {
  console.log(failed ? `${failed} FAILED` : 'all passed');
  process.exit(failed ? 1 : 0);
};
