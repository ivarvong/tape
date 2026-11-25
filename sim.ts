// sim.ts: a deterministic simulator for tape programs. It runs a set of programs in one process, wired as the
// service wires them (a Remote named `pay` reaches the program named pay; a once key is answered from the stored
// reply), and makes every choice a real deployment leaves to chance:
//
//   which waiting request starts next          start c0
//   what happens to each call between programs deliver | lose | drop | cut | cutafter   <call>
//   (and to each fetch, which the model's `http` table answers: a lost or late one is a Timeout)
//   when a due timer runs                      wake <program> <key>
//   how far the clock moves                    tick <ms>
//
//   deliver   the callee runs and the caller gets its reply (if the clock passed the call's `within`, as drop)
//   lose      the callee never runs; the caller sees no answer
//   drop      the callee runs and commits; the caller sees no answer
//   cut       the callee never runs, and the caller's object is reset: its run ends, what it committed stays
//   cutafter  the callee runs and commits, and the caller's run ends
//
// A call is a commit point, so a run can be cut only at a call: the five outcomes above at each call, the order
// of requests and timers, and the clock are all of the nondeterminism there is. A run of the simulator is a list
// of those choices (a script); the same script gives the same run. After the script the faults stop: every call
// still waiting is delivered, timers run and the clock jumps to the next one until none is left (settle).
//
// A model says what must hold:
//   `invariant "name" { SELECT … }` in a program: checked after every step; `settled` ones after settle
//   check(world)    after every step: safety (nothing is ever wrong, even mid-flight)
//   sent again      after settle: each request answered 2xx is sent once more and must change no row (`repeat`)
//   settled(world)  after settle: liveness (nothing is left half-done once the faults stop)
// A run that fails (a trap, a storage error: a 500 in the service) is a finding of its own, `error`.
//
//   explore(model, { seeds, steps, faults })   seeded random scripts
//   exhaust(model, { depth, faults })          every script up to a depth and a number of faults
//   replay(model, script)                      one script again
//   shrink(model, failure)                     the same failure from fewer choices
//
// It tests programs against this model of the host (host.ts over node:sqlite), not workerd or production.
//
// The parts, in sim/: engine.ts (one run), search.ts (many runs), model.ts (a model read from the programs: what
// `tape sim` uses), routes.ts (the requests a program takes), dictionary.ts (words from its seed rows), values.ts
// (values of a type). cli/sim.ts is what `tape sim` prints.
export { FAULTS, build, rng } from './sim/engine.ts';
export { drive, replay, explore, search, exhaust, shrink, report } from './sim/search.ts';
export { auto } from './sim/model.ts';
export { routesOf, routeText } from './sim/routes.ts';
export { valueOf } from './sim/values.ts';
