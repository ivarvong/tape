// node service/verify/seeds/seams-summary.ts <report.json>: what a run of test/seams.test.ts (vitest's JSON
// report) found, as text: each test's status, the seams it covered, its counts, and the cases with anomalies.
import { readFileSync } from 'node:fs';
import { at, fields, list, text } from '../../jepsen/json.ts';

const [path] = process.argv.slice(2);
if (path === undefined) throw new Error('usage: seams-summary.ts <report.json>');
const report: unknown = JSON.parse(readFileSync(path, 'utf8'));
for (const f of list(at(report, 'testResults'))) {
  const message = text(at(f, 'message'));
  if (message !== '') console.log(message.slice(0, 2000));
  for (const t of list(at(f, 'assertionResults'))) {
    if (at(t, 'status') === 'skipped') continue;
    const failures = list(at(t, 'failureMessages')).map(String).join('').slice(0, 1500);
    console.log('##', at(t, 'title'), at(t, 'status'), at(t, 'duration'), failures);
    const m = at(t, 'meta', 'seams');
    if (m === undefined) continue;
    console.log(JSON.stringify(at(m, 'counts') ?? ''));
    for (const [k, v] of Object.entries(fields(at(m, 'coverage')))) console.log(' ', k, JSON.stringify(v));
    console.log(JSON.stringify(at(m, 'stats')), JSON.stringify(at(m, 'traces')));
    console.log(JSON.stringify(at(m, 'anomalies')).slice(0, 4000));
    console.log(JSON.stringify(list(at(m, 'cases')).filter(c => list(at(c, 4)).length > 0)).slice(0, 3000));
  }
}
