// tape fmt: every file in the canonical layout (fmt.ts); --check changes nothing and exits 1 if a file would change.
import { readFileSync, writeFileSync } from 'node:fs';
import { CompileError } from '../compiler/common.ts';
import { format } from '../fmt.ts';
import { USAGE } from './usage.ts';

// a refusal as one line: where, the code, what is wrong, and what to write
const refusalOf = (file: string, e: unknown): string => {
  if (!(e instanceof CompileError)) return `${file}:?:  ${e instanceof Error ? e.message : String(e)}`;
  const i = e.info;
  return `${file}:${i.line}: ${i.code} ${i.message}${i.hint ? '\n  ' + i.hint : ''}`;
};
export function formatFiles(args: string[]): never {
  const check = args.includes('--check'),
    files = args.filter(a => a !== '--check');
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
      out = format(text, f);
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
