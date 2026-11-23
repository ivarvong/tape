// C78 (a timer's key names the row, and woken reads it back) and C79 (a timer's run moves the row out of the
// state it finds it in, or sets its timer again), and C77's ordering and state reading: the mutants of
// experiments/c78 (round 1), each refused at its line with its code; the repository's programs accepted.
import '../node25.ts';
import { readdirSync } from 'node:fs';
import { mutants } from '../experiments/c78/mutants.ts';
import { fulfillmentMutants } from '../experiments/c78/fulfillment-mutants.ts';
import { lineOf, round2, run, swap } from '../experiments/c78/round2.ts';
import type { Mutant, Pair } from '../experiments/c78/round2.ts';
import { timedMutants } from '../experiments/c78/timed-mutants.ts';
import { round3 } from '../experiments/c78/round3.ts';
import { codes as codesOf, finish, problems, read, same as T } from './harness.ts';
const codes = (text: string, name: string): string[] => codesOf(text, {}, name);
/** A mutant by the start of its name. */
const named = (all: readonly Mutant[], start: string): Mutant => {
  const m = all.find(x => x[0].startsWith(start));
  if (!m) throw new Error(`no mutant ${start}`);
  return m;
};
const wanted = (want: Readonly<Record<string, readonly [string, string]>>, name: string): readonly [string, string] =>
  want[name.slice(0, 2)] ?? ['', ''];

// ---- 1. tickets: each mutant, its code and line (the line is found in the mutant)
const tickets = read('apps/tickets/tickets.tape');
T('tickets as is: no errors', codes(tickets, 'tickets.tape'), []);
const want: Record<string, readonly [string, string]> = {
  '1a': ['C78', "UPDATE holds SET state = 'refunding'"],
  '1b': ['C78', "UPDATE holds SET state = 'held', note = :reason"],
  '1c': ['C78', 'INSERT INTO holds(client, tier, buyer, qty, amount, expires) VALUES'],
  '2a': ['C79', 'Err(error) -> unknown(id, n: tries)'],
  '2b': ['C79', 'Hold(id, state: "held", expires) -> {'],
  '2c': ['C79', 'RetryIn(after) -> {\n      shown_hold(found: load_hold(id))'],
  '2d': ['C79', 'Hold(state: "refunding") -> ShowHold'],
  '3a': ['C77', "UPDATE holds SET state = 'refunding'"],
  '3b': ['C77', "UPDATE holds SET state = 'refunding'"],
  '3c': ['C77', "UPDATE holds SET state = 'refunding'"],
  '3d': ['C77', "UPDATE holds SET state = 'refunding'"],
};
for (const [name, ...pairs] of mutants) {
  const text = swap(tickets, pairs),
    [code, at] = wanted(want, name);
  T(`tickets ${name}: ${code} at its line`, codes(text, 'tickets.tape'), [`${code}:${lineOf(text, at)}`]);
}
// the messages say what is wrong
const pairsOf = (i: number): Pair[] => {
  const [, ...pairs] = mutants[i] ?? [''];
  return pairs;
};
const msg = (pairs: readonly Pair[], code: string): string =>
  problems(swap(tickets, pairs), {}, 'tickets.tape').find(e => e.code === code)?.message ?? '';
T(
  "1a: the key is shown and is not the row's",
  /keyed by `999999`, which is not this row's key/.test(msg(pairsOf(0), 'C78')),
  true,
);
T(
  "1b: the key is the row's negated, and woken reads it as `key` (load_hold)",
  /keyed by `0 - id`, the row's key negated, but the timer's run reads holds by `key` \(load_hold/.test(
    msg(pairsOf(1), 'C78'),
  ),
  true,
);
T(
  '2a: the arm leaves the row in "paying", another outcome moves it out',
  /leaves the row in "paying" and sets no timer: another outcome of the call/.test(msg(pairsOf(3), 'C79')),
  true,
);

// ---- 2. fulfillment: a step not tried again, a refund noted only, a retry timer keyed by a constant
const ful = read('examples/fulfillment.tape');
T('fulfillment as is: no errors', codes(ful, 'fulfillment.tape'), []);
const fw: Record<string, readonly [string, string]> = {
  F1: ['C79', 'Timeout -> show(status: 202'],
  F2: ['C79', 'Err(error) -> show(status: 502'],
  F3: ['C78', 'Moved(value: Order(state, retries)) -> show(status: 202'],
};
for (const [name, [a, b]] of Object.entries(fulfillmentMutants)) {
  const text = ful.replace(a, b),
    [code, at] = wanted(fw, name);
  T(`fulfillment ${name}: ${code} at its line`, codes(text, 'fulfillment.tape'), [`${code}:${lineOf(text, at)}`]);
}

// ---- 2b. round 2: a key computed from the row's, sweeps through OR/NOT, a retry policy that gives up, woken's
// guards, an outcome that calls again; with controls that must be accepted
for (const m of round2) {
  const r = run(m);
  T(`round2 ${m[0]}: ${r.want.join(' ') || 'accepted'}`, r.caught ? r.want : r.got, r.want);
}
{
  const r = run(named(round2, '4a')),
    w = run(named(round2, '6a')),
    g = run(named(round2, 'F4'));
  T(
    "4a: the key is computed from the row's but is not it",
    /keyed by `id \+ 1`, which is computed from this row's key but is not it/.test(r.errs[0]?.message ?? ''),
    true,
  );
  T(
    "6a: woken's guard sends the key away from its read-back",
    /woken's guard \(line \d+\) sends such a key where holds is not read by it/.test(w.errs[0]?.message ?? ''),
    true,
  );
  T(
    'F4: the arm that gives up is named (again)',
    /in a timer's run \(again, reached from woken\), this arm leaves the row in "reserving"/.test(
      g.errs[0]?.message ?? '',
    ),
    true,
  );
}

// ---- 2c. round 2: the programs of examples/timed (a machine and timers each) accepted; one planted bug in each refused
for (const f of readdirSync(new URL('../examples/timed', import.meta.url)).filter(x => x.endsWith('.tape')))
  T(`examples/timed/${f}: no errors`, codes(read(`examples/timed/${f}`), f), []);
for (const m of timedMutants) {
  const r = run(m);
  T(`${m[0]}: ${r.want.join(' ')}`, r.caught ? r.want : r.got, r.want);
}

// ---- 2d. round 3: a timer for a row in a final state, a constructor through a record's field and `with`, woken's
// guard in a function it calls, a sweep's subquery, final checked (C80, and only a call's reply ends a path on it), a
// state-filtered read's None
for (const m of round3) {
  const r = run(m);
  T(`round3 ${m[0]}: ${r.want.join(' ') || 'accepted'}`, r.caught ? r.want : r.got, r.want);
}
{
  const a = run(named(round3, 'A2')),
    e = run(named(round3, 'E1')),
    f = run(named(round3, 'F1'));
  T(
    "A2: the cancel timer's key is read as another table's key",
    /woken uses a key of that sign as the key of another table \(load_hold, line \d+, reads holds by it\)/.test(
      a.errs[0]?.message ?? '',
    ),
    true,
  );
  T(
    'E1: final checked where it is made',
    /Stop is declared final \(asking again gives it again\), but it is made where a second run may decide otherwise/.test(
      e.errs[0]?.message ?? '',
    ),
    true,
  );
  T(
    "F1: the filtered read's None is the row in another state",
    /lets through only rows in "held", "paying", "confirmed", so a row in "refunding" reads as None here/.test(
      f.errs[0]?.message ?? '',
    ),
    true,
  );
}

// ---- 3. the repository's machine programs: none of C77, C78, C79
for (const f of [
  'examples/orders.tape',
  'examples/tickets.tape',
  'examples/bump.tape',
  'testdata/compare/billing.tape',
  'testdata/compare/agent.tape',
  'apps/tickets/pay.tape',
])
  T(
    `${f}: no C77-C80`,
    codes(read(f), f).filter(c => /^C(7[789]|80):/.test(c)),
    [],
  );

// ---- 4. C80 follows a clock reading however deep it is written (it used to stop looking nine levels down, and
// passed the constructor as final)
{
  const deciding = (cond: string) => `type Verdict {
  Go(n: Int)
  Stop(n: Int) final
}

fn bump(x: Int) -> Int {
  x + 1
}

fn decide(n: Int, clock: Clock) -> Verdict {
  match {
    ${cond} -> Stop(n)
    else -> Go(n)
  }
}

fn handle(raw: View, clock: Clock) -> Buf {
  match decide(n: 3, clock) {
    Stop(n) -> push(buf: buf(), byte: n)
    Go(n) -> push(buf: buf(), byte: n)
  }
}
`;
  const nested = (depth: number, inner: string) => 'bump(x: '.repeat(depth) + inner + ')'.repeat(depth);
  for (const depth of [1, 5, 12])
    T(`C80: the clock read ${depth} calls deep`, codes(deciding(`${nested(depth, 'now(clock)')} > n`), 'p.tape'), [
      'C80:12',
    ]);
  T('C80: no clock, twelve calls deep', codes(deciding(`${nested(12, 'n')} > 2`), 'p.tape'), []);
}

finish();
