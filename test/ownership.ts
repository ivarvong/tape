// compiler/gen/ownership.ts reads a function again only when a function it calls changed (a worklist) and keeps the
// steps down to an expression as a linked path; it was read by rounds of every function until a round changed
// nothing, with the path copied at each expression. The rounds are the oracle (ownershipRounds: true): every
// program here, plain and traced, compiles to the same bytes both ways, owning copies and all.
import { readdirSync, readFileSync } from 'node:fs';
import { compile } from '../compiler.ts';
import { std } from '../std.ts';
import { finish, same } from './harness.ts';

const ROOT = new URL('../', import.meta.url).pathname;
const programs = ['examples', 'examples/timed', 'examples/tools', 'apps/trace', 'apps/tickets', 'bench/suite'].flatMap(
  d =>
    readdirSync(`${ROOT}${d}`)
      .filter(f => f.endsWith('.tape'))
      .map(f => `${d}/${f}`),
);
const differ: string[] = [];
let compared = 0;
for (const p of programs)
  for (const trace of [false, true]) {
    const sources = [...std, { name: p, text: readFileSync(`${ROOT}${p}`, 'utf8') }];
    const a = compile(sources, { trace }),
      b = compile(sources, { trace, ownershipRounds: true });
    if (a.wasm === null || b.wasm === null) {
      if ((a.wasm === null) !== (b.wasm === null)) differ.push(`${p}: one refused`);
      continue;
    }
    compared++;
    if (Buffer.compare(Buffer.from(a.wasm), Buffer.from(b.wasm)) !== 0) differ.push(`${p}${trace ? ' traced' : ''}`);
  }
same(`${compared} builds: the worklist gives the bytes the rounds give`, differ, []);
same('and the programs compared are most of them', compared >= 70, true);
finish();
