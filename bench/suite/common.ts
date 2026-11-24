// bench/suite/common.ts: what every workload of the suite shares: compiling a Tape program with std, a seeded
// random source, and the ways a request is answered (Tape with the effect log on, as it ships; Tape with it off;
// the JS twin), each on an in-memory SQLite database of its own (nodesql.ts, node:sqlite).
import '../../node25.ts';
import { readFileSync } from 'node:fs';
import { compile } from '../../compiler.ts';
import { instantiate } from '../../host.ts';
import { nodeSql } from '../../nodesql.ts';
import type { NodeSql } from '../../nodesql.ts';
import { std } from '../../std.ts';

export const ROOT = new URL('../../', import.meta.url).pathname;
export { dec, enc, rng } from './rand.ts';

/** A Tape program of the repository (path from the root), compiled with std. */
export function tapeModule(path: string): WebAssembly.Module {
  const r = compile([...std, { name: path, text: readFileSync(`${ROOT}${path}`, 'utf8') }]);
  if (!r.wasm) throw new Error(`${path}: ${r.errors.map(e => `${e.line} ${e.code} ${e.message}`).join('; ')}`);
  return new WebAssembly.Module(r.wasm);
}

/** One way to answer a request: bytes in, bytes out. `reset` gives it a fresh database. */
export type Way = { name: string; run: (req: Uint8Array) => Uint8Array | Promise<Uint8Array> };
export type Workload = {
  name: string;
  /** what one request is, at the benchmark size */
  describe: string;
  /** Tape program (path from the repository root). With `more`, this file is compiled first, so its `handle` is the
   * export when a later file also has one */
  tape: string;
  /** compiled after `tape`, in order */
  more?: readonly string[];
  /** a new database for every measured request: a write that fills a cache would be a hit the next time */
  fresh?: boolean;
  /** run on the database before the measured request, and not timed. `k` is that request's index */
  opening?: (k: number) => Uint8Array[];
  /** pinned `Date.now`, milliseconds since 1970. A date the program formats is then one number, and a year loop does
   * not move on New Year's Day */
  now?: number;
  /** false: no JS twin. The tape/js table skips it; profile it with tape-nolog */
  twin?: boolean;
  /** uses SQL */
  sql: boolean;
  /** called once on each fresh database, after the Tape schema has run (the JS twin's schema is its own) */
  seed?: (db: NodeSql) => void;
  /** the JS twin's setup on its database: its schema; returns its handler */
  js: (db: NodeSql | null) => (req: Uint8Array) => Uint8Array;
  /** the generated inputs whose answers must be the same (≥100) */
  inputs: () => Uint8Array[];
  /** a request at `scale` (1 = the benchmark size); successive k give fresh requests (new keys) */
  request: (k: number, scale: number) => Uint8Array;
};

export type Mode = 'js' | 'tape-log' | 'tape-nolog';
/** A fresh database and a way of `mode` on it. */
export function makeWay(w: Workload, mode: Mode, module: WebAssembly.Module | null): Way['run'] {
  const db = w.sql ? nodeSql() : null;
  if (mode === 'js') {
    const h = w.js(db);
    if (db) w.seed?.(db);
    return db ? req => db.transaction(() => h(req)) : h;
  }
  if (!module) throw new Error('no module');
  const app = instantiate(module, { ...(db ? { sql: db } : {}), name: w.name, log: mode === 'tape-log' });
  if (db) w.seed?.(db);
  if (mode === 'tape-nolog') return db ? req => app.handleIn(f => db.transaction(f), req) : req => app.handle(req);
  return async req => (await app.runLogged(req, db ? { transaction: f => db.transaction(f) } : {})).out;
}

/** The workload's own files, `tape` first. */
export function sourcesOf(w: { tape: string; more?: readonly string[] }): readonly string[] {
  return [w.tape, ...(w.more ?? [])];
}

const GATE = new Set(['corpus/md.tape', 'corpus/blog.tape']);
/** How a workload is compiled. The six keep the path the suite has always passed. The renderer and the blog are
 * named by their basename, which is what test/wasm-size.ts passes, so a profile is of the module the size gate
 * measures. */
export function programFiles(paths: readonly string[]): { name: string; text: string }[] {
  const gate = paths.some(p => GATE.has(p));
  return paths.map(p => ({
    name: gate ? p.slice(p.lastIndexOf('/') + 1) : p,
    text: readFileSync(`${ROOT}${p}`, 'utf8'),
  }));
}

/** `opening` requests, in order, before a measured one. */
export async function prime(
  w: Pick<Workload, 'opening'>,
  run: (req: Uint8Array) => Uint8Array | Promise<Uint8Array>,
  k = 0,
): Promise<void> {
  for (const req of w.opening?.(k) ?? []) await run(req);
}

export const median = (a: readonly number[]): number => a.toSorted((x, y) => x - y)[a.length >> 1] ?? 0;
export const quantile = (a: readonly number[], q: number): number =>
  a.toSorted((x, y) => x - y)[Math.min(a.length - 1, Math.floor(q * a.length))] ?? 0;
