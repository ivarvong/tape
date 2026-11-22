// LANGUAGE.md against the compiler: every program in it compiles (or is refused with the code it shows), is in
// fmt's layout, and every edit it shows of its whole program is refused with the code it shows. The one edit the
// compiler accepts is found by the simulator, as the file says.
import '../node25.ts';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { compile, KEYWORDS } from '../compiler.ts';
import { format } from '../fmt.ts';
import { search } from '../sim.ts';
import type { Searched } from '../sim/search.ts';
import { autoOf, wrongIn } from './simulated.ts';
import { ok, finish, raw, read, std } from './harness.ts';

const build = (text: string) => compile([...std, { name: 'program.tape', text }]);
/** The first thing refused, as text; or that nothing was. */
const refusal = (r: ReturnType<typeof build>, width: number): string => {
  const [e] = r.errors;
  return e ? `${e.code}:${e.line} ${e.message.slice(0, width)}` : 'it compiles';
};
const doc = readFileSync(new URL('../LANGUAGE.md', import.meta.url), 'utf8');
const blocks = [...doc.matchAll(/^```(tape|diff)([^\n]*)\n([\s\S]*?)^```$/gm)].map(m => ({
  kind: m[1] ?? '',
  info: (m[2] ?? '').trim(),
  text: m[3] ?? '',
}));

const whole = blocks.find(b => b.kind === 'tape' && !b.info)?.text ?? '';
ok('the file has one whole program', blocks.filter(b => b.kind === 'tape' && !b.info).length === 1);
const built = build(whole);
ok(
  'the whole program compiles, with the rules on',
  built.wasm !== null,
  built.errors.map(e => `${e.code}:${e.line} ${e.message}`).join('; '),
);
ok("the whole program is in fmt's layout", format(whole) === whole);
ok(
  'the whole program declares invariants and a machine',
  built.wasm !== null && built.invariants.length === 2 && built.machines.length === 1,
);
const sim = (text: string): Promise<Searched> => {
  const a = autoOf([{ name: 'orders', text }], { clients: 4, ops: 10 });
  return search(a.model, { runs: 100, steps: 120, faults: 3 });
};
const clean = await sim(whole);
ok('tape sim finds nothing wrong with it in 100 runs', clean.ok, wrongIn(clean));

for (const b of blocks.filter(x => x.kind === 'tape' && x.info !== '')) {
  const want = /^refused (\w+)$/.exec(b.info)?.[1],
    r = build(b.text);
  ok(
    `a program shown as refused is refused with ${want}`,
    want !== undefined && r.errors.some(e => e.code === want),
    refusal(r, 80),
  );
}

// an edit: runs of - lines are replaced by the + lines that follow them
const edited = (b: { text: string }): string | null => {
  let text = whole;
  const lines = b.text.replace(/\n$/, '').split('\n');
  let i = 0;
  while (i < lines.length) {
    const minus: string[] = [];
    const plus: string[] = [];
    while (lines[i]?.startsWith('-') === true) minus.push((lines[i++] ?? '').slice(1));
    while (lines[i]?.startsWith('+') === true) plus.push((lines[i++] ?? '').slice(1));
    const from = minus.join('\n'),
      to = plus.join('\n');
    if (minus.length === 0 || !text.includes(from)) return null;
    // a line taken away whole goes with its newline
    text =
      to === '' && text.includes(from + '\n') && from.startsWith(' ')
        ? text.replace(from + '\n', '')
        : text.replace(from, to);
  }
  return text;
};
const seen = [];
for (const b of blocks.filter(x => x.kind === 'diff')) {
  const text = edited(b);
  if (text === null) {
    ok(`the edit for ${b.info} applies to the whole program`, false);
    continue;
  }
  const r = build(text);
  if (b.info.startsWith('sim ')) {
    const want = b.info.slice(4),
      found = r.errors?.length ? null : await sim(text);
    ok('the edit the compiler accepts compiles', !r.errors?.length, (r.errors ?? []).map(e => e.code).join(','));
    ok(
      `…and tape sim finds it: ${want}`,
      !!found &&
        !found.ok &&
        found.failures.some(f =>
          f.violations.some(v => v.includes(want.replace(/^\w+: /, '')) && f.kind === want.split(':')[0]),
        ),
      found?.ok ? 'nothing found' : found?.failures[0]?.violations[0],
    );
    continue;
  }
  seen.push(b.info);
  ok(
    `the edit shown for ${b.info} is refused with ${b.info}`,
    r.errors.some(e => e.code === b.info),
    refusal(r, 90),
  );
}
ok('there are at least twelve edits', seen.length >= 12, String(seen.length));

// the words: the reserved words are the lexer's, and every code the file names is one the compiler can give
const src = ['compiler', 'rules', 'sql']
  .flatMap(dir =>
    readdirSync(new URL(`../${dir}/`, import.meta.url), { recursive: true, encoding: 'utf8' })
      .filter(f => f.endsWith('.ts'))
      .map(f => read(`${dir}/${f}`)),
  )
  .join('\n');
const keywords = [...KEYWORDS].join(' ');
ok("the reserved words are the lexer's", doc.includes(`Reserved words: \`${keywords}\``), keywords);
const named = [
  ...new Set(
    [...doc.matchAll(/\bC(\d\d)(?:-C(\d\d))?\b/g)].flatMap(m =>
      m[2] === undefined
        ? [`C${m[1]}`]
        : Array.from({ length: Number(m[2]) - Number(m[1]) + 1 }, (_, i) => `C${Number(m[1]) + i}`),
    ),
  ),
];
const unknown = named.filter(c => !src.includes(`'${c}'`));
ok(`every code named (${named.length}) is one the compiler gives`, unknown.length === 0, unknown.join(' '));
const contextual = /only where they stand: `([^`]*)`/.exec(doc)?.[1]?.split(' ') ?? [];
ok(
  'every word with a meaning where it stands is in the parser',
  contextual.length >= 8 && contextual.every(w => src.includes(`'${w}'`)),
  contextual.filter(w => !src.includes(`'${w}'`)).join(' '),
);

// the README's sample is the function as it stands in the example, so the first code a reader sees compiles
const taste = /## A taste\n[\s\S]*?```\n([\s\S]*?)```/.exec(read('README.md'))?.[1] ?? '';
ok(
  "the README's taste is a function of examples/orders.tape, as it stands",
  taste.length > 200 && raw('examples/orders.tape').includes(taste),
);

// the README opens with a whole example, as it stands, and with what the compiler says when its one comment goes
const opening = /^# Tape\n[\s\S]*?```tape\n([\s\S]*?)```/.exec(read('README.md'))?.[1] ?? '';
ok("the README's first program is examples/hello.tape, as it stands", opening === raw('examples/hello.tape'));
const shown = /```\nhello\.tape:(\d+): (C\d+) ([^\n]*)\n {2}([^\n]*)\n```/.exec(read('README.md'));
const [said] = build(opening.replace('        repeat: True,\n', '')).errors;
ok(
  'the refusal the README shows is what the compiler says of that edit',
  shown !== null &&
    said !== undefined &&
    `${said.line}: ${said.code} ${said.message}` === `${shown[1]}: ${shown[2]} ${shown[3]} ${shown[4]}`,
  said ? `${said.line}: ${said.code} ${said.message}` : 'it compiles',
);

// and the run it shows is what `node tape.ts` prints for the second request, with long lines cut
const printed = execFileSync(process.execPath, ['tape.ts', 'examples/hello.tape', 'GET /hello/ada', 'GET /hello/ada'], {
  cwd: new URL('..', import.meta.url).pathname,
  encoding: 'utf8',
})
  .trimEnd()
  .split('\n');
const second = printed
  .slice(printed.findLastIndex(l => l.startsWith('→')))
  .map(l => (l.length <= 112 ? l : `${l.slice(0, 111)}…`))
  .join('\n');
ok(
  'the run the README shows is what the program prints',
  read('README.md').includes(`'GET /hello/ada' 'GET /hello/ada'\n…\n${second}\n\`\`\``),
);

finish();
