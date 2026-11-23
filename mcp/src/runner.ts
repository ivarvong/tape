// runner.ts: one program's requests, in order, against one fresh in-memory SQLite database (sql.js, through the
// playground's src/sqlite.ts), with the host the service and the playground use (host.ts). Each request is then
// replayed from its effect log through the same build, and the answer compared byte for byte.
//
// It runs where the program's Wasm can be instantiated: in the Dynamic Worker that loaded.ts is the main module of
// (a Worker cannot compile Wasm at run time, so the Loader is given the program's bytes as a module), and in Node
// for test.ts. It imports nothing but the host and the SQLite adapter, and no Workers API.
//
// The clock: when any request carries at_ms, the run is on a clock of its own. now() is the run's start plus that
// request's at_ms (a request without one keeps the time of the one before; the first starts at 0), and before each
// request every timer due by then runs, oldest first (`woken`, as a result of its own), so a test can step past a
// window or a retry delay. The host reads Date.now() (host/run.ts: now, wake and the due check), so the clock is
// Date.now itself, replaced for the length of the run; runs in one isolate are taken one at a time for that.
import { instantiate, isEffect, replay, traceOf } from './host.ts';
import type { App, Effect, Service, ServiceReply, TraceEvent } from './host.ts';
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

/** A request to run: its text, and when it is sent on the run's own clock (null: the clock is the real one). */
export type RunRequest = { request: string; at_ms: number | null };
/** At most this many timer runs a call: a woken that sets its own key again at once would otherwise run for ever. */
export const MAX_WOKEN = 20;

/** How one request went, as the main Worker reads it (over RPC: bytes, bigints and nested values survive). */
export type Ran = {
  request: string;
  /** on the run's own clock: when it ran, in ms from the run's start */
  at_ms?: number;
  /** a timer's run: its key, and when it was due (ms from the run's start) */
  woken?: { key: number; due_ms: number };
  /** the program's answer: `STATUS LF BODY`, or, when it trapped, null */
  out: Uint8Array | null;
  effects: Effect[];
  /** set when the run trapped: what it said; its writes were rolled back */
  failed: { status: 500; error: string; rolled_back: true } | null;
  /**
   * the run replayed from its log gave the same answer, byte for byte (or the same trap); null for a timer's run,
   * which the host's replay (of `handle` only) cannot run again
   */
  replayed: boolean | null;
  /** why the replay did not match, when it did not */
  replay_error: string | null;
  /** the reductions the run used (Tape's budget: 50,000,000) */
  steps: number;
  at: number;
  took: number;
  /**
   * when a traced build was given: the run replayed from its log through it (host.ts traceOf), its events and the
   * trap it ended in; a run past TRACE_STEPS is not traced (`too_long`, its steps). None for a timer's run.
   */
  trace?: { events: TraceEvent[]; error: string | null } | { too_long: number };
};
/** A line trace is made only for a run of at most this many steps: each step can add an event. */
export const TRACE_STEPS = 200_000;
/** Every request, or why the program could not be linked to a database (a schema statement SQLite refused). */
export type RanAll =
  { ok: true; runs: Ran[]; timers?: { fired: number; pending: number } } | { ok: false; error: string };

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

const asRequest = (r: string | RunRequest): RunRequest => (typeof r === 'string' ? { request: r, at_ms: null } : r);
/** One run at a time in this isolate: a run on its own clock replaces Date.now while it runs. */
let queue: Promise<unknown> = Promise.resolve();

/** Run each request in order against one fresh database, then free it. */
export function runAll(
  module: WebAssembly.Module,
  requests: readonly (string | RunRequest)[],
  traced: WebAssembly.Module | null = null,
): Promise<RanAll> {
  const mine = queue.then(() => runInOrder(module, requests.map(asRequest), traced));
  queue = mine.catch(() => null);
  return mine;
}

/** A due timer's run: `woken` with Wake(key), its answer as a response (200 and Ok's JSON, or 500 and Err's text). */
async function wokenRun(app: App, db: NodeSql, key: number, due: number, start: number, now: number): Promise<Ran> {
  const request = `woken ${JSON.stringify({ key })}`,
    at = Date.now();
  let out: Uint8Array | null = null,
    effects: Effect[] = [],
    failed: Ran['failed'] = null;
  try {
    const w = await app.wake(key, { transaction: f => db.transaction(f), now });
    if (w) {
      effects = w.effects;
      const head = w.status === 'ok' ? '200 application/json\n' : '500\n';
      out = new Uint8Array([...enc.encode(head), ...w.body]);
    }
  } catch (e) {
    effects = loggedOf(e);
    failed = { status: 500, error: messageOf(e), rolled_back: true };
  }
  return {
    request,
    at_ms: now - start,
    woken: { key, due_ms: due - start },
    out,
    effects,
    failed,
    replayed: null,
    replay_error: null,
    steps: stepsOf(app.exports),
    at,
    took: Date.now() - at,
  };
}

/** The timers set, each key with when it is due. */
const dueTimes = (db: NodeSql): Map<number, number> => {
  try {
    const rows = db.exec('SELECT key, due FROM _wakes ORDER BY due, key').toArray();
    return new Map(rows.map(r => [Number(r['key']), Number(r['due'])]));
  } catch {
    return new Map();
  }
};

/** The run again from its log, through the traced build: what the line trace is made of. */
function lineTrace(
  traced: WebAssembly.Module,
  bytes: Uint8Array,
  effects: Effect[],
  steps: number,
): NonNullable<Ran['trace']> {
  if (steps > TRACE_STEPS) return { too_long: steps };
  const t = traceOf(traced, bytes, effects);
  return { events: t.events, error: t.error };
}

async function runInOrder(
  module: WebAssembly.Module,
  requests: readonly RunRequest[],
  traced: WebAssembly.Module | null,
): Promise<RanAll> {
  const own = requests.some(r => r.at_ms !== null);
  const realNow = Date.now,
    start = realNow();
  let t = 0;
  if (own) Date.now = () => start + t;
  try {
    return await runEach(module, traced, requests, own, start, (ms: number) => {
      t = ms;
    });
  } finally {
    Date.now = realNow;
  }
}

async function runEach(
  module: WebAssembly.Module,
  traced: WebAssembly.Module | null,
  requests: readonly RunRequest[],
  own: boolean,
  start: number,
  setClock: (ms: number) => void,
): Promise<RanAll> {
  const db: NodeSql = nodeSql();
  try {
    let app: ReturnType<typeof instantiate>;
    try {
      app = instantiate(module, { sql: db, name: NAME, services, random: seeded(7) });
    } catch (e) {
      return { ok: false, error: `the program could not be linked to a fresh database: ${messageOf(e)}` };
    }
    const runs: Ran[] = [];
    let fired = 0,
      last = 0;
    for (const { request, at_ms } of requests) {
      if (own) {
        last = at_ms ?? last;
        setClock(last);
        const now = start + last;
        // every timer due by now, oldest first; one a woken sets that is due already runs too
        for (let key = app.due(now)[0]; key !== undefined && fired < MAX_WOKEN; key = app.due(now)[0]) {
          fired++;
          runs.push(await wokenRun(app, db, key, dueTimes(db).get(key) ?? now, start, now));
        }
      }
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
        ...(own ? { at_ms: last } : {}),
        out,
        effects,
        failed,
        ...replayed(module, bytes, effects, out, failed?.error ?? null),
        steps,
        at,
        took,
        ...(traced === null ? {} : { trace: lineTrace(traced, bytes, effects, steps) }),
      });
    }
    return own ? { ok: true, runs, timers: { fired, pending: dueTimes(db).size } } : { ok: true, runs };
  } finally {
    db.close();
  }
}
