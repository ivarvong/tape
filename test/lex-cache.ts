// compiler/lex.ts lexed, the per-process cache of lexed files: the same tokens lex gives (the oracle: lex itself,
// uncached) for every program here; the same array when asked again; frozen all the way down, so a change throws;
// held within LEXED_CHARS, the least recently used file first out; and a compile from the cache makes the same
// module as the first compile, which filled it.
import { readdirSync, readFileSync } from 'node:fs';
import { compile } from '../compiler.ts';
import { lex, lexed, lexedHeld, LEXED_CHARS } from '../compiler/lex.ts';
import { std } from '../std.ts';
import { finish, same } from './harness.ts';

const ROOT = new URL('../', import.meta.url).pathname;
const files = ['examples', 'std', 'apps/tickets', 'apps/trace'].flatMap(d =>
  readdirSync(ROOT + d)
    .filter(f => f.endsWith('.tape'))
    .map(f => ({ name: `${d}/${f}`, text: readFileSync(`${ROOT}${d}/${f}`, 'utf8') })),
);
const bigints = (_k: string, v: unknown): unknown => (typeof v === 'bigint' ? `${v}n` : v);
const json = (v: unknown): string => JSON.stringify(v, bigints);
same(
  `${files.length} files: lexed gives what lex gives`,
  files.filter(f => json(lexed(f.name, f.text)) !== json(lex(f.name, f.text))).map(f => f.name),
  [],
);
const first = files[0];
if (!first) throw new Error('no files');
/** Lexing a file twice: the same array both times? */
const twice = (file: string, text: string): boolean => {
  const one = lexed(file, text);
  return one === lexed(file, text);
};
same('asked again: the same array', twice(first.name, first.text), true);
same('another name, the same text: its own tokens', lexed('other.tape', first.text)[0]?.file, 'other.tape');

const toks = lexed('frozen.tape', 'fn f() -> Int { "a\\(x)b" }\n');
const interp = toks.find(t => t.t === 'interp');
if (!interp) throw new TypeError('no interp token');
// Reflect.set says whether a write was taken: a frozen value refuses it (and in strict code a plain write throws)
same(
  'frozen: the array, a token, a text with holes, a hole',
  [
    Reflect.set(toks, 0, null),
    Reflect.set(toks[0] ?? {}, 'v', 'changed'),
    Reflect.set(interp.v, 0, null),
    Reflect.set(interp.v.find(p => 'hole' in p) ?? {}, 'hole', []),
  ],
  [false, false, false, false],
);
same('and nothing changed', [toks[0]?.t, toks[0] && 'v' in toks[0] ? toks[0].v : null], ['kw', 'fn']);

// the bound: texts of 300,000 characters each, many more than fit; the newest stays, the oldest went
const big = (i: number): string => `// ${i}\n${'x'.repeat(300_000)}\n`;
const oldest = lexed('big0.tape', big(0));
for (let i = 1; i < 12; i++) lexed(`big${i}.tape`, big(i));
const held = lexedHeld();
same('held within LEXED_CHARS', held.chars <= LEXED_CHARS, true);
const last = lexed('big11.tape', big(11)),
  again = lexed('big11.tape', big(11));
same('the newest kept', last === again, true);
same('the oldest went: lexed again, it is new tokens', lexed('big0.tape', big(0)) === oldest, false);
same('a text over the bound is not kept', twice('huge.tape', 'x'.repeat(LEXED_CHARS + 1)), false);

const hello = [...std, { name: 'hello.tape', text: readFileSync(`${ROOT}examples/hello.tape`, 'utf8') }];
const a = compile(hello),
  b = compile(hello);
same(
  'compiled from the cache: the same module',
  a.wasm && b.wasm && Buffer.from(a.wasm).equals(Buffer.from(b.wasm)),
  true,
);
finish();
