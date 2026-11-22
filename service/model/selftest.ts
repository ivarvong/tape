// node service/model/selftest.ts: the protocol models and the trace conformance checks, tested.
// 1. Every configuration in configs.ts marked for the small suite: the correct protocol has no violation (and the
//    search was not truncated), each seeded historical bug is found, by the invariant named.
// 2. The production fixtures (jepsen/fixtures/, version c4e7a343) conform; each one-change mutant of them, made the
//    way a bug would show in a trace, does not, with the violation type stated.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fields, list, text } from '../jepsen/json.ts';
import type { Fields } from '../jepsen/json.ts';
import { historyOf } from '../jepsen/kv.ts';
import type { Attempt } from '../jepsen/kv.ts';
import { docOf } from '../jepsen/traces.ts';
import type { Attr, Doc, RawSpan } from '../jepsen/traces.ts';
import { CONFIGS, check } from './configs.ts';
import { conform } from './conformance.ts';
import { conformCalls } from './calls-conformance.ts';

let passed = 0,
  failed = 0;
const T = (name: string, ok: boolean, detail = ''): void => {
  if (ok) passed++;
  else {
    failed++;
    console.log(`FAIL ${name} ${detail}`);
  }
};
for (const c of CONFIGS.filter(config => config[6])) {
  const r = check(c);
  T(`model ${r.model} ${r.name}`, r.pass, `want ${r.expect} found ${r.found} truncated ${r.truncated}`);
}

const load = (n: string): Fields => {
  const stored: unknown = JSON.parse(
    gunzipSync(readFileSync(`${import.meta.dirname}/../jepsen/fixtures/${n}.json.gz`)).toString(),
  );
  return fields(stored);
};
/** What a search found; the self-test stops when the fixture has no such thing. */
const must = <V>(found: V | undefined, what: string): V => {
  if (found === undefined) throw new Error(`the fixture has no ${what}`);
  return found;
};
/** The traces of a fixture as OTLP documents, by trace id: a copy, to change. */
const docsOf = (traces: unknown): Record<string, Doc> =>
  Object.fromEntries(Object.entries(fields(traces)).map(([id, otlp]) => [id, docOf(otlp)]));
const allSpans = (traces: Readonly<Record<string, Doc>>): RawSpan[] =>
  Object.values(traces).flatMap(o => o.resourceSpans.flatMap(r => r.scopeSpans.flatMap(sc => sc.spans)));
const a = (of: { attributes: Attr[] }, k: string): Attr | undefined => of.attributes.find(x => x.key === k);
const types = (r: { violations: readonly { type: string }[] }): string =>
  [...new Set(r.violations.map(v => v.type))].toSorted().join(',');

const kvf = load('kv'),
  wff = load('workflow');
const history = historyOf(kvf['history']),
  shards = typeof kvf['shards'] === 'number' ? kvf['shards'] : 0;
const kvc = (h: readonly Attempt[], tr: Readonly<Record<string, unknown>> = fields(kvf['traces'])) =>
  conform(h, tr, { account: text(kvf['account']), cluster: text(kvf['cluster']), shards });
const base = kvc(history);
T('kv fixture conforms', base.conforms, types(base));
{
  const putOk = must(
    history.find(h => h.f === 'put' && (h.status === 201 || h.status === 200)),
    'acknowledged put',
  );
  const r = kvc([...history, { ...putOk, once: 'c9-999' }]);
  T('kv mutant: one commit seen under a second op id (applied twice)', !r.conforms, types(r));
}
{
  // an op sent once, answered 2xx: no other attempt replays it
  const once = (n: string | undefined): boolean => history.filter(h => h.once === n).length === 1;
  const commits = history.filter(h => h.f !== 'get' && (h.status === 200 || h.status === 201) && once(h.once));
  const dropped = must(commits[1], 'second commit');
  const r = kvc(history.filter(h => h !== dropped));
  T(
    'kv mutant: a commit missing (no unknown op to explain the version gap)',
    r.violations.some(v => v.type === 'commit-not-at-next-version'),
    types(r),
  );
}
{
  // a read whose statement returned the version before the current one (a stale read, as H1's old instance gave)
  const g = must(
      history.find(h => h.f === 'get' && h.status === 200 && (h.version ?? 0) > 1),
      'read of a later version',
    ),
    tr = docsOf(kvf['traces']);
  let edited = 0;
  for (const sp of allSpans({ one: must(tr[g.trace], 'trace of that read') }))
    for (const ev of sp.events) {
      const query = a(ev, 'db.query.text'),
        rows = a(ev, 'tape.sql.rows');
      if (query?.value.stringValue?.startsWith('SELECT key, value, version, live FROM kv') !== true || !rows) continue;
      const stored: unknown = JSON.parse(rows.value.stringValue ?? '[]');
      const [first, ...rest] = list(stored).map(list);
      const [key, value, version, ...more] = first ?? [];
      rows.value = { stringValue: JSON.stringify([[key, value, Number(version) - 1, ...more], ...rest]) };
      edited++;
    }
  const r = kvc(history, tr);
  T(
    'kv mutant: a read returns the version before the current one (stale read)',
    edited === 1 && r.violations.some(v => v.type === 'read-not-current'),
    `${edited} ${types(r)}`,
  );
}

const wfc = conformCalls(fields(wff['traces']));
T('workflow fixture calls conform', wfc.conforms, JSON.stringify(wfc.violations.slice(0, 2)));
T(
  'workflow fixture: every ok/rejected answer is matched to a run in the traces',
  wfc.stats.run_not_in_traces === 0 && wfc.stats.answered_ran > 100,
  JSON.stringify(wfc.stats),
);
const deduplicated = (sp: RawSpan): boolean => a(sp, 'tape.call.deduplicated')?.value.boolValue === true;
const answeredOk = (sp: RawSpan): boolean => sp.kind === 3 && a(sp, 'tape.call.status')?.value.stringValue === 'ok';
{
  const tr = docsOf(wff['traces']),
    run = must(
      allSpans(tr).find(sp => sp.kind === 2 && a(sp, 'tape.request_id') && a(sp, 'tape.call.key') && !deduplicated(sp)),
      'callee run',
    );
  const copy = structuredClone(run);
  must(a(copy, 'tape.request_id'), 'request id').value = { stringValue: 'another-run' };
  must(Object.values(tr)[0]?.resourceSpans[0]?.scopeSpans[0], 'scope').spans.push(copy);
  const r = conformCalls(tr);
  T(
    "calls mutant: a key's message runs twice (charged twice)",
    r.violations.some(v => v.type === 'key-committed-twice'),
    types(r),
  );
}
{
  const tr = docsOf(wff['traces']),
    call = must(allSpans(tr).find(answeredOk), 'call answered ok');
  must(a(call, 'tape.call.status'), 'call status').value = { stringValue: 'rejected' };
  const r = conformCalls(tr);
  T(
    'calls mutant: a caller told rejected for a key whose run answered ok (S2/M1 shape)',
    r.violations.some(v => v.type === 'answer-not-the-stored-reply'),
    types(r),
  );
}
{
  const tr = docsOf(wff['traces']),
    call = must(
      allSpans(tr).find(sp => answeredOk(sp) && !deduplicated(sp)),
      'first call answered ok',
    );
  const key = a(call, 'tape.call.key')?.value.stringValue;
  for (const o of Object.values(tr))
    for (const r of o.resourceSpans)
      for (const sc of r.scopeSpans)
        sc.spans = sc.spans.filter(sp => !(sp.kind === 2 && a(sp, 'tape.call.key')?.value.stringValue === key));
  const r = conformCalls(tr);
  T(
    'calls mutant: an ok answer with no run behind it (H2 shape)',
    r.violations.some(v => v.type === 'ok-without-run'),
    types(r),
  );
}
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
