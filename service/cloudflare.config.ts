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
    // Each version has its own cache (no crossVersionCache): with one shared cache, a new version answered / and
    // /playground/ from the cache the version before filled (tape-version of the old commit, seen by the pinned
    // smoke of d9e16de1, 2026-11-22), and could answer a page whose hashed files it does not have. A deploy costs a
    // cold cache: the Wasm of each version is fetched from its object again, once per location.
    cache: { enabled: true },
    env: {
      LOADER: bindings.workerLoader(),
      TOKEN: bindings.secret(),
      VERSION: bindings.versionMetadata(),
      // The hosted compiler and runner (docs/mcp.md, mcp/src): /mcp and /v1/{compile,run,feedback}, served in this
      // Worker (it was the tape-mcp Worker until 2026-11-22; these bindings are its, with the same names and ids).
      // LOADER above also runs its programs, under names that start tape-mcp/ (the service's are account/name/...).
      // RATE is per client IP (a hash of it), per Cloudflare location; namespace 7101 as before, so limits carry on.
      RATE: bindings.rateLimit({ namespace: '7101', simple: { limit: 60, period: 60 } }),
      // "on" refuses every hosted call (503); the rest of the Worker is not affected
      KILL_SWITCH: bindings.text('off'),
      // a secret, set with `cf` (docs/mcp.md), never here: client addresses are hashed with it and the UTC day.
      // Without it the hosted routes refuse every call (503).
      IP_SALT: bindings.secret(),
      // the private bucket feedback reports are stored in (no public access, no r2.dev URL), and feedback's own limit,
      // 5 reports a minute per client (FEEDBACK.perMinute in mcp/src/feedback.ts)
      FEEDBACK: bindings.r2({ name: 'tape-feedback' }),
      FEEDBACK_RATE: bindings.rateLimit({ namespace: '7103', simple: { limit: 5, period: 60 } }),
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
