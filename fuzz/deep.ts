// fuzz/deep.ts: expressions nested past the parser's bound (compiler/parse/expr.ts MAX_DEPTH), one of each kind.
// test/fuzz-found.ts compiles them in its own process and, run as a script (`node --stack-size=850 fuzz/deep.ts`),
// in a cold one: what each gives, as JSON. Each must be P09, never a RangeError from the engine's stack.
import '../node25.ts';
import { compile } from '../compiler.ts';
import { std } from '../std.ts';

export const DEEP: readonly [string, string][] = [
  ['nested parentheses', `fn f(n: Int) -> Int {\n  ${'('.repeat(3200)}n${')'.repeat(3200)}\n}\n`],
  ['a chain of +', `fn f(n: Int) -> Int {\n  n${' + n'.repeat(3200)}\n}\n`],
  [
    'nested lambdas',
    `fn f(n: Int) -> Int {\n  ${'fold(list: range(from: 0, to: 2), from: n, by: fn(a: Int, k: Int) -> Int { '.repeat(800)}n${' })'.repeat(800)}\n}\n`,
  ],
  [
    'nested constructors',
    `fn f(n: Int) -> List[Int] {\n  ${'Cons(head: n, tail: '.repeat(3200)}Nil${')'.repeat(3200)}\n}\n`,
  ],
  [
    'nested patterns',
    `fn f(o: Option[Int]) -> Int {\n  match o {\n    ${'Some(value: '.repeat(3200)}_${')'.repeat(3200)} -> 1\n    _ -> 0\n  }\n}\n`,
  ],
];

/** What compiling each gives: `kind: CODE`, `kind: compiled`, or `kind: threw Name`. */
export const refusalsOf = (): string[] =>
  DEEP.map(([what, text]) => {
    try {
      const b = compile([...std, { name: 'deep.tape', text }], { exports: ['f'] });
      return `${what}: ${b.wasm === null ? (b.errors[0]?.code ?? '?') : 'compiled'}`;
    } catch (e) {
      return `${what}: threw ${e instanceof Error ? e.constructor.name : String(e)}`;
    }
  });

if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(refusalsOf()));
