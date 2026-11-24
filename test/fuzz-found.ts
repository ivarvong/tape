// What the fuzz campaigns (fuzz/) found, each minimized to the smallest program or input that shows it, run here as
// it was reported: compiled and in the reference interpreter where both apply. Each case names the campaign and the
// date, and was seen failing before its fix.
import '../node25.ts';
import { compile } from '../compiler.ts';
import { interpret } from '../interp.ts';
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

finish();
