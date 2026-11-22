// runner.ts: one program's requests, in order, against one fresh in-memory SQLite database (sql.js, through the
// playground's src/sqlite.ts), with the host the service and the playground use (host.ts). Each request is then
// replayed from its effect log through the same build, and the answer compared byte for byte.
//
// It runs where the program's Wasm can be instantiated: in the Dynamic Worker that loaded.ts is the main module of
// (a Worker cannot compile Wasm at run time, so the Loader is given the program's bytes as a module), and in Node
// for test.ts. It imports nothing but the host and the SQLite adapter, and no Workers API.
import { instantiate, isEffect, replay } from './host.ts';
import type { Effect, Service, ServiceReply } from './host.ts';
import { loadSqlite, nodeSql, sqliteReady } from './sqlite.ts';
import type { InitSqlJs, NodeSql, SqlJs } from './sqlite.ts';

/** sql.js's init, given a hook that instantiates its Wasm from a module compiled already. */
export type SqlJsInit = (config: {
  wasmBinary?: ArrayBuffer;
  instantiateWasm: (
    imports: WebAssembly.Imports,
    done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
  ) => WebAssembly.Instance['exports'];
}) => Promise<SqlJs>;

/** Start sql.js once per isolate, from its module: sql.js would otherwise compile its Wasm from bytes. */
export async function startSqlite(init: SqlJsInit, module: WebAssembly.Module): Promise<void> {
  if (sqliteReady()) return;
  const viaModule: InitSqlJs = config =>
    init({
      ...config,
      instantiateWasm(imports, done) {
        const instance = new WebAssembly.Instance(module, imports);
        done(instance, module);
        return instance.exports;
      },
    });
  await loadSqlite(viaModule, new ArrayBuffer(0));
}

/** How one request went, as the main Worker reads it (over RPC: bytes, bigints and nested values survive). */
export type Ran = {
  request: string;
  /** the program's answer: `STATUS LF BODY`, or, when it trapped, null */
  out: Uint8Array | null;
  effects: Effect[];
  /** set when the run trapped: what it said; its writes were rolled back */
  failed: { status: 500; error: string; rolled_back: true } | null;
  /** the run replayed from its log gave the same answer, byte for byte (or the same trap) */
  replayed: boolean;
  /** why the replay did not match, when it did not */
  replay_error: string | null;
  /** the reductions the run used (Tape's budget: 50,000,000) */
  steps: number;
  at: number;
  took: number;
};
/** Every request, or why the program could not be linked to a database (a schema statement SQLite refused). */
export type RanAll = { ok: true; runs: Ran[] } | { ok: false; error: string };

export const NAME = 'tape-mcp/program';
/** What a call to another program gets: this service runs one program, so there is nothing to call. */
export const UNREACHABLE =
  'the hosted runner runs one program at a time: calls to other programs answer Unreachable, and run nothing';
const enc = new TextEncoder();
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const loggedOf = (e: unknown): Effect[] =>
  typeof e === 'object' && e !== null && 'effects' in e && Array.isArray(e.effects) ? e.effects.filter(isEffect) : [];
const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** random(from: entropy) is seeded per call (the simulator's generator), so the same input gives the same output. */
export const seeded = (seed: number): (() => number) => {
  let s = seed % 2147483647 || 1;
  return () => {
    s = (s * 48271) % 2147483647;
    // 53 bits from two draws
    const hi = s % 2097152;
    s = (s * 48271) % 2147483647;
    return hi * 4294967296 + (s >>> 0);
  };
};
const unreachable: Service = (): ServiceReply => ({ status: 'unreachable', body: enc.encode(UNREACHABLE) });
const services = new Proxy({}, { get: (_t, to) => (typeof to === 'string' ? unreachable : undefined) });
const stepsOf = (exports: WebAssembly.Instance['exports']): number => {
  const g = exports['cost'];
  return g instanceof WebAssembly.Global ? Number(g.value) : 0;
};

/** Replay one request from its log through the same build: does it give the same answer, or the same trap? */
function replayed(
  module: WebAssembly.Module,
  bytes: Uint8Array,
  effects: Effect[],
  out: Uint8Array | null,
  failed: string | null,
): { replayed: boolean; replay_error: string | null } {
  try {
    const again = replay(module, bytes, effects);
    if (out !== null && same(again, out)) return { replayed: true, replay_error: null };
    return {
      replayed: false,
      replay_error:
        out === null ? `the run trapped (${failed}); its replay answered` : 'the replay answered other bytes',
    };
  } catch (e) {
    if (out === null && messageOf(e) === failed) return { replayed: true, replay_error: null };
    return { replayed: false, replay_error: messageOf(e) };
  }
}

/** Run each request in order against one fresh database, then free it. */
export async function runAll(module: WebAssembly.Module, requests: readonly string[]): Promise<RanAll> {
  const db: NodeSql = nodeSql();
  try {
    let app: ReturnType<typeof instantiate>;
    try {
      app = instantiate(module, { sql: db, name: NAME, services, random: seeded(7) });
    } catch (e) {
      return { ok: false, error: `the program could not be linked to a fresh database: ${messageOf(e)}` };
    }
    const runs: Ran[] = [];
    for (const request of requests) {
      const bytes = enc.encode(request),
        at = Date.now();
      let out: Uint8Array | null = null,
        effects: Effect[],
        failed: Ran['failed'] = null;
      try {
        const ran = await app.runLogged(bytes, { transaction: f => db.transaction(f) });
        out = ran.out;
        effects = ran.effects;
      } catch (e) {
        // a trap: its writes were rolled back; the log so far is on the error (host/run.ts, stretch)
        effects = loggedOf(e);
        failed = { status: 500, error: messageOf(e), rolled_back: true };
      }
      const steps = stepsOf(app.exports),
        took = Date.now() - at;
      runs.push({
        request,
        out,
        effects,
        failed,
        ...replayed(module, bytes, effects, out, failed?.error ?? null),
        steps,
        at,
        took,
      });
    }
    return { ok: true, runs };
  } finally {
    db.close();
  }
}
