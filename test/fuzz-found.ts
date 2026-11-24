// What the fuzz campaigns (fuzz/) found, each minimized to the smallest program or input that shows it, run here as
// it was reported: compiled and in the reference interpreter where both apply. Each case names the campaign and the
// date, and was seen failing before its fix.
import '../node25.ts';
import { compile } from '../compiler.ts';
import { interpret } from '../interp.ts';
import { instantiate, isEffect, replay } from '../host.ts';
import { pack, unpack } from '../host/log.ts';
import { nodeSql } from '../nodesql.ts';
import { bare, finish, handleBare, same, std } from './harness.ts';

const enc = new TextEncoder(),
  dec = new TextDecoder();
/** handle on each input, compiled and in the interpreter: [compiled, interpreted] answers, or the refusal. */
function both(text: string, inputs: string[]): string[][] | string {
  const sources = [...std, { name: 'found.tape', text }];
  const b = compile(sources);
  if (b.wasm === null) return `refused: ${b.errors[0]?.code} ${b.errors[0]?.message}`;
  const ex = bare(new WebAssembly.Module(b.wasm)),
    it = interpret(sources);
  return inputs.map(i => {
    const meant = it.call('handle', [enc.encode(i)]);
    return [handleBare(ex, enc.encode(i)), meant instanceof Uint8Array ? dec.decode(meant) : 'not bytes'];
  });
}

// fuzz/programs.ts, 23 November 2026: a generic call's type parameter is told from its argument's type, and the
// type of a field was told only when the record was a name: `length(list: R(…).l)` and a match as the argument were
// C43 ("cannot tell what T is"), though every type in them is written down.
same(
  'a generic call takes its type from a field of a constructed record, and from a match',
  both(
    `type R {
  R(a: Int, l: List[Int])
}

fn handle(raw: View) -> Buf {
  let n = length(list: R(a: 1, l: Cons(head: 7, tail: Nil)).l)
  let m = length(list: match len(raw) {
    0 -> Nil
    _ -> Cons(head: 1, tail: Cons(head: 2, tail: Nil))
  })
  let k = reverse(list: match {
    len(raw) > 1 -> Cons(head: len(raw), tail: Nil)
    else -> Nil
  }) |> length()
  buf() |> append(view: "\\(n) \\(m) \\(k)")
}
`,
    ['', 'ab'],
  ),
  [
    ['1 0 0', '1 0 0'],
    ['1 2 1', '1 2 1'],
  ],
);

// fuzz/programs.ts, 23 November 2026: the interpreter had no write_float (Unsupported), so a program that writes a
// Float into a Buf had no reference meaning and the differential could not check it.
same(
  'write_float in the interpreter, as compiled: the shortest digits that read back',
  both(
    `fn handle(raw: View) -> Buf {
  buf()
    |> write_float(value: 0.1f + 0.2f)
    |> append(view: " ")
    |> write_float(value: -1e21f)
    |> append(view: " ")
    |> write_float(value: float(len(raw)))
}
`,
    ['abc'],
  ),
  [['0.30000000000000004 -1e+21 3', '0.30000000000000004 -1e+21 3']],
);

// fuzz/numbers.ts, 23 November 2026: parse_float read its text with JavaScript's Number, which takes the empty text
// and white space as 0 and reads 0x, 0b and 0o in their bases: parse_float("") was Some(0f), " 12 " Some(12f),
// "0x1F" Some(31f). It reads a number in JSON's syntax, as parse_dec does, and nothing else.
{
  const texts = ['', ' 12 ', '\t2', '0x1F', '0b11', '0o7', '+1', '.5', '5.', '05', '-', 'Infinity', '\uFEFF1', '1e5'];
  same(
    'parse_float of text that is not a number in JSON syntax is None, compiled and interpreted',
    both(
      `fn handle(raw: View) -> Buf {
  match parse_float(raw) {
    Some(value: x) -> buf() |> write_float(value: x)
    None -> buf() |> append(view: "none")
  }
}
`,
      texts,
    ),
    texts.map(t => (t === '1e5' ? ['100000', '100000'] : ['none', 'none'])),
  );
}

// fuzz/numbers.ts and fuzz/replay.ts, 23 November 2026: the host read text out of the module with a TextDecoder whose
// default drops a leading U+FEFF (EF BB BF), so a View that began with one lost it on its way to SQL (6 bytes
// written, 3 stored), in the effect log (pack: a request or a call's message of BOM + "hi" was logged as "hi", and
// replayed as 2 bytes), and in the interpreter's parse_dec, which read "\uFEFF1.5" as 1.5 where the module says None.
{
  const text = `migration 1 "notes" {
  CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT NOT NULL)
}

type Note {
  Note(id: Int, body: View)
}

fn handle(raw: View, db: Sql) -> Buf {
  let Some(value: n) = sql_first(
    row: Note,
    query: "INSERT INTO notes(body) VALUES (:raw) RETURNING *",
    raw,
    repeat: True
  ) else -> buf()
  buf() |> append(view: n.body)
}
`;
  const b = compile([...std, { name: 'bom.tape', text }]);
  if (b.wasm === null) throw new Error(b.errors[0]?.message);
  const module = new WebAssembly.Module(b.wasm),
    sql = nodeSql(),
    app = instantiate(module, { sql });
  const sent = ['\uFEFFabc', '\uFEFF', 'a\uFEFFb'].map(t => enc.encode(t));
  const ran = await Promise.all(sent.map(s => app.runLogged(s, { transaction: f => sql.transaction(f) })));
  same(
    'a View that starts with U+FEFF is stored and read back whole',
    ran.map(r => [...r.out]),
    sent.map(s => [...s]),
  );
  same(
    'and its log, through JSON as the service stores it, replays to the same bytes',
    ran.map((r, i): number[] => {
      const effects: unknown = JSON.parse(JSON.stringify(r.effects));
      return Array.isArray(effects) ? [...replay(module, sent[i] ?? null, effects.filter(isEffect))] : [];
    }),
    sent.map(s => [...s]),
  );
  same('pack and unpack keep a leading U+FEFF', [...unpack(pack(enc.encode('\uFEFFhi')))], [...enc.encode('\uFEFFhi')]);
  same(
    'parse_dec of a text that starts with U+FEFF is None, compiled and interpreted',
    both(
      `fn handle(raw: View) -> Buf {
  match parse_dec(text: raw, scale: 1) {
    Some(value: d) -> buf() |> write_dec(value: d)
    None -> buf() |> append(view: "none")
  }
}
`,
      ['\uFEFF1.5', '1.5'],
    ),
    [
      ['none', 'none'],
      ['1.5', '1.5'],
    ],
  );
}

// fuzz/sql.ts, 23 November 2026: a program's type named as a type parameter of std's (T of Option[T] and List[T], V
// of Map[V], E of Result[T, E]) was taken for one that contains itself, so it was boxed: Option's field `value: T`
// was read as the program's T (compiler/gen/layout.ts layouts). A boxed type is not a row type, so
// `type T { T(id: Int, region: Option[View]) }` as a query's row was C09 ("T cannot be a row type"), where the same
// type named Note compiles.
{
  const rowProgram = (name: string): string => `migration 1 "t" {
  CREATE TABLE t(id INTEGER PRIMARY KEY, region TEXT)
}

type ${name} {
  ${name}(id: Int, region: Option[View])
}

fn handle(raw: View, db: Sql) -> Buf {
  let 1 = sql_exec(query: "INSERT INTO t(region) VALUES (:raw)", raw, repeat: True) else -> respond(status: 500)
  respond(status: 200) |> write_rows(rows: sql_all(row: ${name}, query: "SELECT * FROM t ORDER BY id"))
}
`;
  const answers = ['T', 'Note'].map(name => {
    const b = compile([...std, { name: 'row.tape', text: rowProgram(name) }]);
    if (b.wasm === null) return `refused: ${b.errors[0]?.code} ${b.errors[0]?.message}`;
    const app = instantiate(new WebAssembly.Module(b.wasm), { sql: nodeSql() });
    return (
      dec
        .decode(app.handle(enc.encode('x')))
        .split('\n')
        .at(-1) ?? ''
    );
  });
  same('a row type named T reads its rows as one named Note does', answers, [
    '[{"id":1,"region":"x"}]',
    '[{"id":1,"region":"x"}]',
  ]);
}

finish();
