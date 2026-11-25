// std char_count: the characters (code points) of a View, where len counts bytes. Three bench runs wrote it by hand
// for a "1 to 64 characters" field. Checked against JavaScript's own count of code points ([...s].length) on
// generated text of 1- to 4-byte characters, and in a refinement, as a spec's limit is written.
import '../node25.ts';
import { compile } from '../compiler.ts';
import { instantiate } from '../host.ts';
import { std } from '../std.ts';
import { finish, same, answered } from './harness.ts';

const PROGRAM = `type Name = View where char_count(v: self) >= 1 and char_count(v: self) <= 3

fn handle(raw: View) -> Response {
  let r = request(raw)
  match r.path {
    "/count" -> buf() |> write_int(value: char_count(v: r.body)) |> respond(status: 200)
    "/name" -> named(body: r.body)
    _ -> empty(status: 404)
  }
}

fn named(body: View) -> Response {
  match body {
    Name(n) -> buf() |> append(view: n) |> respond(status: 200)
    _ -> empty(status: 400)
  }
}
`;
const r = compile([...std, { name: 'chars.tape', text: PROGRAM }]);
same(
  'a refinement in characters compiles',
  r.errors.map(e => `${e.code}: ${e.message}`),
  [],
);
if (r.wasm) {
  const app = instantiate(new WebAssembly.Module(r.wasm), { log: false });
  const enc = new TextEncoder();
  const ask = (req: string): string => answered(app.handle(enc.encode(req)));
  // characters of every UTF-8 length, the edges of each, and a seeded mix of them
  const pool = ['a', '~', 'é', '߿', 'ࠀ', '日', '￿', '\u{10000}', '😀', '\u{10FFFF}'];
  let seed = 7;
  const next = (n: number): number => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % n;
  };
  const mixed = Array.from({ length: 200 }, () =>
    Array.from({ length: next(40) }, () => pool[next(pool.length)] ?? '').join(''),
  );
  const texts = ['', ...pool, ...mixed];
  const wrong = texts.filter(t => ask(`POST /count\n${t}`) !== `200\n${Array.from(t).length}`);
  same(`char_count is JavaScript's count of code points on ${texts.length} texts`, wrong, []);
  same(
    'a name of 1 to 3 characters: "日本語" (9 bytes) passes, "日本語!" and "" do not',
    [ask('POST /name\n日本語'), ask('POST /name\n日本語!'), ask('POST /name\n')],
    ['200\n日本語', '400\n', '400\n'],
  );
}

finish();
