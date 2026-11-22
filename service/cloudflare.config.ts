import { bindings, defineConfig, exports } from 'cf/config';

// No accountId: cf takes the account from CLOUDFLARE_ACCOUNT_ID, or the only one your login can reach, or asks.
export default defineConfig({
  worker: {
    name: 'tape',
    entrypoint: 'src/index.ts',
    compatibilityDate: '2026-11-13',
    workersDev: true,
    previewUrls: false,
    observability: { enabled: true },
    cache: { enabled: true, crossVersionCache: true },
    env: { LOADER: bindings.workerLoader(), TOKEN: bindings.secret() },
    exports: {
      default: exports.worker({ cache: { enabled: false } }),
      Wasm: exports.worker({ cache: { enabled: true } }),
      Name: exports.durableObject({ storage: 'sqlite' }),
    },
  },
});
