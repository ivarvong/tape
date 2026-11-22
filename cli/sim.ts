// tape sim: the programs together under the simulator, with nothing written for it. A file's name is the name its
// callers reach it by (pay.tape is the Remote `pay`); a Remote no file serves is stood in for by its reply types.
import { readFileSync } from 'node:fs';
import { auto, exhaust, explore, replay, report, routeText, search, shrink } from '../sim.ts';
import type { Failure, Model } from '../sim/engine.ts';
import type { Auto } from '../sim/model.ts';
import type { Route } from '../sim/routes.ts';
import { count, option } from './args.ts';
import { USAGE } from './usage.ts';

type Say = (line: string) => void;
type File = { name: string; text: string; path: string };
/** What the runs came to, whichever kind of run was asked for. */
type Result = {
  ok: boolean;
  ran: number;
  failures: Failure[];
  actions?: number;
  complete?: boolean;
  repeats?: string[];
  reached?: string[];
};

const named = (route: Route): string => routeText(route, part => `<${part.word ?? ''}>`);
const unique = (list: readonly string[]): string[] => [...new Set(list)];
const never = (list: readonly string[]): string => (list.length > 0 ? `; never: ${list.join(', ')}` : '');

// What will be run and checked, before any run is made.
function describe(say: Say, files: readonly File[], model: Auto): void {
  const { routes, unread, stubs, invariants, refused } = model;
  const remotes = Object.entries(stubs);

  say(`programs    ${files.map(f => f.name).join(', ')}; requests go to ${model.model.entry}`);
  say(
    routes.length > 0
      ? `requests    ${routes.length} paths: ${routes.map(r => named(r) + (r.body === null ? '' : ` {${r.body}}`)).join(', ')}`
      : 'requests    0 paths found: only GET / is sent',
  );
  if (unread.length > 0) {
    const where = unique(unread.map(u => u.fn)).join(', ');
    say(
      `not read    ${count(unread.length, 'match arm')} on a path this cannot turn into requests (in ${where}): never sent to`,
    );
  }
  if (remotes.length > 0) {
    const list = remotes.map(([name, methods]) => `${name} (${Object.keys(methods).join(', ')})`).join('; ');
    say(
      `stood in    ${list}: no file serves ${remotes.length > 1 ? 'them' : 'it'}, so replies are made from the reply types`,
    );
  }
  say(
    invariants.length > 0
      ? `invariants  ${invariants.map(v => `${v.program}: "${v.name}"${v.settled ? ' (settled)' : ''}`).join('; ')}`
      : 'invariants  none declared: only a run that fails, and timers that never stop, are findings',
  );
  if (refused.length > 0)
    say(
      `rules off   ${count(refused.length, 'thing')} the rules refuse: ${unique(refused.map(e => e.code)).join(', ')}`,
    );
}

/** The script after --replay: a JSON list of choices. */
function scriptOf(args: readonly string[]): string[] {
  const given: unknown = JSON.parse(option(args, 'replay', '[]'));
  if (!Array.isArray(given)) throw new TypeError('--replay takes a JSON list of choices');
  return given.map(String);
}

// The runs the arguments ask for: one script again, every script to a depth, random scripts, or (the default)
// scripts that build on the ones that reached something new.
async function runs(args: readonly string[], model: Model): Promise<Result> {
  const number = (name: string, fallback: number): number => Number(option(args, name, fallback));
  const seed = number('seed', 1);
  const steps = number('steps', 120);
  if (args.includes('--replay')) {
    const one = await replay(model, scriptOf(args), { seed });
    return { ok: one.ok, ran: 1, actions: one.script.length, failures: one.ok ? [] : [one] };
  }
  if (args.includes('--exhaust'))
    return exhaust(model, { seed, depth: number('exhaust', 10), faults: number('faults', 1) });
  if (args.includes('--random'))
    return explore(model, { seeds: number('seeds', 500), from: seed, steps, faults: number('faults', 3) });
  return search(model, { runs: number('seeds', 500), from: seed, steps, faults: number('faults', 3) });
}

/** The machines' states the runs reached, of all there are. */
function statesLine(model: Auto, reached: readonly string[]): string | null {
  const states = Object.entries(model.model.machines ?? {}).flatMap(([program, machines]) =>
    machines.flatMap(m => (m.states ?? []).map(state => `${program}.${m.table}=${state}`)),
  );
  const unreached = states.filter(s => !reached.includes(s));
  return states.length > 0
    ? `states      ${states.length - unreached.length} of ${states.length} reached${never(unreached)}`
    : null;
}

// Nothing wrong: what was run, and what the runs never did (a path never answered 2xx, a state never reached).
function reportClean(say: Say, args: readonly string[], model: Auto, result: Result, ms: number): void {
  const scripts = `scripts${result.complete === true ? ' (every one to that depth)' : ' (stopped at the limit)'}`;
  const what = args.includes('--exhaust') ? scripts : 'runs';
  const choices = (result.actions ?? 0) > 0 ? `, ${result.actions} choices` : '';
  console.log(`ok          ${result.ran} ${what}${choices}, nothing wrong (${ms} ms)`);

  const unanswered = model.routes.filter(r => (model.answered.get(r.key)?.ok ?? 0) === 0).map(named);
  say(
    `answered    ${model.routes.length - unanswered.length} of ${model.routes.length} paths with a 2xx at least once${never(unanswered)}`,
  );

  const repeats = result.repeats ?? [];
  if (repeats.length > 0) {
    say(
      `sent again  ${count(repeats.length, 'kind')} of request changed a row when sent a second time after all had settled (a count, a command meant to repeat, or work a request left half-way):`,
    );
    for (const note of repeats.slice(0, 8)) say(`              ${note.slice(0, 200)}`);
  }
  const states = result.reached ? statesLine(model, result.reached) : null;
  if (states !== null) say(states);
}

// Something wrong: the failure from as few choices as give it, and the command that runs it again.
async function reportFailure(
  args: readonly string[],
  files: readonly File[],
  model: Auto,
  result: Result,
  ms: number,
): Promise<void> {
  const [first] = result.failures;
  if (!first) return;
  const small = args.includes('--replay') ? first : await shrink(model.model, first, { budget: 200 });
  const shrunk =
    small.script.length < first.script.length
      ? `, shrunk from ${first.script.length} choices to ${small.script.length}`
      : '';
  console.log(report(small, { title: `FAILED      run ${result.ran}${shrunk} (${ms} ms)` }));
  const rules = args.includes('--no-rules') ? ' --no-rules' : '';
  console.log(
    `again: node tape.ts sim ${files.map(f => f.path).join(' ')}${rules} --seed ${small.seed} --replay '${JSON.stringify(small.script)}'`,
  );
}

const fileOf = (path: string): File => ({
  name: (path.split('/').pop() ?? '').replace(/\.tape$/, ''),
  text: readFileSync(path, 'utf8'),
  path,
});

export async function simulate(args: readonly string[]): Promise<never> {
  const files = args.filter(a => a.endsWith('.tape')).map(fileOf);
  if (files.length === 0) {
    console.error(USAGE);
    process.exit(2);
  }
  const model = auto(files, {
    rules: !args.includes('--no-rules'),
    clients: Number(option(args, 'clients', 4)),
    ops: Number(option(args, 'ops', 10)),
  });
  if (model.errors) {
    for (const e of model.errors) {
      const path = files.find(f => f.name === e.program)?.path ?? '';
      console.error(`${path}:${e.line ?? ''}: ${e.code} ${e.message}${e.hint ? `\n  ${e.hint}` : ''}`);
    }
    process.exit(1);
  }
  const say: Say = args.includes('--quiet') ? () => {} : console.log;
  describe(say, files, model);

  const began = performance.now();
  const result = await runs(args, model.model);
  const ms = Math.round(performance.now() - began);
  if (result.ok) {
    reportClean(say, args, model, result, ms);
    process.exit(0);
  }
  await reportFailure(args, files, model, result, ms);
  process.exit(1);
}
