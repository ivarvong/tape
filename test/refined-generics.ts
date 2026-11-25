// A refined type stands for its base type inside the brackets of a type whose values are only read (issue #20):
// an `Option[Delay]` is an `Option[Int]`, a `List[Slug]` a `List[View]`, a `Result` in both its arguments. A
// function's parameter goes the other way (`Fn[Int, X]` is an `Fn[Delay, X]`, not the reverse), and every other
// type is the same type or nothing. The answers are the same on every build and in the interpreter.
import '../node25.ts';
import { interpret } from '../interp.ts';
import { bare, built, codes, finish, handleBare, moduleOf, same, std } from './harness.ts';

const DELAY = 'type Delay = Int where self >= 0 and self <= 3600\n\n';
const prog = (body: string): string => `${DELAY}${body}`;

// ---- what is now accepted
const accepted = prog(`type Slug = View where len(self) >= 1

fn or_int(given: Option[Int], otherwise: Int) -> Int {
  match given {
    Some(value) -> value
    None -> otherwise
  }
}

fn total(xs: List[Int]) -> Int {
  fold(list: xs, from: 0, by: plus)
}

fn plus(acc: Int, x: Int) -> Int {
  acc + x
}

fn width(r: Result[Int, View]) -> Int {
  match r {
    Ok(value) -> value
    Err(error) -> len(error)
  }
}

fn nested(o: Option[List[Int]]) -> Int {
  match o {
    Some(value) -> total(xs: value)
    None -> -1
  }
}

fn slugs(xs: List[View]) -> Int {
  fold(list: xs, from: 0, by: lens)
}

fn lens(acc: Int, x: View) -> Int {
  acc + len(x)
}

fn apply(f: Fn[Delay, Int], d: Delay) -> Int {
  f(d)
}

fn twice(n: Int) -> Int {
  n * 2
}

fn handle(raw: View) -> Buf {
  let Request(body) = request(raw)
  match len(body) {
    Delay(d) -> answer(d, body)
    _ -> respond(status: 400)
  }
}

fn answer(d: Delay, body: View) -> Buf {
  match body {
    Slug(s) -> written(d, s)
    _ -> respond(status: 400)
  }
}

fn one(d: Delay) -> Option[Delay] {
  Some(value: d)
}

fn two(d: Delay) -> List[Delay] {
  Cons(head: d, tail: Cons(head: d, tail: Nil))
}

fn kept(d: Delay) -> Result[Delay, Slug] {
  Ok(value: d)
}

fn lost(s: Slug) -> Result[Delay, Slug] {
  Err(error: s)
}

fn both(d: Delay) -> Option[List[Delay]] {
  Some(value: two(d))
}

fn named(s: Slug) -> List[Slug] {
  Cons(head: s, tail: Nil)
}

fn written(d: Delay, s: Slug) -> Buf {
  respond(status: 200)
    |> write_int(value: or_int(given: one(d), otherwise: 5))
    |> append(view: " ")
    |> write_int(value: or_int(given: None, otherwise: 5))
    |> append(view: " ")
    |> write_int(value: total(xs: two(d)))
    |> append(view: " ")
    |> write_int(value: width(r: kept(d)))
    |> append(view: " ")
    |> write_int(value: width(r: lost(s)))
    |> append(view: " ")
    |> write_int(value: nested(o: both(d)))
    |> append(view: " ")
    |> write_int(value: slugs(xs: named(s)))
    |> append(view: " ")
    |> write_int(value: apply(f: twice, d))
}
`);
same('an Option, a List, a Result of a refined type, and a function of its base, compile', codes(accepted), []);
const input = (body: string): Uint8Array => new TextEncoder().encode(`POST /\n${body}`);
const want = '200\n3 5 6 3 3 6 3 6';
for (const [name, options] of [
  ['the default build', {}],
  ['a build without cell reuse', { reuse: false }],
  ['a checked build', { check: true }],
  ['a build without inlining', { inline: false }],
] as const) {
  const b = bare(moduleOf(built(accepted, options)));
  same(`${name} answers the same`, handleBare(b, input('abc')), want);
}
const interp = interpret([...std, { name: 'program.tape', text: accepted }]);
same('the interpreter answers the same', new TextDecoder().decode(interp.handle(input('abc'))), want);

// ---- a type variable bound by a refined argument and by its base takes the base: value_or(given: Option[Most],
// otherwise: 5) is an Int with nothing around it to say so (an SQL argument), where it was C14 on `5`
const widened = prog(`type Most = Int where self >= 1 and self <= 20

fn most(n: Int) -> Option[Most] {
  match n {
    Most(m) -> Some(value: m)
    _ -> None
  }
}

fn handle(raw: View) -> Buf {
  let n = value_or(given: most(n: len(raw)), otherwise: 5)
  respond(status: 200) |> write_int(value: n)
}
`);
same('a refined argument and its base bind the base', codes(widened), []);
const wb = bare(moduleOf(built(widened)));
same(
  'and answer the value or the default',
  [handleBare(wb, new TextEncoder().encode('GET /\n')), handleBare(wb, new TextEncoder().encode('x'.repeat(30)))],
  ['200\n6', '200\n5'],
);

// ---- what is still refused: the other direction, and every type not listed
const refused = (sig: string, arg: string, setup = ''): string[] =>
  codes(
    prog(`fn take(${sig}) -> Int {
  0
}

fn handle(raw: View) -> Buf {
${setup}  respond(status: 200) |> write_int(value: take(${arg}))
}
`),
  ).map(c => c.split(':')[0] ?? '');
same('an Option[Int] is not an Option[Delay]', refused('x: Option[Delay]', 'x: Some(value: len(raw))'), ['C14']);
same('a List[Int] is not a List[Delay]', refused('xs: List[Delay]', 'xs: Cons(head: len(raw), tail: Nil)'), ['C14']);
same(
  'a function of a Delay is not a function of an Int: it would be handed an Int its condition was not proved of',
  codes(
    prog(`fn half(d: Delay) -> Int {
  d / 2
}

fn apply(f: Fn[Int, Int]) -> Int {
  f(-7)
}

fn handle(raw: View) -> Buf {
  respond(status: 200) |> write_int(value: apply(f: half))
}
`),
  ).map(c => c.split(':')[0] ?? ''),
  ['C14'],
);
same(
  "a program's own generic type is the same type or nothing",
  codes(
    prog(`type Box[T] {
  Box(item: T)
}

fn open(b: Box[Int]) -> Int {
  let Box(item) = b
  item
}

fn boxed(d: Delay) -> Box[Delay] {
  Box(item: d)
}

fn handle(raw: View) -> Buf {
  match len(raw) {
    Delay(d) -> respond(status: 200) |> write_int(value: open(b: boxed(d)))
    _ -> respond(status: 400)
  }
}
`),
  ).map(c => c.split(':')[0] ?? ''),
  ['C14'],
);

finish();
