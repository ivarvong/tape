// One planted bug in each program of examples/timed (round 2), to show C77-C79 read them: [name, file, pairs, want].
import { shown } from './round2.ts';
import type { Mutant } from './round2.ts';
const T = (f: string) => `examples/timed/${f}.tape`;
export const timedMutants: Mutant[] = [
  ['T1 outbox: giving up leaves the delivery pending (no request moves it)', T('outbox'), [['GaveUp(tries) -> shown(found: moved(id, to: "dead",', 'GaveUp(tries) -> shown(found: noted(id,']], ['C79', 'GaveUp(tries) -> shown(found: noted(id,']],
  ['T2 expense: no answer from payments, no timer again', T('expense'), [['      do wake(after: 5000, key: id)\n      unknown(id)', '      unknown(id)']], ['C79', 'Err(error) -> {\n      unknown(id)']],
  ['T3 transfer: a failed step is not tried again (backoff, no timer)', T('transfer'), [['plan: retry_later(timer, key: id, policy: policy(), failed: n)', 'plan: backoff(policy: policy(), failed: n)']], ['C79', 'Err(error) -> failed(id, state: "withdrawing", tries)', 'among']],
  ['T4 delivery: the charge asked again by the timer sets none (the bug C79 found)', T('delivery'), [['Err(error) -> {\n      do wake(after: 5000, key: id)\n      again(found: load(id))\n    }\n  }\n}\n\nfn waiting', 'Err(error) -> shown(found: load(id))\n  }\n}\n\nfn waiting']], ['C79', 'Err(error) -> shown(found: load(id))']],
  ['T5 authcapture: a refused capture is authorized again with no void timer', T('authcapture'), [['      do wake(after: left(until: void_at), key: id)\n', '']], ['C77', "UPDATE payments SET state = 'authorized', note = :reason"]],
  ['T6 trial: reminded, and no timer for the trial\'s end', T('trial'), [['Some(value: t = Trial(state: "reminded", ends)) -> {\n      do wake(after: ends - now(), key: id)\n      later(trial: t)\n    }', 'Some(value: t = Trial(state: "reminded", ends)) -> later(trial: t)']], ['C77', "UPDATE trials SET state = 'reminded'", 'with']],
  ['T7 escalation: the page noted, the SLA timer it replaced not set again (the bug C79 found)', T('escalation'), [['      do wake(after: left(until: due), key: id)\n      noted(id)', '      noted(id)']], ['C79', 'Ok(value) -> {\n      noted(id)']],
];
if (import.meta.url === `file://${process.argv[1]}`) for (const m of timedMutants) console.log(shown(m, 80));
