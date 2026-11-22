// loaded.ts: the main module of the Dynamic Worker that runs one program (index.ts, LOADER). The Loader gives it
// the program's Wasm and sql.js's as modules, compiled by the runtime, so nothing is compiled at run time; it has
// no network (globalOutbound: null) and no bindings. Runner.run is called over RPC by the main Worker.
import { WorkerEntrypoint } from 'cloudflare:workers';
import initSqlJs from './sql-wasm.js';
import sqlite3 from './sqlite3.wasm';
import program from './program.wasm';
import { runAll, startSqlite } from './runner.ts';
import type { RanAll } from './runner.ts';

export class Runner extends WorkerEntrypoint {
  async run(requests: string[]): Promise<RanAll> {
    await startSqlite(initSqlJs, sqlite3);
    return runAll(program, requests);
  }
}
export default {
  fetch: (): Response => new Response(null, { status: 404 }),
};
