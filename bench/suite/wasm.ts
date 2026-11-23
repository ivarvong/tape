// bench/suite/wasm.ts: each Tape program's Wasm, compiled once by the Tape compiler and kept in the system's temp
// directory under the hash of its source and of std (the service, too, stores the Wasm and never compiles a
// program on a request).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { compile } from '../../compiler.ts';
import { std } from '../../std.ts';
import { ROOT } from './common.ts';

const DIR = `${tmpdir()}/tape-bench-suite`;
const sourceOf = (path: string): string => readFileSync(`${ROOT}${path}`, 'utf8');
const hashOf = (path: string): string =>
  createHash('sha256')
    .update(std.map(s => s.text).join('\0'))
    .update(sourceOf(path))
    .update(
      readdirSync(`${ROOT}compiler`, { recursive: true, encoding: 'utf8' })
        .filter(f => f.endsWith('.ts'))
        .toSorted()
        .map(f => readFileSync(`${ROOT}compiler/${f}`, 'utf8'))
        .join('\0'),
    )
    .digest('hex')
    .slice(0, 16);
/** Where the Wasm of the program at `path` is kept (made when it is not there yet). */
export function wasmPath(path: string): string {
  const file = `${DIR}/${path.replaceAll('/', '_')}-${hashOf(path)}.wasm`;
  if (existsSync(file)) return file;
  const r = compile([...std, { name: path, text: sourceOf(path) }]);
  if (!r.wasm) throw new Error(`${path}: ${r.errors.map(e => `${e.line} ${e.code} ${e.message}`).join('; ')}`);
  mkdirSync(DIR, { recursive: true });
  writeFileSync(file, r.wasm);
  return file;
}
