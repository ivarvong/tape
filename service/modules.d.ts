// What the bundler gives for an import with a query: `?raw` is the file's text; `?erased` is a TypeScript file's
// text as JavaScript (erased.ts).
declare module '*?raw' {
  const text: string;
  export default text;
}
declare module '*?erased' {
  const text: string;
  export default text;
}
// a `.wasm` import is a module of a Dynamic Worker (mcp/src/loaded.ts), compiled by the runtime when it loads it
declare module '*.wasm' {
  const module: WebAssembly.Module;
  export default module;
}
// `?base64` is a file's bytes as base64 (mcp/bytes.ts): sql.js's Wasm, for the hosted runner's Dynamic Workers
declare module '*?base64' {
  const base64: string;
  export default base64;
}

// The rows of a Durable Object SQLite cursor, raw(), have toArray() in workerd; the generated type (an
// IterableIterator) leaves it out.
interface SqlStorageCursor<T extends Record<string, SqlStorageValue>> {
  raw<U extends SqlStorageValue[]>(): IterableIterator<U> & { toArray: () => U[] };
}

// What the runtime gives this Worker (cloudflare.config.ts), and what it exports: ctx.exports.Name is the
// namespace of the Name Durable Object, ctx.exports.Calls is a loopback binding.
declare namespace Cloudflare {
  interface Env {
    LOADER: WorkerLoader;
    TOKEN: string;
    /** where each published program has an origin of its own, <name>--<account>.<PROGRAM_DOMAIN> (session.ts); unset,
     * none has (the deploy step is in docs/service.md) */
    PROGRAM_DOMAIN?: string;
    // the version this is (cloudflare.config.ts); the tests have none
    VERSION?: WorkerVersionMetadata;
    // the hosted compiler and runner (mcp/src, cloudflare.config.ts)
    RATE: RateLimit;
    KILL_SWITCH: string;
    /** a Worker secret: what client addresses are hashed with (mcp/src/serve.ts, ipHash) */
    IP_SALT?: string;
    FEEDBACK: R2Bucket;
    FEEDBACK_RATE: RateLimit;
    // a second limiter, of two calls a minute, for the tests only (vitest.config.ts)
    TIGHT?: RateLimit;
    // the tests' seeds and switches (vitest.config.ts)
    JEPSEN_SEEDS: string;
    KV_SEEDS: string;
    DUMP_SEEDS: string;
    DUMP_REPEAT: string;
    U3: string;
    PARITY_SEEDS: string;
    SEAMS_SLICES: string;
    // which copy of the machine plant this is (verify/plant/machine.ts)
    MACHINE_PLANT?: string;
    // the Name namespace by another binding, for runInDurableObject (vitest.config.ts)
    NAMES: DurableObjectNamespace;
  }
  interface GlobalProps {
    // oxlint-disable-next-line typescript/consistent-type-imports -- an ambient declaration cannot import
    mainModule: typeof import('./src/index.ts');
    durableNamespaces: 'Name';
  }
}
type Env = Cloudflare.Env;

// workerd has WebAssembly.compile and refuses to compile bytes with it at runtime (test/service.test.ts checks
// that it does); the generated types leave it out.
declare namespace WebAssembly {
  function compile(bytes: BufferSource): Promise<Module>;
}

// The commit the Worker was built from (vite.config.ts define); a build without it (the tests) has none.
declare const TAPE_VERSION: string | undefined;
declare const TAPE_COMPILER: string | undefined;
