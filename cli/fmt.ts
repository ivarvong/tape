// tape fmt: every file in the canonical layout (fmt.ts); --check changes nothing and exits 1 if a file would change.
// Each file is a program with std, as `tape file.tape` builds it: when it compiles, fmt also writes each function's
// `uses` clause as the compiler infers it (C101). A file of std, or one that is not a whole program, keeps its clauses.
// `--with file` (any number of times) names a file the program is built with after each one formatted, as
// corpus/blog.tape is with corpus/md.tape; it is not formatted itself.
import { readFileSync, writeFileSync } from 'node:fs';
import { CompileError } from '../compiler/common.ts';
import { format } from '../fmt.ts';
import { std } from '../std.ts';
import { USAGE } from './usage.ts';

// a refusal as one line: where, the code, what is wrong, and what to write
const refusalOf = (file: string, e: unknown): string => {
  if (!(e instanceof CompileError)) return `${file}:?:  ${e instanceof Error ? e.message : String(e)}`;
  const i = e.info;
  return `${file}:${i.line}: ${i.code} ${i.message}${i.hint ? '\n  ' + i.hint : ''}`;
};
export function formatFiles(args: string[]): never {
  const check = args.includes('--check'),
    withs = args.flatMap((a, i) => (args[i - 1] === '--with' ? [a] : [])),
    files = args.filter((a, i) => a !== '--check' && a !== '--with' && args[i - 1] !== '--with'),
    after = withs.map(name => ({ name, text: readFileSync(name, 'utf8') }));
  if (files.length === 0) {
    console.error(USAGE);
    process.exit(2);
  }
  let changed = 0,
    broken = 0;
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    let out: string;
    try {
      out = format(text, f, std, after);
    } catch (e) {
      broken++;
      console.error(refusalOf(f, e));
      continue;
    }
    if (out === text) continue;
    changed++;
    if (check) console.log(`${f}: not formatted`);
    else {
      writeFileSync(f, out);
      console.log(`${f}: formatted`);
    }
  }
  process.exit(broken || (check && changed) ? 1 : 0);
}
