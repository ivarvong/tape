import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';
import { erased } from './erased.ts';
import { bytes } from '../mcp/bytes.ts';
import { compilerHash, tapeVersion } from './scripts/sha.ts';

// The service imports the compiler, the standard library and the examples from the repository above it: the dev
// server may read them. The site (scripts/site.ts writes it to .site/) is the public directory, so the build puts it
// in the Worker's static assets. TAPE_VERSION is the commit, for the tape-version header;
// TAPE_COMPILER the hash of the compiler built in (scripts/sha.ts), for the tape-compiler header.
export default defineConfig({
  plugins: [erased(), bytes(), cloudflare()],
  publicDir: '.site',
  define: { TAPE_VERSION: JSON.stringify(tapeVersion()), TAPE_COMPILER: JSON.stringify(compilerHash()) },
  server: { fs: { allow: ['..'] } },
});
