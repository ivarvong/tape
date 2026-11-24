// compiler/step-version.ts: which step accounting this compiler builds. A step count is comparable only with
// another count of the same version. Version 1 counts one entry into a recursive function, after inlining; a call
// of any other function is free (LANGUAGE.md section 10). Version 2 is that, plus one step per 16 bytes a scan
// reads. Append the next definition when that changes, and record its counts in test/step-version.ts. A
// definition's meaning is not edited in place.
export const STEP_DEFINITIONS = [
  { version: 1, unit: 'recursive-entry' },
  { version: 2, unit: 'recursive-entry+scan' },
] as const;
export type StepDefinition = (typeof STEP_DEFINITIONS)[number];
export type StepVersion = StepDefinition['version'];

const latest = STEP_DEFINITIONS.at(-1);
if (latest === undefined) throw new TypeError('no step definition');
/** The accounting this compiler builds into every module and reports beside every step count. */
export const STEP_DEFINITION: StepDefinition = latest;
export const STEP_VERSION: StepVersion = STEP_DEFINITION.version;

/** A number read from a module or a log is a step version this compiler names. */
export const isStepVersion = (v: unknown): v is StepVersion =>
  typeof v === 'number' && STEP_DEFINITIONS.some(d => d.version === v);
