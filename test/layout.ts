// The formatter's two directions on every program in the repository. `format` breaks a line over 100 columns;
// `flat` puts every step back on one line. A file must be as `format` writes it, formatting must change nothing a
// second time, `flat` must undo it, and the flat text must be the same program: the same tokens in the same order,
// which is all the parser sees. The tests and the planted bugs edit the flat text (test/harness.ts `read`).
import '../node25.ts';
import { readdirSync, readFileSync } from 'node:fs';
import { lex } from '../compiler/lex.ts';
import { format, flat } from '../fmt.ts';
import { ok, same, finish } from './harness.ts';

const root = new URL('..', import.meta.url).pathname;
const dirs = [
  'std',
  'examples',
  'examples/timed',
  'examples/tools',
  'apps/tickets',
  'apps/queue',
  'testdata/compare',
  'service/test/fixtures',
];
const files = dirs.flatMap(d =>
  readdirSync(`${root}${d}`)
    .filter(f => f.endsWith('.tape'))
    .map(f => `${d}/${f}`),
);
/** What the parser is given: each token's kind and value, without the line it stood on. */
const seen = (name: string, text: string): string =>
  JSON.stringify(lex(name, text), (key, value: unknown) =>
    key === 'line' ? undefined : typeof value === 'bigint' ? `${value}n` : value,
  );

let wide = 0;
for (const f of files) {
  const text = readFileSync(`${root}${f}`, 'utf8');
  const one = flat(text, f);
  same(`${f}: is as fmt writes it`, format(text, f) === text, true);
  same(`${f}: flat undoes format`, flat(format(one, f), f) === one, true);
  same(`${f}: flat twice is flat once`, flat(one, f) === one, true);
  same(`${f}: the flat text is the same tokens`, seen(f, one) === seen(f, text), true);
  wide += text.split('\n').filter(l => l.length > 100 && !l.trimStart().startsWith('//')).length;
}
ok(`${files.length} programs checked`, files.length >= 45);
// what is still wider than 100 columns and is no comment: SQL in a migration or an invariant, kept as written, and
// names too long to break. The count may only go down.
ok('lines wider than 100 columns that are not comments: at most 41', wide <= 41, `${wide}`);

// ---- the forms, on small programs
const body = (inside: string): string => `fn handle(raw: View) -> Buf {\n  ${inside}\n}\n`;
const long =
  'respond(status: 200) |> append(view: "one") |> append(view: "two") |> append(view: "three") |> append(view: "four")';
same(
  'a line too wide breaks before each |>',
  format(body(long)),
  'fn handle(raw: View) -> Buf {\n  respond(status: 200)\n    |> append(view: "one")\n    |> append(view: "two")\n    |> append(view: "three")\n    |> append(view: "four")\n}\n',
);
const call =
  'pick(first: slice(v: raw, from: 0, to: 1), second: slice(v: raw, from: 1, to: 2), third: slice(v: raw, from: 2, to: 3))';
same(
  'with no |>, inside its widest brackets, one argument to a line',
  format(`fn pick(first: View, second: View, third: View) -> Buf {\n  buf()\n}\n${body(call)}`)
    .split('\n')
    .slice(3, 9),
  [
    'fn handle(raw: View) -> Buf {',
    '  pick(',
    '    first: slice(v: raw, from: 0, to: 1),',
    '    second: slice(v: raw, from: 1, to: 2),',
    '    third: slice(v: raw, from: 2, to: 3)',
    '  )',
  ],
);
const text = `buf() |> append(view: "${'SELECT a FROM t WHERE b '.repeat(6)}end")`;
const carried = format(body(text));
ok(
  'a text too long for its line is carried over lines, each ending in a backslash',
  /\\\n {8}\S/.test(carried),
  carried,
);
same('and is the same text', seen('t', flat(carried)), seen('t', body(text)));
same(
  'a line that fits is left alone',
  format(body('respond(status: 200) |> append(view: "ok")')),
  body('respond(status: 200) |> append(view: "ok")'),
);
same(
  'a break the author put inside brackets is not kept: a step that fits is one line, however it was typed',
  format(body('respond(\n    status: 200\n  )')),
  body('respond(status: 200)'),
);

const arg = `"aa ${'a'.repeat(80)}"`;
same(
  'a call broken after a `|>` has its arguments inside the `|>` line, and its closer where that line stands',
  format(body(`buf() |> append(view: ${arg}) |> append(view: "x")`)),
  `fn handle(raw: View) -> Buf {\n  buf()\n    |> append(\n      view: ${arg}\n    )\n    |> append(view: "x")\n}\n`,
);

finish();
