// bench/heap.ts: where csv.tape's memory goes. node bench/heap.ts [bytes]
import '../node25.ts';
import { heapOf, instantiate, responseOf } from '../host.ts';
import { built, moduleOf, read } from '../test/harness.ts';
import { gen } from './csv-gen.ts';

const sources = [{ name: 'examples/csv.tape', text: read('examples/csv.tape') }];
const size = Number(process.argv[2] ?? 1_000_000);
const input = gen(size, 7);
const app = instantiate(moduleOf(built(sources)));
const out: unknown = JSON.parse(new TextDecoder().decode(responseOf(app.handle(input)).body));
const h = heapOf(moduleOf(built(sources, { profile: true })), input, app.effects);
const rows = input.toString().split('\n').length - 2;
const listed = typeof out === 'object' && out !== null && 'countries' in out ? out.countries : [];
const countries = Array.isArray(listed) ? listed.length : 0;
console.log(
  `input ${input.length} bytes, ${rows} rows, ${countries} countries; allocated ${h.total} bytes (${(h.total / input.length).toFixed(1)}x the input, ${(h.total / rows).toFixed(0)} per row)${h.error === null ? '' : ` ERROR ${h.error}`}`,
);
for (const f of h.functions.slice(0, 8))
  console.log(
    `${(100 * f.share).toFixed(1).padStart(5)}%  ${String(f.bytes).padStart(10)} bytes  ${String(f.count).padStart(7)} allocations  ${f.fn}   <- ${f.from.map(c => c.fn).join(', ')}`,
  );
console.log(
  `live at the end: one map of ${countries} nodes, ${countries * 72} bytes (${((100 * countries * 72) / h.total).toFixed(3)}% of what was allocated)`,
);
