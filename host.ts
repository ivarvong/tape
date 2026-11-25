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
// key; the callee runs a key at most once and repeats its stored reply (to a send while it runs, once it has one).
//
// The parts are in host/: the effect log (log), what is read from and written into the module's memory (memory),
// a call out (call), a linked module and its runs (run), migrations and machine triggers (schema).
import { link, listed } from './host/run.ts';
import type { App, Heap, LinkOptions } from './host/run.ts';
import type { Effect, Sql, TraceEvent } from './host/log.ts';
import { dropMachines, installMachines, migrate } from './host/schema.ts';
import type { Link, MachineSpec, Migrated } from './host/schema.ts';

export { storageKind, transientAtEdge, transientBetween } from './host/failure.ts';
export { NO_TIMERS, TimedOut } from './host/call.ts';
export type { Service, ServiceOptions, ServiceReply, Timers } from './host/call.ts';
export { isCall, isEffect, isHead, isNow, isRandom, isSql, isWake, measuredText, spans } from './host/log.ts';
export type { Cell, Effect, Flags, Head, Packed, Sql, SqlParam, Status, TraceEvent } from './host/log.ts';
export { MAX_WAKE_MS, stepVersionOf } from './host/run.ts';
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

// A program's answer is a Response (std/http.tape): `handle` gives that value, and the function the compiler
// generates around it (compiler/gen/answer.ts) writes it in a frame, which responseOf reads. A program writes no
// byte of the frame: a body, from a request or a row, is a body, and cannot become a status or a header.
//
// The frame, every number little-endian and as wide as what it holds, so nothing is cut (a status of 65736 is
// 65736, and refused, not 200):
//   0  4 bytes  0x00 't' 'a' 'p'
//   4  1 byte   the version, 1
//   5  8 bytes  the status, signed
//   13 1 byte   the content: Content's constructor by its place in the type (Html 0, Json 1, Text 2 … Xml 8)
//   14 4 bytes  the number of headers, then for each, in the order it was set: the name's length (4 bytes), the
//               name, the value's length (4 bytes), the value
//   …           the body, to the end
// Only generated code writes it, so a frame that does not read is a bug of the host or the compiler, answered 500
// with what is wrong; there is no other form, and no "all body as 200". The module writes the head and, in place of
// the body, where the body lies (its address and length, 4 bytes each); host/memory.ts frameAt copies the head and
// the body out of its memory into this frame, so an answer costs the module its head and not a second body.
//
// The type is a closed list, so a program cannot send a header the service does not mean to send (no
// `text/html; x-injected: …`, no type a program can use to set a parameter on the header). Atom, RSS and XML
// are on the list because a feed reader or an XML client asks for them by name. Chrome renders application/xml,
// application/atom+xml and application/rss+xml as pages: a script in the XHTML or SVG namespace runs, and nosniff
// does not stop it. What stops it is the content-security-policy on every response the service gives (`sandbox`
// without `allow-scripts`, `default-src 'none'`; service/src/headers.ts). responseOf does not send that policy. A
// host that serves these types to a browser must. application/xhtml+xml is not on the list: a page is text/html
// (Html). text/xml is not, because it is obsolete and was sniffed. Text types and these three XML documents are
// labeled charset=utf-8. The host's bytes are UTF-8, and the charset overrides an encoding declaration in the
// document (`<?xml encoding="iso-8859-1"?>` is still read as UTF-8). RFC 7303 leaves the parameter optional.
// application/json and image/svg+xml carry no charset (RFC 8259; SVG is an image). The program names the
// constructor and the host writes the header, so a type cannot carry a parameter of its own.
//
// What a Response holds is checked here, for every host alike, and a Response that fails is answered 500 with the
// reason (a program that means to redirect and cannot should not answer as if it had; a status `new Response`
// throws on must not throw after the run committed): a status from 200 to 599; no body on 204, 205 or 304; each
// header a name of token characters and a value of printable ASCII (a space and a tab too: no CR, LF, NUL or byte past ASCII, which a Headers object would refuse or send as Latin-1), within the limits below, and none of those
// the host sets itself.
export const CONTENT_TYPES = new Map([
  ['text/plain', 'text/plain; charset=utf-8'],
  ['text/html', 'text/html; charset=utf-8'],
  ['application/json', 'application/json'],
  ['text/css', 'text/css; charset=utf-8'],
  ['image/svg+xml', 'image/svg+xml'],
  ['text/csv', 'text/csv; charset=utf-8'],
  ['application/atom+xml', 'application/atom+xml; charset=utf-8'],
  ['application/rss+xml', 'application/rss+xml; charset=utf-8'],
  ['application/xml', 'application/xml; charset=utf-8'],
]);
/** Content's constructors in their order in std/http.tape, as the frame's content byte names them: the media type. */
export const CONTENTS = [
  'text/html',
  'application/json',
  'text/plain',
  'text/css',
  'image/svg+xml',
  'text/csv',
  'application/atom+xml',
  'application/rss+xml',
  'application/xml',
] as const;
/** The most headers an answer may set, the longest name and value, and the most bytes of names and values. */
export const HEADER_LIMITS = { count: 32, name: 64, value: 4096, head: 16384 } as const;
/** Headers the host owns: the body's framing and type, cookies (every program shares the service's origin), and the
 * headers the service sets on every answer. */
const HOST_OWNED =
  /^(content-type|content-length|content-encoding|transfer-encoding|connection|keep-alive|upgrade|te|trailer|proxy-.*|set-cookie|set-cookie2|content-security-policy.*|x-frame-options|x-content-type-options|referrer-policy|x-robots-tag|strict-transport-security|cross-origin-.*|permissions-policy|tape-.*|cf-.*)$/;
const TOKEN = /^[!#$%&'*+.^_`|~0-9a-z-]+$/;
/** The statuses that have no body (RFC 9110 sections 15.3.5, 15.3.6, 15.4.5). */
const NO_BODY = new Set([204, 205, 304]);
const MAGIC = [0, 0x74, 0x61, 0x70];
const VERSION = 1;
export type Header = { name: string; value: string };
export type Answer = { status: number; type: string | undefined; headers: Header[]; body: Uint8Array };
const refusedAs = (text: string): Answer => ({
  status: 500,
  type: CONTENT_TYPES.get('text/plain'),
  headers: [],
  body: new TextEncoder().encode(text),
});
const refused = (why: string): Answer => refusedAs(`the program set a response header the host refuses: ${why}`);
const refusedStatus = (why: string): Answer => refusedAs(`the program answered a response the host refuses: ${why}`);
const unframed = (why: string): Answer =>
  refusedAs(`the program's answer is not a response frame (a bug in the host or the compiler): ${why}`);
/** A header, or why it is refused. */
function headerOf(name: string, value: string): Header | string {
  if (name.length === 0 || name.length > HEADER_LIMITS.name || !TOKEN.test(name))
    return `invalid header name ${JSON.stringify(name.slice(0, HEADER_LIMITS.name))}`;
  if (value.length > HEADER_LIMITS.value || /[^\t -~]/.test(value)) return `invalid header value for ${name}`;
  if (HOST_OWNED.test(name)) return `${name} is the host's to set${name === 'content-type' ? ' (use respond_as)' : ''}`;
  return { name, value };
}
/** The frame's parts, or why it does not read. */
function unframe(
  out: Uint8Array,
): { status: bigint; content: number; heads: [string, string][]; body: Uint8Array } | string {
  if (out.length < 18 || MAGIC.some((b, i) => out[i] !== b)) return `${out.length} bytes that do not start "\\0tap"`;
  if (out[4] !== VERSION) return `version ${out[4]}, not ${VERSION}`;
  const d = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const status = d.getBigInt64(5, true),
    content = out[13] ?? 255,
    count = d.getUint32(14, true);
  const dec = new TextDecoder();
  const heads: [string, string][] = [];
  let at = 18;
  const part = (): string | null => {
    if (at + 4 > out.length) return null;
    const n = d.getUint32(at, true);
    if (at + 4 + n > out.length) return null;
    const text = dec.decode(out.subarray(at + 4, at + 4 + n));
    at += 4 + n;
    return text;
  };
  for (let i = 0; i < count; i++) {
    const name = part(),
      value = name === null ? null : part();
    if (name === null || value === null) return `header ${i + 1} of ${count} runs past the end`;
    heads.push([name, value]);
  }
  return { status, content, heads, body: out.subarray(at) };
}
export function responseOf(out: Uint8Array): Answer {
  const f = unframe(out);
  if (typeof f === 'string') return unframed(f);
  const type = CONTENTS[f.content];
  if (type === undefined) return unframed(`content ${f.content}, which Content does not have`);
  if (f.status < 200n || f.status > 599n) return refusedStatus(`status ${f.status} is outside 200 to 599`);
  const status = Number(f.status);
  if (NO_BODY.has(status) && f.body.length > 0)
    return refusedStatus(`a ${status} has no body, and this one has ${f.body.length} bytes (use empty)`);
  if (f.heads.length > HEADER_LIMITS.count) return refused(`more than ${HEADER_LIMITS.count} headers`);
  const size = f.heads.reduce((n, [name, value]) => n + name.length + value.length, 0);
  if (size > HEADER_LIMITS.head) return refused(`more than ${HEADER_LIMITS.head} bytes of headers`);
  const headers: Header[] = [];
  for (const [name, value] of f.heads) {
    const h = headerOf(name, value);
    if (typeof h === 'string') return refused(h);
    headers.push(h);
  }
  return { status, type: CONTENT_TYPES.get(type), headers, body: f.body };
}
/** An answer as text, for tests and tools that print one: `STATUS[ TYPE](CR name: value)* LF BODY`, the type left
 * out for text/plain. It is a picture of the Answer, never what a host serves. */
export function answerText(a: Answer): string {
  const type = [...CONTENT_TYPES].find(([, v]) => v === a.type)?.[0];
  const head = `${a.status}${type && type !== 'text/plain' ? ` ${type}` : ''}`;
  return `${head}${a.headers.map(h => `\r${h.name}: ${h.value}`).join('')}\n${new TextDecoder().decode(a.body)}`;
}
/** A frame, as the generated code writes one: for tests of responseOf, and hosts that answer for a program. */
export function framed(a: {
  status: number | bigint;
  content?: number;
  headers?: readonly Header[];
  body?: Uint8Array | string;
}): Uint8Array {
  const enc = new TextEncoder();
  const body = typeof a.body === 'string' ? enc.encode(a.body) : (a.body ?? new Uint8Array());
  const heads = (a.headers ?? []).flatMap(h => [enc.encode(h.name), enc.encode(h.value)]);
  const out = new Uint8Array(18 + heads.reduce((n, b) => n + 4 + b.length, 0) + body.length);
  const d = new DataView(out.buffer);
  out.set(MAGIC);
  out[4] = VERSION;
  d.setBigInt64(5, BigInt(a.status), true);
  out[13] = a.content ?? 2;
  d.setUint32(14, (a.headers ?? []).length, true);
  let at = 18;
  for (const b of heads) {
    d.setUint32(at, b.length, true);
    out.set(b, at + 4);
    at += 4 + b.length;
  }
  out.set(body, at);
  return out;
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
  if (methods.some(m => m.name === 'woken')) {
    sql.exec(
      'CREATE TABLE IF NOT EXISTS _wakes(key INTEGER PRIMARY KEY, due INTEGER NOT NULL, trace TEXT, span TEXT NOT NULL, tries INTEGER NOT NULL DEFAULT 0)',
    );
    // an object made before failed runs were retried: add the count of storage failures in a row (0 for its rows)
    if (sql.exec("SELECT 1 FROM pragma_table_info('_wakes') WHERE name = 'tries'").toArray().length === 0)
      sql.exec('ALTER TABLE _wakes ADD COLUMN tries INTEGER NOT NULL DEFAULT 0');
  }
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
// A request that loops over its input tries an arm per byte, so its events are kept to `most`: past that only
// effects are recorded, and `cut` counts the line events left out (csv2chart's 60 KB CSV made 2,234,855 of them,
// 124 MB of heap, and the Worker that replayed it for its trace page ran out of memory: 1101).
export const TRACE_SITES = 100_000;
export function traceOf(
  tracedModule: WebAssembly.Module,
  bytes: Uint8Array | null,
  effects: Effect[],
  most: number = TRACE_SITES,
): { events: TraceEvent[]; out: Uint8Array | null; error: string | null; cut: number } {
  const events: TraceEvent[] = [];
  const cut = { n: 0 };
  const app = link(tracedModule, { recorded: effects, trace: events, traceMost: most, traceCut: cut });
  try {
    const out = app.handle(bytes);
    return { events, out, error: null, cut: cut.n };
  } catch (e) {
    return { events, out: null, error: messageOf(e), cut: cut.n };
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
