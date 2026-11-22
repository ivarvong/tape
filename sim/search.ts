// sim/search.ts: many runs. Seeded random scripts (explore), scripts grown from the ones that reached something
// new (search), every script up to a depth (exhaust), one script again (replay), the same failure from fewer
// choices (shrink), and a failure as text (report).
import { FAULTS, rng, run } from './engine.ts';
import type { Failure, Model, Outcome, RunOptions, World } from './engine.ts';
import { cellText } from '../host/log.ts';

export const drive = (model: Model, options: RunOptions): Promise<Outcome> => run(model, options);

export function replay(
  model: Model,
  script: readonly string[],
  { seed = 1, faults = Infinity }: { seed?: number; faults?: number } = {},
): Promise<Outcome> {
  const todo = [...script];
  return run(model, { seed, faults, choose: () => todo.shift() ?? null });
}

// Weights: starting and delivering are common, a fault is rare, the clock moves sometimes.
const WEIGHTS: readonly (readonly [string, number])[] = [
  ['start', 6],
  ['deliver', 6],
  ['wake', 5],
  ['tick', 2],
];
const weight = (a: string): number => WEIGHTS.find(([kind]) => a.startsWith(kind))?.[1] ?? 1;
/** One of the choices, by weight. */
function weighted(acts: readonly string[], pick: () => number): string | undefined {
  const total = acts.reduce((sum, a) => sum + weight(a), 0);
  let x = pick() * total;
  for (const a of acts) {
    x -= weight(a);
    if (x <= 0) return a;
  }
  return acts.at(-1);
}

export type ExploreOptions = { seeds?: number; from?: number; steps?: number; faults?: number; stopAtFirst?: boolean };
export type Explored = { ok: boolean; ran: number; actions: number; failures: Failure[] };

/** Seeded random scripts. */
export async function explore(model: Model, options: ExploreOptions = {}): Promise<Explored> {
  const { seeds = 100, from = 1, steps = 60, faults = 2, stopAtFirst = true } = options;
  const failures: Failure[] = [];
  let ran = 0;
  let actions = 0;
  for (let seed = from; seed < from + seeds; seed++) {
    const pick = rng(seed * 7919 + 13);
    let n = 0;
    const choose = (acts: string[]): string | null | undefined =>
      n++ >= steps || acts.length === 0 ? null : weighted(acts, pick);
    const r = await run(model, { seed, faults, choose });
    ran++;
    actions += r.script.length;
    if (!r.ok) {
      failures.push(r);
      if (stopAtFirst) break;
    }
  }
  return { ok: failures.length === 0, ran, actions, failures };
}

/** What a world has reached: a call waiting, a fault taken on a method, a machine in a state. */
function features(model: Model, w: World): string[] {
  const out = w.pending.map(p => `waiting:${p.to}.${p.meta.method}`);
  if (w.did !== undefined) out.push(`did:${w.did}`);
  for (const [name, ms] of Object.entries(model.machines ?? {}))
    for (const m of ms) {
      try {
        const rows = w.programs[name]?.sql.exec(`SELECT DISTINCT "${m.column}" AS s FROM "${m.table}"`).toArray() ?? [];
        out.push(...rows.map(r => `${name}.${m.table}=${cellText(r['s'])}`));
      } catch {
        // a table this program does not have yet
      }
    }
  return out;
}

export type SearchOptions = { runs?: number; from?: number; steps?: number; faults?: number; stopAtFirst?: boolean };
export type Searched = Explored & { reached: string[]; corpus: number; repeats: string[] };
type Start = { seed: number; script: string[] };

// Seeded random scripts that build on each other. A run that reaches something not seen before (a machine in a
// state, a call waiting, a fault taken on a method) leaves its script up to that point in a corpus; most later
// runs start by replaying one of those and go on from there at random. Deep states (a hold confirmed, a refund
// out) become starting points instead of luck. The whole search follows from `from`: the same call finds the same.
export async function search(model: Model, options: SearchOptions = {}): Promise<Searched> {
  const { runs = 500, from = 1, steps = 120, faults = 3, stopAtFirst = true } = options;
  const corpus: Start[] = [];
  const seen = new Set<string>();
  const failures: Failure[] = [];
  const repeats = new Map<string, string>();
  let ran = 0;
  let actions = 0;
  for (let i = 0; i < runs; i++) {
    const pick = rng((from + i) * 7919 + 13);
    // later entries reached more, so they are taken more often
    const base =
      corpus.length > 0 && pick() < 0.75
        ? corpus[Math.min(corpus.length - 1, Math.floor(corpus.length * Math.sqrt(pick())))]
        : undefined;
    const seed = base ? base.seed : from + i;
    const prefix = base ? [...base.script] : [];
    const marks = new Set<number>();
    let n = 0;
    const choose = (acts: string[], w: World, script: readonly string[]): string | null | undefined => {
      for (const f of features(model, w))
        if (!seen.has(f)) {
          seen.add(f);
          if (script.length > 0) marks.add(script.length);
        }
      if (prefix.length > 0) return prefix.shift();
      return n++ >= steps || acts.length === 0 ? null : weighted(acts, pick);
    };
    const r = await run(model, { seed, faults, choose });
    ran++;
    actions += r.script.length;
    for (const note of r.ok ? r.notes : []) {
      const [k = ''] = note.split(' changed ');
      if (!repeats.has(k)) repeats.set(k, note);
    }
    // what settling reached counts as reached, though nothing starts from it
    for (const f of features(model, r.world)) seen.add(f);
    for (const m of marks) if (corpus.length < 500) corpus.push({ seed, script: r.script.slice(0, m) });
    if (!r.ok) {
      failures.push(r);
      if (stopAtFirst) break;
    }
  }
  const reached = [...seen].filter(f => !f.startsWith('did:') && !f.startsWith('waiting:')).toSorted();
  return {
    ok: failures.length === 0,
    ran,
    actions,
    failures,
    reached,
    corpus: corpus.length,
    repeats: [...repeats.values()],
  };
}

export type ExhaustOptions = { seed?: number; depth?: number; faults?: number; limit?: number; stopAtFirst?: boolean };

// Every script up to `depth` choices with at most `faults` faults, for one fixed workload (seed). Each script is
// run from the start: there is no snapshot.
export async function exhaust(
  model: Model,
  { seed = 1, depth = 12, faults = 1, limit = 200000, stopAtFirst = true }: ExhaustOptions = {},
): Promise<{ ok: boolean; ran: number; complete: boolean; failures: Failure[] }> {
  const failures: Failure[] = [];
  let ran = 0;
  const stack: string[][] = [[]];
  while (stack.length > 0 && ran < limit) {
    const prefix = stack.pop() ?? [];
    const todo = [...prefix];
    const open: string[][] = [];
    const choose = (acts: string[]): string | null => {
      const next = todo.shift();
      if (next === undefined) open.push(acts);
      return next ?? null;
    };
    const r = await run(model, { seed, faults, choose });
    ran++;
    if (!r.ok) {
      failures.push(r);
      if (stopAtFirst) break;
      continue;
    }
    const [last] = open;
    if (prefix.length >= depth || !last) continue;
    stack.push(...last.toReversed().map(a => [...prefix, a]));
  }
  return { ok: failures.length === 0, ran, complete: stack.length === 0, failures };
}

// The same kind of failure from fewer choices: drop one choice at a time, then turn each fault into a delivery.
export async function shrink(
  model: Model,
  failure: Failure,
  { budget = 400 }: { budget?: number } = {},
): Promise<Failure> {
  let best = failure;
  let spent = 0;
  const again = async (script: string[]): Promise<Failure | null> => {
    const r = await replay(model, script, { seed: failure.seed });
    return !r.ok && r.kind === failure.kind ? r : null;
  };
  for (let changed = true; changed;) {
    changed = false;
    for (let i = best.script.length - 1; i >= 0 && spent < budget; i--, spent++) {
      const r = await again(best.script.filter((_, j) => j !== i));
      if (r && r.script.length < best.script.length) {
        best = r;
        changed = true;
        i = Math.min(i, best.script.length);
      }
    }
    for (let i = 0; i < best.script.length && spent < budget; i++) {
      const [kind = '', id = ''] = best.script[i]?.split(' ') ?? [];
      if (!FAULTS.includes(kind)) continue;
      spent++;
      const r = await again(best.script.map((a, j) => (j === i ? `deliver ${id}` : a)));
      if (r) {
        best = r;
        changed = true;
      }
    }
  }
  return best;
}

/** A failure as text: the choices, what each did, and what was wrong at the end. */
export function report(failure: Failure, { title = '' }: { title?: string } = {}): string {
  const t0 = failure.log[0]?.at ?? 0;
  return [
    ...(title ? [title] : []),
    `${failure.kind}: ${failure.violations.join('; ')}`,
    `seed ${failure.seed}, ${failure.script.length} choices:`,
    ...failure.log.map(e => `  +${String(e.at - t0).padStart(7)} ms  ${e.what.padEnd(24)} ${e.detail}`),
    `replay: ${JSON.stringify(failure.script)}`,
  ].join('\n');
}
