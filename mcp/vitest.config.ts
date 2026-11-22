import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { erased } from '../service/erased.ts';
import { bytes } from './bytes.ts';

// The plugin does not read cloudflare.config.ts bindings yet, so they are declared again here. TIGHT is a second
// rate limit, of two calls a minute, for the test that sees the real binding refuse.
const miniflare = {
  workerLoaders: { LOADER: {} },
  bindings: { KILL_SWITCH: 'off', IP_SALT: 'test-salt' },
  ratelimits: {
    RATE: { namespace_id: '7101', simple: { limit: 1000, period: 60 } },
    TIGHT: { namespace_id: '7102', simple: { limit: 2, period: 60 } },
  },
} as const;
export default defineConfig({
  plugins: [erased(), bytes(), cloudflareTest({ main: './src/index.ts', miniflare })],
  server: { fs: { allow: ['..'] } },
});
