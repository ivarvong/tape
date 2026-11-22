// bytes.ts: a Vite plugin. `import b64 from './file.wasm?base64'` gives the file's bytes as base64 text. For
// sql.js's Wasm, which the Worker does not run itself but hands to the Loader as a module of the Dynamic Worker
// (src/index.ts): a `.wasm` import would be compiled into the Worker, and Vitest's pool does not take one from
// outside the project.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Plugin } from 'vite';

const MARK = '\0base64:';
export const bytes = (): Plugin => ({
  name: 'base64',
  enforce: 'pre',
  // the path is resolved here, not by the other plugins: the Cloudflare plugin takes any `.wasm` it resolves as a
  // module to compile into the Worker
  resolveId(id, importer) {
    if (!id.endsWith('?base64') || importer === undefined) return null;
    return MARK + resolve(dirname(importer), id.slice(0, -'?base64'.length));
  },
  load(id) {
    if (!id.startsWith(MARK)) return null;
    const file = id.slice(MARK.length);
    this.addWatchFile(file);
    return `export default ${JSON.stringify(readFileSync(file).toString('base64'))};`;
  },
});
