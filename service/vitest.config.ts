import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { erased } from './erased.ts';

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
  },
  durableObjects: { NAMES: { className: 'Name', useSQLite: true } },
  // tape-mcp stands in as an echo of the request it is given (test/mcp-route.test.ts)
  serviceBindings: {
    MCP: async (request: Request): Promise<Response> =>
      Response.json(
        {
          method: request.method,
          url: request.url,
          headers: Object.fromEntries(request.headers),
          body: await request.text(),
        },
        { status: 299, headers: { 'tape-mcp-version': 'echo' } },
      ),
  },
};
// Files run one at a time: some tests give a call a 50 ms budget, which a cold Durable Object meets only when another
// test file is not loading the machine at the same time.
export default defineConfig({
  plugins: [erased(), cloudflareTest({ main: './src/index.ts', miniflare })],
  test: { fileParallelism: false },
});
