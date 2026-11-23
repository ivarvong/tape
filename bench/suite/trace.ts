// bench/suite/trace.ts: OTLP/JSON to an SVG waterfall: apps/trace/trace.tape against its JS port, trace-js.ts.
import { readFileSync } from 'node:fs';
import { ROOT, enc } from './common.ts';
import type { Workload } from './common.ts';
import { handle as traceJs } from './trace-js.ts';
import { traceOf } from './trace-gen.ts';

const FIXTURES = ['big', 'clock', 'deep', 'failure', 'fulfillment', 'hello', 'orders', 'shop'];
const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;
const records = (x: unknown): Record<string, unknown>[] => (Array.isArray(x) ? x.filter(isRecord) : []);
/**
 * A generated trace whose events include writes and timers a rollback undid (tape.sql.undone, tape.timer.undone;
 * the dashed marks), true, false or repeated, so the port is checked on them too: the generator itself has none,
 * since its k = 0 must stay big.json byte for byte.
 */
function withUndone(spans: number, seed: number): Uint8Array {
  const doc: unknown = JSON.parse(traceOf(spans, seed));
  const flag = (key: string, v: boolean) => ({ key, value: { boolValue: v } });
  let n = 0;
  for (const rs of records(isRecord(doc) ? doc['resourceSpans'] : null))
    for (const ss of records(rs['scopeSpans']))
      for (const sp of records(ss['spans'])) {
        const k = n++;
        const t = String(sp['startTimeUnixNano']);
        const extra = [
          { timeUnixNano: t, name: 'db.query', attributes: [flag('tape.sql.undone', k % 3 !== 0)] },
          { timeUnixNano: t, name: 'tape.timer.set', attributes: [flag('tape.timer.undone', k % 4 !== 0)] },
          // the first of two is what counts
          {
            timeUnixNano: t,
            name: 'db.exec',
            attributes: [flag('tape.sql.undone', k % 2 === 0), flag('tape.sql.undone', k % 2 !== 0)],
          },
        ];
        sp['events'] = [...records(sp['events']), ...extra.slice(0, 1 + (k % 3))];
      }
  return enc.encode(JSON.stringify(doc));
}
export const workload: Workload = {
  name: 'trace',
  describe: 'OTLP/JSON trace to an SVG waterfall (apps/trace/trace.tape vs bench/suite/trace-js.ts)',
  tape: 'apps/trace/trace.tape',
  sql: false,
  js: () => traceJs,
  inputs: () => [
    ...FIXTURES.map(f => new Uint8Array(readFileSync(`${ROOT}apps/trace/fixtures/${f}.json`))),
    ...Array.from({ length: 100 }, (_, i) => enc.encode(traceOf([1, 5, 40, 300][i % 4] ?? 1, i + 1))),
    ...Array.from({ length: 12 }, (_, i) => withUndone([1, 3, 40][i % 3] ?? 1, i + 500)),
  ],
  // scale 1: 2,000 spans, the size of big.json (k = 0 is big.json itself, byte for byte)
  request: (k, scale) => enc.encode(traceOf(Math.round(2000 * scale), k)),
};
