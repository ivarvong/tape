// tape test: the examples in comments (doctest.ts), file by file. With no files: std and examples.
import { readFileSync, readdirSync } from 'node:fs';
import { finish, prepare } from '../doctest.ts';
import type { Result } from '../doctest.ts';
import { callExamples } from '../host/examples.ts';
import type { Source } from '../interp.ts';
import { std } from '../std.ts';

/** sources: every file of the program (std first); file: the one whose examples run. One result per example. */
export function doctests(sources: readonly Source[], file: string): Result[] {
  const p = prepare(sources, file);
  return finish(
    p,
    p.batches.map(b => callExamples(new WebAssembly.Module(b.wasm), b.fns)),
  );
}

export function testFiles(args: string[]): never {
  const files =
    args.length > 0
      ? args
      : [
          ...std.map(s => s.name),
          ...readdirSync(new URL('../examples/', import.meta.url))
            .filter(f => f.endsWith('.tape'))
            .map(f => `examples/${f}`),
        ];
  let n = 0,
    failed = 0;
  for (const f of files) {
    const own = std.find(
      s =>
        s.name === f ||
        new URL(`../${s.name}`, import.meta.url).pathname === new URL(f, `file://${process.cwd()}/`).pathname,
    );
    const sources = own ? std : [...std, { name: f, text: readFileSync(f, 'utf8') }];
    for (const r of doctests(sources, own ? own.name : f)) {
      n++;
      if (r.ok) {
        console.log(`ok    ${r.file}:${r.line}  ${r.expr}`);
        continue;
      }
      failed++;
      console.log(`FAIL  ${r.file}:${r.line}  > ${r.expr}`);
      if (r.error !== null) console.log(`        ${r.error}`);
      else console.log(`        expected  ${r.want}\n        got       ${r.got}`);
    }
  }
  console.log(`${n} examples, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
