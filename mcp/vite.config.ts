import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';
import { erased } from '../service/erased.ts';
import { bytes } from './bytes.ts';

// The Worker imports the compiler, the host, the standard library, the playground's SQLite and the service's OTLP
// view from the repository above it: the dev server may read them.
export default defineConfig({ plugins: [erased(), bytes(), cloudflare()], server: { fs: { allow: ['..'] } } });
