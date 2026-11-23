import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { erased } from '../service/erased.ts';
import { bytes } from './bytes.ts';

// The plugin does not read cloudflare.config.ts bindings yet, so they are declared again here. TIGHT is a second
// rate limit, of two calls a minute, for the test that sees the real binding refuse.
const miniflare = {
  workerLoaders: { LOADER: {} },
  bindings: { KILL_SWITCH: 'off', IP_SALT: 'test-salt', VERSION: { id: 'test-version', tag: '', timestamp: '' } },
  r2Buckets: { FEEDBACK: 'tape-feedback' },
  ratelimits: {
    RATE: { namespace_id: '7101', simple: { limit: 1000, period: 60 } },
    FEEDBACK_RATE: { namespace_id: '7103', simple: { limit: 1000, period: 60 } },
    TIGHT: { namespace_id: '7102', simple: { limit: 2, period: 60 } },
  },
} as const;
export default defineConfig({
  plugins: [erased(), bytes(), cloudflareTest({ main: './src/index.ts', miniflare })],
  server: { fs: { allow: ['..'] } },
  // vitest's default 5 s per test is a wall-clock budget a loaded machine can spend on a few compiles; no test's
  // property is how fast it ran, so the budget is only there to end a hung run
  test: { testTimeout: 120_000, hookTimeout: 120_000 },
});
