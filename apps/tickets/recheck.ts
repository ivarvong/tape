// Re-run the trace check of finished tickets Jepsen runs on their saved history and final state, with the traces
// fetched again (the checker of harness.ts as it is now). The token is read from the file and never printed.
// node apps/tickets/recheck.ts --base … --token-file … --dir /tmp/…/tix
import { readFileSync, readdirSync } from 'node:fs';
import { need, tokenFromFile } from '../../service/jepsen/cli.ts';
import { makeSender } from '../../service/jepsen/client.ts';
import { collectTraces, checkTraces, historyOf } from '../../service/jepsen/harness.ts';
import { at, list, text } from '../../service/jepsen/json.ts';
import { stateFrom } from './rows.ts';

const base = need('base'),
  token = tokenFromFile(),
  dir = need('dir');
for (const f of readdirSync(dir)
  .filter(name => name.endsWith('.json'))
  .toSorted()) {
  const stored: unknown = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'));
  const account = text(at(stored, 'account')),
    history = historyOf(at(stored, 'history')),
    audit = at(stored, 'final', 'audit');
  const send = makeSender({ base, token, route: path => `/${account}${path}` });
  const traces = await collectTraces(send, history);
  const waitlisted = new Set(
    stateFrom(audit, [], [])
      .holds.filter(h => h.client.startsWith('waitlist-'))
      .map(h => h.id),
  );
  const tr = checkTraces(history, { holds: list(at(audit, 'holds')) }, traces, { tables: [['holds', 'hold']] });
  const anomalies = tr.anomalies.filter(
    a => !(a.type === 'holds-created-by-no-trace' && typeof a['id'] === 'number' && waitlisted.has(a['id'])),
  );
  console.log(
    JSON.stringify({
      account,
      was: at(stored, 'traces', 'valid'),
      was_anomalies: [...new Set(list(at(stored, 'traces', 'anomalies')).map(a => at(a, 'type')))],
      now: anomalies.length === 0,
      anomalies,
      router_missing_unanswered: tr.stats.router_missing_unanswered ?? 0,
    }),
  );
}
