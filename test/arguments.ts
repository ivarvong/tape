// How a call passes its arguments (LANGUAGE.md section 4): by name; a variable named like the parameter bare; and
// the one argument of a one-parameter function bare, whatever expression it is, for a function, a generic
// function, a function value and a built-in alike. A call of a function with two or more parameters names every
// argument that is not such a variable (C10), and the refusal shows the call written that way.
import '../node25.ts';
import { compile } from '../compiler.ts';
import { interpret } from '../interp.ts';
import { std } from '../std.ts';
import { bare, call, finish, same } from './harness.ts';

const program = `fn fact(n: Int) -> Int {
  match {
    n <= 1 -> 1
    else -> n * fact(n - 1)
  }
}

fn twice[T](x: T) -> List[T] {
  Cons(head: x, tail: Cons(head: x, tail: Nil))
}

fn count[T](list: List[T]) -> Int {
  match list {
    Cons(tail) -> 1 + count(tail)
    Nil -> 0
  }
}

fn apply(f: Fn[Int, Int], x: Int) -> Int {
  f(f(x + 1))
}

fn nested() -> Int {
  let pair = twice(fact(2))
  fact(fact(3) - 2) + count(pair) + len("ab" ++ "c")
}

fn through_value() -> Int {
  apply(f: fn(v: Int) -> Int { v * 10 }, x: 1)
}

fn of_five() -> Int {
  fact(5)
}
`;
// fact(fact(3) - 2) = 4! = 24; a list of two; "abc" is 3 long. ((1 + 1) * 10) * 10 = 200. 5! = 120.
const want = { nested: 24n + 2n + 3n, through_value: 200n, of_five: 120n };
const r = compile([...std, { name: 't.tape', text: program }], { exports: Object.keys(want) });
same(
  'one-parameter calls with any expression compile',
  r.errors.map(e => `${e.code} ${e.line} ${e.message}`),
  [],
);
if (r.wasm) {
  const ex = bare(new WebAssembly.Module(r.wasm));
  const it = interpret([...std, { name: 't.tape', text: program }]);
  for (const [fn, value] of Object.entries(want)) {
    call(ex.fns, 'reset');
    same(`${fn}: compiled and interpreted`, [call(ex.fns, fn), it.call(fn, [])], [value, value]);
  }
}

const refusal = (text: string): string => {
  const [e] = compile([...std, { name: 't.tape', text }], { exports: ['f'] }).errors;
  return e ? `${e.code} ${e.line}: ${e.message} | ${e.hint}` : 'compiled';
};
const POW = `fn pow(b: Int, e: Int) -> Int {
  match {
    e <= 0 -> 1
    else -> b * pow(b, e - 1)
  }
}

fn f() -> Int {
  pow(b: 2, e: 10)
}
`;
const RULE =
  "A variable with the parameter's name can be passed bare, and so can the one argument of a function with one parameter.";
same(
  'two parameters: an unnamed expression is refused, and the fix is shown',
  refusal(POW),
  `C10 4: arguments must be named | function pow takes (b, e), so each argument is \`name: value\`, as in \`pow(b, e: e - 1)\`. ${RULE}`,
);
same(
  'two parameters, both unnamed',
  refusal('fn add(a: Int, b: Int) -> Int {\n  a + b\n}\n\nfn f() -> Int {\n  add(1, 2 * 3)\n}\n'),
  `C10 6: arguments must be named | function add takes (a, b), so each argument is \`name: value\`, as in \`add(a: 1, b: 2 * 3)\`. ${RULE}`,
);
same('named, it compiles', refusal(POW.replace('pow(b, e - 1)', 'pow(b, e: e - 1)')), 'compiled');

finish();
