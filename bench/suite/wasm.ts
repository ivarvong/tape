// bench/suite/wasm.ts: each Tape program's Wasm, compiled once by the Tape compiler and kept in the system's temp
// directory under the hash of its source and of std (the service, too, stores the Wasm and never compiles a
// program on a request). A workload of several files is compiled in the order given, under the names programFiles
// gives them.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { compile } from '../../compiler.ts';
import { std } from '../../std.ts';
import { programFiles, ROOT } from './common.ts';

const DIR = `${tmpdir()}/tape-bench-suite`;
const compilerText = (): string =>
  readdirSync(`${ROOT}compiler`, { recursive: true, encoding: 'utf8' })
    .filter(f => f.endsWith('.ts'))
    .toSorted()
    .map(f => readFileSync(`${ROOT}compiler/${f}`, 'utf8'))
    .join('\0');
function hashOf(files: readonly { name: string; text: string }[]): string {
  const h = createHash('sha256');
  for (const s of std) h.update(s.text).update('\0');
  for (const f of files) h.update(f.name).update('\0').update(f.text).update('\0');
  h.update(compilerText());
  return h.digest('hex').slice(0, 16);
}
/** Functions in a module: its function section's count, which includes the runtime's alloc, reset and reserve. */
export function functionsOf(wasm: Uint8Array): number {
  const leb = (at: number): [number, number] => {
    let v = 0,
      shift = 0,
      i = at;
    for (;;) {
      const b = wasm[i++] ?? 0;
      v |= (b & 0x7f) << shift;
      shift += 7;
      if (b < 0x80) return [v, i];
    }
  };
  let at = 8;
  while (at < wasm.length) {
    const id = wasm[at] ?? 0;
    const [len, body] = leb(at + 1);
    if (id === 3) return leb(body)[0];
    at = body + len;
  }
  return 0;
}
/** Where the Wasm of the program at `path` (or of those files, in order) is kept. Made when it is not there yet. */
export function wasmPath(path: string | readonly string[], baseNames = false): string {
  const paths = typeof path === 'string' ? [path] : [...path];
  const files = programFiles(paths, baseNames);
  const file = `${DIR}/${paths.join('+').replaceAll('/', '_')}-${hashOf(files)}.wasm`;
  if (existsSync(file)) return file;
  const r = compile([...std, ...files]);
  if (!r.wasm)
    throw new Error(`${paths.join(' + ')}: ${r.errors.map(e => `${e.line} ${e.code} ${e.message}`).join('; ')}`);
  mkdirSync(DIR, { recursive: true });
  writeFileSync(file, r.wasm);
  return file;
}
