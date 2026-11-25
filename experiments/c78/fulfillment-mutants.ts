// Mutants of examples/fulfillment.tape for C78 and C79 (round 1): each prints the codes it gets.
import '../../node25.ts';
import { readFileSync, readdirSync } from 'node:fs';
import { compile } from '../../compiler.ts';
const R = new URL('../../', import.meta.url).pathname;
const std = readdirSync(`${R}std`)
  .filter(f => f.endsWith('.tape'))
  .map(f => ({ name: `std/${f}`, text: readFileSync(`${R}std/${f}`, 'utf8') }));
const codes = (text: string): string[] =>
  compile([...std, { name: 'fulfillment.tape', text }]).errors.map(e => `${e.code}:${e.line}`);
const t = readFileSync(`${R}examples/fulfillment.tape`, 'utf8');
export const fulfillmentMutants: Record<string, readonly [string, string]> = {
  'F1 a timed-out step is not tried again': ['Timeout -> retrying(id, why: step ++ " did not answer in time", found: failed_again(id, state))', 'Timeout -> show(status: 202, found: noted(id, state, stall: step))'],
  'F2 a failed refund is noted, not tried again': ['Err(error) -> stalled(id, state: Refunding, step: "payments.refund", error)', 'Err(error) -> show(status: 502, found: noted(id, state: Refunding, stall: "refund failed"))'],
  'F3 the retry timer keyed 7': ['retry_later(timer, key: id,', 'retry_later(timer, key: 7,'],
};
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('fulfillment as is', codes(t));
  for (const [n, [a, b]] of Object.entries(fulfillmentMutants)) {
    if (!t.includes(a)) throw new Error(n);
    console.log(n, codes(t.replace(a, b)));
  }
}
