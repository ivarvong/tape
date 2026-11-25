// loaded.ts: the main module of the Dynamic Worker that runs one program (index.ts, LOADER). The Loader gives it
// the program's Wasm and sql.js's as modules, compiled by the runtime, so nothing is compiled at run time; it has
// no network (globalOutbound: null) and no bindings. Runner.run is called over RPC by the main Worker.
import { WorkerEntrypoint } from 'cloudflare:workers';
import initSqlJs from './sql-wasm.js';
import sqlite3 from './sqlite3.wasm';
import program from './program.wasm';
import traced from './traced.wasm';
import { runAll, startSqlite } from './runner.ts';
import type { RanAll, RunRequest, Scripts } from './runner.ts';
import { callExamples } from './examples.ts';
import type { Called } from './examples.ts';

export class Runner extends WorkerEntrypoint {
  /**
   * `trace`: replay each request through traced.wasm (the build with { trace: true }) for its line trace. `runId`:
   * logged first, so the tail of this invocation (index.ts RunTail) can say which call it was.
   */
  async run(
    requests: RunRequest[],
    trace = false,
    remotes: Scripts = {},
    runId = '',
    secrets: Readonly<Record<string, string>> = {},
  ): Promise<RanAll> {
    if (runId) console.log(JSON.stringify({ 'tape-mcp.run_id': runId }));
    await startSqlite(initSqlJs, sqlite3);
    return runAll(program, requests, trace ? traced : null, remotes, secrets);
  }
  /** program.wasm is a build of doc examples (doctest.ts): call each named one (the test tool) */
  examples(fns: string[]): Called[] {
    return callExamples(program, fns);
  }
}
export default {
  fetch: (): Response => new Response(null, { status: 404 }),
};
