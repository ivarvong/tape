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
        const text = sig
          .replace(/\s*\{\s*$/, '')
          .replace(/\s+/g, ' ')
          .replace(/\( /g, '(')
          .replace(/,? \)/g, ')');
        decls.push({ kind, name: m[2] ?? '', text, doc: block, line: start + 1 });
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
  { name: 'push', sig: 'push(buf: Buf, byte: Int) -> Buf', doc: 'Appends one byte.' },
  { name: 'append', sig: 'append(buf: Buf, view: View) -> Buf', doc: 'Appends text.' },
  { name: 'freeze', sig: 'freeze(buf: Buf) -> View', doc: 'The bytes written so far, as a View.' },
  { name: 'size', sig: 'size(buf: Buf) -> Int', doc: 'The number of bytes written so far.' },
  {
    name: 'write_json',
    sig: 'write_json(out: Buf, value: T) -> Buf',
    doc: 'Appends a record as a JSON object, its fields by name: `Int`, `Bool`, `View` (and refinements of them), records and `List[…]` of these. Refused (C09): an `Option` field (write two record types, or the JSON by hand), and a `List` on its own (put it in a field, or use `write_rows` for the rows of a query).',
  },
  {
    name: 'decode',
    sig: 'decode(json: View, as: T) -> Result[T, View]',
    doc: 'Reads a JSON object into the record type `T` (or into the first of its constructors whose keys fit). A missing key, an unknown key, a wrong kind or a refinement that fails is `Err` with the path to it (`tiers[1]: price: not a valid Money`). An `Option` field may be absent; `null` is refused.',
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
    uses: ['fn decimal', 'fn digits', 'fn decimal_text'],
    text: '`decimal(v)` is `Some(n)` for canonical digits (no sign, no leading zero, at most 16 digits); `digits(v)` takes leading zeros. Any function that returns an Option is a pattern, so `"/items/" ++ decimal(id)` routes and parses at once, and a refined type checks the range: `decimal(Id(id))`. There is no parser for negative numbers yet. `decimal_text(value)` and holes (`"\\(n)"`) go the other way.',
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
    title: 'Validate characters',
    uses: ['fn is_digit', 'fn is_hex', 'builtin len'],
    text: '`v[i]` is the byte at `i`, as an Int. `is_digit(b)` and `is_hex(b)` test one byte; there is no `is_alpha` yet, so compare with the byte values (`a` is 97, `z` 122, `A` 65, `Z` 90, `-` 45, `_` 95). A check over every byte is a function that calls itself.',
    program: `// a slug: 1 to 32 bytes of a-z, 0-9 and -
type Slug = View where len(self) >= 1 and len(self) <= 32 and slug_from(v: self, at: 0)

fn slug_from(v: View, at: Int) -> Bool {
  match {
    at >= len(v) -> True
    (v[at] >= 97 and v[at] <= 122) or is_digit(v[at]) or v[at] == 45 -> slug_from(v, at: at + 1)
    else -> False
  }
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
    title: 'Read a header (not yet possible)',
    uses: ['type Request'],
    text: 'The host passes a request as its method, target and body: `Request` has `method`, `path`, `query`, `body` and `caller`, and no headers. A program cannot set response headers either, beyond the content type (`respond_as`): no `Location`, no cookies. Send what the program needs in the path, the query or the body.',
    program: `fn handle(raw: View) -> Buf {
  let Request(method, path, query, body) = request(raw)
  respond(status: 200) |> append(view: method ++ " " ++ path ++ " " ++ body)
}
`,
  },
];

// ---- the page

function page(files: readonly File[]): string {
  const out: string[] = [];
  out.push(
    '# The standard library',
    '',
    '<!-- Generated by `node docs/gen-std.ts` from std/*.tape and compiler/types.ts. Do not edit: edit the comments in std/ and run it again. `node docs/gen-std.ts --check` (in proof/all.ts) fails when this file is stale. -->',
    '',
    'Every program is compiled with these files before its own, so everything here is in scope without an import. Arguments are named (`until(v: raw, byte: 10)`); an argument whose value is a name of the same name may be written bare (`until(v, byte)`). `a |> f(b: 1)` is `f(<first parameter>: a, b: 1)`. A program may define a function of the same name as one here; its own wins. For the language itself see [LANGUAGE.md](../LANGUAGE.md); for a whole service, [the guide](guide.md).',
    '',
    'The examples under a function (`> expression`, then what it gives) are run by `tape test` on every commit.',
    '',
    '## Common tasks',
    '',
  );
  for (const t of TASKS) {
    out.push(`### ${t.title}`, '', t.text, '', '```tape', t.program.trimEnd(), '```', '');
    out.push(`Uses: ${t.uses.map(u => `[\`${u.split(' ')[1] ?? u}\`](#${usedAnchor(u)})`).join(', ')}.`, '');
  }
  out.push('## Contents', '');
  out.push(`- [Built-ins](#built-ins): ${BUILT_INS.map(b => `[\`${b.name}\`](#builtin-${b.name})`).join(', ')}`);
  for (const f of files) {
    const pub = f.decls.filter(d => !isInternal(d));
    out.push(
      `- [${f.name}](#${f.name.replace(/[/.]/g, '')}): ${pub.map(d => `[\`${d.name}\`](#${anchor(d)})`).join(', ')}`,
    );
  }
  out.push('', '## Built-ins', '');
  out.push(
    'Provided by the compiler itself. A built-in that needs a capability (`Sql`, `Remote`, `Clock`, `Entropy`, `Timer`) uses the one the entry point declares (`fn handle(raw: View, db: Sql, clock: Clock)`), by name, without passing it.',
    '',
  );
  for (const b of BUILT_INS) {
    out.push(`### builtin ${b.name}`, '', '```tape', b.sig, '```', '');
    out.push(b.needs ? `Needs \`${b.needs}\`. ${b.doc}` : b.doc, '');
  }
  for (const f of files) {
    out.push(`## ${f.name}`, '');
    if (f.about.length > 0)
      out.push(render(f.about.map(l => l.replace(/^std\/\w+\.tape: (.)/, (_m, c: string) => c.toUpperCase()))), '');
    const internal = f.decls.filter(isInternal);
    for (const d of f.decls.filter(x => !isInternal(x))) {
      out.push(`### ${d.kind} ${d.name}`, '', '```tape', d.text, '```', '');
      const doc = render(d.doc);
      if (doc !== '') out.push(doc, '');
    }
    if (internal.length > 0) {
      out.push('Helpers (called by the functions above; callable, but not meant to be):', '');
      for (const d of internal)
        out.push(`- \`${d.kind === 'fn' ? d.text : `type ${d.name}`}\`: ${render(d.doc).replace(/^Internal:\s*/, '')}`);
      out.push('');
    }
  }
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
