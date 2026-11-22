import { bindings, defineConfig } from 'cf/config';

// tape-mcp: the hosted compiler and runner (docs/mcp.md). Stateless: no Durable Objects, no storage, no secrets.
// LOADER runs each posted program in a Dynamic Worker (a Worker cannot compile Wasm itself), with no network.
// RATE is per client IP (a hash of it), per Cloudflare location. KILL_SWITCH "on" refuses every call (503).
// No accountId: cf takes the account from CLOUDFLARE_ACCOUNT_ID, or the only one your login can reach, or asks.
export default defineConfig({
  worker: {
    name: 'tape-mcp',
    entrypoint: 'src/index.ts',
    compatibilityDate: '2026-11-13',
    workersDev: true,
    previewUrls: false,
    observability: { enabled: true },
    env: {
      LOADER: bindings.workerLoader(),
      RATE: bindings.rateLimit({ namespace: '7101', simple: { limit: 60, period: 60 } }),
      KILL_SWITCH: bindings.text('off'),
    },
  },
});
