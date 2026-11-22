// host.ts: runs a Tape module against Durable Object SQLite (ctx.storage.sql). No Node APIs: works in workerd,
// Node and the browser.
//   const app = instantiate(module, { sql, services });   // runs the module's schema statements once
//   const out = app.handle(requestBytes);           // Uint8Array; app.effects is that request's effect log
//   const out = await app.run(requestBytes, { transaction, deadlineMs });   // for handlers that make calls;
//                                                    // runLogged returns { out, effects }
//   replay(module, requestBytes, effects)           // the same response from the log alone, or throws on divergence
// Every host call is logged (axiom 1); pass { log: false } to turn that off (not for handlers that make calls).
// The log's first entry names the build that made it; replaying it through another build is refused.
// Flags: app.setFlags({ name: value }) between requests; each request's log starts with the values it ran under.
//
// A module with exported methods is a callee: await app.serve({ method, fingerprint, key, withinMs }, bytes,
// { transaction }) checks the fingerprint (answering skew, and running nothing, when the two sides differ),
// answers a repeated key from its `_calls` table, and otherwise runs the method and stores the reply in the same
// transaction. `key` is set for a command (`call ... once:`): the caller's `name`, the method and the program's
// key; the callee runs a key at most once and repeats its stored reply.
//
// The parts are in host/: the effect log (log), what is read from and written into the module's memory (memory),
// a call out (call), a linked module and its runs (run), migrations and machine triggers (schema).
import { link, listed } from './host/run.ts';
import type { App, Heap, LinkOptions } from './host/run.ts';
import type { Effect, Sql, TraceEvent } from './host/log.ts';
import { dropMachines, installMachines, migrate } from './host/schema.ts';
import type { Link, MachineSpec, Migrated } from './host/schema.ts';

export { NO_TIMERS, TimedOut } from './host/call.ts';
export type { Service, ServiceOptions, ServiceReply, Timers } from './host/call.ts';
export { isCall, isEffect, isHead, isNow, isRandom, isSql, isWake, spans } from './host/log.ts';
export type { Cell, Effect, Flags, Head, Packed, Sql, SqlParam, Status, TraceEvent } from './host/log.ts';
export { MAX_WAKE_MS } from './host/run.ts';
export type { App, Broken, Observed, Ran, RunOptions, Served, Woken } from './host/run.ts';
export {
  MACHINE_PREFIX,
  columns,
  dropMachines,
  installMachines,
  machineTriggers,
  machineTriggersIn,
  migrate,
  removalError,
  removedBy,
} from './host/schema.ts';
export type { MachineSpec, Migrated, Transaction } from './host/schema.ts';

// A program's answer: `STATUS LF BODY`, or `STATUS SP TYPE LF BODY` with TYPE one of CONTENT_TYPES (std/http's
// respond_as). Output whose first line is neither is all body, with status 200 (as before content types). The type
// is a closed list, so a program cannot send a header the service does not mean to send (no `text/html;
// x-injected: …`, no types a browser runs as script beyond the page itself).
export const CONTENT_TYPES = new Map([
  ['text/plain', 'text/plain; charset=utf-8'],
  ['text/html', 'text/html; charset=utf-8'],
  ['application/json', 'application/json'],
  ['text/css', 'text/css; charset=utf-8'],
  ['image/svg+xml', 'image/svg+xml'],
]);
const HEAD = /^([1-5][0-9][0-9])(?: ([a-z+/]+))?$/;
export function responseOf(out: Uint8Array): { status: number; type: string | undefined; body: Uint8Array } {
  const nl = out.indexOf(10);
  const m = nl > 0 && nl <= 32 ? HEAD.exec(new TextDecoder().decode(out.subarray(0, nl))) : null;
  const type = m?.[2];
  if (!m || (type !== undefined && !CONTENT_TYPES.has(type)))
    return { status: 200, type: CONTENT_TYPES.get('text/plain'), body: out };
  return { status: Number(m[1]), type: CONTENT_TYPES.get(type ?? 'text/plain'), body: out.subarray(nl + 1) };
}

export type InstantiateOptions = Omit<LinkOptions, 'recorded' | 'trace' | 'heap'> & {
  /** the chain to apply (the module's own by default; false to apply none, when the host has done it) */
  migrations?: readonly Link[] | false | undefined;
  /**
   * the machines whose triggers to install (the module's own by default, when this host migrates the data; false
   * to leave the triggers as they are, when the host has installed them)
   */
  machines?: readonly MachineSpec[] | false | undefined;
};

/** The host's own tables: replies to keyed commands, so a repeated key is answered without running again; timers. */
function ownTables(sql: Sql, module: WebAssembly.Module): void {
  const methods = listed<{ name: string }>(module, 'methods');
  if (methods.length > 0) {
    sql.exec(
      'CREATE TABLE IF NOT EXISTS _calls(key TEXT PRIMARY KEY, status TEXT NOT NULL, body TEXT NOT NULL, message TEXT)',
    );
    // an object made before messages were kept: add the column (its old rows stay NULL, and are replayed as before)
    if (sql.exec("SELECT 1 FROM pragma_table_info('_calls') WHERE name = 'message'").toArray().length === 0)
      sql.exec('ALTER TABLE _calls ADD COLUMN message TEXT');
  }
  if (methods.some(m => m.name === 'woken'))
    sql.exec(
      'CREATE TABLE IF NOT EXISTS _wakes(key INTEGER PRIMARY KEY, due INTEGER NOT NULL, trace TEXT, span TEXT NOT NULL)',
    );
}

/** The module's schema statements and migrations run on the database, with its machines' triggers put back after. */
function prepare(sql: Sql, module: WebAssembly.Module, { migrations, machines }: InstantiateOptions): Migrated[] {
  const own =
    machines === false || (migrations === false && machines === undefined)
      ? null
      : (machines ?? listed<MachineSpec>(module, 'machines'));
  if (own) dropMachines(sql);
  for (const s of listed<string>(module, 'schema')) sql.exec(s);
  const chain = migrations === false ? [] : (migrations ?? listed<Link>(module, 'migrations'));
  const migrated = chain.length > 0 ? migrate(sql, chain) : [];
  if (own) installMachines(sql, own);
  ownTables(sql, module);
  return migrated;
}

export function instantiate(
  module: WebAssembly.Module,
  options: InstantiateOptions = {},
): App & { migrated: Migrated[] } {
  const { sql, log, services, name, sink, random, timers, observe } = options;
  const migrated = sql ? prepare(sql, module, options) : [];
  const given = { sql, log, services, name, sink, random, timers, observe };
  const set = Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined));
  return Object.assign(link(module, set), { migrated });
}

export function replay(module: WebAssembly.Module, bytes: Uint8Array | null, effects: Effect[]): Uint8Array {
  const app = link(module, { recorded: effects });
  const out = app.handle(bytes);
  if (app.replayed() !== effects.length)
    throw new Error(
      `replay diverged: the program made ${app.replayed()} host calls, the recording has ${effects.length}`,
    );
  return out;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// A full trace of one request, made after the fact: run a build compiled with { trace: true } against the
// request's effect log. The live request pays nothing. Events, in order: { site, what } (what 2: function
// entered; 0: arm or step tried; 1: matched; sites are in the compile result), { sql, p, r | rows }, { json },
// { call, method, within, status }. For a method's log (one served to another object), `bytes` may be null: the
// message it was sent is in the log.
export function traceOf(
  tracedModule: WebAssembly.Module,
  bytes: Uint8Array | null,
  effects: Effect[],
): { events: TraceEvent[]; out: Uint8Array | null; error: string | null } {
  const events: TraceEvent[] = [];
  const app = link(tracedModule, { recorded: effects, trace: events });
  try {
    return { events, out: app.handle(bytes), error: null };
  } catch (e) {
    return { events, out: null, error: messageOf(e) };
  }
}

// Where a request's memory went, made after the fact like a trace: run a build compiled with { profile: true }
// against the request's effect log. `functions` is largest first; `from` is the callers, by bytes.
export function heapOf(profiledModule: WebAssembly.Module, bytes: Uint8Array | null, effects: Effect[]) {
  const heap: Heap = { total: 0, by: new Map() };
  const app = link(profiledModule, { recorded: effects, heap });
  let error: string | null = null;
  try {
    app.handle(bytes);
  } catch (e) {
    error = messageOf(e);
  }
  const functions = [...heap.by.values()]
    .toSorted((a, b) => b.bytes - a.bytes)
    .map(r => ({
      fn: r.fn,
      bytes: r.bytes,
      count: r.count,
      share: r.bytes / heap.total,
      from: [...r.from]
        .toSorted((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([fn, size]) => ({ fn, bytes: size })),
    }));
  return { total: heap.total, functions, error };
}
