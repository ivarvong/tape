// sim/engine.ts: one run of the simulator. run() takes a model and a way to choose, applies one choice at a time
// (apply.ts) to a world (world.ts), checks what must hold after each (checks.ts), and settles the world at the end
// (settle.ts). What the choices are, and what a model says, is described in ../sim.ts.
import { compile } from '../compiler.ts';
import type { Built } from '../compiler.ts';
import type { Problem } from '../compiler/common.ts';
import { std } from '../std.ts';
import { apply } from './apply.ts';
import { declared } from './checks.ts';
import { duplicate, sentAgain, settle, wrongNow } from './settle.ts';
import { boot, clientsOf, enabled, rng } from './world.ts';
import type { Line, Model, World } from './world.ts';

export { FAULTS, rng } from './world.ts';
export type { Answer, Client, Line, Mem, Model, Op, Request, World } from './world.ts';

export type BuiltProgram = { errors?: undefined; module: WebAssembly.Module; refused: Problem[]; info: Built };
/** Compile one program with std. rules: false builds what the rules refuse (and returns what they found). */
export function build(text: string, { rules = true }: { rules?: boolean } = {}): BuiltProgram | { errors: Problem[] } {
  const b = compile([...std, { name: 'program.tape', text }], { rules });
  if (b.wasm === null) return { errors: b.errors };
  return { module: new WebAssembly.Module(b.wasm), refused: b.refused, info: b };
}

/** The next choice: one of `enabled`, or null to stop. */
export type Choose = (enabled: string[], world: World, script: readonly string[]) => string | null | undefined;
export type RunOptions = { seed?: number; choose: Choose; faults?: number; account?: string };
export type Kind = 'error' | 'safety' | 'liveness' | 'repeat';
export type Failure = {
  ok: false;
  kind: Kind;
  violations: string[];
  script: string[];
  seed: number;
  log: Line[];
  world: World;
};
export type Passed = { ok: true; script: string[]; seed: number; log: Line[]; world: World; notes: string[] };
export type Outcome = Failure | Passed;
type Found = { kind: Kind; violations: string[] } | null;

const crashOf = (world: World): void => {
  if (world.crash !== undefined) throw world.crash;
};
const failedOf = (world: World): Found =>
  world.failed === undefined ? null : { kind: 'error', violations: [world.failed] };

const safetyOf = (bad: string[]): Found => (bad.length > 0 ? { kind: 'safety', violations: bad } : null);

/** The choices, one at a time, until `choose` stops or something is wrong. */
async function steps(
  world: World,
  model: Model,
  o: Required<Pick<RunOptions, 'choose' | 'faults' | 'seed'>>,
  script: string[],
): Promise<Found> {
  const clients = clientsOf(model, world, o.seed);
  for (;;) {
    crashOf(world);
    const acts = enabled(world, clients, o.faults);
    const act = o.choose(acts, world, script);
    if (act === null || act === undefined) break;
    // a replayed choice that is not open in this run is passed over
    if (!acts.includes(act)) continue;
    script.push(act);
    world.choices++;
    await apply(world, model, clients, act);
    crashOf(world);
    const found = failedOf(world) ?? safetyOf(wrongNow(world, model));
    if (found) return found;
  }
  const stuck = await settle(world, model, clients);
  crashOf(world);
  if (world.failed !== undefined) return failedOf(world);
  if (stuck !== null && typeof stuck !== 'string') return { kind: 'safety', violations: stuck.safety };
  if (stuck !== null) return { kind: 'liveness', violations: [stuck] };
  const left = [...declared(world, true), ...(model.settled?.(world) ?? [])];
  return left.length > 0 ? { kind: 'liveness', violations: left } : null;
}

/** After a run that held: the duplicate rule for one finished request, then every answered request sent again. */
async function repeats(
  world: World,
  model: Model,
  o: { seed: number; faults: number; account: string | undefined },
  script: string[],
): Promise<{ found: Found; notes: string[] }> {
  // the duplicate rule, for one finished request of this run (which one is the seed's choice)
  const sent = world.finished[Math.floor(rng(o.seed * 104729 + 13)() * world.finished.length)];
  if (model.duplicates !== false && sent) {
    const changed = await duplicate(model, o, script, sent);
    Date.now = (): number => world.clock;
    if (changed !== null) return { found: { kind: 'repeat', violations: [changed] }, notes: [] };
  }
  // what a second sending changed is a note, not a failure, unless the model says a repeat must change nothing:
  // counting requests, or a command meant to be given twice, changes a row by design, and a row left half-way is
  // moved on by any later request. It is printed so that each case is one somebody has looked at.
  if (model.repeat === false) return { found: null, notes: [] };
  const notes = await sentAgain(world, model);
  crashOf(world);
  const strict = notes.length > 0 && model.repeat === 'strict';
  return { found: strict ? { kind: 'repeat', violations: notes } : null, notes };
}

/** Run one script, or make one: choose(enabled, world, script) returns the next action, or null to stop. */
export async function run(model: Model, { seed = 1, choose, faults = 2, account }: RunOptions): Promise<Outcome> {
  const realNow = Date.now;
  const world = boot(model, account, seed);
  const script: string[] = [];
  Date.now = (): number => world.clock;
  const fail = (found: { kind: Kind; violations: string[] }): Failure => ({
    ok: false,
    ...found,
    script,
    seed,
    log: world.log,
    world,
  });
  try {
    const found = await steps(world, model, { seed, choose, faults }, script);
    if (found) return fail(found);
    const after = await repeats(world, model, { seed, faults, account }, script);
    return after.found ? fail(after.found) : { ok: true, script, seed, log: world.log, world, notes: after.notes };
  } finally {
    Date.now = realNow;
  }
}
