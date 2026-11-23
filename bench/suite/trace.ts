// bench/suite/trace.ts: OTLP/JSON to an SVG waterfall: apps/trace/trace.tape against its JS port, trace-js.ts.
import { readFileSync } from 'node:fs';
import { ROOT, enc } from './common.ts';
import type { Workload } from './common.ts';
import { handle as traceJs } from './trace-js.ts';
import { traceOf } from './trace-gen.ts';

const FIXTURES = ['big', 'clock', 'deep', 'failure', 'fulfillment', 'hello', 'orders', 'shop'];
export const workload: Workload = {
  name: 'trace',
  describe: 'OTLP/JSON trace to an SVG waterfall (apps/trace/trace.tape vs bench/suite/trace-js.ts)',
  tape: 'apps/trace/trace.tape',
  sql: false,
  js: () => traceJs,
  inputs: () => [
    ...FIXTURES.map(f => new Uint8Array(readFileSync(`${ROOT}apps/trace/fixtures/${f}.json`))),
    ...Array.from({ length: 100 }, (_, i) => enc.encode(traceOf([1, 5, 40, 300][i % 4] ?? 1, i + 1))),
  ],
  // scale 1: 2,000 spans, the size of big.json (k = 0 is big.json itself, byte for byte)
  request: (k, scale) => enc.encode(traceOf(Math.round(2000 * scale), k)),
};
