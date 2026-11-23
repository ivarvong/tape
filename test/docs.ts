// The prose docs against the compiler. The 0.3 usability benchmark found std.md and guide.md saying things the
// compiler had since made false ("Read a header (not yet possible)", "there is no `is_alpha` yet"), reported by
// agents in 5 of 8 tasks. So: every ```tape block in the docs compiles, with std and the rules on (LANGUAGE.md's are
// test/definition.ts's, std.md's common tasks also docs/gen-std.ts --check's); a doc that says a std name is
// missing ("no `x` yet", "there is no `x`") is wrong when std or the compiler has it; and each limit the docs once
// stated and a release lifted is looked for by its words and proven lifted by a program here.
import '../node25.ts';
import { compile } from '../compiler.ts';
import { INTRINSICS } from '../compiler/types.ts';
import { finish, ok, raw, std } from './harness.ts';

const PROSE = [
  'README.md',
  'LANGUAGE.md',
  'STATUS.md',
  'docs/guide.md',
  'docs/std.md',
  'docs/service.md',
  'docs/mcp.md',
  'docs/design.md',
];
const docs = PROSE.map(path => ({ path, text: raw(path) }));
// std's own comments are docs too (std.md is made from them)
const stdComments = std.map(s => ({
  path: s.name,
  text: s.text
    .split('\n')
    .filter(l => l.trimStart().startsWith('//'))
    .join('\n'),
}));

const build = (text: string) => compile([...std, { name: 'doc.tape', text }]);
const firstError = (text: string): string => {
  const [e] = build(text).errors;
  return e ? `${e.code} line ${e.line}: ${e.message.slice(0, 160)}` : '';
};

// ---- every ```tape block compiles (std.md's other blocks are signatures, not programs)
const programs = (path: string, text: string): { at: number; text: string }[] => {
  const scope =
    path === 'docs/std.md' ? text.slice(text.indexOf('## Common tasks'), text.indexOf('## Contents')) : text;
  return [...scope.matchAll(/^```tape[^\n]*\n([\s\S]*?)^```$/gm)].map(m => ({
    at: text.slice(0, text.indexOf(m[0])).split('\n').length,
    text: m[1] ?? '',
  }));
};
let blocks = 0;
for (const { path, text } of docs) {
  if (path === 'LANGUAGE.md') continue;
  for (const p of programs(path, text)) {
    blocks += 1;
    // a block that shows a function alone is compiled as part of a program
    const whole = /^fn handle\(/m.test(p.text)
      ? p.text
      : `${p.text}\nfn handle(raw: View) -> Buf {\n  respond(status: 200)\n}\n`;
    const e = firstError(whole);
    ok(`${path}:${p.at}: the tape block compiles`, e === '', e);
  }
}
ok('there are tape blocks to check (std.md common tasks, guide, README)', blocks >= 10, `${blocks}`);

// ---- "no `x` yet" names nothing std or the compiler has
const declared = new Set<string>(INTRINSICS.keys());
for (const s of std)
  for (const m of s.text.matchAll(/^(?:export )?(?:fn|type) ([A-Za-z_]\w*)/gm)) declared.add(m[1] ?? '');
ok('std declares is_alpha and header_of (the names below are looked up here)', declared.has('is_alpha'));
const MISSING = [
  /\bno `([A-Za-z_]\w*)`(?: \w+)? yet/g,
  /\bthere is no `([A-Za-z_]\w*)`/gi,
  /`([A-Za-z_]\w*)` (?:does not exist|is not (?:there|available) yet)/g,
];
for (const { path, text } of [...docs, ...stdComments])
  for (const re of MISSING)
    for (const m of text.matchAll(re)) {
      const name = m[1] ?? '';
      const line = text.slice(0, m.index).split('\n').length;
      ok(
        `${path}:${line}: says \`${name}\` is missing, and it is not declared`,
        !declared.has(name),
        `"${m[0]}", but \`${name}\` is ${INTRINSICS.has(name) ? 'a built-in' : 'in std'}`,
      );
    }

// ---- limits a release lifted: the words that stated them, and a program that does what they said it could not
type Lifted = { claim: RegExp; what: string; program: string };
const LIFTED: Lifted[] = [
  {
    claim:
      /read a header \(not yet possible\)|sees no request\s+headers|and no headers\b|cannot set (?:any other|response) headers?/i,
    what: 'request headers are read with header_of and response headers set with header (0.3)',
    program: `fn handle(raw: View) -> Buf {
  let r = request(raw)
  let Some(value: tag) = header_of(request: r, name: "if-none-match") else -> respond(status: 400)
  respond(status: 302) |> header(name: "location", value: "/items/\\(len(tag))")
}
`,
  },
  {
    claim: /no parser for negative numbers/i,
    what: 'parse_int reads a sign (0.3)',
    program: `fn handle(raw: View) -> Buf {
  let Some(value: n) = parse_int(text: "-12") else -> respond(status: 400)
  respond(status: 200) |> append(view: "\\(n)")
}
`,
  },
  {
    claim: /chain steps with `with`/,
    what: '`with` went on 20 November 2026; steps are `let … else`',
    program: `fn handle(raw: View) -> Buf {
  let Ok(value: n) = half(n: 4) else {
    Err(error) -> respond(status: 400) |> append(view: error)
  }
  respond(status: 200) |> append(view: "\\(n)")
}

fn half(n: Int) -> Result[Int, View] {
  match n % 2 {
    0 -> Ok(value: n / 2)
    _ -> Err(error: "odd")
  }
}
`,
  },
];
for (const l of LIFTED) {
  const e = firstError(l.program);
  ok(`the program that shows ${l.what} compiles`, e === '', e);
  for (const { path, text } of [...docs, ...stdComments]) {
    const m = l.claim.exec(text);
    ok(
      `${path} does not state the lifted limit (${l.what})`,
      m === null,
      m ? `line ${text.slice(0, m.index).split('\n').length}: "${m[0]}"` : '',
    );
  }
}
finish();
