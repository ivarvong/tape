// node service/verify/plant/plant.ts --out <jsonl> [--only J1,R7] [--jobs 2]
// node service/verify/plant/plant.ts --check
// Each planted bug (plants.ts) in its own copy of the tree under /tmp/plant/<id> (node_modules linked): the edit is
// applied (it must match exactly once), then the plant's detector runs there. A plant is caught when the detector
// fails; the result line keeps its exit code and the anomaly types the Jepsen runs reported. --check runs nothing:
// it says which edits no longer match this tree, and exits 1 if any does not (the gate runs it, so a plant cannot
// go stale without notice).
import { appendFileSync } from 'node:fs';
import { at, fields, list, text } from '../../jepsen/json.ts';
import { PLANTS } from './plants.ts';
import type { Detect, Plant } from './plants.ts';
import { ROOT, apply, copyTree, fits, flag, matches, reportAt, sh } from './tree.ts';
import type { Ran } from './tree.ts';

if (process.argv.includes('--check')) {
  const stale = PLANTS.flatMap(p => p.edits.filter(e => !fits(ROOT, e)).map(e => ({ id: p.id, e })));
  for (const { id, e } of stale) console.log(`${id}: the edit matches ${matches(ROOT, e)} times in ${e.file}`);
  console.log(`${PLANTS.length} plants, ${stale.length} edits do not match`);
  process.exit(stale.length > 0 ? 1 : 0);
}
const out = flag('out') ?? '/tmp/plant.jsonl',
  only = flag('only')?.split(','),
  jobs = Number(flag('jobs') ?? 2);
const plants = PLANTS.filter(p => only?.includes(p.id) ?? true);

/** What a Jepsen report says: each anomaly type and how often, the tests that failed, and any file's own failure. */
type Reported = { types: Record<string, number>; failed: string[]; message: string };
const typesOf = (report: unknown): Reported | null => {
  if (report === null) return null;
  const types: Record<string, number> = {},
    failed: string[] = [],
    files = list(at(report, 'testResults'));
  for (const t of files.flatMap(f => list(at(f, 'assertionResults')))) {
    const status = at(t, 'status');
    if (status === 'skipped') continue;
    if (status !== 'passed') failed.push(text(at(t, 'title')).slice(0, 60));
    const meta = fields(at(t, 'meta')),
      m = meta['jepsen'] ?? meta['seams'];
    for (const a of [...list(at(m, 'anomalies')), ...list(at(m, 'trace_anomalies'))]) {
      const type = text(at(a, 'type'));
      types[type] = (types[type] ?? 0) + 1;
    }
  }
  const message = files
    .map(f => text(at(f, 'message')))
    .filter(m => m !== '')
    .join('\n')
    .slice(0, 800);
  return { types, failed, message };
};
const jepsen = (file: string, name: string, report: string): string[] => [
  'vitest',
  'run',
  file,
  '-t',
  name,
  '--reporter=json',
  `--outputFile=${report}`,
];
const detect = (d: Detect, dir: string, report: string): Promise<Ran> => {
  const svc = `${dir}/service`;
  if ('kv' in d) return sh('npx', jepsen('test/kv-jepsen.test.ts', 'seed', report), svc, { KV_SEEDS: d.kv });
  if ('wf' in d) return sh('npx', jepsen('test/jepsen.test.ts', 'seed', report), svc, { JEPSEN_SEEDS: d.wf });
  if ('seams' in d) return sh('npx', jepsen('test/seams.test.ts', d.seams, report), svc);
  const [cmd, ...args] = d.cmd;
  return sh(cmd, args, d.cwd === 'service' ? svc : dir);
};
const one = async (plant: Plant): Promise<void> => {
  const dir = copyTree(plant.id),
    began = Date.now(),
    report = `${dir}/report.json`;
  apply(dir, plant.id, plant.edits);
  const r = await detect(plant.detect, dir, report);
  const said = typesOf(reportAt(report)) ?? {
    log: r.log
      .split('\n')
      .filter(l => /FAIL|fail|error|Error|C\d\d/.test(l))
      .slice(0, 12),
  };
  const line = {
    id: plant.id,
    what: plant.what,
    detector: plant.detect,
    caught: r.code !== 0,
    exit: r.code,
    ms: Date.now() - began,
    ...said,
  };
  appendFileSync(out, `${JSON.stringify(line)}\n`);
  console.log(
    `${line.caught ? 'caught' : 'MISSED'} ${plant.id} (exit ${r.code}) ${JSON.stringify('types' in said ? said.types : said.log)}`,
  );
};
const queue = [...plants];
const worker = async (): Promise<void> => {
  for (let plant = queue.shift(); plant !== undefined; plant = queue.shift()) await one(plant);
};
await Promise.all(Array.from({ length: jobs }, worker));
