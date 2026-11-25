// compileAlso (compiler/build.ts builds): the build and its traced build from one parse and one set of checks are byte
// for byte what two compiles of their own make, for every program in examples/, apps/ and the std files' own
// examples run (doctest's build is not here: it compiles once), and a second traced build in a row is too (the
// first leaves nothing behind in the front). A program that does not compile is refused with the same problems.
// What is compared: the Wasm, the sites the line trace reads, the queries, the build's name and `refused`.
import { readdirSync, readFileSync } from 'node:fs';
import { compile, compileAlso } from '../compiler.ts';
import type { Built } from '../compiler.ts';
import { std } from '../std.ts';
import { finish, same } from './harness.ts';

const ROOT = new URL('../', import.meta.url).pathname;
const tapes = (d: string): string[] =>
  readdirSync(ROOT + d)
    .filter(f => f.endsWith('.tape'))
    .map(f => `${d}/${f}`);
const programs: { name: string; files: { name: string; text: string }[] }[] = [
  ...[...tapes('examples'), ...tapes('apps/trace'), 'apps/tickets/tickets.tape'].map(p => ({
    name: p,
    files: [{ name: p, text: readFileSync(ROOT + p, 'utf8') }],
  })),
  {
    name: 'apps/tickets/tickets.tape + pay.tape',
    files: ['apps/tickets/tickets.tape', 'apps/tickets/pay.tape'].map(p => ({
      name: p,
      text: readFileSync(ROOT + p, 'utf8'),
    })),
  },
  // refused: a type error, and a write a retry would apply twice (a rule, found after the checks)
  { name: 'a type error', files: [{ name: 'bad.tape', text: 'fn handle(raw: View) -> Response {\n  1 + "a"\n}\n' }] },
];
const hex = (b: Uint8Array | null): string => (b ? Buffer.from(b).toString('hex') : 'null');
const shape = (b: Built): unknown => [hex(b.wasm), b.sites, b.queries, b.build, b.refused];
let compiledN = 0,
  refusedN = 0;
for (const p of programs) {
  const sources = [...std, ...p.files];
  const plain = compile(sources),
    traced = compile(sources, { trace: true }),
    both = compileAlso(sources, {}, [{ trace: true }, { trace: true }]);
  if (plain.wasm === null || !Array.isArray(both)) {
    refusedN++;
    same(
      `${p.name}: refused with the same problems`,
      Array.isArray(both) ? 'compiled' : both.errors,
      plain.wasm === null ? plain.errors : 'compiled',
    );
    continue;
  }
  if (traced.wasm === null) throw new Error(`${p.name}: the traced build alone was refused`);
  compiledN++;
  const [a, b, c] = both;
  same(`${p.name}: the build`, shape(a), shape(plain));
  same(`${p.name}: the traced build`, b && shape(b), shape(traced));
  same(`${p.name}: a second traced build`, c && shape(c), shape(traced));
}
same('programs that compiled, and refused (both kinds reached)', [compiledN > 20, refusedN >= 1], [true, true]);
finish();
