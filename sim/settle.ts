// sim/settle.ts: what happens once the faults stop. Every call still waiting is delivered, timers run and the
// clock jumps to the next one until nothing is left; then the requests that were answered are sent again.
import { isSql, responseOf } from '../host.ts';
import type { Effect } from '../host.ts';
import { apply } from './apply.ts';
import { declared, firstChange, rowsOf } from './checks.ts';
import type { Rows } from './checks.ts';
import { boot, clientsOf, drain, enabled, messageOf, programOf } from './world.ts';
import type { Client, Finished, Model, World } from './world.ts';

const enc = new TextEncoder();
/** What stopped a world from settling: a rule broken on the way (safety), or why it never ends. */
export type Stuck = { safety: string[] } | string | null;
export const wrongNow = (world: World, model: Model): string[] => [
  ...declared(world, false),
  ...(model.check?.(world) ?? []),
];

/** The next thing to do with no faults: a delivery, else a due timer, else the clock. */
const nextQuiet = (acts: readonly string[]): string | undefined =>
  acts.find(a => a.startsWith('deliver ')) ??
  acts.find(a => a.startsWith('wake ')) ??
  acts.find(a => a.startsWith('tick '));

// No more faults: deliver what waits, run due timers, jump to the next one, until nothing is left to happen.
export async function settle(world: World, model: Model, clients: readonly Client[]): Promise<Stuck> {
  // a timer far ahead is not a timer for ever: what counts is how often one key runs again once nothing fails
  const limit = model.timerRuns ?? 100;
  const ran = new Map<string, number>();
  world.say('settle', 'the faults stop');
  let still = 0;
  for (let i = 0; i < 20000; i++) {
    if (world.crash !== undefined) throw world.crash;
    if (world.failed !== undefined) return null;
    const act = nextQuiet(enabled(world, clients, 0));
    if (act === undefined) return null;
    if (act.startsWith('wake ')) {
      const n = (ran.get(act) ?? 0) + 1;
      ran.set(act, n);
      if (n > limit)
        return `timer ${act.slice(5)} has run ${limit} times since the faults stopped and is set again each time: something asks again for ever`;
    }
    still = act.startsWith('tick ') ? 0 : still + 1;
    if (still > 300)
      return 'timers keep running without the clock moving: a timer is set again for now, every time it runs';
    await apply(world, model, clients, act);
    const bad = wrongNow(world, model);
    if (bad.length > 0) return { safety: bad };
  }
  return 'settling did not end in 20000 steps';
}

type Resent =
  | { problem: string }
  | { problem?: undefined; status: number; changed: { table: string; detail: string } | null; counted: boolean };

// One request sent again, with nothing else let happen: the calls it makes are delivered, no fault is injected.
// Returns how it was answered, what it wrote, and the first table whose rows it changed.
async function resend(world: World, model: Model, text: string, tag: string): Promise<Resent> {
  const entry = programOf(world, model.entry);
  const before = rowsOf(world);
  const was = world.cur;
  const got: { done: boolean; status: number; failed: unknown; effects: Effect[] } = {
    done: false,
    status: 0,
    failed: null,
    effects: [],
  };
  world.cur = { id: tag };
  const sending = async (): Promise<void> => {
    try {
      const r = await entry.app.runLogged(enc.encode(text), entry.tx);
      got.status = responseOf(r.out).status;
      got.effects = r.effects;
    } catch (e) {
      got.failed = e ?? new Error('failed');
    }
    got.done = true;
  };
  void sending();
  for (let i = 0; i < 300 && !got.done; i++) {
    await drain();
    const p = world.pending.find(call => call.id.startsWith(`${tag}:`));
    if (p && !got.done) await apply(world, model, [], `deliver ${p.id}`);
  }
  await drain();
  world.cur = was;
  const name = text.replace('\n', ' ').trim();
  if (got.failed !== null) return { problem: `${name} failed: ${messageOf(got.failed)}` };
  if (!got.done) return { problem: `${name} did not finish` };
  // does this run make a write that says every attempt is meant to count?
  const queries = model.queries?.[model.entry] ?? [];
  const counted = got.effects.some(e => isSql(e) && queries[e.q]?.repeat === true);
  return { status: got.status, changed: firstChange(before, rowsOf(world)), counted };
}

export type Life = { seed: number; faults: number; account: string | undefined };
type Lived = { sentAgain: Resent | null; rows?: Rows; stuck?: string | undefined };

// The run lived again from its seed and its choices up to the moment the request was answered, in a new world;
// with `again` the duplicate is sent there; then the world is settled.
async function lived(
  model: Model,
  life: Life,
  script: readonly string[],
  sent: Finished,
  again: boolean,
): Promise<Lived> {
  const world = boot(model, life.account, life.seed);
  Date.now = (): number => world.clock;
  const clients = clientsOf(model, world, life.seed);
  for (const act of script.slice(0, sent.after)) {
    if (!enabled(world, clients, life.faults).includes(act)) continue;
    world.choices++;
    await apply(world, model, clients, act);
  }
  const resent = again ? await resend(world, model, sent.text, 'twice') : null;
  if (resent && (resent.problem !== undefined || !resent.changed || resent.counted)) return { sentAgain: resent };
  const stuck = await settle(world, model, clients);
  const why = typeof stuck === 'string' ? stuck : stuck?.safety[0];
  return { sentAgain: resent, rows: rowsOf(world), stuck: world.failed ?? why };
}

/** How the rows end differently with the duplicate, for the first table where they do. */
function ending(once: Rows, twice: Rows): { table: string; detail: string } | null {
  for (const [table, rows] of Object.entries(twice)) {
    const alone = once[table] ?? [];
    if (rows.length === alone.length && rows.every((row, i) => row === alone[i])) continue;
    const i = rows.findIndex((row, k) => row !== alone[k]);
    const detail =
      rows.length === alone.length
        ? `row ${i + 1} ends as ${alone[i]?.slice(0, 110)} without the duplicate and as ${rows[i]?.slice(0, 110)} with it`
        : `${alone.length} rows without the duplicate, ${rows.length} with it`;
    return { table, detail };
  }
  return null;
}

// The duplicate rule. A request answered 200, 201 or 204, sent again at once (a client that did not hear the
// answer, a queue that delivers twice), must not change where things end up: with the duplicate and without it,
// once every call is delivered and every timer has run, the rows are the same. A duplicate that only carries on
// work the timer would have finished passes; one that makes a second link, a second charge or a second attempt
// does not. The one exception is declared in the program: a run that makes a write marked
// `repeat: True` is meant to count each time it is sent (a hit against a limit, a greeting counted).
//
// It is checked by living the run twice from the moment the request was answered: the choices so far are made
// again in two new worlds (a run is its seed and its choices), the duplicate is sent in one, and both are settled.
export async function duplicate(
  model: Model,
  life: Life,
  script: readonly string[],
  sent: Finished,
): Promise<string | null> {
  const name = sent.text.replace('\n', ' ').trim();
  const twice = await lived(model, life, script, sent, true);
  const again = twice.sentAgain;
  if (again?.problem !== undefined) return `sent twice: ${again.problem}`;
  // it changed nothing, or says it repeats
  if (!twice.rows || !again) return null;
  const once = await lived(model, life, script, sent, false);
  if (twice.stuck !== undefined && once.stuck === undefined)
    return `sent twice: ${name}, sent again at once: ${twice.stuck}`;
  const end = ending(once.rows ?? {}, twice.rows);
  return end
    ? `sent twice: ${name} was answered ${sent.status}; the same request again at once (answered ${again.status}) changes where ${end.table} ends up: ${end.detail}`
    : null;
}

// After everything has settled, each request that was answered 2xx is sent once more. What that changes is a
// note, not a failure: by then other requests have moved the rows, so a command meant to be given again (a
// redrive of what died a second time) changes a row by design.
export async function sentAgain(world: World, model: Model): Promise<string[]> {
  const ok = world.sent.filter(x => x.status >= 200 && x.status < 300);
  const todo = ok.filter((x, i) => ok.findIndex(y => y.text === x.text) === i).slice(-(model.repeatLast ?? 12));
  const found: string[] = [];
  for (const x of todo) {
    const again = await resend(world, model, x.text, 'again');
    if (again.problem !== undefined) return [`sent again, ${again.problem}`];
    if (!again.changed) continue;
    world.say('sent again', `${x.text.replace('\n', ' ')} -> ${again.status}`);
    const line = (x.text.split('\n')[0] ?? '').replaceAll(/\d+/g, '<n>');
    found.push(`${line} (answered ${again.status}) changed ${again.changed.table}: ${again.changed.detail}`);
  }
  return found;
}
