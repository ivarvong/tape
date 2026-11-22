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
    env: {
      LOADER: bindings.workerLoader(),
      TOKEN: bindings.secret(),
      VERSION: bindings.versionMetadata(),
      // the hosted compiler and runner (docs/mcp.md): /mcp, /v1/compile and /v1/run are passed to tape-mcp as they came
      MCP: bindings.worker({ worker: 'tape-mcp' }),
    },
    // the homepage and the playground (scripts/site.ts, Vite's public directory in vite.config.ts): a request for
    // one of their files is answered from them with their _headers; any other request reaches the Worker
    assets: { htmlHandling: 'auto-trailing-slash', notFoundHandling: 'none' },
    exports: {
      default: exports.worker({ cache: { enabled: false } }),
      Wasm: exports.worker({ cache: { enabled: true } }),
      Name: exports.durableObject({ storage: 'sqlite' }),
    },
  },
});
