import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';
import { erased } from './erased.ts';

// The service imports the compiler, the standard library and the examples from the repository above it: the dev
// server may read them.
export default defineConfig({ plugins: [erased(), cloudflare()], server: { fs: { allow: ['..'] } } });
