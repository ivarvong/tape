// plants.ts: bugs planted in tickets.tape, one at a time, and what catches each: the compiler (its codes), or the
// scenarios and their invariants (the checks that fail). A plant that nothing catches is reported as missed.
// node apps/tickets/plants.ts  (writes results/plants.json)
import { writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { sources, compiled } from './world.ts';
import { usesStripped, usesWritten } from '../../fmt.ts';
import { std } from '../../std.ts';
import { mutants } from '../../experiments/c78/mutants.ts';
import { round2 } from '../../experiments/c78/round2.ts';
import { round3 } from '../../experiments/c78/round3.ts';

const here = new URL('./', import.meta.url).pathname;
// each plant is one or more [from, to] replacements, all of which must be found
type Pair = readonly [from: string, to: string];
export type Plant = { name: string; pairs: readonly Pair[] };
const isOne = (p: readonly unknown[]): p is Pair => p.length === 2 && typeof p[0] === 'string';
const P = (name: string, ...pairs: Pair | readonly Pair[]): Plant => ({ name, pairs: isOne(pairs) ? [pairs] : pairs });
export const plants: Plant[] = [
  P(
    'a decline without its expiry timer (the second bug prod Jepsen found)',
    '      do wake(after: 0, key: id)\n      held_again(reason)',
    '      held_again(reason)',
  ),
  P(
    'a refund without its retry timer (the bug prod Jepsen found)',
    '      do wake(after: 5000, key: id)\n      refund_hold(hold: value)',
    '      refund_hold(hold: value)',
  ),
  P(
    'drop the capacity guard on a hold',
    'WHERE id = :tier AND left >= :qty AND NOT EXISTS (SELECT 1 FROM holds WHERE client = :key AND tier = :tier) AND (SELECT state',
    'WHERE id = :tier AND NOT EXISTS (SELECT 1 FROM holds WHERE client = :key AND tier = :tier) AND (SELECT state',
  ),
  P(
    'drop the capacity guard and the CHECK',
    ['left INTEGER NOT NULL CHECK (left >= 0 AND left <= capacity)', 'left INTEGER NOT NULL'],
    [
      'WHERE id = :tier AND left >= :qty AND NOT EXISTS (SELECT 1 FROM holds WHERE client = :key AND tier = :tier) AND (SELECT state',
      'WHERE id = :tier AND NOT EXISTS (SELECT 1 FROM holds WHERE client = :key AND tier = :tier) AND (SELECT state',
    ],
  ),
  P(
    'a hold key that does not name the tier',
    'NOT EXISTS (SELECT 1 FROM holds WHERE client = :key AND tier = :tier) AND (SELECT state',
    'NOT EXISTS (SELECT 1 FROM holds WHERE client = :key) AND (SELECT state',
  ),
  P('reuse one once key for every charge', 'once: PayFor(hold: id, attempt)', 'once: PayFor(hold: 0, attempt: 0)'),
  P(
    'a once key per hold, not per attempt (the bug the scenarios found)',
    'once: PayFor(hold: id, attempt)',
    'once: PayFor(hold: id, attempt: 0)',
  ),
  P(
    'charge without a once key',
    'reply: Charged, error: PayError, within: 2000, once: PayFor(hold: id, attempt))',
    'reply: Charged, error: PayError, within: 2000)',
  ),
  P(
    'release twice: no state guard',
    "UPDATE holds SET state = 'released' WHERE id = :id AND state = 'held' RETURNING *",
    "UPDATE holds SET state = 'released' WHERE id = :id RETURNING *",
  ),
  P(
    'release a paying hold',
    "UPDATE holds SET state = 'released' WHERE id = :id AND state = 'held' RETURNING *",
    "UPDATE holds SET state = 'released' WHERE id = :id AND state IN ('held', 'paying') RETURNING *",
  ),
  P(
    'expire a paying hold',
    "UPDATE holds SET state = 'expired' WHERE id = :id AND state = 'held' RETURNING *",
    "UPDATE holds SET state = 'expired' WHERE id = :id AND state IN ('held', 'paying') RETURNING *",
  ),
  P(
    'seats back with a set update outside the move',
    '      let 1 = sql_exec(query: "UPDATE tiers SET left = left + :qty WHERE id = :tier", qty, tier) else -> Problem(status: 500, reason: "the hold ended, and its tier \\(tier) is gone")\n      do promote(tier)\n      ShowHold(status: 200, hold)\n    }\n    Raced(now) -> ShowHold(status: 409, hold: now)',
    '      do promote(tier)\n      ShowHold(status: 200, hold)\n    }\n    Raced(now) -> {\n      let _ = sql_exec(query: "UPDATE tiers SET left = left + :qty WHERE id = :tier", qty: now.qty, tier: now.tier)\n      ShowHold(status: 409, hold: now)\n    }',
  ),
  P(
    'a refund that does not give the seats back',
    '      let 1 = sql_exec(query: "UPDATE tiers SET left = left + :qty WHERE id = :tier", qty, tier) else -> Problem(status: 500, reason: "hold \\(id) is refunded, and its tier \\(tier) is gone")\n      do promote(tier)\n      refunded_all(hold, tickets)',
    '      do promote(tier)\n      refunded_all(hold, tickets)',
  ),
  P(
    'tickets issued without ON CONFLICT',
    'VALUES (:hold, :seat, :buyer) ON CONFLICT(hold, seat) DO NOTHING"',
    'VALUES (:hold, :seat, :buyer)"',
  ),
  P('one ticket too few', '    seat > qty -> Done', '    seat >= qty -> Done'),
  P(
    'a hold without its expiry timer',
    '  do wake(after: ms, key: hold.id)\n  ShowHold(status: 201, hold)',
    '  ShowHold(status: 201, hold)',
  ),
  P(
    'transfer without the owner check',
    '"UPDATE tickets SET owner = :to WHERE id = :id AND owner = :from AND state = \'valid\' RETURNING *", to, id, from)',
    '"UPDATE tickets SET owner = :to WHERE id = :id AND state = \'valid\' RETURNING *", to, id)',
  ),
  P(
    'promotion without its op-id guard',
    'WHERE id = :tier AND left >= :qty AND NOT EXISTS (SELECT 1 FROM holds WHERE client = :key AND tier = :tier) RETURNING price',
    'WHERE id = :tier AND left >= :qty AND :key = :key RETURNING price',
  ),
  P(
    'admin cancel open to the public',
    '    Anyone -> buyer_post(path, body)',
    '    Anyone -> operator_post(path, body)',
  ),
  P(
    'cancel sweep does not drop the waitlist',
    "  let _ = sql_exec(query: \"UPDATE waitlist SET state = 'dropped' WHERE state = 'waiting' AND tier IN (SELECT id FROM tiers WHERE event = :event)\", event)\n",
    '',
  ),
  P(
    'a decline leaves the hold paying',
    "    Err(error: Rejected(reason: refused)) -> declined(reason: refusal(refused), moved: sql_move(row: Hold, query: \"UPDATE holds SET state = 'held', note = :reason WHERE id = :id AND state = 'paying' RETURNING *\", reason: refusal(refused), id))",
    '    Err(error: Rejected(reason: refused)) -> Problem(status: 402, reason: refusal(refused))',
  ),
  P(
    'the page writes the buyer unescaped',
    '  page_top(title: "Hold \\(id)") |> append(view: "<p>\\(qty) seat(s) for ") |> write_html(text: buyer)',
    '  page_top(title: "Hold \\(id)") |> append(view: "<p>\\(qty) seat(s) for \\(buyer)")',
  ),
  // the C77 weaknesses (mutant round 1, experiments/c78/mutants.ts): wrong timer keys, timer runs that leave the row, ordering and state reading
  ...mutants.map(([name, ...pairs]) => P(`C78/C79 mutant ${name}`, ...pairs)),
  // the weaknesses rounds 1 and 2 left (experiments/c78/round2.ts, round3.ts), the mutants of tickets.tape that
  // are bugs (their controls, which must compile, are in test/timers-keys.ts)
  ...[...round2.map(m => ['round 2', m] as const), ...round3.map(m => ['round 3', m] as const)]
    .filter(([, [, file, , want]]) => file === 'apps/tickets/tickets.tape' && want.length > 0)
    .map(([round, [name, , pairs]]) => P(`${round} mutant ${name}`, ...pairs)),
];

type Caught =
  | { plant: string; error: string }
  | { plant: string; caught: 'compiler'; codes: string[]; first: string }
  | { plant: string; caught: 'scenarios' | 'missed'; failed: string[] };
type Check = { name: string; ok: boolean };
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const field = (e: unknown, name: string): string =>
  typeof e === 'object' && e !== null && name in e ? String(Object.fromEntries(Object.entries(e))[name]) : '';
/** The last line of what the scenarios printed: their checks, as JSON. */
function checksIn(printed: string): Check[] {
  const parsed: unknown = JSON.parse(printed.trim().split('\n').at(-1) ?? '');
  if (!Array.isArray(parsed)) throw new TypeError('the scenarios printed no list of checks');
  return parsed.map((c: unknown) => ({ name: field(c, 'name'), ok: field(c, 'ok') === 'true' }));
}
/** The scenarios run against one program text: every check, or one failed check saying they crashed. */
function scenarios(file: string): Check[] {
  try {
    return checksIn(
      execFileSync(process.execPath, [`${here}scenarios.ts`, file, '--json'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  } catch (e) {
    try {
      return checksIn(field(e, 'stdout'));
    } catch {
      const why =
        field(e, 'stderr')
          .split('\n')
          .find(l => l.includes('Error')) ?? messageOf(e);
      return [{ name: `the scenarios crashed: ${why}`, ok: false }];
    }
  }
}
/** What catches one plant: the compiler, the scenarios, or nothing. */
function caught(p: Plant, n: number): Caught {
  // a plant is written against the program without its `uses` clauses, and they are written again after it as fmt
  // would: a plant that drops a `wake` drops its function's `timer` with it, which is no catch (C101)
  const base = usesStripped(sources.tickets);
  const missing = p.pairs.find(([from]) => !base.includes(from));
  if (missing) {
    console.log(`??    ${p.name}: its text is not in tickets.tape: ${missing[0].slice(0, 60)}`);
    return { plant: p.name, error: 'its text is not in tickets.tape' };
  }
  const text = usesWritten(
    p.pairs.reduce((t, [from, to]) => t.replace(from, to), base),
    'program.tape',
    std,
  );
  const refused = compiled(text).errors ?? [];
  const [first] = refused;
  if (first) {
    const codes = [...new Set(refused.map(e => e.code))];
    console.log(`comp  ${p.name}: ${codes.join(', ')} — ${first.message.slice(0, 140)}`);
    return { plant: p.name, caught: 'compiler', codes, first: `${first.code}:${first.line} ${first.message}` };
  }
  // a directory of its own: two gates (two checkouts) at once wrote and ran each other's /tmp/plant-<n>.tape
  const file = join(mkdtempSync(join(tmpdir(), 'tickets-plant-')), `plant-${n}.tape`);
  writeFileSync(file, text);
  const failed = scenarios(file).flatMap(r => (r.ok ? [] : [r.name]));
  const more = failed.length > 3 ? ` (+${failed.length - 3})` : '';
  console.log(
    failed.length > 0 ? `scen  ${p.name}: ${failed.slice(0, 3).join(' | ')}${more}` : `MISS  ${p.name}: nothing failed`,
  );
  return { plant: p.name, caught: failed.length > 0 ? 'scenarios' : 'missed', failed };
}

// run only as a script: apps/tickets/sim.ts imports the list
if (process.argv[1] === new URL(import.meta.url).pathname) {
  mkdirSync(`${here}results`, { recursive: true });
  const out = plants.map(caught);
  writeFileSync(`${here}results/plants.json`, `${JSON.stringify(out, null, 1)}\n`);
  const by = (how: string): number => out.filter(o => 'caught' in o && o.caught === how).length;
  console.log(
    `${out.length} plants: ${by('compiler')} by the compiler, ${by('scenarios')} by the scenarios, ${by('missed')} missed`,
  );
}
