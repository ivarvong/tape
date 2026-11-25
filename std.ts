// The standard library as the compiler takes it: the files of std/, before a program's own. One list, so every
// build in this repository (the CLI, the simulator, the tests, the proofs) is given the same files in the same
// order. The service bundles the same files itself (service/src), because it cannot read a directory.
import { readFileSync } from 'node:fs';

export const std = ['core', 'text', 'json', 'http', 'list', 'map', 'retry', 'time', 'math', 'crypto'].map(n => ({
  name: `std/${n}.tape`,
  text: readFileSync(new URL(`./std/${n}.tape`, import.meta.url), 'utf8'),
}));
