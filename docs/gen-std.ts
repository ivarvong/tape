// docs/gen-std.ts: docs/std.md, the reference to the standard library, made from std/*.tape (each declaration with
// the comment above it, and the examples in that comment, which `tape test` runs) and from the compiler's list of
// built-ins (compiler/types.ts, INTRINSICS), with the common tasks below at the top.
//   node docs/gen-std.ts           write docs/std.md
//   node docs/gen-std.ts --check   exit 1 when docs/std.md is not what this writes, when a function or type in std/
//                                  has no doc comment, when a built-in has no entry here (or an entry names none),
//                                  or when a common task's program does not compile
// A helper is not listed: a `private fn` (C94: a program cannot call it), or a type whose comment starts
// `Internal:` (one the helpers pass among themselves). They were 165 lines, 21 KB of the 70 KB an agent read; the
// source is their reference.
import { readFileSync, writeFileSync } from 'node:fs';
// what every sql_ call takes after its query, on a write (INSERT, UPDATE, DELETE, with RETURNING for sql_first and sql_all)
const WRITES =
  'On a write it also takes `repeat: True`, for a write meant to apply again on each run: a count in SQL (`n = n + 1`) or an INSERT with no unique key (C54, C55; C88 refuses it where the write is safe without it); and `no_floor: True`, for a column it takes from that has no floor (C73).';
import { compile } from '../compiler.ts';
import { INTRINSICS, PRIVATE_INTRINSICS } from '../compiler/types.ts';
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
  /** written `private fn` */
  private: boolean;
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
        decls.push({
          kind,
          name: m[2] ?? '',
          text: one,
          doc: block,
          line: start + 1,
          private: l.startsWith('private '),
        });
      } else {
        let body = l;
        if (l.trimEnd().endsWith('{')) while (j + 1 < lines.length && lines[j] !== '}') body += `\n${lines[++j] ?? ''}`;
        decls.push({ kind, name: m[2] ?? '', text: body, doc: block, line: start + 1, private: false });
      }
      i = j;
    } else if (l.trim() === '' && block.length > 0 && blockStart === 0) about = block;
    block = [];
  }
  return { name, about, decls };
}
const balanced = (s: string): boolean => (s.match(/\(/g) ?? []).length === (s.match(/\)/g) ?? []).length;

const isInternal = (d: Decl): boolean => (d.kind === 'fn' ? d.private : /^Internal\b/.test(d.doc[0] ?? ''));
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
  {
    name: 'buf',
    sig: 'buf() -> Buf',
    doc: 'A new, empty buffer to write into: the body of an answer is written into one, then given its status with `respond`.',
  },
  ...(['add', 'sub', 'mul'] as const).map((op): BuiltIn => ({
    name: `wrapping_${op}`,
    sig: `wrapping_${op}(a: Int, b: Int) -> Int`,
    doc: `a ${{ add: '+', sub: '-', mul: '*' }[op]} b modulo 2^64: the low 64 bits of the exact result. Plain \`${{ add: '+', sub: '-', mul: '*' }[op]}\` traps on overflow (trap 6); use this where wrapping is meant (a hash).`,
  })),
  {
    name: 'float',
    sig: 'float(n: Int) -> Float, float(n: Dec[s]) -> Float',
    doc: 'The Float nearest `n`, a tie to the even one: exact up to 2^53 for an Int. The one way from an Int or a Dec to a Float; there is no implicit conversion.',
  },
  {
    name: 'dec',
    sig: 'dec(n: Int, scale: s) -> Dec[s]',
    doc: 'The Int as a Dec[s], exactly: `dec(n: 3, scale: 2)` is 3.00. Beyond the Decs it traps (integer overflow, trap 6). The scale is a number written in the call.',
  },
  {
    name: 'rescale',
    sig: 'rescale(x: Dec[s], to: t) -> Dec[t]',
    doc: 'The same number with more digits after the point, exactly (t ≥ s): `rescale(x: 1.5, to: 3)` is 1.500. Fewer digits is `round`. Traps (trap 6) when it does not fit.',
  },
  {
    name: 'round',
    sig: 'round(x: Dec[s], to: t, rounding: Rounding) -> Dec[t]',
    doc: 'The nearest Dec with fewer digits (t < s), as the rounding says: `round(x: 2.345, to: 2, rounding: HalfEven)` is 2.34.',
  },
  {
    name: 'to_int',
    sig: 'to_int(x: Dec[s], rounding: Rounding) -> Int',
    doc: 'The Int a Dec rounds to: `to_int(x: -2.5, rounding: HalfEven)` is -2, with `Floor` -3.',
  },
  {
    name: 'mul',
    sig: 'mul(a: Dec[s], by: Dec[u], scale: t, rounding: Rounding) -> Dec[t]',
    doc: 'The exact product, rounded once to t digits: `a * b` is a Dec[s + u], and this is for when that has more digits than you keep, or more than 18. The product is 128 bits, so it traps (trap 6) only when the result does not fit. `by` may be an Int.',
  },
  {
    name: 'div',
    sig: 'div(a: Dec[s], by: Dec[u], scale: t, rounding: Rounding) -> Dec[t]',
    doc: 'The quotient at t digits, rounded once: `div(a: 1.00, by: 3.00, scale: 2, rounding: HalfEven)` is 0.33. Exact in between (128 bits), so `a * b / c` loses nothing before the one rounding. By zero it traps (trap 4). `by` may be an Int. A Dec has no `/`.',
  },
  {
    name: 'parse_dec',
    sig: 'parse_dec(text: View, scale: s) -> Option[Dec[s]]',
    doc: "The Dec[s] the text is, exactly: JSON's number syntax (`12.30`, `-0.5`, `1.23e1`), with no more digits after the point than s unless they are zeros (`12.300` is 12.30, `12.345` is None for a Dec[2]). No sign `+`, no spaces, no leading zeros.",
  },
  {
    name: 'write_dec',
    sig: 'write_dec(out: Buf, value: Dec[s]) -> Buf',
    doc: 'Appends a Dec with exactly its scale\'s digits after the point: `12.30`, `-0.05`, `0.00` (what a hole, `"\\(x)"`, writes).',
  },
  {
    name: 'to_dec',
    sig: 'to_dec(x: Float, scale: t, rounding: Rounding) -> Dec[t]',
    doc: "The Float's exact value (a binary fraction) rounded to t digits: `to_dec(x: 2.675f, scale: 2, rounding: HalfUp)` is 2.67, as 2.675f is a little below 2.675.",
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
      ['tan', 'x', 'The tangent, x in radians; never infinite (no Float is that near an odd multiple of pi/2).'],
      ['asin', 'x', 'The arcsine, from -pi/2 to pi/2; outside -1 to 1 it traps (trap 8, float not finite).'],
      ['acos', 'x', 'The arccosine, from 0 to pi; outside -1 to 1 it traps (trap 8). `acos(x: -1f)` is `pi()`.'],
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
    sig: 'abs(x: Int) -> Int, abs(x: Dec[s]) -> Dec[s], abs(x: Float) -> Float',
    doc: 'The absolute value. Of the least Int (or Dec) it traps (integer overflow, trap 6).',
  },
  ...(['min', 'max'] as const).map((name): BuiltIn => ({
    name,
    sig: `${name}(a: Int, b: Int) -> Int, ${name}(a: Dec[s], b: Dec[s]) -> Dec[s], ${name}(a: Float, b: Float) -> Float`,
    doc: `The ${name === 'min' ? 'smaller' : 'larger'} of two Ints, two Decs of one scale, or two Floats.`,
  })),
  {
    name: 'write_float',
    sig: 'write_float(out: Buf, value: Float) -> Buf',
    doc: 'Appends the shortest digits that read back as the Float: `0.1`, `1e+21`, `5` (what a hole, `"\\(x)"`, writes).',
  },
  {
    name: 'parse_float',
    sig: 'parse_float(text: View) -> Option[Float]',
    doc: 'The Float nearest the number `text` (`"0.1"`, `"-2.5e3"`), correctly rounded, the same everywhere; `None` when it is not finite (`"1e400"`) or `text` is not a number in the syntax of JSON, as `parse_dec` reads one (not `""`, white space, `+1`, `.5`, `5.`, `05`, `0x1F` or `Infinity`). decode reads a Float field with it.',
  },
  {
    name: 'scan_plain',
    sig: 'scan_plain(v: View, at: Int) -> Int',
    doc: 'The first position at or after `at` whose byte is below 32, 128 or more, a quote (34) or a backslash (92); `len(v)` when there is none. `scan(v:, at:, set:)` of those bytes, which a text literal cannot spell. Reads 16 bytes at a time (Wasm SIMD). One step per 16 bytes read, rounded up, as `scan(v:, at:, set:)` does. std/json.tape finds the plain runs of a string with it. `at` outside 0 to `len(v)` traps (trap 3).',
  },
  {
    name: 'scan',
    sig: 'scan(v: View, at: Int, set: View) -> Int',
    doc: 'The first position at or after `at` whose byte is one of `set`; `len(v)` when none is. `set` is a text literal: its bytes, escapes included (`\\n` is byte 10), and a character\'s UTF-8 bytes are each members (`"é"` is bytes 195 and 169). The same byte twice is one member. Reads 16 bytes at a time (Wasm SIMD when the set has at most 16 bytes, or the JSON set of `scan_plain(v:, at:)`). One step per 16 bytes read, rounded up: every byte from `at` through the one it stops on, or from `at` to the end when it does not stop; `at` equal to `len(v)` reads nothing and costs nothing. `at` outside 0 to `len(v)` traps (trap 3).',
  },
  { name: 'push', sig: 'push(buf: Buf, byte: Int) -> Buf', doc: 'Appends one byte.' },
  { name: 'append', sig: 'append(buf: Buf, view: View) -> Buf', doc: 'Appends text.' },
  { name: 'freeze', sig: 'freeze(buf: Buf) -> View', doc: 'The bytes written so far, as a View.' },
  { name: 'size', sig: 'size(buf: Buf) -> Int', doc: 'The number of bytes written so far.' },
  {
    name: 'write_json',
    sig: 'write_json(out: Buf, value: T) -> Buf',
    doc: 'Appends a value as JSON, exactly the form `decode` reads back: a record as an object, its fields by name (`Int`, `Float` (the shortest digits that read back as it), `Bool`, `View` and refinements of them, records, `List[…]` of these, `Option[…]` of one); an `Option` field that is `None` has no key, and `Some(value)` is its value; a type with several constructors as `{"Constructor": {…}}` (`{"AlwaysUp": {}}` for one without fields); a `List` as an array; `Int`, `Bool`, `View` as themselves. Refused (C09): what cannot be JSON (a `Buf`, a function, `Option` inside a `List`).',
  },
  {
    name: 'decode',
    sig: 'decode(json: View, as: T) -> Result[T, View]',
    doc: 'Reads a JSON object into the record type `T`, or an array into `List[T]` (`as: List[Item]`). Of a type with several constructors it takes the one the object\'s only key names, `{"Sets": {…}}`, as `write_json` writes it; else the one that has all its fields among the keys and names the most of them. A key no field names is left unread: clients send more than a service reads. A missing key, a null, a wrong kind or a refinement that fails is `Err` with the path to it: `items[2].price: missing`, `key: null`, `qty: expected an integer`, `key: expected Key, 1 to 64 bytes`, `slug: not a valid Slug` (LANGUAGE.md section 6). An `Option` field that is absent or `null` is `None`. The bytes are read in the module, once (std/json.tape); a number is read exactly from its text.',
  },
  {
    name: 'next',
    sig: 'next(rows: Rows[T]) -> Step[T]',
    doc: 'One step through the rows of `sql_all`: `Next(value, rest)` or `End`. To go through all of them, `fold_rows`.',
  },
  {
    name: 'sql_first',
    sig: 'sql_first(row: T, query: "… WHERE id = :id", id) -> Option[T]',
    needs: 'Sql',
    doc: `The first row the query returns, as \`T\` (its fields name the columns). Each \`:name\` in the query takes the argument of that name: \`id\` when a value of that name is at hand, \`id: 7\` otherwise. ${WRITES}`,
  },
  {
    name: 'sql_all',
    sig: 'sql_all(row: T, query: "…", …) -> Rows[T]',
    needs: 'Sql',
    doc: `Every row, to fold with \`fold_rows\`, write as JSON with \`write_rows\`, or take one at a time with \`next\`. ${WRITES}`,
  },
  {
    name: 'sql_exec',
    sig: 'sql_exec(query: "…", …) -> Int',
    needs: 'Sql',
    doc: `Runs a write; the number of rows it changed, which is read: \`let 1 = sql_exec(…) else -> …\` when the row must be there or the guard must hold, \`let _ = sql_exec(…)\` when the count does not matter. ${WRITES}`,
  },
  {
    name: 'sql_move',
    sig: 'sql_move(row: T, query: "UPDATE … WHERE … RETURNING *", …) -> Move[T]',
    needs: 'Sql',
    doc: `A compare-and-set: \`Moved(value)\`, \`Raced(now)\` when the row was not in the state the WHERE names, \`NoRow\`. ${WRITES}`,
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
    sig: 'wake(after: Int, key: Int) -> Done',
    needs: 'Timer',
    doc: "Asks the host to run the program's `export fn woken(…, message: Wake)` with `Wake(key)` after `after` ms. Setting a key again moves its time. Run it with `do wake(…)`.",
  },
  {
    name: 'rollback',
    sig: 'rollback(out: Response) -> Response',
    doc: "Answers `out` and undoes this request's writes since its last call.",
  },
];

// ---- common tasks: each a program that compiles (checked by --check), with links to what it uses

type Task = { title: string; uses: string[]; text: string; program: string };
const TASKS: Task[] = [
  {
    title: 'Respond with JSON',
    uses: ['fn json', 'fn respond_as', 'type Content', 'builtin write_json', 'fn write_rows', 'fn empty'],
    text: '`json(status: …, value: …)` answers a value as `application/json`. For a body written in steps, write it first and give it its type last: `buf() |> write_rows(rows: …) |> respond_as(status: 200, content: Json)`. `empty(status: …)` answers no body. An error body is a record too.',
    program: `type Item {
  Item(id: Int, name: View)
}

type Problem {
  Problem(error: View)
}

fn handle(raw: View) -> Response {
  match request(raw) {
    Request(method: Get, path: "/item") -> json(status: 200, value: Item(id: 1, name: "lamp"))
    _ -> json(status: 404, value: Problem(error: "not_found"))
  }
}
`,
  },
  {
    title: 'Respond with an Atom feed',
    uses: ['fn respond_as', 'type Content', 'fn respond'],
    text: "`buf() |> respond_as(status: 200, content: Atom)` answers `application/atom+xml` (the host adds `charset=utf-8`, which overrides an encoding declaration in the document). `Rss` is `application/rss+xml` and `Xml` is `application/xml`. Chrome renders these as pages; the service's content-security-policy is what stops a script in the document, and a host that serves them must send that policy.",
    program: `fn handle(raw: View) -> Response {
  match request(raw) {
    Request(method: Get, path: "/feed.xml") -> buf() |> append(view: "<feed xmlns='http://www.w3.org/2005/Atom'></feed>") |> respond_as(status: 200, content: Atom)
    _ -> empty(status: 404)
  }
}
`,
  },
  {
    title: 'Read query parameters',
    uses: ['type Request', 'fn form_field', 'fn decimal'],
    text: '`Request(query)` is the raw text after `?` (`None` when there is no `?`). A query string is encoded as a form is, so `form_field(body: query, name: "limit")` reads one parameter, decoded (`+` and `%XX`). The path never holds the query.',
    program: `fn handle(raw: View) -> Response {
  match request(raw) {
    Request(method: Get, path: "/items", query) -> buf() |> append(view: "limit \\(limit_of(query))") |> respond(status: 200)
    _ -> empty(status: 404)
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

fn handle(raw: View) -> Response {
  match request(raw) {
    Request(method: Get, path: "/items/" ++ decimal(Id(id))) -> buf() |> append(view: "item \\(id)") |> respond(status: 200)
    Request(method: Get, path: "/items/" ++ _) -> buf() |> append(view: "bad id") |> respond(status: 400)
    _ -> empty(status: 404)
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

fn handle(raw: View) -> Response {
  match request(raw) {
    Request(method: Post, path: "/items", body) -> created(body)
    _ -> empty(status: 404)
  }
}

fn created(body: View) -> Response {
  let Ok(value: NewItem(name, qty)) = decode(json: body, as: NewItem) else {
    Err(error) -> json(status: 400, value: Problem(error))
  }
  buf() |> append(view: "\\(qty) of \\(name)") |> respond(status: 201)
}
`,
  },
  {
    title: 'Build a JSON list',
    uses: ['fn write_rows', 'builtin write_json', 'type List', 'fn map'],
    text: '`write_json` writes a `List` as an array, on its own or as a field, and `decode(json:, as: List[Item])` reads one back. For items computed from others, `map` them into a record type and write that. `write_rows(rows: sql_all(…))` writes the rows of a query as an array.',
    program: `type Item {
  Item(name: View, qty: Int)
}

type Line {
  Line(name: View, double: Int)
}

fn handle(raw: View) -> Response {
  match request(raw) {
    Request(method: Post, body) -> counted(items: decode(json: body, as: List[Item]))
    _ -> json(status: 200, value: map(list: stock(), by: fn(i: Item) -> Line { Line(name: i.name, double: 2 * i.qty) }))
  }
}

fn counted(items: Result[List[Item], View]) -> Response {
  match items {
    Ok(value) -> buf() |> append(view: "\\(length(list: value)) items") |> respond(status: 200)
    Err(error) -> buf() |> append(view: error) |> respond(status: 400)
  }
}

// A list is built with Cons and Nil, in a function that says its type (a \`let\` cannot tell which List a Nil is: C21).
fn stock() -> List[Item] {
  Cons(head: Item(name: "lamp", qty: 2), tail: Cons(head: Item(name: "desk", qty: 1), tail: Nil))
}
`,
  },
  {
    title: 'Money, exactly',
    uses: ['builtin parse_dec', 'builtin mul', 'builtin div', 'type Rounding'],
    text: 'Money is a `Dec[2]`: `12.30` is one, `price * qty` is exact, and a hole or `write_json` writes it with its two digits (JSON as text, `"12.30"`; decode takes a number or text, exactly). What loses a digit names its rounding, once: `mul` for a rate, `div` for a share. In the database a Dec is its count, an INTEGER (12.30 is 1230). A measurement is a Float instead (`1.5f`).',
    program: `// three at the price in the query, with tax at 8.875% rounded once to the cent, half away from zero
fn handle(raw: View) -> Response {
  let Some(value: price) = parse_dec(text: query_of(raw), scale: 2) else -> empty(status: 400)
  let net = price * 3
  let tax = mul(a: net, by: 0.08875, scale: 2, rounding: HalfUp)
  let each = div(a: net + tax, by: 3, scale: 2, rounding: Down)
  buf() |> append(view: "\\(net) + \\(tax) = \\(net + tax), \\(each) each") |> respond(status: 200)
}

fn query_of(raw: View) -> View {
  match request(raw) {
    Request(query: Some(value: q)) -> q
    _ -> ""
  }
}
`,
  },
  {
    title: 'Validate characters',
    uses: ['fn every_byte', 'fn is_lower', 'fn is_digit', 'fn is_alpha', 'fn is_alnum', 'builtin len'],
    text: '`v[i]` is the byte at `i`, as an Int. `is_digit`, `is_lower`, `is_upper`, `is_alpha`, `is_alnum`, `is_space` and `is_hex` test one byte; `every_byte(v: …, keep: …)` is True when `keep` holds for every byte of `v`, and `keep` may be a function of your own.',
    program: `// a slug: 1 to 32 bytes of a-z, 0-9 and -; decode's 400 for one that is not says the text after else
type Slug = View where len(self) >= 1 and len(self) <= 32 and every_byte(v: self, keep: slug_byte) else "1 to 32 of a-z, 0-9 and -"

fn slug_byte(b: Int) -> Bool {
  is_lower(b) or is_digit(b) or b == 45
}

fn handle(raw: View) -> Response {
  match request(raw) {
    Request(method: Get, path: "/s/" ++ Slug(s)) -> buf() |> append(view: s) |> respond(status: 200)
    _ -> empty(status: 400)
  }
}
`,
  },
  {
    title: 'Advance to the next byte in a set',
    uses: ['builtin scan', 'builtin slice', 'fn respond'],
    text: "`scan(v:, at:, set:)` is the first position at or after `at` whose byte is one of `set`, a text literal, or `len(v)` when none is. It reads 16 bytes at a time and costs one step per 16 bytes read, rounded up. A CSV separator, the bytes HTML escapes and the bytes a line of Markdown stops on are sets of this form. `scan_plain(v:, at:)` is that scan for the bytes that end a JSON string's plain run.",
    program: `fn handle(raw: View) -> Response {
  let at = scan(raw, at: 0, set: "*&<>")
  buf() |> append(view: slice(raw, from: 0, to: at)) |> respond(status: 200)
}
`,
  },
  {
    title: 'Read a request header, set a response header',
    uses: ['fn header_of', 'fn header', 'type Request'],
    text: "`header_of(request: r, name: \"if-none-match\")` is the header's value, `None` when it was not sent (the service passes accept, accept-language, content-type, if-match, if-none-match, if-modified-since, idempotency-key, user-agent, webhook-id, webhook-timestamp, webhook-signature and x-… (but not x-forwarded-… or x-real-ip), never cookie or authorization; and its own `tape-base`, the URL the program's `/` is at, without the last slash, for links and redirects to its other pages). `header(name:, value:)` adds one to an answer, before or after the body; the content type is `respond_as`'s.",
    program: `fn handle(raw: View) -> Response {
  let r = request(raw)
  match r {
    Request(method: Get, path: "/old") -> empty(status: 301) |> header(name: "location", value: "/new")
    Request(method: Get, path: "/new") -> match header_of(request: r, name: "if-none-match") {
      Some(value: "v1") -> empty(status: 304)
      _ -> buf() |> append(view: "new") |> respond(status: 200) |> header(name: "etag", value: "v1")
    }
    _ -> empty(status: 404)
  }
}
`,
  },
  {
    title: 'Check a signature',
    uses: ['fn hmac_sha256_verify', 'fn hmac_sha256', 'fn from_base64', 'fn sha256', 'fn hex', 'fn base64url'],
    text: '`hmac_sha256_verify(key:, data:, mac:)` is True when `mac` is the HMAC-SHA-256 of `data` under `key`, and compares every byte whatever they hold; `==` on two Views stops at the first byte that differs, which a caller can see in the time and the steps, so a signature is never checked with `==`. The mac arrives as text: `from_base64` reads it, or `from_base64url` for base64url without padding (each `None` for text that is not exactly an encoding). `sha256(data:)` and `hmac_sha256(key:, data:)` give 32 raw bytes; `hex`, `base64` and `base64url` write bytes as text. All are std code, metered in steps like any other (66 a 64-byte block). Standard Webhooks signs `id.timestamp.body` and sends `v1,<base64>`; the example signs the body alone.',
    program: `fn handle(raw: View) -> Response {
  let r = request(raw)
  let Request(method: Post, path: "/hook", body) = r else -> empty(status: 404)
  let Some(value: sent) = header_of(request: r, name: "x-signature") else -> empty(status: 401)
  let Some(value: mac) = from_base64(text: sent) else -> empty(status: 401)
  match hmac_sha256_verify(key: signing_key(), data: body, mac) {
    True -> empty(status: 204)
    False -> empty(status: 401)
  }
}

// the key the sender signs with
fn signing_key() -> View {
  "a key shared with the sender"
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
  'Every program is compiled with these files before its own, so everything here is in scope without an import. Arguments are named (`until(v: raw, byte: 10)`), but the first may go without its name (`until(raw, byte: 10)`), and an argument whose value is a name of the same name may be written bare (`until(v, byte)`). `a |> f(b: 1)` is `f(<first parameter>: a, b: 1)`. A program may define a function of the same name as one here; its own wins. For the language itself see [LANGUAGE.md](../LANGUAGE.md); for a whole service, [the guide](guide.md).',
  '',
  'The examples under a function (`> expression`, then what it gives) are run by `tape test` on every commit. Each file also has helpers that these functions call: each is a `private fn`, which a program cannot call (C94; a function of its own of the same name is its own), and the types they pass among themselves (their comments start `Internal:`). They are in the source, std/*.tape, and not listed here.',
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
function fileLines(f: File): string[] {
  const about = f.about.map(l => l.replace(/^std\/\w+\.tape: (.)/, (_m, c: string) => c.toUpperCase()));
  return [
    `## ${f.name}`,
    '',
    ...(about.length > 0 ? [render(about), ''] : []),
    ...f.decls.filter(d => !isInternal(d)).flatMap(declLines),
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
  // a built-in private to a file of std is not listed, as its helpers are not
  for (const n of INTRINSICS.keys())
    if (!listed.has(n) && !PRIVATE_INTRINSICS.has(n)) out.push(`built-in ${n} has no entry in docs/gen-std.ts`);
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
