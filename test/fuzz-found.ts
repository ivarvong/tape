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
  const texts = ['', ' 12 ', '\t2', '0x1F', '0b11', '0o7', '+1', '.5', '5.', '05', '-', 'Infinity', '﻿1', '1e5'];
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

finish();
