import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';
import { erased } from '../service/erased.ts';
import { bytes } from './bytes.ts';
import { compilerHash, tapeVersion } from '../service/scripts/sha.ts';

// The Worker imports the compiler, the host, the standard library, the playground's SQLite and the service's OTLP
// view from the repository above it: the dev server may read them. TAPE_VERSION and TAPE_COMPILER, as the tape
// Worker's (service/scripts/sha.ts): the commit and the compiler built in, for the tape-version and tape-compiler
// headers.
export default defineConfig({
  plugins: [erased(), bytes(), cloudflare()],
  define: { TAPE_VERSION: JSON.stringify(tapeVersion()), TAPE_COMPILER: JSON.stringify(compilerHash()) },
  server: { fs: { allow: ['..'] } },
});
