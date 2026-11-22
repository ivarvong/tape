import { bindings, defineConfig } from 'cf/config';

// tape-mcp: the hosted compiler and runner (docs/mcp.md). No Durable Objects; one bucket, written only by the feedback
// tool; one secret.
// FEEDBACK is the private bucket feedback reports are stored in (no public access, no r2.dev URL); FEEDBACK_RATE
// is the feedback tool's own limit, 5 reports a minute per client (FEEDBACK.perMinute in src/feedback.ts).
// VERSION is the version's metadata: every answer names it (tape-mcp-version).
// LOADER runs each posted program in a Dynamic Worker (a Worker cannot compile Wasm itself), with no network.
// RATE is per client IP (a hash of it), per Cloudflare location. KILL_SWITCH "on" refuses every call (503).
// IP_SALT is a secret, set with `cf` (docs/mcp.md), never here: the hash of a client's address is salted with it and
// the UTC day. Without it the Worker refuses every call (503).
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
      IP_SALT: bindings.secret(),
      VERSION: bindings.versionMetadata(),
      FEEDBACK: bindings.r2({ name: 'tape-feedback' }),
      FEEDBACK_RATE: bindings.rateLimit({ namespace: '7103', simple: { limit: 5, period: 60 } }),
    },
  },
});
