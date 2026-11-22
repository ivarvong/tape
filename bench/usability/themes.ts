// bench/usability/themes.ts: the friction themes the report clusters a run into. A theme is matched by diagnostic
// codes (codes are reused for different refusals, so a message pattern can narrow one), by the text of the feedback
// agents file, and by the names of acceptance checks that failed. `prior` is the evidence from before the benchmark:
// the apps' friction logs and the MCP feedback queue (ids are feedback report ids, `node mcp/scripts/feedback.ts
// --show <id>`). A code no theme takes becomes a theme of its own in the report.
export type Theme = {
  id: string;
  title: string;
  change: string;
  codes?: { code: RegExp; message?: RegExp }[];
  feedback?: RegExp;
  checks?: RegExp;
  prior: string[];
};

export const THEMES: Theme[] = [
  {
    id: 'json-decode',
    title: 'Reading JSON bodies: decode shapes, optional fields, wrong-type errors',
    change:
      'decode takes the shapes real APIs send (optional fields, lists of records, nullable), and its refusal names the field and the fix',
    codes: [{ code: /^C35$/ }, { code: /^C09$/, message: /json|JSON|decode|written as/ }],
    feedback: /decode|JSON (array|body|field)|optional field|Option\[/i,
    prior: [
      'apps/trace/FRICTION.md #1: decode refuses unknown keys, so OTLP needed a hand-written reader',
      'feedback 20261122T232050.119Z-809602d0280e: decode cannot read JSON arrays (C09); 400 of 833 lines were a parser',
      'apps/tickets/FRICTION.md 14:45: flat records only (since fixed: records in records, lists)',
    ],
  },
  {
    id: 'named-args',
    title: 'Every argument must be named (C10)',
    change:
      'allow positional arguments where unambiguous (self-calls, one obvious parameter), or C10 fix text that shows the exact rewrite',
    codes: [{ code: /^C10$/ }],
    feedback: /named argument|arguments must be named|positional/i,
    prior: ['feedback-triage.md #3 (C10 in self-calls, by design)'],
  },
  {
    id: 'retry-rules',
    title: 'Retry-safety rules on writes (C54 C55 C56 C73 C88) and their fix text',
    change:
      'each retry rule fix shows the rewrite for the statement at hand (with :name placeholders); a way to say "this create is not idempotent" when the spec says so',
    codes: [{ code: /^C5[4-8]$/ }, { code: /^C73$/ }, { code: /^C88$/ }],
    feedback: /C5[4-8]|C73|C88|repeat: True|idempoten|client key|op-id/i,
    prior: [
      'feedback 20261122T225732.543Z-67e1f8a9ede0: C54 fix text suggests ?n placeholders the compiler rejects',
      'feedback 20261122T225741.180Z-f6b580f47e79: a SQL error (C67) also raised a spurious C54',
      'apps/queue/FRICTION.md #7: no rule for a non-idempotent claim',
    ],
  },
  {
    id: 'parse-errors',
    title: 'Parse and lex errors that do not say what is wrong (P0x, L0x)',
    change:
      'parse errors name the token and the rule (a reserved word, one statement per line, a name std already has) and carry a fix',
    codes: [{ code: /^P0\d$/ }, { code: /^L0\d$/ }],
    feedback: /parse error|P0\d|reserved word|L0\d/i,
    prior: [
      'feedback 20261122T232056.998Z-9d2e11f1f1d1: a parameter named `or` gives a generic P02; P02 for two statements on a line',
      "feedback 20261122T225735.268Z-1cef52dbea41: a constructor named like std's (Malformed) gives P01 in the wrong file",
      'apps/playground/FRICTION.md #6: errors inside holes and carried text point at the wrong line',
    ],
  },
  {
    id: 'pattern-binding',
    title: 'Binding inside patterns: `field: P` binds what P binds (C15 C16)',
    change:
      'C16 says "write `value: name = Ctor(...)`" when a field given a pattern is used by name; C15 explains rebinding',
    codes: [{ code: /^C1[56]$/ }],
    feedback: /C1[56]|Some\(value|bind/i,
    prior: [
      'apps/queue/FRICTION.md #3 and apps/tickets/FRICTION.md 14:53, 15:04: the same mistake three times',
      'feedback 20261122T225741.180Z-f6b580f47e79: C16 with an empty fix',
    ],
  },
  {
    id: 'sql-checker',
    title: 'The SQL checker: names, keywords, placeholders (C11 C13 C32 C67 C68 C75)',
    change: "SQL refusals quote the clause and the table's columns, and keywords as names are allowed or named as such",
    codes: [{ code: /^C1[13]$/ }, { code: /^C32$/ }, { code: /^C6[78]$/ }, { code: /^C75$/ }],
    feedback: /\bSQL\b|C67|C68|C32|placeholder|column/i,
    prior: [
      'feedback 20261122T225741.180Z-f6b580f47e79: `AS from` gives C67',
      'apps/tickets/FRICTION.md 14:54 (a column named `left`, fixed)',
    ],
  },
  {
    id: 'match-expr',
    title: 'match is not an expression argument (C40), so every if is a function',
    change: 'allow `match` (or an `if` expression) as an argument or a let value',
    codes: [{ code: /^C40$/ }],
    feedback: /C40|match.*argument|if expression|ternary/i,
    prior: ['apps/trace/FRICTION.md #7: about 30 one-arm helpers'],
  },
  {
    id: 'types',
    title: 'Type errors: refined types, Option of refined, holes (C14 C19 C20-C23)',
    change:
      'a refined type is accepted where its base is asked, inside Option and List too; type errors show both types and where',
    codes: [{ code: /^C14$/ }, { code: /^C19$/ }, { code: /^C2[0-3]$/ }],
    feedback: /refined|C14|C19|type mismatch/i,
    prior: ['apps/queue/FRICTION.md #1: Option[Delay] is not Option[Int]'],
  },
  {
    id: 'exhaustive',
    title: 'Exhaustiveness and step shapes (C24, let … else)',
    change: 'C24 lists the cases left out and gives the arm to add',
    codes: [{ code: /^C24$/ }],
    feedback: /C24|exhaustive|not covered/i,
    prior: [],
  },
  {
    id: 'state-machines',
    title: 'Machines and compare-and-set (C59-C63, C81)',
    change: 'sql_move and machine refusals show the WHERE to write',
    codes: [{ code: /^C59$/ }, { code: /^C6[0-3]$/ }, { code: /^C81$/ }],
    feedback: /machine|sql_move|C6[0-3]|C59/i,
    prior: ['apps/queue/FRICTION.md #2, #4 (true positives that made the program better)'],
  },
  {
    id: 'calls-timers',
    title: 'Calls to other programs and timers (C39 C41 C71 C77-C79 C87)',
    change: 'a worked call-with-timer example in the guide, and fix text that writes the arms',
    codes: [{ code: /^C39$/ }, { code: /^C41$/ }, { code: /^C71$/ }, { code: /^C7[7-9]$/ }, { code: /^C87$/ }],
    feedback: /\bcall\(|woken|wake|timer|Remote|once:|C77|C87|Unreachable/i,
    prior: [],
  },
  {
    id: 'capabilities',
    title: 'Capabilities and do (C72, C83-C85)',
    change: 'C72 names the function chain that needs the capability and the parameter to add',
    codes: [{ code: /^C72$/ }, { code: /^C8[3-5]$/ }],
    feedback: /capabilit|C72|C8[3-5]/i,
    prior: [],
  },
  {
    id: 'headers',
    title: 'No response headers (Location, content type) and no request headers',
    change: 'let a program set response headers (at least Location and Content-Type) and read request headers',
    feedback: /header|Location|redirect|content.type/i,
    checks: /302|redirect/,
    prior: ['apps/tickets/FRICTION.md 14:40 and 15:04: no headers, so no redirect and no caller identity'],
  },
  {
    id: 'decimal',
    title: 'No decimal numbers: money as strings, parsed and rounded by hand',
    change: 'a Decimal type (0.3), with parsing, exact arithmetic and rounding modes in std',
    feedback: /decimal|fraction|float|money|cents|rounding/i,
    checks: /decimals?|rounds|JPY|"1\.5"|USD|EUR/,
    prior: ['LANGUAGE.md section 11: numbers other than Int are not defined yet'],
  },
  {
    id: 'overflow',
    title: 'Int overflow wraps silently',
    change: 'trap on overflow of + - * (as division by zero does)',
    feedback: /overflow|wrap/i,
    checks: /overflow/,
    prior: [
      'feedback 20261122T225729.414Z-ddc40c145d53: 21! is negative with status 200',
      'apps/trace/FRICTION.md #5: five overflow bugs found only by the random gate',
    ],
  },
  {
    id: 'query-string',
    title: 'Query strings and path parameters by hand',
    change: 'std parses query strings (a param by name, in any order) and path segments',
    feedback: /query string|query param|\?done|format=|percent.?encod/i,
    checks: /\?|order|format|done=/,
    prior: [],
  },
  {
    id: 'std-gaps',
    title: 'Missing std helpers (text, lists, numbers)',
    change:
      'std gets the helpers every task wrote by hand (min/max, character classes, split, int parsing and printing)',
    feedback: /\bstd\b|helper|is_alpha|split|to_int|parse.*int|min\/max/i,
    prior: ['apps/highlight/FRICTION.md #5, #6: two "not found" conventions; no is_alpha, min, max'],
  },
  {
    id: 'docs',
    title: 'Docs and examples that disagree with the compiler, or do not cover the task',
    change:
      'every snippet and fix string compiles in CI; the guide has a worked REST example with validation and lists',
    feedback: /documentation|the docs|README|LANGUAGE\.md|guide\.md|mcp\.md|undocumented|not documented/i,
    prior: ['feedback 20261122T225732.543Z-67e1f8a9ede0: README and examples used retired syntax'],
  },
  {
    id: 'json-output',
    title: 'Writing JSON: lists, Options and nested records',
    change: 'write_json takes any record, Option fields and lists of records',
    feedback: /write_json|write_rows|writing JSON|serializ/i,
    prior: [
      'LANGUAGE.md section 11: writing a record with an Option field is not defined',
      'apps/tickets/FRICTION.md 15:15 (since fixed: write_rows)',
    ],
  },
];
