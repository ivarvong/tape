// Runs every model configuration (model/configs.ts) and the trace conformance checks, writing one JSON file.
//   node model/run.ts [--small] [--out file] [--kv dir...] [--calls dir...]
// --kv dirs hold <account>.json and <account>.traces.json from jepsen/run.ts or kv-run.ts; --calls dirs the same
// from the workflow runner.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fields, text } from '../jepsen/json.ts';
import { historyOf } from '../jepsen/kv.ts';
import { CONFIGS, check } from './configs.ts';
import { conform } from './conformance.ts';
import { conformCalls } from './calls-conformance.ts';

const args = process.argv.slice(2),
  small = args.includes('--small');
/** The values after a flag, up to the next flag. */
const valuesOf = (flag: string): string[] => {
  const i = args.indexOf(flag);
  if (i < 0) return [];
  const rest = args.slice(i + 1),
    end = rest.findIndex(a => a.startsWith('--'));
  return end < 0 ? rest : rest.slice(0, end);
};
const read = (path: string): unknown => {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return value;
};
const [out] = valuesOf('--out');
const models = CONFIGS.filter(c => !small || c[6]).map(c => {
  const r = check(c);
  console.log(
    `${r.pass ? 'pass' : 'FAIL'} ${r.model} ${r.name}: ${r.states} states, ${r.transitions} transitions, depth ${r.depth}${r.truncated ? ' TRUNCATED' : ''}, ${r.ms} ms, found ${r.found ?? 'none'}`,
  );
  return r;
});
/** One stored KV run (jepsen/kv-run.ts) against the model. */
const kvRun = (dir: string, f: string): Record<string, unknown> & { conforms: boolean } => {
  const d = fields(read(`${dir}/${f}`)),
    traces = fields(read(`${dir}/${f.replace(/\.json$/, '.traces.json')}`));
  const shards = d['shards'] ?? fields(d['config'])['shards'],
    account = text(d['account']),
    valid = fields(d['result'])['valid'];
  const r = conform(historyOf(d['history']), traces, {
    account,
    cluster: typeof d['cluster'] === 'string' ? d['cluster'] : 'j',
    shards: typeof shards === 'number' ? shards : 0,
  });
  const kinds = r.conforms ? '' : ` ${[...new Set(r.violations.map(v => v.type))].join(',')}`;
  console.log(`kv ${account}: jepsen ${String(valid)} conforms ${r.conforms}${kinds}`);
  return {
    account,
    jepsen_valid: valid,
    conforms: r.conforms,
    stats: r.stats,
    violations: r.violations.slice(0, 20).map(v => ({ type: v.type, key: v.key, once: v.once, trace: v.trace })),
  };
};
const kvRuns = valuesOf('--kv').flatMap(dir =>
  readdirSync(dir)
    .filter(f => f.endsWith('.json') && !f.endsWith('.traces.json'))
    .map(f => kvRun(dir, f)),
);
const callRuns = valuesOf('--calls').flatMap(dir =>
  readdirSync(dir)
    .filter(f => f.endsWith('.traces.json'))
    .map(f => {
      const r = conformCalls(fields(read(`${dir}/${f}`)));
      console.log(`calls ${f}: conforms ${r.conforms}`);
      return {
        account: f.replace(/\.traces\.json$/, ''),
        conforms: r.conforms,
        stats: r.stats,
        violations: r.violations.slice(0, 20),
      };
    }),
);
const summary = {
  at: new Date().toISOString(),
  small,
  models_pass: models.filter(m => m.pass).length,
  models: models.length,
  kv_conform: kvRuns.filter(r => r.conforms).length,
  kv: kvRuns.length,
  calls_conform: callRuns.filter(r => r.conforms).length,
  calls: callRuns.length,
};
console.log(JSON.stringify(summary));
if (out !== undefined) writeFileSync(out, JSON.stringify({ summary, models, kvRuns, callRuns }, null, 1));
process.exitCode = models.every(m => m.pass) ? 0 : 1;
