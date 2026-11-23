// The size of what the compiler makes, held to a record. Inlining grew every module by 14-22% (hello 3,770 ->
// 4,602 bytes, a 1,578-line Markdown renderer 40,790 -> 48,995) and nothing in the gate showed it: a size change is
// a number a change should state, like a step count. bench/sizes.json holds each program's Wasm bytes and function
// count as last recorded; a program more than 2% off its record, or the sum of them more than 1%, fails here, and
// `node test/wasm-size.ts --write` records the new sizes, for the commit that changed them to say why.
//   node test/wasm-size.ts           compare
//   node test/wasm-size.ts --write   record (and say the change in the commit)
import '../node25.ts';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { compile } from '../compiler.ts';
import { std } from '../std.ts';
import { finish, same } from './harness.ts';

const root = new URL('../', import.meta.url).pathname;
const RECORD = `${root}bench/sizes.json`;
type Size = { bytes: number; functions: number };

// each program as it is compiled alone (with std): the examples, the suite's workloads, money
const programs = [
  ...readdirSync(`${root}examples`)
    .filter(f => f.endsWith('.tape'))
    .map(f => `examples/${f}`),
  ...readdirSync(`${root}bench/suite`)
    .filter(f => f.endsWith('.tape'))
    .map(f => `bench/suite/${f}`),
  'bench/money.tape',
].toSorted();

/** Functions in a module: its function section's count (a module from this compiler, read by hand). */
function functionsOf(wasm: Uint8Array): number {
  const leb = (at: number): [number, number] => {
    let v = 0,
      shift = 0,
      i = at;
    for (;;) {
      const b = wasm[i++] ?? 0;
      v |= (b & 0x7f) << shift;
      shift += 7;
      if (b < 0x80) return [v, i];
    }
  };
  let at = 8;
  while (at < wasm.length) {
    const id = wasm[at] ?? 0;
    const [len, body] = leb(at + 1);
    if (id === 3) return leb(body)[0];
    at = body + len;
  }
  return 0;
}

const now: Record<string, Size> = {};
// the compiler does not validate what it makes: a call of a host function it did not import is a module WebAssembly
// refuses (test/imports.ts)
const invalid: string[] = [];
for (const p of programs) {
  const r = compile([...std, { name: p.slice(p.lastIndexOf('/') + 1), text: readFileSync(root + p, 'utf8') }]);
  if (r.wasm) now[p] = { bytes: r.wasm.length, functions: functionsOf(r.wasm) };
  if (r.wasm && !WebAssembly.validate(r.wasm)) invalid.push(p);
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
