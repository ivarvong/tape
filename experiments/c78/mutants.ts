// Mutants of apps/tickets/tickets.tape for the C77 weaknesses (round 1): each is a bug a correct way-out rule
// refuses. node experiments/c78/mutants.ts [--json]  -> one line per mutant: its name and the codes it gets.
import '../../node25.ts';
import { readFileSync, readdirSync } from 'node:fs';
import { compile } from '../../compiler.ts';
import { readFlat } from '../../fmt.ts';
const here = (p: string): string => new URL(`../../${p}`, import.meta.url).pathname;
const read = (p: string): string => (p.endsWith('.tape') ? readFlat(here(p)) : readFileSync(here(p), 'utf8'));
const std = readdirSync(here('std')).filter(f => f.endsWith('.tape')).map(f => ({ name: `std/${f}`, text: read(`std/${f}`) }));
const tickets = read('apps/tickets/tickets.tape');
type Pair = readonly [string, string];
const swap = (text: string, pairs: readonly Pair[]): string =>
  pairs.reduce((t, [a, b]) => {
    if (!t.includes(a)) throw new Error(`not found: ${a}`);
    return t.replace(a, b);
  }, text);
const problems = (text: string) => compile([...std, { name: 'tickets.tape', text }]).errors;
const NOREFUNDWAKE: Pair = ['      do wake(after: 5000, key: id)\n      refund_hold(hold: value)', '      refund_hold(hold: value)'];
export const mutants: (readonly [string, ...Pair[]])[] = [
  ['1a refund timer keyed 999999', ['do wake(after: 5000, key: id)\n      refund_hold(hold: value)', 'do wake(after: 5000, key: 999999)\n      refund_hold(hold: value)']],
  ['1b decline timer keyed as the event (0 - id)', ['do wake(after: 0, key: id)\n      held_again(reason)', 'do wake(after: 0, key: 0 - id)\n      held_again(reason)']],
  ['1c new hold timer keyed by its tier', ['do wake(after: ms, key: hold.id)', 'do wake(after: ms, key: tier)']],
  ['2a unknown outcome: no timer again', ['fn unknown(id: Int, n: Int) -> Outcome {\n  // first the shortest wait, so no way out of this run leaves the hold without a timer; ask_again moves it later\n  do wake(after: 5000, key: id)\n', 'fn unknown(id: Int, n: Int) -> Outcome {\n'], ['      do wake(after, key: id)\n      asked(found: load_hold(id))', '      asked(found: load_hold(id))']],
  ['2b due before expiry: no timer again', ['      do wake(after: expires - now(), key: id)\n      ShowHold(status: 200, hold)', '      ShowHold(status: 200, hold)']],
  ['2c refund failed: no timer again', ['fn refund_unknown(id: Int, n: Int) -> Outcome {\n  do wake(after: 5000, key: id)\n', 'fn refund_unknown(id: Int, n: Int) -> Outcome {\n'], ['      do wake(after, key: id)\n      shown_hold(found: load_hold(id))', '      shown_hold(found: load_hold(id))']],
  ['2d due leaves a refunding hold alone', ['    Hold(state: "refunding") -> refund_hold(hold)\n', '    Hold(state: "refunding") -> ShowHold(status: 200, hold)\n']],
  ['3a refund timer set after the call', ['      do wake(after: 5000, key: id)\n      refund_hold(hold: value)', '      let r = refund_hold(hold: value)\n      do wake(after: 5000, key: id)\n      r']],
  ['3b no refund timer; sweep picks confirmed by a parameter', NOREFUNDWAKE, ["h.state = 'confirmed' ORDER BY h.id LIMIT 1\", event)", "h.state = :state ORDER BY h.id LIMIT 1\", event, state: \"confirmed\")"]],
  ['3c no refund timer; sweep picks by NOT IN', NOREFUNDWAKE, ["h.state = 'confirmed' ORDER BY h.id LIMIT 1", "h.state NOT IN ('held', 'paying', 'refunding', 'refunded', 'released', 'expired') ORDER BY h.id LIMIT 1"]],
  ['3d no refund timer; sweep picks by <>', NOREFUNDWAKE, ["h.state = 'confirmed' ORDER BY h.id LIMIT 1", "h.state <> 'refunding' AND h.state <> 'refunded' ORDER BY h.id LIMIT 1"]],
];
if (import.meta.url === `file://${process.argv[1]}`) {
  const out = [['0 tickets as is'] as const, ...mutants].map(([name, ...pairs]) => {
    const found = problems(swap(tickets, pairs));
    return { name, codes: found.map(e => `${e.code}:${e.line}`), errors: found.map(e => e.message.slice(0, 160)) };
  });
  if (process.argv.includes('--json')) console.log(JSON.stringify(out));
  else
    for (const o of out)
      console.log(o.name.padEnd(58), o.codes.join(' ') || '-', o.codes.length > 0 ? `| ${o.errors[0] ?? ''}` : '');
}
