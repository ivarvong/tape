// docs/gen-std.ts: docs/std.md, the reference to the standard library, made from std/*.tape (each declaration with
// the comment above it, and the examples in that comment, which `tape test` runs) and from the compiler's list of
// built-ins (compiler/types.ts, INTRINSICS), with the common tasks below at the top.
//   node docs/gen-std.ts           write docs/std.md
//   node docs/gen-std.ts --check   exit 1 when docs/std.md is not what this writes, when a function or type in std/
//                                  has no doc comment, when a built-in has no entry here (or an entry names none),
//                                  or when a common task's program does not compile
// A comment that starts `Internal:` marks a helper: it is listed in one line, after the functions meant to be called.
import { readFileSync, writeFileSync } from 'node:fs';
import { compile } from '../compiler.ts';
import { INTRINSICS } from '../compiler/types.ts';
import { std } from '../std.ts';

const OUT = new URL('./std.md', import.meta.url);

type Decl = {
  kind: 'fn' | 'type';
  name: string;
  /** the declaration as written: a function's signature on one line, a type whole */
  text: string;
  /** the comment above it, without `//` */
  doc: string[];
  line: number;
};
type File = { name: string; about: string[]; decls: Decl[] };

const uncomment = (l: string): string => l.replace(/^\s*\/\/ ?/, '');
const isComment = (l: string): boolean => /^\s*\/\//.test(l);

/** The declarations of one std file, each with the comment block right above it (no blank line between). */
function parse(name: string, text: string): File {
  const lines = text.split('\n');
  const decls: Decl[] = [];
  let about: string[] = [];
  let block: string[] = [];
  let blockStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? '';
    if (isComment(l)) {
      if (block.length === 0) blockStart = i;
      block.push(uncomment(l));
      continue;
    }
    const m = /^(?:private )?(fn|type) ([A-Za-z_][A-Za-z0-9_]*)/.exec(l);
    if (m) {
      const kind = m[1] === 'fn' ? 'fn' : 'type';
      const start = i;
      let j = i;
      if (kind === 'fn') {
        // the signature: up to the line that ends with `{` once the parentheses close
        let sig = l;
        while (!(balanced(sig) && sig.trimEnd().endsWith('{')) && j + 1 < lines.length) sig += ` ${lines[++j] ?? ''}`;
        const one = sig
          .replace(/\s*\{\s*$/, '')
          .replaceAll(/\s+/g, ' ')
          .replaceAll('( ', '(')
          .replaceAll(/,? \)/g, ')');
        decls.push({ kind, name: m[2] ?? '', text: one, doc: block, line: start + 1 });
      } else {
        let body = l;
        if (l.trimEnd().endsWith('{')) while (j + 1 < lines.length && lines[j] !== '}') body += `\n${lines[++j] ?? ''}`;
        decls.push({ kind, name: m[2] ?? '', text: body, doc: block, line: start + 1 });
      }
      i = j;
    } else if (l.trim() === '' && block.length > 0 && blockStart === 0) about = block;
    block = [];
  }
  return { name, about, decls };
}
const balanced = (s: string): boolean => (s.match(/\(/g) ?? []).length === (s.match(/\)/g) ?? []).length;

const isInternal = (d: Decl): boolean => /^Internal\b/.test(d.doc[0] ?? '');
const anchor = (d: { kind: string; name: string }): string => `${d.kind}-${d.name.toLowerCase()}`;
/** `fn decimal`, `type Request`, `builtin len`: the anchor of that entry (GitHub's, of its heading). */
const usedAnchor = (u: string): string => u.toLowerCase().replace(' ', '-');

/** A comment as Markdown: prose joined into paragraphs, indented lines and examples as code. */
function render(doc: readonly string[]): string {
  const out: string[] = [];
  let para: string[] = [];
  let code: string[] = [];
  const flushPara = (): void => {
    if (para.length > 0) out.push(para.join(' '));
    para = [];
  };
  const flushCode = (): void => {
    if (code.length > 0) out.push(['```', ...code, '```'].join('\n'));
    code = [];
  };
  for (const l of doc) {
    if (/^\s{2,}\S/.test(l)) {
      flushPara();
      code.push(l.replace(/^\s{2}/, ''));
    } else if (l.trim() === '') {
      flushPara();
      flushCode();
    } else {
      flushCode();
      para.push(l.trim());
    }
  }
  flushPara();
  flushCode();
  return out.join('\n\n');
}

// ---- built-ins: what the compiler provides itself, with no source in std/

type BuiltIn = { name: string; sig: string; needs?: string; doc: string };
const BUILT_INS: BuiltIn[] = [
  { name: 'len', sig: 'len(v: View) -> Int', doc: 'The number of bytes in a View. (A Buf: `size`.)' },
  {
    name: 'slice',
    sig: 'slice(v: View, from: Int, to: Int) -> View',
    doc: 'The bytes from `from` up to, not including, `to`; no copy. `v[i]` is one byte, as an Int.',
  },
  { name: 'buf', sig: 'buf() -> Buf', doc: 'A new, empty buffer to write into. A response starts as one: `respond`.' },
  ...(['add', 'sub', 'mul'] as const).map((op): BuiltIn => ({
    name: `wrapping_${op}`,
    sig: `wrapping_${op}(a: Int, b: Int) -> Int`,
    doc: `a ${{ add: '+', sub: '-', mul: '*' }[op]} b modulo 2^64: the low 64 bits of the exact result. Plain \`${{ add: '+', sub: '-', mul: '*' }[op]}\` traps on overflow (trap 6); use this where wrapping is meant (a hash).`,
  })),
  {
    name: 'float',
    sig: 'float(n: Int) -> Float',
    doc: 'The Float nearest `n`, a tie to the even one: exact up to 2^53. The one way from an Int to a Float; there is no implicit conversion.',
  },
  {
    name: 'trunc',
    sig: 'trunc(x: Float) -> Int',
    doc: 'The Int toward zero: the one way from a Float to an Int (`floor` or `ceil` first for the other ways). Outside the Ints (beyond ±9.2e18) it traps, integer overflow (trap 6).',
  },
  ...(
    [
      ['floor', 'The integer below or equal, as a Float (`floor(-0.5f)` is -1).'],
      ['ceil', 'The integer above or equal, as a Float.'],
      ['sqrt', 'The square root, correctly rounded; below 0 it traps (trap 8, float not finite).'],
    ] as const
  ).map(([name, doc]): BuiltIn => ({ name, sig: `${name}(x: Float) -> Float`, doc })),
  ...(
    [
      ['sin', 'x', 'The sine, x in radians.'],
      ['cos', 'x', 'The cosine, x in radians.'],
      ['exp', 'x', 'e to the x; beyond about 709.78 it traps (trap 8, float not finite).'],
      ['log', 'x', 'The natural logarithm; of 0 or less it traps (trap 8).'],
    ] as const
  ).map(([name, p, doc]): BuiltIn => ({
    name,
    sig: `${name}(${p}: Float) -> Float`,
    doc: `${doc} musl's, in Wasm: the same bits everywhere, within 1 ulp.`,
  })),
  {
    name: 'atan2',
    sig: 'atan2(y: Float, x: Float) -> Float',
    doc: "The angle of the point (x, y), from -pi to pi; `atan2(y: t, x: 1f)` is the arctangent of t. musl's, in Wasm: within 1.5 ulp.",
  },
  {
    name: 'pow',
    sig: 'pow(x: Float, y: Float) -> Float',
    doc: "x to the y. A negative x takes only an integer y, and a result beyond the largest Float traps (trap 8). musl's, in Wasm: within 1 ulp.",
  },
  {
    name: 'abs',
    sig: 'abs(x: Int) -> Int, abs(x: Float) -> Float',
    doc: 'The absolute value. Of the least Int it traps (integer overflow, trap 6).',
  },
  ...(['min', 'max'] as const).map((name): BuiltIn => ({
    name,
    sig: `${name}(a: Int, b: Int) -> Int, ${name}(a: Float, b: Float) -> Float`,
    doc: `The ${name === 'min' ? 'smaller' : 'larger'} of two Ints, or of two Floats.`,
  })),
  {
    name: 'write_float',
    sig: 'write_float(out: Buf, value: Float) -> Buf',
    doc: 'Appends the shortest digits that read back as the Float: `0.1`, `1e+21`, `5` (what a hole, `"\\(x)"`, writes).',
  },
  {
    name: 'parse_float',
    sig: 'parse_float(text: View) -> Option[Float]',
    doc: 'The Float nearest the decimal number `text` (`"0.1"`, `"-2.5e3"`), correctly rounded, the same everywhere; `None` when it is not finite (`"1e400"`) or `text` is not a number. decode reads a Float field with it.',
  },
  {
    name: 'scan_plain',
    sig: 'scan_plain(v: View, at: Int) -> Int',
    doc: 'The first position at or after `at` whose byte is below 32, 128 or more, a quote (34) or a backslash (92); `len(v)` when there is none. Reads 16 bytes at a time (Wasm SIMD); std/json.tape finds the plain runs of a string with it. `at` outside 0 to `len(v)` traps (trap 3).',
  },
  { name: 'push', sig: 'push(buf: Buf, byte: Int) -> Buf', doc: 'Appends one byte.' },
  { name: 'append', sig: 'append(buf: Buf, view: View) -> Buf', doc: 'Appends text.' },
  { name: 'freeze', sig: 'freeze(buf: Buf) -> View', doc: 'The bytes written so far, as a View.' },
  { name: 'size', sig: 'size(buf: Buf) -> Int', doc: 'The number of bytes written so far.' },
  {
    name: 'write_json',
    sig: 'write_json(out: Buf, value: T) -> Buf',
    doc: 'Appends a record as a JSON object, its fields by name: `Int`, `Float` (the shortest digits that read back as it), `Bool`, `View` (and refinements of them), records and `List[…]` of these. Refused (C09): an `Option` field (write two record types, or the JSON by hand), and a `List` on its own (put it in a field, or use `write_rows` for the rows of a query).',
  },
  {
    name: 'decode',
    sig: 'decode(json: View, as: T) -> Result[T, View]',
    doc: 'Reads a JSON object into the record type `T` (or, of a type with several constructors, into the one that has all its fields among the keys and names the most of them). A key no field names is left unread: clients send more than a service reads. A missing key, a wrong kind or a refinement that fails is `Err` with the path to it (`tiers[1]: price: not a valid Money`). An `Option` field may be absent; `null` is refused. The bytes are read in the module, once (std/json.tape); a number is read exactly from its text.',
  },
  {
    name: 'next',
    sig: 'next(rows: Rows[T]) -> Step[T]',
    doc: 'One step through the rows of `sql_all`: `Next(value, rest)` or `End`.',
  },
  {
    name: 'sql_first',
    sig: 'sql_first(row: T, query: "… WHERE id = :id", id) -> Option[T]',
    needs: 'Sql',
    doc: 'The first row the query returns, as `T` (its fields name the columns). Each `:name` in the query takes the argument of that name: `id` when a value of that name is at hand, `id: 7` otherwise.',
  },
  {
    name: 'sql_all',
    sig: 'sql_all(row: T, query: "…", …) -> Rows[T]',
    needs: 'Sql',
    doc: 'Every row, to walk with `next` or write with `write_rows`.',
  },
  {
    name: 'sql_exec',
    sig: 'sql_exec(query: "…", …) -> Int',
    needs: 'Sql',
    doc: 'Runs a write; the number of rows it changed. `repeat: True` says a write is meant to apply again each time it runs (C54); `no_floor: True` that a column it takes from has no floor (C73).',
  },
  {
    name: 'sql_move',
    sig: 'sql_move(row: T, query: "UPDATE … WHERE … RETURNING *", …) -> Move[T]',
    needs: 'Sql',
    doc: 'A compare-and-set: `Moved(value)`, `Raced(now)` when the row was not in the state the WHERE names, `NoRow`.',
  },
  {
    name: 'call',
    sig: 'call(to: Remote, method: "…", send: Msg, reply: Reply, within: Int, once: Key) -> Result[Reply, CallError]',
    needs: 'Remote',
    doc: "A command to another program's `export fn`. The same `once` key runs at most once and gets the stored reply.",
  },
  {
    name: 'ask',
    sig: 'ask(to: Remote, method: "…", send: Msg, reply: Reply, within: Int) -> Result[Reply, CallError]',
    needs: 'Remote',
    doc: 'A read from another program: `call` without a key.',
  },
  {
    name: 'remote',
    sig: 'remote(of: Remotes, index: Int) -> Remote',
    needs: 'Remotes',
    doc: 'One member of a family of Remotes: `remote(of: shards, index: fnv1a(v: key) % count)`.',
  },
  { name: 'now', sig: 'now() -> Int', needs: 'Clock', doc: 'Milliseconds since 1970, in the log so a replay sees it.' },
  { name: 'random', sig: 'random() -> Int', needs: 'Entropy', doc: '53 random bits, in the log.' },
  {
    name: 'wake',
    sig: 'wake(after: Int, key: Int) -> Int',
    needs: 'Timer',
    doc: "Asks the host to run the program's `export fn woken(…, message: Wake)` with `Wake(key)` after `after` ms. Setting a key again moves its time. Run it with `do wake(…)`.",
  },
  {
    name: 'rollback',
    sig: 'rollback(out: Buf) -> Buf',
    doc: "Answers `out` and undoes this request's writes since its last call.",
  },
];

// ---- common tasks: each a program that compiles (checked by --check), with links to what it uses

type Task = { title: string; uses: string[]; text: string; program: string };
const TASKS: Task[] = [
  {
    title: 'Respond with JSON',
    uses: ['fn respond_as', 'type Content', 'builtin write_json', 'fn write_rows', 'fn respond'],
    text: '`respond(status)` answers `text/plain`. `respond_as(status, content: Json)` answers `application/json`; then write the body with `write_json` (a record) or `write_rows` (the rows of a query). An error body is a record too.',
    program: `type Item {
  Item(id: Int, name: View)
}

type Problem {
  Problem(error: View)
}

fn handle(raw: View) -> Buf {
  match request(raw) {
    Request(method: "GET", path: "/item") -> respond_as(status: 200, content: Json)
      |> write_json(value: Item(id: 1, name: "lamp"))
    _ -> respond_as(status: 404, content: Json) |> write_json(value: Problem(error: "not_found"))
  }
}
`,
  },
  {
    title: 'Read query parameters',
    uses: ['type Request', 'fn form_field', 'fn decimal'],
    text: '`Request(query)` is the raw text after `?` (`None` when there is no `?`). A query string is encoded as a form is, so `form_field(body: query, name: "limit")` reads one parameter, decoded (`+` and `%XX`). The path never holds the query.',
    program: `fn handle(raw: View) -> Buf {
  match request(raw) {
    Request(method: "GET", path: "/items", query) -> respond(status: 200)
      |> append(view: "limit \\(limit_of(query))")
    _ -> respond(status: 404)
  }
}

// ?limit=N, 1 to 100; 20 when it is absent or not a number
fn limit_of(query: Option[View]) -> Int {
  let Some(value: q) = query else -> 20
  match form_field(body: q, name: "limit") {
    Some(value: decimal(n)) if n >= 1 and n <= 100 -> n
    _ -> 20
  }
}
`,
  },
  {
    title: 'Parse an integer, and route on one in the path',
    uses: ['fn decimal', 'fn parse_int', 'fn decimal_text'],
    text: '`decimal(v)` is `Some(n)` for canonical digits (no sign, no leading zero, at most 16 digits). Any function that returns an Option is a pattern, so `"/items/" ++ decimal(id)` routes and parses at once, and a refined type checks the range: `decimal(Id(id))`. `parse_int(text)` takes a number as people write one (a sign, leading zeros). `decimal_text(value)` and holes (`"\\(n)"`) go the other way.',
    program: `type Id = Int where self >= 1 and self <= 9007199254740991

fn handle(raw: View) -> Buf {
  match request(raw) {
    Request(method: "GET", path: "/items/" ++ decimal(Id(id))) -> respond(status: 200)
      |> append(view: "item \\(id)")
    Request(method: "GET", path: "/items/" ++ _) -> respond(status: 400) |> append(view: "bad id")
    _ -> respond(status: 404)
  }
}
`,
  },
  {
    title: 'Decode a JSON body, with a 400 that says why',
    uses: ['builtin decode', 'type Result'],
    text: '`decode(json: body, as: T)` is `Ok(value)` or `Err(error)`, where `error` names the field and what is wrong. Refined types validate while decoding; an `Option` field may be absent. Go on with `let Ok(…) = … else { … }`.',
    program: `type Name = View where len(self) >= 1 and len(self) <= 80
type Qty = Int where self >= 1 and self <= 1000

type NewItem {
  NewItem(name: Name, qty: Qty, note: Option[View])
}

type Problem {
  Problem(error: View)
}

fn handle(raw: View) -> Buf {
  match request(raw) {
    Request(method: "POST", path: "/items", body) -> created(body)
    _ -> respond(status: 404)
  }
}

fn created(body: View) -> Buf {
  let Ok(value: NewItem(name, qty)) = decode(json: body, as: NewItem) else {
    Err(error) -> respond_as(status: 400, content: Json) |> write_json(value: Problem(error))
  }
  respond(status: 201) |> append(view: "\\(qty) of \\(name)")
}
`,
  },
  {
    title: 'Build a JSON list',
    uses: ['fn write_rows', 'builtin write_json', 'type List', 'fn write_json_string'],
    text: '`write_rows(rows: sql_all(…))` writes the rows of a query as an array. A `List[T]` field of a record is written as an array by `write_json`. A list on its own is not a value `write_json` takes (C09): wrap it in a record, as here, or write `[`, `,` and `]` yourself.',
    program: `type Item {
  Item(name: View, qty: Int)
}

type Items {
  Items(items: List[Item], count: Int)
}

fn handle(raw: View) -> Buf {
  let items = stock()
  respond_as(status: 200, content: Json) |> write_json(value: Items(items, count: length(list: items)))
}

// A list is built with Cons and Nil, in a function that says its type (a \`let\` cannot tell which List a Nil is: C21).
fn stock() -> List[Item] {
  Cons(head: Item(name: "lamp", qty: 2), tail: Cons(head: Item(name: "desk", qty: 1), tail: Nil))
}
`,
  },
  {
    title: 'Money and other fractions, in fixed point',
    uses: ['fn isqrt', 'fn decimal_text', 'fn parse_int'],
    text: 'There are no floats yet (`Dec` and `Float` are planned): keep amounts as whole numbers of the smallest unit (cents, thousandths) and scale before you divide or take a root, so `isqrt(n: 2 * 1000 * 1000)` is the root of 2 in thousandths, 1414. Arithmetic that does not fit an Int traps (trap 6) instead of wrapping.',
    program: `// the length of the diagonal of a w by h rectangle, in thousandths of the unit
fn diagonal(w: Int, h: Int) -> Int {
  let Some(value: root) = isqrt(n: (w * w + h * h) * 1000 * 1000) else -> 0
  root
}

fn handle(raw: View) -> Buf {
  let d = diagonal(w: 3, h: 4)
  respond(status: 200) |> append(view: "\\(d) thousandths")
}
`,
  },
  {
    title: 'Validate characters',
    uses: ['fn every_byte', 'fn is_lower', 'fn is_digit', 'fn is_alpha', 'fn is_alnum', 'builtin len'],
    text: '`v[i]` is the byte at `i`, as an Int. `is_digit`, `is_lower`, `is_upper`, `is_alpha`, `is_alnum`, `is_space` and `is_hex` test one byte; `every_byte(v, keep)` is True when `keep` holds for every byte of `v`, and `keep` may be a function of your own.',
    program: `// a slug: 1 to 32 bytes of a-z, 0-9 and -
type Slug = View where len(self) >= 1 and len(self) <= 32 and every_byte(v: self, keep: slug_byte)

fn slug_byte(b: Int) -> Bool {
  is_lower(b) or is_digit(b) or b == 45
}

fn handle(raw: View) -> Buf {
  match request(raw) {
    Request(method: "GET", path: "/s/" ++ Slug(s)) -> respond(status: 200) |> append(view: s)
    _ -> respond(status: 400)
  }
}
`,
  },
  {
    title: 'Read a request header, set a response header',
    uses: ['fn header_of', 'fn header', 'type Request'],
    text: '`header_of(request: r, name: "if-none-match")` is the header\'s value, `None` when it was not sent (the service passes accept, content-type, if-match, if-none-match, idempotency-key and x-…, never cookie or authorization). `header(name:, value:)` adds one to an answer, before or after the body; the content type is `respond_as`\'s.',
    program: `fn handle(raw: View) -> Buf {
  let r = request(raw)
  match r {
    Request(method: "GET", path: "/old") -> respond(status: 301) |> header(name: "location", value: "/new")
    Request(method: "GET", path: "/new") -> match header_of(request: r, name: "if-none-match") {
      Some(value: "v1") -> respond(status: 304)
      _ -> respond(status: 200) |> header(name: "etag", value: "v1") |> append(view: "new")
    }
    _ -> respond(status: 404)
  }
}
`,
  },
];

// ---- the page

const HEAD = [
  '# The standard library',
  '',
  '<!-- Generated by `node docs/gen-std.ts` from std/*.tape and compiler/types.ts. Do not edit: edit the comments in std/ and run it again. `node docs/gen-std.ts --check` (in proof/all.ts) fails when this file is stale. -->',
  '',
  'Every program is compiled with these files before its own, so everything here is in scope without an import. Arguments are named (`until(v: raw, byte: 10)`); an argument whose value is a name of the same name may be written bare (`until(v, byte)`). `a |> f(b: 1)` is `f(<first parameter>: a, b: 1)`. A program may define a function of the same name as one here; its own wins. For the language itself see [LANGUAGE.md](../LANGUAGE.md); for a whole service, [the guide](guide.md).',
  '',
  'The examples under a function (`> expression`, then what it gives) are run by `tape test` on every commit.',
  '',
];
const BUILT_INS_ABOUT =
  'Provided by the compiler itself. A built-in that needs a capability (`Sql`, `Remote`, `Clock`, `Entropy`, `Timer`) uses the one the entry point declares (`fn handle(raw: View, db: Sql, clock: Clock)`), by name, without passing it.';

const taskLines = (t: Task): string[] => [
  `### ${t.title}`,
  '',
  t.text,
  '',
  '```tape',
  t.program.trimEnd(),
  '```',
  '',
  `Uses: ${t.uses.map(u => `[\`${u.split(' ')[1] ?? u}\`](#${usedAnchor(u)})`).join(', ')}.`,
  '',
];
const builtInLines = (b: BuiltIn): string[] => [
  `### builtin ${b.name}`,
  '',
  '```tape',
  b.sig,
  '```',
  '',
  b.needs ? `Needs \`${b.needs}\`. ${b.doc}` : b.doc,
  '',
];
const declLines = (d: Decl): string[] => {
  const doc = render(d.doc);
  return [`### ${d.kind} ${d.name}`, '', '```tape', d.text, '```', '', ...(doc === '' ? [] : [doc, ''])];
};
const helperLine = (d: Decl): string =>
  `- \`${d.kind === 'fn' ? d.text : `type ${d.name}`}\`: ${render(d.doc).replace(/^Internal:\s*/, '')}`;
function fileLines(f: File): string[] {
  const internal = f.decls.filter(isInternal);
  const about = f.about.map(l => l.replace(/^std\/\w+\.tape: (.)/, (_m, c: string) => c.toUpperCase()));
  return [
    `## ${f.name}`,
    '',
    ...(about.length > 0 ? [render(about), ''] : []),
    ...f.decls.filter(d => !isInternal(d)).flatMap(declLines),
    ...(internal.length > 0
      ? ['Helpers (called by the functions above; callable, but not meant to be):', '', ...internal.map(helperLine), '']
      : []),
  ];
}
const contentsLine = (f: File): string =>
  `- [${f.name}](#${f.name.replaceAll(/[/.]/g, '')}): ${f.decls
    .filter(d => !isInternal(d))
    .map(d => `[\`${d.name}\`](#${anchor(d)})`)
    .join(', ')}`;

function page(files: readonly File[]): string {
  const out = [
    ...HEAD,
    '## Common tasks',
    '',
    ...TASKS.flatMap(taskLines),
    '## Contents',
    '',
    `- [Built-ins](#built-ins): ${BUILT_INS.map(b => `[\`${b.name}\`](#builtin-${b.name})`).join(', ')}`,
    ...files.map(contentsLine),
    '',
    '## Built-ins',
    '',
    BUILT_INS_ABOUT,
    '',
    ...BUILT_INS.flatMap(builtInLines),
    ...files.flatMap(fileLines),
  ];
  return `${out.join('\n').trimEnd()}\n`;
}

// ---- the check

function problems(files: readonly File[], written: string | null, fresh: string): string[] {
  const out: string[] = [];
  for (const f of files)
    for (const d of f.decls)
      if (d.doc.length === 0) out.push(`${f.name}:${d.line}: ${d.kind} ${d.name} has no doc comment`);
  const listed = new Set(BUILT_INS.map(b => b.name));
  for (const n of INTRINSICS.keys()) if (!listed.has(n)) out.push(`built-in ${n} has no entry in docs/gen-std.ts`);
  for (const n of listed) if (!INTRINSICS.has(n)) out.push(`docs/gen-std.ts lists ${n}, which is not a built-in`);
  const anchors = new Set([
    ...BUILT_INS.map(b => `builtin-${b.name}`),
    ...files.flatMap(f => f.decls.filter(d => !isInternal(d)).map(anchor)),
  ]);
  for (const t of TASKS) {
    const r = compile([...std, { name: 'task.tape', text: t.program }]);
    const [e] = r.errors;
    if (e) out.push(`common task "${t.title}" does not compile: ${e.code} line ${e.line}: ${e.message}`);
    for (const u of t.uses)
      if (!anchors.has(usedAnchor(u))) out.push(`common task "${t.title}" links to ${u}, which is not here`);
  }
  if (written !== fresh) out.push('docs/std.md is stale: run node docs/gen-std.ts');
  return out;
}

const files = std.map(s => parse(s.name, s.text));
const fresh = page(files);
if (process.argv.includes('--check')) {
  let written: string | null = null;
  try {
    written = readFileSync(OUT, 'utf8');
  } catch {
    written = null;
  }
  const found = problems(files, written, fresh);
  for (const p of found) console.log(`FAIL ${p}`);
  const fns = files.flatMap(f => f.decls).length;
  console.log(
    found.length === 0
      ? `docs/std.md is current: ${fns} declarations, ${BUILT_INS.length} built-ins, ${TASKS.length} common tasks`
      : `${found.length} problems`,
  );
  process.exit(found.length === 0 ? 0 : 1);
} else {
  writeFileSync(OUT, fresh);
  console.log(`wrote docs/std.md (${fresh.length} bytes)`);
}
