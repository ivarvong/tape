// Mutants for the C77-C79 weaknesses left by round 1 (round 2): a key that derives from the row's but is not
// it, a sweep read through OR, a retry policy that gives up without saying so, woken's guards routing a key away
// from its read-back, and an outcome that calls again but whose call's own outcomes leave the row.
// node experiments/c78/round2.ts  -> one line per mutant: its name, the codes it gets and what it wants.
// Each mutant: [name, file, pairs, want], want = [code, anchor text whose line it is at] or [] (accepted).
import '../../node25.ts';
import { readFileSync, readdirSync } from 'node:fs';
import { compile } from '../../compiler.ts';
import { readFlat } from '../../fmt.ts';
/** A replacement in a program's text: [what is there, what to put]. */
export type Pair = readonly [string, string];
/** What a mutant wants: nothing (it is accepted), or [code, the text whose line it is at, how]. */
export type Want = readonly [] | readonly [string, string] | readonly [string, string, 'among' | 'with'];
export type Mutant = readonly [name: string, file: string, pairs: readonly Pair[], want: Want];
const here = (p: string): string => new URL(`../../${p}`, import.meta.url).pathname;
const read = (p: string): string => (p.endsWith('.tape') ? readFlat(here(p)) : readFileSync(here(p), 'utf8'));
const NOREFUNDWAKE: Pair = ['      do wake(after: 5000, key: id)\n      refund_hold(hold: value)', '      refund_hold(hold: value)'];
const SWEEP = "h.state = 'confirmed' ORDER BY h.id LIMIT 1";
const REFUNDING = "UPDATE holds SET state = 'refunding'";
// a policy of one's own: three tries, then nothing (F4), or a type whose giving up is (F5b) or is not (F5a) declared final
const OWN = (stop: string, give: string): Pair[] => [['waiting(decided: retry_later(timer, key: id, policy: resume(), failed: retries))', `planned(decided: again(id, failed: retries))`],
  ['fn waiting(decided: Retry) -> View {', `type Plan {\n  Again(after: Int)\n  ${stop}\n}\n\nfn again(id: Int, failed: Int) -> Plan {\n  match {\n    failed >= 3 -> ${give}\n    else -> Again(after: wake(timer, after: 1000, key: id))\n  }\n}\n\nfn planned(decided: Plan) -> View {\n  match decided {\n    Again(after) -> "; again in " ++ decimal_text(value: after) ++ " ms"\n    Stop -> "; stopped"\n  }\n}\n\nfn waiting(decided: Retry) -> View {`]];
export const round2: Mutant[] = [
  // (1) the key must be the row's key, not one computed from it
  ['4a refund timer keyed id + 1', 'apps/tickets/tickets.tape', [['do wake(after: 5000, key: id)\n      refund_hold(hold: value)', 'do wake(after: 5000, key: id + 1)\n      refund_hold(hold: value)']], ['C78', REFUNDING]],
  ['4b new hold timer keyed hold.id * 2', 'apps/tickets/tickets.tape', [['do wake(after: ms, key: hold.id)', 'do wake(after: ms, key: hold.id * 2)']], ['C78', 'INSERT INTO holds(client, tier, buyer, qty, amount, expires) VALUES']],
  ['4c refund retried with key id - 1', 'apps/tickets/tickets.tape', [['fn refund_unknown(id: Int, n: Int) -> Outcome {\n  do wake(after: 5000, key: id)\n', 'fn refund_unknown(id: Int, n: Int) -> Outcome {\n  do wake(after: 5000, key: id - 1)\n'], ['do wake(after, key: id)\n      shown_hold(found: load_hold(id))', 'do wake(after, key: id - 1)\n      shown_hold(found: load_hold(id))']], ['C78', 'fn refund_ask_again(\u0001RetryIn(after) -> {', 'among']],
  // (2) a sweep's WHERE read through OR and nesting
  ['5a no refund timer; sweep picks by OR', 'apps/tickets/tickets.tape', [NOREFUNDWAKE, [SWEEP, "(h.state = 'confirmed' OR h.state = 'released') ORDER BY h.id LIMIT 1"]], ['C77', REFUNDING]],
  ['5b no refund timer; sweep picks by nested AND/OR', 'apps/tickets/tickets.tape', [NOREFUNDWAKE, [SWEEP, "((h.state = 'confirmed' AND h.qty > 0) OR (h.state IN ('released', 'expired') AND NOT h.qty > 0)) ORDER BY h.id LIMIT 1"]], ['C77', REFUNDING]],
  ['5c no refund timer; sweep picks by NOT (… OR …)', 'apps/tickets/tickets.tape', [NOREFUNDWAKE, [SWEEP, "NOT (h.state = 'refunding' OR h.state IN ('held', 'paying', 'refunded', 'released', 'expired')) ORDER BY h.id LIMIT 1"]], ['C77', REFUNDING]],
  ['5d control: no refund timer; sweep OR admits refunding', 'apps/tickets/tickets.tape', [NOREFUNDWAKE, [SWEEP, "(h.state = 'confirmed' OR h.state = 'refunding') ORDER BY h.id LIMIT 1"]], []],
  // (3) a retry policy that gives up: the giving up must be declared (a final constructor), or set a timer
  ['F4 own policy gives up with a plain value', 'examples/fulfillment.tape', [['waiting(decided: retry_later(timer, key: id, policy: resume(), failed: retries))', '"; next in " ++ decimal_text(value: again(id, failed: retries))'],
    ['fn waiting(decided: Retry) -> View {', 'fn again(id: Int, failed: Int) -> Int {\n  match {\n    failed >= 3 -> 0\n    else -> wake(timer, after: 1000, key: id)\n  }\n}\n\nfn waiting(decided: Retry) -> View {']], ['C79', 'failed >= 3 -> 0']],
  ['F5a own policy gives up with a constructor not declared final', 'examples/fulfillment.tape', OWN('Stop', 'Stop'), ['C79', 'failed >= 3 -> Stop']],
  ['F5b control: the same, its Stop declared final', 'examples/fulfillment.tape', OWN('Stop final', 'Stop'), []],
  // (4) woken's guards send the key to the function that reads it back
  ['6a woken: key > 0 is the sweep', 'apps/tickets/tickets.tape', [['key < 0 -> Ok(value: summary(outcome: sweep(event: 0 - key)))', 'key > 0 -> Ok(value: summary(outcome: sweep(event: 0 - key)))']], ['C78', 'INSERT INTO holds(client, tier, buyer, qty, amount, expires) VALUES', 'among']],
  ['6b woken: key < 10 is the sweep', 'apps/tickets/tickets.tape', [['key < 0 -> Ok(value: summary(outcome: sweep(event: 0 - key)))', 'key < 10 -> Ok(value: summary(outcome: sweep(event: 0 - key)))']], ['C78', 'INSERT INTO holds(client, tier, buyer, qty, amount, expires) VALUES', 'among']],
  ['6c control: woken: 0 > key is the sweep', 'apps/tickets/tickets.tape', [['key < 0 -> Ok(value: summary(outcome: sweep(event: 0 - key)))', '0 > key -> Ok(value: summary(outcome: sweep(event: 0 - key)))']], []],
  // (5) an outcome that calls again is handled only if that call's outcomes are
  ['7a charge unknown: an operator paged (a call), the row left', 'apps/tickets/tickets.tape', [['    Err(error) -> unknown(id, n: tries)\n', '    Err(error) -> paged(id, tries, reply: call(to: pay, method: "page", send: Refund(card: "", amount: 0, ref: "hold-" ++ decimal_text(value: id)), reply: Refunded, within: 2000, once: RefundFor(hold: id)))\n'],
    ['fn unknown(id: Int, n: Int) -> Outcome {', 'fn paged(id: Int, tries: Int, reply: Result[Refunded, CallError]) -> Outcome {\n  match reply {\n    Ok(value) -> Problem(status: 202, reason: "an operator was paged after \\(tries) asks")\n    Err(error) -> Problem(status: 502, reason: "no operator answered")\n  }\n}\n\nfn unknown(id: Int, n: Int) -> Outcome {']], ['C79', '    Err(error) -> paged(id']],
  ['7b the same, only the page failing sets the timer', 'apps/tickets/tickets.tape', [['    Err(error) -> unknown(id, n: tries)\n', '    Err(error) -> paged(id, tries, reply: call(to: pay, method: "page", send: Refund(card: "", amount: 0, ref: "hold-" ++ decimal_text(value: id)), reply: Refunded, within: 2000, once: RefundFor(hold: id)))\n'],
    ['fn unknown(id: Int, n: Int) -> Outcome {', 'fn paged(id: Int, tries: Int, reply: Result[Refunded, CallError]) -> Outcome {\n  match reply {\n    Ok(value) -> Problem(status: 202, reason: "an operator was paged after \\(tries) asks")\n    Err(error: Rejected(reason)) -> unknown(id, n: tries)\n    Err(error) -> unknown(id, n: tries)\n  }\n}\n\nfn unknown(id: Int, n: Int) -> Outcome {']], ['C79', 'Ok(value) -> Problem(status: 202, reason: "an operator was paged after \\(tries) asks")']],
  ['7c control: the same, both outcomes set the timer', 'apps/tickets/tickets.tape', [['    Err(error) -> unknown(id, n: tries)\n', '    Err(error) -> paged(id, tries, reply: call(to: pay, method: "page", send: Refund(card: "", amount: 0, ref: "hold-" ++ decimal_text(value: id)), reply: Refunded, within: 2000, once: RefundFor(hold: id)))\n'],
    ['fn unknown(id: Int, n: Int) -> Outcome {', 'fn paged(id: Int, tries: Int, reply: Result[Refunded, CallError]) -> Outcome {\n  match reply {\n    Ok(value) -> unknown(id, n: tries)\n    Err(error: Rejected(reason)) -> unknown(id, n: tries)\n    Err(error) -> unknown(id, n: tries)\n  }\n}\n\nfn unknown(id: Int, n: Int) -> Outcome {']], []],
  ['7d refund failed: refunded again at once, its failure left (the inner call is read on its own)', 'apps/tickets/tickets.tape', [['Err(error) -> refund_unknown(id, n: tries)', 'Err(error) -> refund_once(found: load_hold(id))'], ['refunded(id, tries: tries_of(id), reply:', 'refunded(id, reply:'], ['fn refunded(id: Int, tries: Int, reply:', 'fn refunded(id: Int, reply:'],
    ['fn settled(moved: Move[Hold]) -> Outcome {', 'fn refund_once(found: Option[Hold]) -> Outcome {\n  let Some(value: Hold(id, card, amount)) = found else -> Problem(status: 404, reason: "no such hold")\n  match call(to: pay, method: "refund", send: Refund(card, amount, ref: "hold-" ++ decimal_text(value: id)), reply: Refunded, within: 2000, once: RefundFor(hold: id)) {\n    Ok(value) -> settled(moved: sql_move(row: Hold, query: "UPDATE holds SET state = \'refunded\', note = \'\' WHERE id = :id AND state = \'refunding\' RETURNING *", id))\n    Err(error) -> Problem(status: 502, reason: "the refund failed twice")\n  }\n}\n\nfn settled(moved: Move[Hold]) -> Outcome {']], ['C79', 'Err(error) -> Problem(status: 502, reason: "the refund failed twice")']],
];
const std = readdirSync(here('std'))
  .filter(f => f.endsWith('.tape'))
  .map(f => ({ name: `std/${f}`, text: read(`std/${f}`) }));
export const swap = (text: string, pairs: readonly Pair[]): string =>
  pairs.reduce((t, [a, b]) => {
    if (!t.includes(a)) throw new Error(`not found: ${a.slice(0, 80)}`);
    return t.replace(a, b);
  }, text);
// s may be 'before\u0001target': the first target after the first before
export const lineOf = (text: string, s: string): number => {
  const [a = '', b = ''] = s.includes('\u0001') ? s.split('\u0001') : ['', s];
  const i = text.indexOf(b, text.indexOf(a));
  if (i < 0 || !text.includes(a)) throw new Error(`not found: ${s}`);
  return text.slice(0, i).split('\n').length;
};
/** Is what the mutant got what it wants: that one line; or, `among`, that line among others of its code; or, `with`, among others of C77-C79. */
function caughtBy(got: readonly string[], want: Want, w: string | null): boolean {
  const [code = '', , how] = want;
  if (w === null) return got.length === 0;
  // 'among': the line is one of several the mutant gets, all of that code (woken's guard loses every timer)
  if (how === 'among') return got.includes(w) && got.every(g => g.startsWith(code));
  if (how === 'with') return got.includes(w) && got.every(g => /^C7[789]:/.test(g));
  return JSON.stringify(got) === JSON.stringify([w]);
}
export const run = ([name, file, pairs, want]: Mutant) => {
  const text = swap(read(file), pairs);
  const errs = compile([...std, { name: file.split('/').pop() ?? file, text }]).errors;
  const got = errs.map(e => `${e.code}:${e.line}`);
  const [code, anchor] = want;
  const w = code !== undefined && anchor !== undefined ? `${code}:${lineOf(text, anchor)}` : null;
  return { name, got, want: w === null ? [] : [w], caught: caughtBy(got, want, w), errs };
};
/** One mutant as a line: caught or missed, its name, what it got and what it wants. */
export const shown = (m: Mutant, width: number): string => {
  const r = run(m);
  const [first] = r.errs;
  const why = first ? `| ${first.message.slice(0, 220)}` : '';
  return `${(r.caught ? 'caught' : 'MISSED').padEnd(7)} ${r.name.padEnd(width)} ${JSON.stringify(r.got)} want ${JSON.stringify(r.want)} ${why}`;
};
if (import.meta.url === `file://${process.argv[1]}`) for (const m of round2) console.log(shown(m, 60));
