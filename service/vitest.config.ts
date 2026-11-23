import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { erased } from './erased.ts';
import { bytes } from '../mcp/bytes.ts';

// The plugin does not read cloudflare.config.ts bindings or exports yet, so the loader and DO are declared again here.
const miniflare = {
  workerLoaders: { LOADER: {} },
  bindings: {
    TOKEN: 'test-token',
    JEPSEN_SEEDS: process.env.JEPSEN_SEEDS ?? '1,2,3,4',
    KV_SEEDS: process.env.KV_SEEDS ?? '1,2,3',
    DUMP_SEEDS: process.env.DUMP_SEEDS ?? '',
    DUMP_REPEAT: process.env.DUMP_REPEAT ?? '1',
    U3: process.env.U3 ?? '',
    PARITY_SEEDS: process.env.PARITY_SEEDS ?? '',
    SEAMS_SLICES: process.env.SEAMS_SLICES ?? '6',
    KILL_SWITCH: 'off',
    IP_SALT: 'test-salt',
  },
  durableObjects: { NAMES: { className: 'Name', useSQLite: true } },
  // the hosted compiler and runner's (mcp/src): as cloudflare.config.ts, with a test salt; TIGHT is a second rate
  // limit, of two calls a minute, for mcp's test that sees the real binding refuse
  r2Buckets: { FEEDBACK: 'tape-feedback' },
  ratelimits: {
    RATE: { namespace_id: '7101', simple: { limit: 1000, period: 60 } },
    FEEDBACK_RATE: { namespace_id: '7103', simple: { limit: 1000, period: 60 } },
    TIGHT: { namespace_id: '7102', simple: { limit: 2, period: 60 } },
  } as const,
};
// Files run one at a time: the Jepsen runs keep the box office's 50 ms first charge (a timeout there is one more
// outcome they check), and the faults' waits are tens of ms; another file loading the machine moves both. Tests that
// need that charge answered run it with room (test/help.ts roomy), so their outcomes do not depend on the load.
export default defineConfig({
  plugins: [erased(), bytes(), cloudflareTest({ main: './src/index.ts', miniflare })],
  test: { fileParallelism: false },
});
