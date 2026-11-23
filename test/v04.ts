// 0.4: what the 0.3 usability bench (48 runs, Sonnet and Haiku) and its feedback asked of the language, each
// checked here against something other than the code that does it.
import '../node25.ts';
import { compile } from '../compiler.ts';
import { std } from '../std.ts';
import { finish, same } from './harness.ts';

const said = (text: string): string => {
  const [e] = compile([...std, { name: 't.tape', text }], { exports: ['f'] }).errors;
  return e ? `${e.code} ${e.line}: ${e.message} | ${e.hint}` : 'compiled';
};

// ---- the fallback arm of each match (feedback 20261123T015148.926Z-8896b9c5701d): `_ ->` in a match of
// conditions was "expected an expression but found `_`", and `else ->` in a match on a value "expected a pattern"
same(
  '`_ ->` in a match with no subject says its fallback is `else ->`',
  said('fn f(n: Int) -> Int {\n  match {\n    n > 1 -> 1\n    _ -> 2\n  }\n}\n'),
  'P02 4: a match with no subject takes conditions; its fallback arm is `else -> …`, not `_ -> …` | Write `else -> …` as the last arm, or give the match a subject (`match n { 1 -> … _ -> … }`) to match patterns.',
);
same(
  '`else ->` in a match on a value says its fallback is `_ ->`',
  said('fn f(n: Int) -> Int {\n  match n {\n    1 -> 1\n    else -> 2\n  }\n}\n'),
  'P04 4: a match on a value takes patterns; its fallback arm is `_ -> …`, not `else -> …` | Write `_ -> …` as the last arm, or drop the subject (`match { n > 1 -> … else -> … }`) to match conditions.',
);
same(
  'each written as the doc says compiles',
  [
    said('fn f(n: Int) -> Int {\n  match {\n    n > 1 -> 1\n    else -> 2\n  }\n}\n'),
    said('fn f(n: Int) -> Int {\n  match n {\n    1 -> 1\n    _ -> 2\n  }\n}\n'),
  ],
  ['compiled', 'compiled'],
);

finish();
