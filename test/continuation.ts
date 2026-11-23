// A line that starts with a binary operator (and, or, ++, +, ==, …), or one after a line that ends with `->`, carries
// the expression on, as a line that starts with `|>` does. Haiku wrapped a long condition or an arm's value that way
// in two or more runs of each of three bench rounds, and got P02. The independent check: each wrapped program parses
// to the same program as the same code on one line (line numbers aside), and gives the same answers. `-` is left out
// (it also starts a value: `-x` on its own line is a block's value), and that stays a P02 that says why.
import '../node25.ts';
import { compile, parseProgram } from '../compiler.ts';
import { flat, format } from '../fmt.ts';
import { std } from '../std.ts';
import { call, finish, functionsOf, same } from './harness.ts';

const fn = (body: string): string => `fn f(a: Int, b: Int) -> Int {\n${body}\n}\n`;
/** The program without where each node was written: what it means. */
const meaning = (text: string): string => {
  try {
    return JSON.stringify(parseProgram([{ name: 't.tape', text }]).fns.get('f')?.body ?? null, (k, v: unknown) =>
      k === 'line' || k === 'file' ? undefined : typeof v === 'bigint' ? String(v) : v,
    );
  } catch (e) {
    return `does not parse: ${e instanceof Error ? e.message : String(e)}`;
  }
};
const answers = (text: string): string => {
  const r = compile([...std, { name: 't.tape', text }], { exports: ['f'] });
  if (!r.wasm) return `ERR ${r.errors[0]?.code} ${r.errors[0]?.message}`;
  const ex = functionsOf(new WebAssembly.Module(r.wasm));
  const out: string[] = [];
  for (const [a, b] of [
    [0n, 0n],
    [1n, 2n],
    [3n, 1n],
    [-4n, 5n],
    [7n, 7n],
  ] as const) {
    call(ex, 'reset');
    out.push(String(call(ex, 'f', a, b)));
  }
  return out.join(' ');
};

// [what, wrapped, the same on one line]
const CASES: readonly (readonly [string, string, string])[] = [
  ['+ at the start of a line', '  a\n    + b * 2', '  a + b * 2'],
  ['* and / and %', '  (a + 10)\n    * b\n    / 3\n    % 5', '  (a + 10) * b / 3 % 5'],
  [
    '== in a condition arm',
    '  match {\n    a + b\n      == 3 -> 1\n    else -> 0\n  }',
    '  match {\n    a + b == 3 -> 1\n    else -> 0\n  }',
  ],
  [
    'and, or in a condition arm',
    '  match {\n    a > 1\n      and b > 1\n      or a == b -> 1\n    else -> 0\n  }',
    '  match {\n    a > 1 and b > 1 or a == b -> 1\n    else -> 0\n  }',
  ],
  [
    'and in a let',
    '  let ok = a > 0\n    and b > 0\n  match {\n    ok -> 1\n    else -> 0\n  }',
    '  let ok = a > 0 and b > 0\n  match {\n    ok -> 1\n    else -> 0\n  }',
  ],
  [
    '++ of text',
    '  let t = "ab"\n    ++ "cd"\n    ++ "e"\n  len(v: t) + a',
    '  let t = "ab" ++ "cd" ++ "e"\n  len(v: t) + a',
  ],
  ['<< | & ^', '  (a & 3)\n    << 2\n    | b\n    ^ 1', '  (a & 3) << 2 | b ^ 1'],
  [
    "an arm's value after its arrow",
    '  match a {\n    1 ->\n      b + 100\n    _ ->\n      b\n  }',
    '  match a {\n    1 -> b + 100\n    _ -> b\n  }',
  ],
  [
    "a guarded arm's value after its arrow",
    '  match {\n    a > b ->\n      a\n    else ->\n      b\n  }',
    '  match {\n    a > b -> a\n    else -> b\n  }',
  ],
  ["a step's else value after its arrow", '  let 1 = a else ->\n    0\n  b', '  let 1 = a else -> 0\n  b'],
];
for (const [what, wrapped, oneLine] of CASES) {
  same(`${what}: the same program as on one line`, meaning(fn(wrapped)), meaning(fn(oneLine)));
  same(`${what}: the same answers`, answers(fn(wrapped)), answers(fn(oneLine)));
  same(`${what}: it compiles and runs`, answers(fn(wrapped)).startsWith('ERR'), false);
}

// the formatter: a carried line is indented once past the line it carries on, as a `|>` line is; formatting is
// stable and keeps the meaning; `flat` puts the expression back on one line
const WRAPPED = fn('  let ok = a > 0\n      and b > 0\n  match a {\n    1 ->\n  b\n    _ -> 0\n  }');
const FLAT = fn('  let ok = a > 0 and b > 0\n  match a {\n    1 -> b\n    _ -> 0\n  }');
same('fmt puts short carried lines back on one line, as flat does', [format(WRAPPED), flat(WRAPPED)], [FLAT, FLAT]);
const LONG = `  match {\n    a > 1000000000 and b > 1000000000 and a + b + a * b > 3000000000000 or a == b + 1234567890 or b == a * 2 -> 1\n    else -> 0\n  }`;
same(
  'a condition too long for a line is broken before each and/or, each carried line indented once more',
  format(fn(LONG)),
  fn(
    '  match {\n    a > 1000000000\n      and b > 1000000000\n      and a + b + a * b > 3000000000000\n      or a == b + 1234567890\n      or b == a * 2 -> 1\n    else -> 0\n  }',
  ),
);
same(
  '…formats again to itself, and means what it meant',
  [format(format(fn(LONG))) === format(fn(LONG)), meaning(format(fn(LONG))) === meaning(fn(LONG))],
  [true, true],
);

// a statement after another is still its own: a let, then a value that starts a line
same('a let and then a value: two statements, as before', answers(fn('  let x = a\n  x + b')), answers(fn('  a + b')));
// `-` starts a value, so a line that starts with it is not the rest of the one before
const [minus] = compile([...std, { name: 't.tape', text: fn('  a\n    - b') }], { exports: ['f'] }).errors;
same(
  'a line that starts with `-`: P02 that says why it does not carry on',
  [minus?.code, minus?.message],
  ['P02', 'a line that starts with `-` is a new value, not the rest of the one before'],
);

finish();
