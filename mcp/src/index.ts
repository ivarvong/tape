// tape-mcp: the hosted compiler and runner (docs/mcp.md). This file is what only workerd has: the standard library
// and examples/hello.tape as text, sql.js's Wasm as a module, and the Loader. The rest is serve.ts and tools.ts.
//
// A Worker cannot compile Wasm at run time (WebAssembly.compile and new WebAssembly.Module are refused), so a
// program's build is run in a Dynamic Worker: the Loader is given its bytes as a module, with runner.ts, the host
// and sql.js beside it (loaded.ts is its main module). That Worker has no network and no bindings, and a CPU limit.
// Its code is cached by the build's hash, so the same program sent again runs in the same warm isolate; each call
// still gets a fresh database.
import { STD } from '../../service/src/build.ts';
import helloText from '../../examples/hello.tape?raw';
import sqlite3Base64 from '../../apps/playground/vendor/sql.js-1.10.3/sql-wasm.wasm?base64';
import sqlJsText from '../../apps/playground/vendor/sql.js-1.10.3/sql-wasm.js?raw';
import loadedSrc from './loaded.ts?erased';
import runnerSrc from './runner.ts?erased';
import sqliteSrc from '../../apps/playground/src/sqlite.ts?erased';
import hostSrc from '../../host.ts?erased';
import hostCall from '../../host/call.ts?erased';
import hostExamples from '../../host/examples.ts?erased';
import hostLog from '../../host/log.ts?erased';
import hostMemory from '../../host/memory.ts?erased';
import hostRun from '../../host/run.ts?erased';
import hostSchema from '../../host/schema.ts?erased';
import { serve } from './serve.ts';
import { LIMITS } from './tools.ts';
import type { Deps, Program } from './tools.ts';
import type { RanAll, RunRequest, Scripts } from './runner.ts';
import type { Runner } from './loaded.ts';
import type { Called } from '../../host/examples.ts';
import type { Store } from './feedback.ts';

const MODULES = {
  'loaded.js': loadedSrc,
  'runner.js': runnerSrc,
  'sqlite.js': sqliteSrc,
  // sql.js is a script that defines initSqlJs (and assigns `module`); as a module it declares `module` and exports
  // initSqlJs, as the playground's build does (apps/playground/build.ts). workerd has a `process` global, which
  // sql.js reads as Node (and then calls require): here it is hidden.
  'sql-wasm.js': `var module;\nvar process;\n${sqlJsText}\nexport default initSqlJs;\n`,
  'host.js': hostSrc,
  'host/call.js': hostCall,
  'examples.js': hostExamples,
  'host/log.js': hostLog,
  'host/memory.js': hostMemory,
  'host/run.js': hostRun,
  'host/schema.js': hostSchema,
};
/** sql.js's Wasm, for the Dynamic Worker's modules: decoded once per isolate. */
const sqlite3 = Uint8Array.from(atob(sqlite3Base64), c => c.codePointAt(0) ?? 0);
const enc = new TextEncoder();
const hexOf = (buf: ArrayBuffer): string => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
/** The runner's own code, hashed once per isolate: a Loader name changes when the code it would load does. */
let codeHash: Promise<string> | null = null;
const codeOf = (): Promise<string> =>
  (codeHash ??= crypto.subtle
    .digest('SHA-256', enc.encode(Object.values(MODULES).join('\0')))
    .then(b => hexOf(b).slice(0, 16)));

/** The Dynamic Worker that runs a build (and, for a line trace, its traced build), by their hash: warm when sent again. */
async function runnerOf(env: Env, program: Uint8Array, traced: Uint8Array) {
  const both = new Uint8Array(program.length + traced.length);
  both.set(program);
  both.set(traced, program.length);
  const wasm = hexOf(await crypto.subtle.digest('SHA-256', both)).slice(0, 32);
  const worker = env.LOADER.get(`tape-mcp/${await codeOf()}/${wasm}`, () => ({
    compatibilityDate: '2026-11-13',
    mainModule: 'loaded.js',
    globalOutbound: null,
    limits: { cpuMs: LIMITS.cpuMs, subRequests: 0 },
    modules: {
      ...MODULES,
      'sqlite3.wasm': { wasm: sqlite3 },
      'program.wasm': { wasm: program },
      'traced.wasm': { wasm: traced },
    },
  }));
  return worker.getEntrypoint<Runner>('Runner', { limits: { cpuMs: LIMITS.cpuMs, subRequests: 0 } });
}

const runIn =
  (env: Env) =>
  async (program: Program, requests: readonly RunRequest[], remotes: Scripts = {}): Promise<RanAll> => {
    const traced = program.traced ?? program.wasm;
    const runner = await runnerOf(env, program.wasm, traced);
    return runner.run([...requests], program.traced !== undefined, remotes);
  };
/** A doc examples build (doctest.ts), its functions called in a Dynamic Worker: this Worker cannot compile Wasm. */
const examplesIn =
  (env: Env) =>
  async (wasm: Uint8Array, fns: readonly string[]): Promise<Called[]> =>
    (await runnerOf(env, wasm, wasm)).examples([...fns]);

/** The commit this deploy was built from (vite.config.ts), as the tape-version header and MCP's serverInfo.version. */
const RELEASE = typeof TAPE_VERSION === 'string' ? TAPE_VERSION : 'dev';

/** Feedback reports: one private R2 object each (feedback.ts), behind their own rate limit. */
const feedbackStore = (bucket: R2Bucket, limiter: RateLimit | null): Store => ({
  put: async (key, body) => {
    await bucket.put(key, body, { httpMetadata: { contentType: 'application/json' } });
  },
  limiter,
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    void ctx;
    const deps: Deps = {
      std: STD,
      hello: { name: 'hello.tape', text: helloText },
      run: runIn(env),
      examples: examplesIn(env),
    };
    const res = await serve(request, deps, {
      killSwitch: env.KILL_SWITCH,
      salt: env.IP_SALT,
      limiter: env.RATE,
      feedback: feedbackStore(env.FEEDBACK, env.FEEDBACK_RATE),
      version: env.VERSION?.id ?? null,
      release: RELEASE,
      log: line => {
        console.log(JSON.stringify(line));
      },
    });
    // which version of tape-mcp answered: for the deploy's pinned smoke, and through the tape Worker's binding
    if (env.VERSION) res.headers.set('tape-mcp-version', env.VERSION.id);
    // the commit and the compiler built in (vite.config.ts), as the tape Worker names its own (parity.ts)
    res.headers.set('tape-version', RELEASE);
    res.headers.set('tape-compiler', typeof TAPE_COMPILER === 'string' ? TAPE_COMPILER : 'dev');
    return res;
  },
} satisfies ExportedHandler<Env>;
