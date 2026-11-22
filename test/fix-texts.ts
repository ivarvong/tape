// The code a diagnostic shows is code the compiler takes. Every text in rules/, compiler/ and sql/ is read with
// TypeScript's own parser (a `${…}` in a template stands as `⟨⟩`), and each snippet set in backticks inside it is
// checked: no positional SQL placeholder (`?1`, `?n`: C32 refuses them), a concrete SQL snippet parses as SQL with
// :name placeholders, and a concrete Tape snippet parses as Tape. A snippet is concrete when it has no `…`, no
// `⟨⟩` and no word that stands for code (Type, expression, pattern…); the rest are shown, counted, and only
// checked for placeholders. C54's fix once said `AND version = ?n` after the compiler stopped taking it.
import '../node25.ts';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import ts from 'typescript';
import { compile, parseProgram } from '../compiler.ts';
import { std } from '../std.ts';
import { numbered } from '../compiler/sqltext.ts';
import { tryParse } from '../sql.ts';
import { finish, same } from './harness.ts';

const root = new URL('../', import.meta.url).pathname;
const tree = (d: string): string[] =>
  readdirSync(root + d).flatMap(f => {
    const p = `${d}/${f}`;
    return statSync(root + p).isDirectory() ? tree(p) : f.endsWith('.ts') ? [p] : [];
  });
const FILES = [...tree('rules'), 'rules.ts', ...tree('compiler'), ...tree('sql')];
const HOLE = '⟨⟩';

/** Every string the code holds, with where it is. */
function texts(file: string): { at: string; text: string }[] {
  const src = ts.createSourceFile(file, readFileSync(root + file, 'utf8'), ts.ScriptTarget.Latest, true);
  const out: { at: string; text: string }[] = [];
  const visit = (n: ts.Node): void => {
    const at = `${file}:${src.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push({ at, text: n.text });
    else if (ts.isTemplateExpression(n))
      out.push({ at, text: n.head.text + n.templateSpans.map(s => HOLE + s.literal.text).join('') });
    ts.forEachChild(n, visit);
  };
  visit(src);
  return out;
}
const all = FILES.flatMap(texts);
const snippets = all.flatMap(({ at, text }) => [...text.matchAll(/`([^`]+)`/g)].map(m => ({ at, code: m[1] ?? '' })));

// a positional placeholder outside SQL text: `?`, `?1`, `?n`, `?⟨⟩`
const positional = (code: string): boolean => /(^|[\s(=,])\?(\d+|[a-z]\b|⟨⟩)/.test(code.replaceAll(/'[^']*'/g, "''"));
// and in any text, a value compared with one (`${c} = ?${i + 1}` builds a snippet inside another)
const compared = (text: string): boolean => /= \?(\d+|[a-z]\b|⟨⟩)/.test(text);
same(
  'no snippet shows a positional SQL placeholder (C32)',
  [
    ...snippets.filter(s => positional(s.code)).map(s => `${s.at} ${s.code}`),
    ...all
      .filter(t => compared(t.text) && !snippets.some(s => s.at === t.at && positional(s.code)))
      .map(t => `${t.at} ${t.text}`),
  ],
  [],
);

const SCHEMATIC = /…|⟨⟩|\b(Type|Base|expression|condition|pattern|fallback|value|Ctor|field|table|column)\b/;
const SQL_START = /^(SELECT|INSERT|UPDATE|DELETE|WHERE|AND|SET|ON CONFLICT|NOT EXISTS|ORDER BY)\b|^\w+ = :\w+$/;
/** A SQL snippet as a whole statement: fragments go where they stand in one. */
function statement(code: string): string {
  if (/^(SELECT|INSERT|UPDATE|DELETE)\b/.test(code)) return code;
  if (/^WHERE\b/.test(code)) return `SELECT 1 FROM t ${code}`;
  if (/^\w+ = :\w+$/.test(code)) return `SELECT 1 FROM t WHERE ${code}`;
  if (/^(AND|NOT EXISTS)\b/.test(code)) return `SELECT 1 FROM t WHERE 1 ${code.startsWith('AND') ? '' : 'AND '}${code}`;
  if (/^SET\b/.test(code)) return `UPDATE t ${code}`;
  if (/^ON CONFLICT\b/.test(code)) return `INSERT INTO t(k) VALUES (1) ${code}`;
  return `SELECT 1 FROM t ${code}`;
}
const sql = snippets.filter(s => SQL_START.test(s.code) && !SCHEMATIC.test(s.code));
same(
  `every concrete SQL snippet parses, with :name placeholders (${sql.length})`,
  sql.flatMap(s => {
    const { sql: q, names } = numbered(statement(s.code));
    const r = tryParse(q);
    return r.error || names === null ? [`${s.at} ${s.code}: ${r.error?.message ?? 'not named'}`] : [];
  }),
  [],
);

// Tape: a whole declaration, a step, an expression, an argument or an arm, each tried where it can stand
const WRAPS = [
  (c: string) => c,
  (c: string) => `fn f() -> Int {\n  ${c}\n  0\n}\n`,
  (c: string) => `fn f() -> Int {\n  ${c}\n}\n`,
  (c: string) => `fn f() -> Int {\n  g(${c})\n}\n`,
  (c: string) => `fn f() -> Int {\n  match x {\n    ${c}\n  }\n}\n`,
  (c: string) => `fn f() -> Int {\n  match {\n    ${c}\n    else -> 0\n  }\n}\n`,
  (c: string) => `${c} {\n  0\n}\n`,
  (c: string) => `interface I {\n  ${c}\n}\n`,
];
const parses = (text: string): boolean => {
  try {
    parseProgram([{ name: 'snippet.tape', text }]);
    return true;
  } catch {
    return false;
  }
};
// code: something with brackets, an arrow, a pipe or a colon; one word or an operator alone is a name for a form
// (a label alone, `once:`, and a query's `:id` are names)
const tape = snippets.filter(
  s => !SQL_START.test(s.code) && /[(:>|]/.test(s.code) && !/:$|^:/.test(s.code) && !SCHEMATIC.test(s.code),
);
same(
  `every concrete Tape snippet parses (${tape.length})`,
  tape.filter(s => !WRAPS.some(w => parses(w(s.code)))).map(s => `${s.at} ${s.code}`),
  [],
);
console.log(
  `  ${snippets.length} snippets: ${sql.length} SQL and ${tape.length} Tape parsed; the rest name a form or are schematic`,
);

// Every diagnostic says what to write: no call that raises one (a code, a message, then the fix) gives '' for
// the fix, in either branch of a condition. (Forty-eight did; C99s, which a program cannot cause, say so.)
const emptyFix = (n: ts.Node | undefined): boolean =>
  n !== undefined &&
  (((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.text === '') ||
    (ts.isConditionalExpression(n) && (emptyFix(n.whenTrue) || emptyFix(n.whenFalse))));
const silent = FILES.flatMap(file => {
  const src = ts.createSourceFile(file, readFileSync(root + file, 'utf8'), ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const i = n.arguments.findIndex(a => ts.isStringLiteral(a) && /^[CPLM]\d\d$/.test(a.text));
      const code = n.arguments[i];
      if (code && ts.isStringLiteral(code) && emptyFix(n.arguments[i + 2]))
        found.push(`${code.text} ${file}:${src.getLineAndCharacterOfPosition(n.getStart()).line + 1}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
  return found;
});
same('no diagnostic is raised with an empty fix', silent, []);

// and the fixes made from what is at hand
const fixOf = (text: string): string => {
  const [e] = compile([...std, { name: 't.tape', text }], { exports: ['f'] }).errors;
  return e ? `${e.code}: ${e.hint}` : 'compiled';
};
same(
  'C16 for a field a nested pattern matched without binding it shows `name: name = Pattern`',
  fixOf(`type T { T(n: Int) }

fn f() -> Int {
  match Some(value: T(n: 1)) {
    Some(value: T(n)) -> n + g(t: value)
    None -> 0
  }
}

fn g(t: T) -> Int {
  t.n
}
`),
  'C16: `Some(value: Pattern)` matches the field value without binding it. To have both, write `Some(value: value = Pattern)` (name = Pattern).',
);
same(
  'C16 otherwise says where names come from',
  fixOf('fn f() -> Int {\n  zzz + 1\n}\n'),
  'C16: A name is a parameter, a `let`, or bound by a pattern before it is used: `let zzz = …`.',
);
same('P01 says what to write', fixOf('fn f( -> Int {\n  1\n}\n').startsWith('P01: Write '), true);

finish();
