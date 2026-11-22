// apps/playground/src/simulate.ts: `tape sim` on the programs in the page. The same model (sim/model.ts, read from
// the programs), the same search, shrink and report as cli/sim.ts, which reads files and exits; this returns the
// lines it would print, with the failure, if any, as data.
import { auto, report, routeText, search, shrink } from '../../../sim.ts';
import type { Route } from '../../../sim/routes.ts';

export type SimFile = { name: string; text: string };
export type SimResult = {
  ok: boolean;
  lines: string[];
  ms: number;
  runs: number;
  /** what failed, shrunk: the kind, what was wrong, how many choices, and the command that runs it again */
  failure: { kind: string; violations: string[]; choices: number; shrunkFrom: number; replay: string } | null;
};

const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;
const named = (route: Route): string => routeText(route, part => `<${part.word ?? ''}>`);

export async function simulate(
  files: readonly SimFile[],
  {
    seeds = 500,
    steps = 120,
    faults = 3,
    seed = 1,
  }: { seeds?: number; steps?: number; faults?: number; seed?: number } = {},
): Promise<SimResult> {
  const lines: string[] = [],
    say = (l: string): void => {
      lines.push(l);
    };
  const t0 = performance.now();
  const model = auto(files, { clients: 4, ops: 10 });
  if (model.errors) {
    for (const e of model.errors) say(`${e.program ?? ''}.tape:${e.line ?? ''}: ${e.code} ${e.message}`);
    return { ok: false, lines, ms: performance.now() - t0, runs: 0, failure: null };
  }
  const { routes, stubs, invariants, refused } = model;
  say(`programs    ${files.map(f => f.name).join(', ')}; requests go to ${model.model.entry}`);
  say(
    routes.length > 0
      ? `requests    ${routes.length} paths: ${routes.map(r => named(r) + (r.body === null ? '' : ` {${r.body}}`)).join(', ')}`
      : 'requests    0 paths found: only GET / is sent',
  );
  const remotes = Object.entries(stubs);
  if (remotes.length > 0)
    say(
      `stood in    ${remotes.map(([n, m]) => `${n} (${Object.keys(m).join(', ')})`).join('; ')}: no file serves ${remotes.length > 1 ? 'them' : 'it'}, so replies are made from the reply types`,
    );
  say(
    invariants.length > 0
      ? `invariants  ${invariants.map(v => `${v.program}: "${v.name}"${v.settled ? ' (settled)' : ''}`).join('; ')}`
      : 'invariants  none declared: only a run that fails, and timers that never stop, are findings',
  );
  if (refused.length > 0)
    say(
      `rules off   ${count(refused.length, 'thing')} the rules refuse: ${[...new Set(refused.map(e => e.code))].join(', ')}`,
    );

  const result = await search(model.model, { runs: seeds, from: seed, steps, faults });
  const ms = performance.now() - t0;
  const [first] = result.failures;
  if (result.ok || !first) {
    say(`ok          ${result.ran} runs, ${result.actions} choices, nothing wrong (${Math.round(ms)} ms)`);
    const unanswered = routes.filter(r => (model.answered.get(r.key)?.ok ?? 0) === 0).map(named);
    say(
      `answered    ${routes.length - unanswered.length} of ${routes.length} paths with a 2xx at least once${unanswered.length > 0 ? `; never: ${unanswered.join(', ')}` : ''}`,
    );
    return { ok: true, lines, ms, runs: result.ran, failure: null };
  }
  const small = await shrink(model.model, first, { budget: 200 });
  const total = performance.now() - t0;
  const shrunk =
    small.script.length < first.script.length
      ? `, shrunk from ${first.script.length} choices to ${small.script.length}`
      : '';
  say(
    report(small, {
      title: `FAILED      run ${result.ran}${shrunk} (${Math.round(ms)} ms to find, ${Math.round(total - ms)} ms to shrink)`,
    }),
  );
  const replay = `node tape.ts sim ${files.map(f => `${f.name}.tape`).join(' ')} --seed ${small.seed} --replay '${JSON.stringify(small.script)}'`;
  say(`again: ${replay}`);
  return {
    ok: false,
    lines,
    ms: total,
    runs: result.ran,
    failure: {
      kind: small.kind,
      violations: small.violations,
      choices: small.script.length,
      shrunkFrom: first.script.length,
      replay,
    },
  };
}
