// bench/suite/workerd/worker.ts: the three workloads with no database (csv, words, trace), served by workerd so
// they can be timed in the runtime the service runs in. GET /?w=csv&way=tape|js|none&k=0 answers one request of
// that workload at scale 1 (input k of 4, made once per isolate) and says how many bytes the answer had. Inside
// workerd the clock does not move while code runs, so bench/suite/workerd.ts times each fetch from outside and
// subtracts way=none (the same fetch doing no work).
import { handle as csvJs } from '../../csv-baseline.ts';
import { gen as csvGen } from '../../csv-gen.ts';
import { instantiate } from '../../../host.ts';
import { prose, wordsJs } from '../pure.ts';
import { handle as traceJs } from '../trace-js.ts';
import { traceOf } from '../trace-gen.ts';
import { enc } from '../rand.ts';
// @ts-expect-error -- a Wasm module, bound by the workerd config
import csvWasm from './csv.wasm';
// @ts-expect-error -- as above
import wordsWasm from './words.wasm';
// @ts-expect-error -- as above
import traceWasm from './trace.wasm';

type Entry = { js: (b: Uint8Array) => Uint8Array; module: WebAssembly.Module; make: (k: number) => Uint8Array };
// the Wasm imports have no type (see above); workerd binds each to a compiled WebAssembly.Module
/* oxlint-disable typescript/no-unsafe-type-assertion -- the bindings above, typed here */
const WORKLOADS: Record<string, Entry> = {
  csv: {
    js: csvJs,
    module: csvWasm as WebAssembly.Module,
    make: k => new Uint8Array(csvGen(2_000_000, k + 7, k % 2 === 0)),
  },
  words: { js: wordsJs, module: wordsWasm as WebAssembly.Module, make: k => prose(2_000_000, k + 11) },
  trace: { js: traceJs, module: traceWasm as WebAssembly.Module, make: k => enc.encode(traceOf(2000, k)) },
};
/* oxlint-enable typescript/no-unsafe-type-assertion */
const inputs = new Map<string, Uint8Array[]>();
const apps = new Map<string, ReturnType<typeof instantiate>>();

export default {
  fetch(request: Request): Response {
    const u = new URL(request.url);
    const name = u.searchParams.get('w') ?? 'csv';
    const way = u.searchParams.get('way') ?? 'none';
    const k = Number(u.searchParams.get('k') ?? '0') % 4;
    const w = WORKLOADS[name];
    if (!w) return new Response('no such workload', { status: 404 });
    if (u.searchParams.has('prepare')) {
      inputs.set(name, inputs.get(name) ?? Array.from({ length: 4 }, (_, i) => w.make(i)));
      return new Response('ready');
    }
    const input = inputs.get(name)?.[k];
    if (!input) return new Response('prepare first', { status: 409 });
    if (way === 'none') return new Response(String(input.length));
    if (way === 'js') return new Response(String(w.js(input).length));
    const app = apps.get(name) ?? instantiate(w.module, { log: false });
    apps.set(name, app);
    return new Response(String(app.handle(input).length));
  },
};
