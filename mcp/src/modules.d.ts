// What the bundler gives for an import with a query (../service/erased.ts): `?raw` is the file's text; `?erased`
// is a TypeScript file's text as JavaScript; `?base64` is a file's bytes as base64 (bytes.ts). A `.wasm` import is
// the module, compiled by the runtime when it loads the Dynamic Worker (loaded.ts), whose modules index.ts names.
declare module '*?base64' {
  const base64: string;
  export default base64;
}
declare module '*?raw' {
  const text: string;
  export default text;
}
declare module '*?erased' {
  const text: string;
  export default text;
}
declare module '*.wasm' {
  const module: WebAssembly.Module;
  export default module;
}

// What the runtime gives this Worker (cloudflare.config.ts), and what it exports.
declare namespace Cloudflare {
  interface Env {
    LOADER: WorkerLoader;
    RATE: RateLimit;
    KILL_SWITCH: string;
    /** a Worker secret: what client addresses are hashed with (serve.ts, ipHash) */
    IP_SALT?: string;
    /** the version this is (cloudflare.config.ts): its id is the tape-mcp-version header */
    VERSION?: WorkerVersionMetadata;
    /** feedback reports, one object each: a private bucket (cloudflare.config.ts) */
    FEEDBACK: R2Bucket;
    /** feedback's own rate limit, per client */
    FEEDBACK_RATE: RateLimit;
    // a second limiter, of two calls a minute, for the tests only (vitest.config.ts)
    TIGHT?: RateLimit;
  }
  interface GlobalProps {
    // oxlint-disable-next-line typescript/consistent-type-imports -- an ambient declaration cannot import
    mainModule: typeof import('./index.ts');
  }
}
type Env = Cloudflare.Env;

// workerd has WebAssembly.compile and refuses to compile bytes with it at run time (test/worker.test.ts checks that
// it does); the generated types leave it out.
declare namespace WebAssembly {
  function compile(bytes: BufferSource): Promise<Module>;
}
