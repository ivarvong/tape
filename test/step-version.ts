// A step count is comparable only within one step version (compiler/step-version.ts). These programs' counts are
// what the current version meters: a fold over range takes one step a number and one more, a tail call and a call
// that is not tail each count one entry, and a call of a function that is not recursive counts nothing, with
// inlining or without it. A metering change fails here. Append a definition, record its counts under that version,
// and say what a step now is in LANGUAGE.md. Do not edit a version's counts.
//   node test/step-version.ts
import '../node25.ts';
import { STEP_DEFINITIONS, STEP_VERSION, isStepVersion } from '../compiler/step-version.ts';
import type { StepVersion } from '../compiler/step-version.ts';
import type { Options } from '../compiler.ts';
import { instantiate, isHead, stepVersionOf } from '../host.ts';
import { built, finish, moduleOf, ok, read, same, sectionText } from './harness.ts';

const OFF: Partial<Options> = { inline: false, localSteps: false };
const FOLD = `fn folded() -> Int {
  range(from: 0, to: 1000) |> fold(from: 0, by: fn(acc: Int, x: Int) -> Int { acc + x })
}
`;
const TAIL = `fn up(n: Int) -> Int {
  match {
    n >= 100 -> n
    else -> up(n: n + 1)
  }
}
`;
const HELPER = `fn bump(n: Int) -> Int { n + 1 }
fn up(n: Int) -> Int {
  match {
    n >= 100 -> n
    else -> up(n: bump(n))
  }
}
`;
const FACT = `fn fact(n: Int) -> Int {
  match {
    n <= 1 -> 1
    else -> n * fact(n: n - 1)
  }
}
`;
// decode walks a JSON string. A change to that metering (a scan that charges by the bytes it reads) moves this
// count, which is why it is pinned beside the folds: the four small programs do not touch JSON.
const JSON_READ = `type Box { Box(n: Int) }
fn read() -> Int {
  match decode(json: "{\\"n\\":7}", as: Box) {
    Ok(value: Box(n)) -> n
    Err(error) -> -1
  }
}
`;
const GET = `fn handle(raw: View) -> Buf {
  match request(raw) {
    Request(method: "GET", path: "/") -> respond(status: 200) |> append(view: "ok")
    _ -> respond(status: 404)
  }
}
`;

type Sample = {
  readonly fold: number;
  readonly tail: number;
  readonly helper: number;
  readonly fact: number;
  readonly json: number;
};
type Recorded = Sample & { readonly inlineOffMatches: boolean };
const COUNTS = {
  // version 1, before scan charged: seen failing once scan landed and the row was still the current one,
  // got {"fold":1001,"tail":101,"helper":101,"fact":10,"json":48}, wanted json 47 (test/step-version.ts on that commit)
  1: { fold: 1001, tail: 101, helper: 101, fact: 10, json: 47, inlineOffMatches: true },
  2: { fold: 1001, tail: 101, helper: 101, fact: 10, json: 48, inlineOffMatches: true },
} satisfies Record<StepVersion, Recorded>;

function stepsOf(text: string, fn: string, args: readonly bigint[], options: Partial<Options>): number {
  const app = instantiate(moduleOf(built(text, { ...options, exports: [fn] })), { log: false });
  const f = app.exports[fn],
    reset = app.exports['reset'];
  if (typeof f !== 'function' || typeof reset !== 'function') throw new TypeError(`no ${fn}`);
  reset();
  f(...args);
  const cost = app.exports['cost'];
  if (!(cost instanceof WebAssembly.Global)) throw new TypeError('no cost');
  return Number(cost.value);
}
const measure = (options: Partial<Options> = {}): Sample => ({
  fold: stepsOf(FOLD, 'folded', [], options),
  tail: stepsOf(TAIL, 'up', [0n], options),
  helper: stepsOf(HELPER, 'up', [0n], options),
  fact: stepsOf(FACT, 'fact', [10n], options),
  json: stepsOf(JSON_READ, 'read', [], options),
});

const want = COUNTS[STEP_VERSION];
const got = measure();
same(
  `steps of step version ${STEP_VERSION} (a metering change appends a definition and records its counts; it does not edit this row)`,
  got,
  { fold: want.fold, tail: want.tail, helper: want.helper, fact: want.fact, json: want.json },
);
if (want.inlineOffMatches)
  same('inlining and the local step counter leave these step counts unchanged', measure(OFF), got);
const versions = STEP_DEFINITIONS.map(d => d.version);
ok(
  'step versions are 1, 2, 3, … in the order appended, none skipped or repeated',
  versions.every((v, i) => v === i + 1),
);
ok(
  'only a named whole version is one',
  isStepVersion(STEP_VERSION) && !isStepVersion(STEP_VERSION + 1) && !isStepVersion(1.5) && !isStepVersion('1'),
);

const mod = moduleOf(built(FOLD, { exports: ['folded'] }));
same('a module carries its step version as a number', sectionText(mod, 'step_version'), String(STEP_VERSION));
same('the host reads the step version the module carries', stepVersionOf(mod), STEP_VERSION);
const off = moduleOf(built(FOLD, { ...OFF, exports: ['folded'] }));
same('a build without inlining carries the same step version', stepVersionOf(off), STEP_VERSION);

const app = instantiate(moduleOf(built(GET)), { log: true });
app.handle(new TextEncoder().encode('GET /'));
const [head] = app.effects;
const cost = app.exports['cost'];
same(
  'a run records the module step version beside its steps',
  head && isHead(head) ? head.step_version : null,
  STEP_VERSION,
);
same(
  'the recorded steps are the module cost',
  head && isHead(head) ? head.steps : null,
  cost instanceof WebAssembly.Global ? Number(cost.value) : null,
);
ok(
  'LANGUAGE.md names the current step version',
  read('LANGUAGE.md').includes(`This definition is step version ${STEP_VERSION}.`),
);

finish();
