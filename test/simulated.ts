// What the tests of the simulator share: a model or a build that must be there, and the first failure of a search.
import { auto, build } from '../sim.ts';
import type { BuiltProgram, Failure } from '../sim/engine.ts';
import type { Auto, AutoOptions } from '../sim/model.ts';

/** The model read from these programs; an error when one of them does not compile. */
export function autoOf(files: readonly { name: string; text: string }[], options: AutoOptions = {}): Auto {
  const a = auto(files, options);
  if (a.errors)
    throw new Error(`no model: ${a.errors.map(e => `${e.program ?? ''} ${e.code} ${e.message}`).join('; ')}`);
  return a;
}
/** One program compiled for the simulator; an error when it does not compile. */
export function builtFor(text: string, options: { rules?: boolean } = {}): BuiltProgram {
  const b = build(text, options);
  if (b.errors) throw new Error(`does not compile: ${b.errors.map(e => `${e.code} ${e.message}`).join('; ')}`);
  return b;
}
/** What was wrong in the first run that failed, or '' when none did. */
export const wrongIn = (r: { failures: readonly Failure[] }): string => r.failures[0]?.violations[0] ?? '';
