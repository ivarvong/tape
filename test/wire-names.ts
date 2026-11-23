// The decoders and writers compiler/wire.ts writes call only names a program cannot take the place of. Every
// function their code calls that it does not define itself (std's json_get, text's max and write_int, the built-ins
// push and append, …) is read from the generated source, not listed here, and a program then defines each of them
// as a function of its own (the built-ins a program may not shadow left out); it must still decode nested JSON and
// write it, with the answers written below from the rule (its own code calls std by qualified names). Before, a program with its own `max` (apps/trace) was
// refused, C45 "max is defined in std/text.tape and trace.tape".
import '../node25.ts';
import { compile, parseProgram } from '../compiler.ts';
import { instantiate } from '../host.ts';
import { SHADOWABLE } from '../compiler/shadow.ts';
import { INTRINSICS } from '../compiler/types.ts';
import { wireSource } from '../compiler/wire.ts';
import { std } from '../std.ts';
import { finish, ok, same } from './harness.ts';

const program = `type Name = View where len(self) >= 1 and len(self) <= 8
type Item { Item(sku: Name, qty: Int, tags: List[View]) }
type Order { Order(id: Int, ok: Bool, items: List[Item], grid: List[List[Int]], to: Item) }
type Maybe { Maybe(a: Option[Int], b: Option[Name], c: Option[Item], d: Option[List[Item]]) }
type Shape {
  Circle(r: Int)
  Rect(w: Int, h: Int)
}

fn handle(raw: View) -> Buf {
  match raw {
    "order " ++ json -> order(found: decode(json, as: Order))
    "maybe " ++ json -> maybe(found: decode(json, as: Maybe))
    "shape " ++ json -> shape(found: decode(json, as: Shape))
    _ -> buf()
  }
}

fn order(found: Result[Order, View]) -> Buf {
  match found {
    Ok(value) -> buf() |> write_json(value)
    Err(error) -> buf() |> json.json_append(view: "error: ") |> json.json_append(view: error)
  }
}

fn maybe(found: Result[Maybe, View]) -> Buf {
  match found {
    Ok(value: Maybe(a: Some(value: n), b: Some(value: name), c: None, d: Some(value: Cons(head: first)))) -> buf()
      |> text.write_int(value: n)
      |> json.json_append(view: name)
      |> write_json(value: first)
    Ok -> buf() |> json.json_append(view: "other")
    Err(error) -> buf() |> json.json_append(view: "error: ") |> json.json_append(view: error)
  }
}

fn shape(found: Result[Shape, View]) -> Buf {
  match found {
    Ok(value: Circle(r)) -> buf() |> json.json_append(view: "circle ") |> text.write_int(value: r)
    Ok(value: Rect(w, h)) -> buf() |> json.json_append(view: "rect ") |> text.write_int(value: w * h)
    Err(error) -> buf() |> json.json_append(view: "error: ") |> json.json_append(view: error)
  }
}
`;
const sources = (extra: string) => [...std, { name: 'p.tape', text: program + extra }];
// the names the generated code calls and does not define
const wire = wireSource(parseProgram(sources(''))).text;
const defined = new Set([...wire.matchAll(/\bfn ([a-z_][A-Za-z0-9_]*)/g)].map(m => m[1]));
const called = new Set(
  [...wire.matchAll(/\b([a-z_][A-Za-z0-9_]*\.)?([a-z_][A-Za-z0-9_]*)\(/g)]
    .map(m => m[2] ?? '')
    .filter(n => n !== 'fn' && !defined.has(n) && (!INTRINSICS.has(n) || SHADOWABLE.has(n))),
);
ok(`the generated code calls ${called.size} functions it does not define`, called.size > 10);
// a function of the program's own for each; none of them is ever called by the program
// and the built-ins and std functions a program is most likely to have its own of, whether or not the code calls them
const own = [...new Set([...called, 'max', 'push', 'append', 'write_int', 'write_json_string'])]
  .toSorted()
  .map(n => `\nfn ${n}(x: Int) -> Int {\n  x + 1\n}\n`)
  .join('');
const built = compile(sources(own));
ok(
  `a program defining all ${called.size} of them, and max, push and append, compiles`,
  built.wasm !== null,
  built.errors.map(e => `${e.file}:${e.line} ${e.code} ${e.message}`).join('; '),
);
if (built.wasm) {
  const app = instantiate(new WebAssembly.Module(built.wasm), { log: false });
  const dec = new TextDecoder(),
    enc = new TextEncoder();
  const say = (s: string): string => dec.decode(app.handle(enc.encode(s)));
  same(
    'it decodes nested JSON and writes it',
    say(
      'order {"id":7,"ok":true,"items":[{"sku":"a","qty":2,"tags":["x"]}],"grid":[[1],[2,3]],"to":{"sku":"b","qty":0,"tags":[]},"extra":1}',
    ),
    '{"id":7,"ok":true,"items":[{"sku":"a","qty":2,"tags":["x"]}],"grid":[[1],[2,3]],"to":{"sku":"b","qty":0,"tags":[]}}',
  );
  same(
    'and says why not, with the path',
    say('order {"id":7,"ok":true,"items":[],"grid":[[1],[2,"3"]],"to":{"sku":"b","qty":0,"tags":[]}}'),
    'error: grid[1][1]: expected an integer',
  );
  same(
    'a refinement in a list element',
    say('order {"id":7,"ok":true,"items":[{"sku":"","qty":2,"tags":[]}],"grid":[],"to":{"sku":"b","qty":0,"tags":[]}}'),
    'error: items[0].sku: expected 1 to 8 bytes',
  );
  same(
    'Option fields of each kind',
    say('maybe {"a":5,"b":"bo","d":[{"sku":"z","qty":1,"tags":[]}]}'),
    '5bo{"sku":"z","qty":1,"tags":[]}',
  );
  same('of two constructors, the one that names the most keys', say('shape {"r":1,"w":2,"h":3}'), 'rect 6');
  same('and the reason when none fits: the one that got furthest', say('shape {"w":2}'), 'error: h: missing');
}
finish();
