// The size of what the compiler makes, held to a record. Inlining once grew every module by 14-22% (hello 3,770 ->
// 4,602 bytes, the Markdown renderer 40,790 -> 48,995) and the examples did not show it: a size change is a number
// a change should state, like a step count. bench/sizes.json holds each program's Wasm bytes and function count as
// last recorded; a program more than 2% off its record, or the sum of them more than 1%, fails here, and
// `node test/wasm-size.ts --write` records the new sizes, for the commit that changed them to say why.
// The programs are the examples, the suite's programs, money, the renderer (corpus/md.tape) and the blog. The blog
// is corpus/blog.tape compiled before corpus/md.tape. A name is the first file's (LANGUAGE.md §4), so the blog's
// handle is the entry and the renderer's is md.handle, typechecked and left out. A single file named program.tape
// (the same two, packed) is the same code and 58 bytes more of name-section strings; the gate records the two
// files, which is what the bench runs.
//   node test/wasm-size.ts           compare
//   node test/wasm-size.ts --write   record (and say the change in the commit)
import '../node25.ts';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { compile } from '../compiler.ts';
import { std } from '../std.ts';
import { functionsOf } from '../bench/suite/wasm.ts';
import { finish, same } from './harness.ts';

const root = new URL('../', import.meta.url).pathname;
const RECORD = `${root}bench/sizes.json`;
type Size = { bytes: number; functions: number };
type Program = { key: string; files: readonly string[] };

const programs: Program[] = [
  ...readdirSync(`${root}examples`)
    .filter(f => f.endsWith('.tape'))
    .map(f => ({ key: `examples/${f}`, files: [`examples/${f}`] })),
  ...readdirSync(`${root}bench/suite`)
    .filter(f => f.endsWith('.tape'))
    .map(f => ({ key: `bench/suite/${f}`, files: [`bench/suite/${f}`] })),
  { key: 'bench/money.tape', files: ['bench/money.tape'] },
  { key: 'corpus/md.tape', files: ['corpus/md.tape'] },
  { key: 'corpus/blog.tape', files: ['corpus/blog.tape', 'corpus/md.tape'] },
].toSorted((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

const now: Record<string, Size> = {};
// the compiler does not validate what it makes: a call of a host function it did not import is a module WebAssembly
// refuses (test/imports.ts)
const invalid: string[] = [];
for (const p of programs) {
  const r = compile([
    ...std,
    ...p.files.map(f => ({ name: f.slice(f.lastIndexOf('/') + 1), text: readFileSync(root + f, 'utf8') })),
  ]);
  if (r.wasm) now[p.key] = { bytes: r.wasm.length, functions: functionsOf(r.wasm) };
  if (r.wasm && !WebAssembly.validate(r.wasm)) invalid.push(p.key);
}
same('every program is a module WebAssembly validates', invalid, []);

if (process.argv.includes('--write')) {
  writeFileSync(RECORD, `${JSON.stringify(now, null, 2)}\n`);
  console.log(`wrote ${RECORD}: ${Object.keys(now).length} programs`);
} else {
  const parsed: unknown = JSON.parse(readFileSync(RECORD, 'utf8'));
  const isSizes = (v: unknown): v is Record<string, Size> =>
    typeof v === 'object' &&
    v !== null &&
    Object.values(v).every(x => typeof x === 'object' && x !== null && typeof Reflect.get(x, 'bytes') === 'number');
  const record: Record<string, Size> = isSizes(parsed) ? parsed : {};
  same('the same programs compile as were recorded', Object.keys(now), Object.keys(record));
  const off = Object.entries(now).flatMap(([p, s]) => {
    const was = record[p]?.bytes ?? 0;
    return Math.abs(s.bytes - was) > 0.02 * was ? [`${p}: ${was} -> ${s.bytes} bytes`] : [];
  });
  same('every program within 2% of its recorded Wasm bytes (node test/wasm-size.ts --write to record)', off, []);
  const sum = (m: Record<string, Size>): number => Object.values(m).reduce((n, s) => n + s.bytes, 0);
  const [a, b] = [sum(record), sum(now)];
  same(`all of them within 1% of the recorded ${a} bytes (now ${b})`, Math.abs(b - a) <= 0.01 * a, true);
}

finish();
