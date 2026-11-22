// test/typed.ts: the repository is TypeScript and nothing else, and the list of files the type checker does not
// yet read (proof/untyped.txt) says exactly which they are. A file comes off the list when it passes `tsc` under
// `strict`; none goes on.
import '../node25.ts';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import './fail-exit.ts';

const root = new URL('..', import.meta.url).pathname;
const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 })
  .split('\n')
  .filter(Boolean);
const listed = new Set(
  readFileSync(root + 'proof/untyped.txt', 'utf8')
    .split('\n')
    .filter(Boolean),
);
// outside: service/runtime.d.ts is generated; experiments/ is an archive of one-off scripts kept as they were run,
// except the cases the tests read
const APART =
  /^service\/runtime\.d\.ts$|^experiments\/(?!(c78\/(mutants|round2|round3|timed-mutants|fulfillment-mutants)|lang\/port-keys)\.ts$)/;
let failed = 0;
const T = (name: string, got: readonly string[]) => {
  if (got.length > 0) failed++;
  console.log(got.length > 0 ? 'FAIL' : 'ok  ', name, got.length > 0 ? `-> ${got.slice(0, 8).join(', ')}` : '');
};

// vendored: third-party code kept as its authors published it, with its licence beside it
const VENDORED = /^apps\/playground\/vendor\//;
T(
  'no JavaScript file is tracked, but what is vendored',
  tracked.filter(f => /\.(js|mjs|cjs|jsx)$/.test(f) && !VENDORED.test(f)),
);
const unchecked = tracked.filter(
  f => f.endsWith('.ts') && !APART.test(f) && /^(#!.*\n)?\/\/ @ts-nocheck/.test(readFileSync(root + f, 'utf8')),
);
T(
  'a file the checker skips is on the list',
  unchecked.filter(f => !listed.has(f)),
);
T(
  'a file on the list is still skipped (take it off when it is typed)',
  [...listed].filter(f => !unchecked.includes(f)),
);
console.log(
  `${unchecked.length} of ${tracked.filter(f => f.endsWith('.ts') && !APART.test(f)).length} files not yet typed`,
);
console.log(failed ? `${failed} FAILED` : 'all passed');
