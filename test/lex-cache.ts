// compiler/lex.ts lexed, the per-process cache of the standard library's lexed files: the same tokens lex gives (the
// oracle: lex itself, uncached) for every program here; for a std file the same array when asked again, frozen all
// the way down, so a change throws; any other file lexed afresh each time (a program's own files are not kept); held
// within LEXED_CHARS, the least recently used file first out; and a compile from the cache makes the same module as
// the first compile, which filled it.
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
/** Lexing a file twice: the same array both times? */
const twice = (file: string, text: string): boolean => {
  const one = lexed(file, text);
  return one === lexed(file, text);
};
const core = std.find(f => f.name === 'std/core.tape');
if (!core) throw new Error('no std/core.tape');
same('a std file asked again: the same array', twice(core.name, core.text), true);
same('another std name, the same text: its own tokens', lexed('std/other.tape', core.text)[0]?.file, 'std/other.tape');
same(
  "a program's own file, and one named like std but not std's: lexed afresh each time",
  [twice('examples/hello.tape', core.text), twice('std/sub/core.tape', core.text), twice('mystd/core.tape', core.text)],
  [false, false, false],
);
const before = lexedHeld();
lexed('hello.tape', `// ${Date.now()}\n${core.text}`);
same('and not held', lexedHeld(), before);

const toks = lexed('std/frozen.tape', 'fn f() -> Int { "a\\(x)b" }\n');
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

// the bound: std files of 60,000 characters each, many more than fit; the newest stays, the oldest went
const big = (i: number): string => `// ${i}\n${'x'.repeat(60_000)}\n`;
const oldest = lexed('std/big.tape', big(0));
for (let i = 1; i < 12; i++) lexed(`std/big.tape`, big(i));
same('held within LEXED_CHARS', lexedHeld().chars <= LEXED_CHARS, true);
same('the newest kept', twice('std/big.tape', big(11)), true);
same('the oldest went: lexed again, it is new tokens', lexed('std/big.tape', big(0)) === oldest, false);
same('a text over the bound is not kept', twice('std/huge.tape', 'x'.repeat(LEXED_CHARS + 1)), false);

const hello = [...std, { name: 'hello.tape', text: readFileSync(`${ROOT}examples/hello.tape`, 'utf8') }];
const a = compile(hello),
  b = compile(hello);
same(
  'compiled from the cache: the same module',
  a.wasm && b.wasm && Buffer.from(a.wasm).equals(Buffer.from(b.wasm)),
  true,
);
finish();
